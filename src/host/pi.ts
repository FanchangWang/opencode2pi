/**
 * pi 1.3.0 adapter.
 *
 * pi differs from omp in four ways that actually matter here, and each one is
 * handled below rather than worked around:
 *
 *  1. **No `registerCustomApi`.** The only seam is `streamSimple` inside a
 *     `pi.registerProvider` call, which is why `request.ts` registers through
 *     `registerProvider` on both hosts rather than calling omp's process-wide
 *     registry at module scope. That top-level call is what crashed pi with
 *     `(0, _piAi.registerCustomApi) is not a function`.
 *  2. **The context is a transcript, not a structured context.** `systemPrompt`
 *     and the tool declarations live in the leading system message, so the
 *     declared tool set has to be replayed out with `getCurrentTools` before it
 *     can be gated, and the gated set has to be written back into the transcript
 *     before the engine reads it.
 *  3. **No `pi.logger`.** Diagnostics are buffered and flushed through the UI, so
 *     a discovery note still reaches the user instead of vanishing.
 *  4. **`ctx.ui.select` takes `string[]`.** The second line of every row is
 *     folded into the label rather than dropped: the exit-pool menu's rows are
 *     mostly evidence, and losing that would make the menu unreadable here.
 *
 * pi's stream also has no `fail`, so a thrown relay ends the stream instead of
 * rejecting `result()`; that is the `abort` hook's whole job.
 */

import {
	collapseSystemMessages,
	createAssistantMessageEventStream,
	getCurrentTools,
	streamSimple,
} from '@earendil-works/pi-ai'
import type {
	Context,
	Model,
	SimpleStreamOptions,
	TranscriptContext,
} from '@earendil-works/pi-ai'

import { classifyUpstreamFailure, formatFailure } from '../errors.ts'
import { createStreamHandler } from '../request.ts'
import {
	ANONYMOUS_KEY,
	API_ID,
	EFFORT_LEVELS,
	type CommandUi,
	type FailedMessage,
	type HostAdapter,
	type HostLogger,
	type HostTool,
	type ModelProjector,
	type ModelSpec,
	type NormalizedContext,
	type SelectItem,
	type StreamEngine,
	type StreamHandler,
} from './contract.ts'

/**
 * pi's thinking levels, in ascending order, with `off` first.
 *
 * pi spells per-model effort support as `thinkingLevelMap`, a partial record from
 * level to the provider's own value, where `null` marks a level unsupported. So
 * a spec carrying `['low', 'high']` becomes `{ low: 'low', high: 'high' }` with
 * every other level explicitly `null` — including `xhigh` and `max`, which pi
 * treats as available only when the map mentions them.
 */
const MODEL_THINKING_LEVELS = ['off', ...EFFORT_LEVELS] as const

export const projectModel: ModelProjector = (spec: ModelSpec) => {
	const config: Record<string, unknown> = {
		id: spec.id,
		name: spec.name,
		reasoning: spec.reasoning,
		input: [...spec.input],
		cost: { ...spec.cost },
		contextWindow: spec.contextWindow,
		maxTokens: spec.maxTokens,
	}
	if (spec.efforts !== undefined && spec.efforts.length > 0) {
		const supported = new Set(spec.efforts)
		config.thinkingLevelMap = Object.fromEntries(
			MODEL_THINKING_LEVELS.map((level) => [
				level,
				level === 'off' || supported.has(level) ? level : null,
			]),
		)
	}
	return config
}

/**
 * Read the declared tools out of the transcript and write a gated set back.
 *
 * Reading is `getCurrentTools`, which replays every system message's
 * `toolsAdded` / `toolsRemoved` delta in order — the tool set at request time is
 * not simply the first message's list.
 *
 * Writing is the subtle half. The gated set must land where the *engine* reads
 * it, and pi's openai-completions resolves tools from the transcript after
 * `resolveTranscript` / `resolveTranscriptTools` (`openai-completions.ts:815`).
 * So the substituted set goes into the leading system message's `toolsAdded`, and
 * the later tool deltas are dropped along with the rest of the system messages —
 * `collapseSystemMessages` folds every system message into one leading message
 * carrying the current prompt and the resolved tools, which is exactly the shape
 * the engine wants. Rebuilding the transcript this way also means the engine
 * reads our tools rather than the host's.
 */
function normalizeContext(raw: unknown): NormalizedContext {
	const messages = ((raw as TranscriptContext | undefined)?.messages ?? []) as readonly TranscriptMessage[]
	return {
		tools: getCurrentTools(messages) as readonly HostTool[],
		withTools: (tools) => {
			// Collapse first so the prompt text and the tool state are resolved
			// exactly the way the engine would resolve them, then replace the tool
			// list on the folded message.
			const collapsed = collapseSystemMessages({ messages: [...messages] } as TranscriptContext)
			const head = collapsed.messages.find((message) => message.role === 'system') as
				| Record<string, unknown>
				| undefined
			const rest = collapsed.messages.filter((message) => message.role !== 'system')
			// The engine reads `toolsAdded` off the leading system message, so that
			// is where the gated set has to land. `toolsRemoved` from the original
			// messages is intentionally not carried over: the collapsed head already
			// reflects every delta applied, and re-applying removals would delete
			// tools we just substituted in.
			const substituted = {
				...(head ?? { role: 'system', content: '', timestamp: 0 }),
				toolsAdded: tools,
				toolsRemoved: undefined,
			}
			return { messages: [substituted, ...rest] } as unknown as Context
		},
	}
}

/** One transcript entry, as far as the replay helpers are concerned. */
type TranscriptMessage = TranscriptContext['messages'][number]

/**
 * pi's failed turn has no `errorStatus`: the HTTP status is folded into the text
 * as `"<status>: <body>"` (`utils/error-body.ts`). Classification therefore runs
 * on the text, which is what `errors.ts`' marker checks already do — `FreeTierError`
 * and `RegionError` survive the round trip, and a bare 403 with no marker reads as
 * `UNKNOWN` rather than being silently reported as an auth problem.
 */
function explainFailure(modelId: string, error: FailedMessage): FailedMessage {
	const original = error.errorMessage ?? ''
	const classification = classifyUpstreamFailure(error.errorStatus, original)
	return { ...error, errorMessage: formatFailure(modelId, classification) }
}

/**
 * pi's `select` takes bare strings, so the description is folded into the label.
 *
 * The label doubles as the key the caller matches its answer against, so the
 * description is appended after the label rather than replacing it: the callers
 * compare against the label they passed in, and a menu that returned only
 * descriptions would match nothing.
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
		select: async (title, items: readonly SelectItem[]) => {
			const choice = await ui.select(
				title,
				items.map((item) => (item.description ? `${item.label} — ${item.description}` : item.label)),
			)
			if (choice === undefined) return undefined
			// Unfold to the label the caller knows, so the dispatch below the menu
			// matches on exactly what it offered.
			const matched = items.find(
				(item) => choice === item.label || choice === `${item.label} — ${item.description}`,
			)
			return matched?.label ?? choice
		},
	}
}

/** The slice of pi's `ExtensionCommandContext` the UI port actually reads. */
interface ExtensionCommandContextLike {
	readonly hasUI: boolean
	readonly ui: {
		select(title: string, options: string[], opts?: unknown): Promise<string | undefined>
		confirm(title: string, message: string, opts?: unknown): Promise<boolean>
		input(title: string, placeholder?: string, opts?: unknown): Promise<string | undefined>
		notify(message: string, type?: 'info' | 'warning' | 'error'): void
		setWorkingMessage(message?: string): void
	}
}

/**
 * pi's provider registration.
 *
 * Same shape as omp's, and pi validates it too: `streamSimple` without `api`
 * throws, and a custom model set without `baseUrl` throws. `apiKey` is not
 * optional on either host for the same reason — the anonymous credential still
 * has to reach the `Authorization` header.
 */
export function piProviderConfig(
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
		models: models.map((model) => projectModel(model)),
		streamSimple,
	}
}

/**
 * Diagnostics for a host with no logger.
 *
 * pi 1.3.0 gives extensions no logging sink at all, and dropping the startup
 * summary on the floor would leave a silent extension that registers a provider
 * and says nothing. So notes are buffered and replayed through the first command
 * invocation's UI, which is the only surface pi offers. Failures are kept rather
 * than thrown: a diagnostic must never be the reason a request fails.
 */
function bufferedLogger(): HostLogger & { drain(): readonly string[] } {
	const lines: string[] = []
	return {
		info: (message) => {
			lines.push(message)
		},
		warn: (message) => {
			lines.push(message)
		},
		drain: () => lines.splice(0, lines.length),
	}
}

/** Build the adapter for a pi `ExtensionAPI`. */
export function piAdapter(pi: unknown): HostAdapter {
	const sink = bufferedLogger()
	const diagnostics: HostLogger = sink

	const engine: StreamEngine = {
		diagnostics,
		normalizeContext,
		explainFailure,
		createStream: () => createAssistantMessageEventStream(),
		// pi's stream has no `fail`: ending it is the only terminal state
		// available, and the error has already been reported through the event
		// stream by the time anything throws here.
		abort: (stream) => stream.end(undefined),
		dispatch: (model, context, options) =>
			streamSimple(
				model as unknown as Model,
				context as Context,
				options as SimpleStreamOptions,
			),
	}

	const stream = createStreamHandler(engine)

	const adapter: HostAdapter = {
		name: 'pi',
		stream,
		providerConfig: (models, baseUrl, headers) => piProviderConfig(stream, models, baseUrl, headers),
		diagnostics,
		ui: (ctx) => {
			const ui = commandUi(ctx)
			// First command of the session is where the buffered startup notes can
			// still reach a human; after that the buffer is empty and this is free.
			const pending = sink.drain()
			if (pending.length > 0) {
				queueMicrotask(() => {
					for (const line of pending) ui.notify(line)
				})
			}
			return ui
		},
	}

	// pi exposes no logger at all, so nothing is read off `pi` here beyond the
	// adapter's own construction. The parameter is kept because the two adapters
	// are called from the same dispatch site in `index.ts`.
	void pi
	return adapter
}

/** Re-exported so `index.ts` names one api id for both hosts. */
export { API_ID }
