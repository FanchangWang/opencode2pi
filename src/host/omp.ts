/**
 * omp adapter.
 *
 * Two things make omp the easy half. Its custom-API handler receives an omp
 * `Context` with `systemPrompt` / `messages` / `tools` as separate fields, so
 * gating the tool set is a spread rather than a transcript replay. And its
 * extension API carries a real `pi.logger`, so diagnostics have somewhere to
 * go.
 *
 * Registration goes through `pi.registerProvider`, not a top-level
 * `registerCustomApi` call, and that is deliberate rather than incidental: the
 * top-level call is the exact statement that crashed pi 1.3.0
 * (`(0, _piAi.registerCustomApi) is not a function`) because pi has no such
 * export. `pi.registerProvider(name, { api, streamSimple })` works on both
 * hosts — omp's model registry calls `registerCustomApi` internally with the
 * same handler — so registering through it is what turns two code paths into
 * one.
 */

import { createAssistantMessageEventStream, streamSimple } from '@earendil-works/pi-ai'
import type { Context, Model, SimpleStreamOptions, Tool } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ProviderModelConfig } from '@oh-my-pi/pi-coding-agent'

import { classifyUpstreamFailure, formatFailure } from '../errors.ts'
import { createStreamHandler } from '../request.ts'
import {
	ANONYMOUS_KEY,
	API_ID,
	type CommandUi,
	type FailedMessage,
	type HostAdapter,
	type HostLogger,
	type HostTool,
	type ModelProjector,
	type ModelSpec,
	type NormalizedContext,
	type SelectItem,
	type SessionModel,
	type StreamEngine,
	type StreamHandler,
} from './contract.ts'

/**
 * Project a {@link ModelSpec} onto omp's `ProviderModelConfig`.
 *
 * The only non-verbatim field is `thinking`: omp spells per-model effort support
 * as `{ mode: 'effort', efforts }`, and a model with no effort axis must leave
 * the key absent rather than carry an empty list — omp's contract requires a
 * non-empty `efforts`.
 */
export const projectModel: ModelProjector = (spec: ModelSpec): ProviderModelConfig => {
	const config: ProviderModelConfig = {
		id: spec.id,
		name: spec.name,
		reasoning: spec.reasoning,
		input: [...spec.input],
		cost: { ...spec.cost },
		contextWindow: spec.contextWindow,
		maxTokens: spec.maxTokens,
	}
	if (spec.efforts !== undefined && spec.efforts.length > 0) {
		// `efforts` is a literal union on omp's side; the spec carries plain
		// strings that `metadata.ts` already validated against the same level set,
		// so the widening happens here and nowhere else.
		config.thinking = { mode: 'effort', efforts: [...spec.efforts] } as ProviderModelConfig['thinking']
	}
	return config
}

/** omp's `Context` already separates prompt, messages and tools. */
function normalizeContext(raw: unknown): NormalizedContext {
	const context = (raw ?? {}) as Context
	const tools = (context.tools ?? []) as readonly Tool[]
	return {
		tools: tools as readonly HostTool[],
		messages: (context.messages ?? []) as readonly unknown[],
		withTools: (next) => ({ ...context, tools: next as Tool[] }),
	}
}

/** omp's extension context carries the selected model; narrow it to the two ids. */
function currentModel(ctx: unknown): SessionModel | undefined {
	const model = (ctx as { model?: SessionModel } | undefined)?.model
	if (model === undefined) return undefined
	return { provider: model.provider, api: model.api, id: model.id }
}

/** omp's failed turn carries the status as a number, so classify from both. */
function explainFailure(modelId: string, error: FailedMessage): FailedMessage {
	const original = error.errorMessage ?? ''
	const classification = classifyUpstreamFailure(error.errorStatus, original)
	return {
		...error,
		errorMessage: formatFailure(modelId, classification),
		// `errorClassificationMessage` is the field omp's recovery logic reads, so
		// it is preserved, and seeded from the original text when absent. Only the
		// human-facing text is rewritten; without that split the classification
		// would also erase omp's own retry decisions.
		errorClassificationMessage: error.errorClassificationMessage ?? original,
	}
}

/**
 * omp's `select` already takes `{label, description}[]` and resolves to the chosen
 * label, so the shared UI port is a pass-through.
 */
function commandUi(ctx: unknown): CommandUi {
	const command = ctx as ExtensionCommandContextLike
	const ui = command.ui
	return {
		get hasUI() {
			return command.hasUI
		},
		notify: (message, level) => ui.notify(message, level),
		setWorkingMessage: (message) => ui.setWorkingMessage(message),
		confirm: (title, message) => ui.confirm(title, message),
		input: (title, placeholder) => ui.input(title, placeholder),
		select: (title, items: readonly SelectItem[]) => ui.select(title, items.map((item) => ({ ...item }))),
	}
}

/** The slice of omp's `ExtensionCommandContext` the UI port actually reads. */
interface ExtensionCommandContextLike {
	readonly hasUI: boolean
	readonly ui: {
		select(
			title: string,
			options: readonly SelectItem[],
			dialogOptions?: unknown,
		): Promise<string | undefined>
		confirm(title: string, message: string, dialogOptions?: unknown): Promise<boolean>
		input(title: string, placeholder?: string, dialogOptions?: unknown): Promise<string | undefined>
		notify(message: string, type?: 'info' | 'warning' | 'error'): void
		setWorkingMessage(message?: string): void
	}
}

/**
 * The omp provider registration.
 *
 * `apiKey: 'public'` with `authHeader: true` is the anonymous credential: the
 * upstream gate checks that an `Authorization: Bearer` header is present and
 * what follows it, so no real key exists to be wrong. omp validates this config
 * (a custom model set with no `baseUrl` or no `apiKey` throws), which is why both
 * are always present rather than conditionally spread.
 */
export function ompProviderConfig(
	streamSimple: StreamHandler,
	models: readonly ModelSpec[],
	baseUrl: string,
	headers: Record<string, string>,
): Record<string, unknown> {
	return {
		baseUrl,
		api: API_ID,
		apiKey: ANONYMOUS_KEY,
		authHeader: true,
		headers,
		models: models.map((model) => projectModel(model) as ProviderModelConfig),
		streamSimple,
	}
}

/** Build the adapter for an omp `ExtensionAPI`. */
export function ompAdapter(pi: unknown): HostAdapter {
	const logger = (pi as { logger?: ExtensionAPI['logger'] }).logger
	// Every call site goes through this object rather than `logger?.`, because pi
	// has no logger at all and a missing method must never be why a request fails.
	const diagnostics: HostLogger = {
		info: (message) => logger?.info(message),
		warn: (message) => logger?.warn(message),
	}

	const engine: StreamEngine = {
		diagnostics,
		normalizeContext,
		explainFailure,
		createStream: () => createAssistantMessageEventStream(),
		/** omp's stream has a real `fail`, so a thrown error rejects `result()`. */
		abort: (stream, error) => (stream as unknown as { fail(err: unknown): void }).fail(error),
		dispatch: (model, context, options) =>
			streamSimple(model as unknown as Model, context as Context, options as SimpleStreamOptions),
	}

	const stream = createStreamHandler(engine)

	return {
		name: 'omp',
		stream,
		providerConfig: (models, baseUrl, headers) => ompProviderConfig(stream, models, baseUrl, headers),
		diagnostics,
		currentModel,
		ui: commandUi,
	}
}

/** Re-exported so `index.ts` names one api id for both hosts. */
export { API_ID }
