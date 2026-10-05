/**
 * opencode2pi — OpenCode Zen's anonymous free lane as an omp/pi provider.
 *
 * The built-in `opencode-zen` provider requires a paid `OPENCODE_API_KEY`.
 * This extension needs none: the upstream gate is a request-shape check, not
 * a credential check. Three conditions, all confirmed live on 2026-10-05:
 *
 *   1. `Authorization: Bearer public`  (anonymous credential)
 *   2. canonical session id  `^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`
 *   3. an agent-shaped body: `tools` containing `bash` and `read`
 *
 * Non-streaming requests are rejected with FreeTierError. Host streaming is
 * inherent to the openai-completions engine, so condition 3 is the only body
 * change this extension has to make.
 *
 * Integration seam (verified against omp 18.6.1 — see docs/FINDINGS.md):
 *   - `pi.registerProvider` config accepts `onPayload` / `prepareRequest`
 *     WITHOUT ERROR but NEVER CALLS THEM. Do not use them.
 *   - The working seam is `registerCustomApi(apiId, streamSimple, sourceId)`,
 *     which receives `(model, context, options)` — a structured context, not a
 *     serialized body. Shape the context, then delegate to the host engine
 *     with `model.api` swapped back to `openai-completions` to avoid recursion.
 *   - `toolChoice` lives on the *options* object, not on `Context`; setting it
 *     on the context is a silent no-op.
 */

import { createHash } from 'node:crypto'

import { createAssistantMessageEventStream, registerCustomApi, streamSimple } from '@earendil-works/pi-ai'
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ProviderModelConfig } from '@oh-my-pi/pi-coding-agent'

import { discoverFreeModels } from './discovery.ts'
import { classifyUpstreamFailure, formatFailure } from './errors.ts'
import { PROCESS_SESSION, sessionForRequest, sessionHeaders } from './session.ts'
import { SEED_MODELS, UNAVAILABLE, VERIFIED_FREE } from './seed.ts'

const PROVIDER = 'opencode-zen-free'
const API_ID = 'openai-completions-zen-free'
const ZEN_BASE = 'https://opencode.ai/zen/v1'
const ANONYMOUS_KEY = 'public'
const SOURCE_ID = 'opencode2pi'

const PROJECT_ID = 'prj_' + createHash('sha256').update('omp:default-project').digest('hex').slice(0, 24)

const DISGUISE_HEADERS: Record<string, string> = {
	'user-agent': 'opencode/1.18.31 (win32 x64; node24.19.0)',
	'x-opencode-client': 'cli',
	'x-opencode-project': PROJECT_ID,
}

/** The upstream gate demands a `bash` and a `read` function in `tools`. */
const GATE_TOOL_NAMES = ['bash', 'read'] as const

const GATE_TOOLS = GATE_TOOL_NAMES.map((name) => ({
	name,
	description: 'Reserved for the host runtime; do not call it.',
	parameters: { type: 'object' as const, properties: {} },
}))

/**
 * Ensure the gate tools are present.
 *
 * The host ships real `bash` and `read` tools, so in practice this is a no-op
 * and the stubs never reach the model. It only bites when a caller runs with no
 * tools at all (a bare completion), where the gate would otherwise fail — so in
 * that case the stubs arrive with `toolChoice: 'none'` to stop the model from
 * calling a stub the host cannot service.
 */
function withGateTools(
	context: Context,
	options: SimpleStreamOptions,
): { context: Context; options: SimpleStreamOptions } {
	const existing = context.tools ?? []
	const names = new Set(existing.map((tool) => tool.name))
	const missing = GATE_TOOLS.filter((tool) => !names.has(tool.name))
	if (missing.length === 0) return { context, options }

	if (existing.length > 0) return { context: { ...context, tools: [...existing, ...missing] }, options }

	return {
		context: { ...context, tools: [...missing] },
		options: { ...options, toolChoice: 'none' },
	}
}

/**
 * Replace a raw provider error with one that names the actual failure mode.
 *
 * `errorClassificationMessage` is preserved (and seeded from the original text
 * when absent) because that is the field the host's recovery logic reads; only
 * the human-facing `errorMessage` is rewritten. Without that split the
 * classification would be display-only but would also erase the host's own
 * retry decisions.
 */
function explainFailure(modelId: string, message: AssistantMessage): AssistantMessage {
	const original = message.errorMessage ?? ''
	const classification = classifyUpstreamFailure(message.errorStatus, original)
	return {
		...message,
		errorMessage: formatFailure(modelId, classification),
		errorClassificationMessage: message.errorClassificationMessage ?? original,
	}
}

let log: ExtensionAPI['logger'] | undefined
let warnedMissingSession = false

/**
 * Custom API handler: shapes the context, pins the conversation's session id,
 * classifies failures, then delegates the actual streaming to the host engine.
 */
registerCustomApi(API_ID, (model: Model, context: Context, options?: SimpleStreamOptions) => {
	const incoming = options ?? {}
	const gated = withGateTools(context, incoming)

	const session = sessionForRequest(options)
	if (!session.derived && !warnedMissingSession) {
		warnedMissingSession = true
		log?.warn(
			`[${PROVIDER}] host supplied no session identity; using process-level session ${session.id}`,
		)
	}

	// The session headers ride on the model we hand the engine rather than on
	// a wrapped `options.fetch`: `fetch` is optional, and a missing wrapper
	// would silently drop the session header and fail the upstream gate with a
	// bare 403. Merging onto the model's own headers also preserves whatever
	// the host already resolved there.
	const builtin: Model = {
		...model,
		api: 'openai-completions' as Model['api'],
		headers: { ...model.headers, ...sessionHeaders(session.id) },
	}
	const forwarded = gated.options

	const upstream = streamSimple(builtin, gated.context, forwarded)

	// Failures arrive as a stream *event*, not a rejected promise, so
	// classification means forwarding the stream and rewriting that event.
	const relayed = createAssistantMessageEventStream()
	void (async () => {
		try {
			for await (const event of upstream) {
				relayed.push(
					event.type === 'error'
						? { ...event, error: explainFailure(model.id, event.error) }
						: event,
				)
			}
			relayed.end(await upstream.result())
		} catch (error) {
			relayed.fail(error)
		}
	})()
	return relayed
}, SOURCE_ID)

export default function (pi: ExtensionAPI): void {
	log = pi.logger

	pi.registerProvider(PROVIDER, {
		baseUrl: ZEN_BASE,
		api: API_ID,
		apiKey: ANONYMOUS_KEY,
		authHeader: true,
		headers: DISGUISE_HEADERS,
		// The seed is what makes cold start work: async discovery cannot
		// participate in `--model` resolution (docs/FINDINGS.md §7.3).
		models: [...SEED_MODELS],
		fetchDynamicModels: async (): Promise<readonly ProviderModelConfig[]> => {
			const { models, diagnostics } = await discoverFreeModels()
			for (const line of diagnostics) log?.info(`[${PROVIDER}] ${line}`)
			return models
		},
	})

	pi.logger.info(
		`[${PROVIDER}] registered · process session ${PROCESS_SESSION} · seed ${SEED_MODELS.length} models · ` +
			`verified-free ${Object.keys(VERIFIED_FREE).length} · known-rejected ${Object.keys(UNAVAILABLE).length}`,
	)
}

export {
	explainFailure,
	withGateTools,
	PROVIDER,
	API_ID,
	SOURCE_ID,
	PROCESS_SESSION,
	SEED_MODELS,
	UNAVAILABLE,
	VERIFIED_FREE,
}
