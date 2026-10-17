/**
 * opencode2pi — OpenCode Zen's anonymous free lane as an omp/pi provider.
 *
 * The built-in `opencode-zen` provider requires a paid `OPENCODE_API_KEY`.
 * This extension needs none: the upstream gate is a request-shape check, not
 * a credential check. The keyless lane is served on TWO origins with
 * DIFFERENT shapes (confirmed live 2026-10-17, docs/FINDINGS.md §2.4/§2.5):
 *
 *   1. `Authorization: Bearer public`  (anonymous credential)
 *   2. canonical session id  `^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$` with a
 *      validated counter layout (low 12 bits decode to a counter in [1, 63])
 *   3. an agent-shaped body: on the legacy /zen/v1 origin a single "read"
 *      tool (definitions not checked); on /inference, `shell` + `read` with
 *      the GENUINE OpenCode definitions (stubs are rejected)
 *
 * Non-streaming requests are rejected with FreeTierError. Host streaming is
 * inherent to the openai-completions engine, so condition 3 is the only body
 * change this extension has to make.
 *
 * The host resolves the request URL from the provider registration and
 * neither `model.baseUrl` nor `options.fetch` can redirect it (both probed
 * 2026-10-17), so lane preference is registration-level: the legacy /zen/v1
 * lane is registered first, and a shape rejection re-probes both lanes and
 * re-registers against the healthy one.
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

import { createAssistantMessageEventStream, registerCustomApi, streamSimple } from '@earendil-works/pi-ai'
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ProviderModelConfig } from '@oh-my-pi/pi-coding-agent'

import { discoverFreeModels } from './discovery.ts'
import { handleCommand } from './commands.ts'
import { classifyUpstreamFailure, formatFailure } from './errors.ts'
import { hidden, loadFilters, onHiddenChange, publishFilters, publishHealth } from './filters.ts'
import { loadHealth } from './health.ts'
import { laneFor, type LaneKey } from './lanes.ts'
import { findHealthyLane } from './gate.ts'
import { currentLane, setCurrentLane } from './lanes.ts'
import { PROCESS_SESSION, sessionForRequest } from './session.ts'
import { SEED_MODELS, UNAVAILABLE, VERIFIED_FREE } from './seed.ts'

const PROVIDER = 'opencode-zen-free'
const API_ID = 'openai-completions-zen-free'
const ANONYMOUS_KEY = 'public'
const SOURCE_ID = 'opencode2pi'

/** Project signal rendered into each lane's header shape (FINDINGS §2.5). */
const PROJECT_ID = 'omp:default-project'

/** The lane the provider is currently registered against (shared in lanes.ts). */
let reapply: (() => void) | undefined
let lastLaneSwitchAt = 0
const LANE_SWITCH_COOLDOWN_MS = 60_000

/** Re-register the provider against the lane currently believed healthy. */
function republish(): void {
	reapply?.()
}

/**
 * A shape rejection (403 FreeTierError) means the registered lane may have
 * stopped accepting our shape. Re-probe both lanes and re-register against the
 * healthy one so the NEXT request takes the fallback. Cooldown prevents
 * oscillation when the upstream is flaky.
 */
function scheduleLaneSwitch(): void {
	const now = Date.now()
	if (now - lastLaneSwitchAt < LANE_SWITCH_COOLDOWN_MS) return
	lastLaneSwitchAt = now
	void (async () => {
		const next = await findHealthyLane()
		if (next !== null && next !== currentLane()) {
			setCurrentLane(next)
			log?.warn(`[${PROVIDER}] switching anonymous lane to ${next}`)
			republish()
		}
	})()
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
	const lane = laneFor(currentLane())

	const gated = lane.gateTools(context.tools ?? [])
	// HostTool carries the same wire fields the host's own Tool objects do;
	// the host Context type is generic over the schema, so bridge it here.
	const gatedContext = { ...context, tools: gated.tools as Context['tools'] }
	const forwarded: SimpleStreamOptions = gated.toolChoice ? { ...incoming, toolChoice: gated.toolChoice } : incoming

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
		headers: { ...model.headers, ...lane.sessionHeaders(session.id) },
	}

	const upstream = streamSimple(builtin, gatedContext, forwarded)

	// Failures arrive as a stream *event*, not a rejected promise, so
	// classification means forwarding the stream and rewriting that event.
	const relayed = createAssistantMessageEventStream()
	let sawShapeRejection = false
	void (async () => {
		try {
			for await (const event of upstream) {
				if (event.type === 'error') {
					if (classifyUpstreamFailure(event.error.errorStatus, event.error.errorMessage ?? '').kind === 'SHAPE_REJECTED') {
						sawShapeRejection = true
					}
					relayed.push(
						{ ...event, error: explainFailure(model.id, event.error) },
					)
				} else {
					relayed.push(event)
				}
			}
			relayed.end(await upstream.result())
		} catch (error) {
			relayed.fail(error)
		}
		// Only after the stream has been forwarded: the current request is
		// already answered with the rejection; the switch helps the NEXT one.
		if (sawShapeRejection) scheduleLaneSwitch()
	})()
	return relayed
}, SOURCE_ID)

/**
 * The catalog we publish. Starts as the seed — the only thing that can exist
 * before discovery — and is replaced by the discovered list once it lands.
 */
let catalog: readonly ProviderModelConfig[] = SEED_MODELS

/**
 * Write the provider registry from the catalog minus what the user hid.
 *
 * This is the *only* place the model list is written, and it writes the whole
 * list every time: re-registering a provider name replaces its entire model
 * slice (host contract, `src/config/model-registry.ts`), which is what makes a
 * filter choice reach `/model` and `--model`.
 *
 * Discovery is ours to run, not the host's. Registering `fetchDynamicModels`
 * looked equivalent and is not: the host caches a dynamic result for 24 h
 * under a fingerprint of its *own* empty static list, so a warm cache never
 * calls the fetcher again, and a re-registration inside a session never re-runs
 * discovery — the models merged at startup stay in the registry no matter what
 * we filter. Both were measured: a hidden model came straight back after
 * `/opencode2pi filter`, and one that had never been in the seed survived.
 */
function applyProvider(pi: ExtensionAPI): void {
	const excluded = hidden()
	const models = catalog.filter((model) => !excluded.has(model.id))
	if (models.length === 0) {
		// The host reads a provider with no models as a URL override and keeps the
		// previous list, so a filter that hides everything would silently do
		// nothing. Say so instead.
		log?.warn(`[${PROVIDER}] 过滤规则隐藏了全部模型，模型列表不会缩小；用 /opencode2pi filter 放宽`)
	}

	const lane = laneFor(currentLane())
	pi.registerProvider(PROVIDER, {
		baseUrl: lane.baseUrl,
		api: API_ID,
		apiKey: ANONYMOUS_KEY,
		authHeader: true,
		headers: lane.headers(PROJECT_ID),
		models: [...models],
	})
}

/** Re-discover the free lane and republish. A failure keeps what we have. */
async function refreshCatalog(pi: ExtensionAPI): Promise<void> {
	const { models, diagnostics } = await discoverFreeModels()
	for (const line of diagnostics) log?.info(`[${PROVIDER}] ${line}`)
	if (models.length === 0) return
	catalog = models
	applyProvider(pi)
}

export default async function (pi: ExtensionAPI): Promise<void> {
	log = pi.logger
	reapply = () => applyProvider(pi)

	// The stored choices are part of what the roster is, so they are adopted
	// before the first registration rather than applied on the next probe.
	publishFilters(await loadFilters())
	publishHealth(await loadHealth())
	onHiddenChange(() => reapply?.())
	applyProvider(pi)

	// The host awaits extension factories and only then drains the registration
	// queue (`extensibility/extensions/loader.ts`), so waiting here is what lets
	// `--model provider/id` resolve an id that discovery found and the seed does
	// not carry. The seed is already registered, so a discovery failure costs
	// nothing but the wait — and that wait is the one the host imposed on itself
	// back when it owned discovery.
	await refreshCatalog(pi)

	pi.registerCommand('opencode2pi', {
		description:
			'opencode2pi 诊断：doctor 检查形状闸门，status 显示上次探测结果，probe 重新探测全部模型，filter 设置隐藏规则',
		handler: handleCommand,
	})

	pi.logger.info(
		`[${PROVIDER}] registered · process session ${PROCESS_SESSION} · seed ${SEED_MODELS.length} models · ` +
			`verified-free ${Object.keys(VERIFIED_FREE).length} · known-rejected ${Object.keys(UNAVAILABLE).length} · ` +
			`hidden ${hidden().size}`,
	)
}

export {
	explainFailure,
	PROVIDER,
	API_ID,
	SOURCE_ID,
	PROCESS_SESSION,
	SEED_MODELS,
	UNAVAILABLE,
	VERIFIED_FREE,
}
