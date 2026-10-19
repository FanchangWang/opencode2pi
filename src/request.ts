/**
 * The request path, identical on both hosts.
 *
 * Everything that happens between "the host called our custom API" and "the host
 * got its events back" lives here: gating the tool set into the shape the
 * upstream gate accepts, pinning the conversation's session id onto per-request
 * headers, riding the exit pool on `options.fetch`, relaying the upstream stream
 * while rewriting its failure events, and re-probing the lanes when the gate
 * itself is what got rejected.
 *
 * It is one module rather than two because none of it depends on which host is
 * running. The four genuinely host-specific pieces arrive as a
 * {@link StreamEngine}; see `contract.ts` for what each one is and why.
 */

import { classifyUpstreamFailure } from './errors.ts'
import { findHealthyLane } from './gate.ts'
import { currentLane, laneFor, setCurrentLane } from './lanes.ts'
import { activeCandidate, poolFetch, recordPassive } from './pool.ts'
import { messageIDForRequest, sessionForRequest, userTurnKey } from './session.ts'
import { proxyBackendNote } from './transport.ts'
import {
	BUILTIN_API,
	PROVIDER,
	type MessageStream,
	type StreamEngine,
	type StreamHandler,
	type StreamModel,
	type StreamOptions,
} from './host/contract.ts'

/** Cooldown that keeps a flaky upstream from oscillating the registration. */
const LANE_SWITCH_COOLDOWN_MS = 60_000

let lastLaneSwitchAt = 0
let warnedMissingSession = false
/** Said once per process; a per-request warning would drown the transcript. */
let warnedNoProxyMechanism = false

/**
 * Re-register against the lane now believed healthy.
 *
 * Set by `index.ts` once the provider is registered. A `403 FreeTierError` on
 * `modelId` means the registered lane may have stopped accepting our shape, so we
 * re-probe both lanes with that same model — shape rejection is lane-level
 * (`errors.ts` classifies it that way), which makes the failing model the correct
 * probe target — and re-register against the healthy one so the NEXT request
 * takes the fallback.
 */
let republish: (() => void) | undefined

export function onRepublishReady(fn: () => void): void {
	republish = fn
}

async function scheduleLaneSwitch(modelId: string, diagnostics: StreamEngine['diagnostics']): Promise<void> {
	const now = Date.now()
	if (now - lastLaneSwitchAt < LANE_SWITCH_COOLDOWN_MS) return
	lastLaneSwitchAt = now
	const next = await findHealthyLane(modelId)
	if (next === null || next === currentLane()) return
	setCurrentLane(next)
	diagnostics.warn(`[${PROVIDER}] switching anonymous lane to ${next}`)
	republish?.()
}

/**
 * Build the handler both hosts register.
 *
 * Synchronous by contract: pi's `ProviderConfig.streamSimple` and omp's
 * registered custom API both call this and expect a stream back immediately, and
 * either may throw before a stream exists (a missing credential does exactly
 * that). So the shape and the gated tool set are computed here, on the caller's
 * stack, and only the relaying is deferred.
 */
export function createStreamHandler(engine: StreamEngine): StreamHandler {
	return (model: StreamModel, context: unknown, options?: StreamOptions): MessageStream => {
		const incoming = options ?? {}
		const lane = laneFor(currentLane())

		const normalized = engine.normalizeContext(context)
		const gated = lane.gateTools(normalized.tools)
		// `toolChoice` lives on the *options* object on both hosts, never on the
		// context; setting it on the context is a silent no-op.
		const forwarded: StreamOptions = gated.toolChoice ? { ...incoming, toolChoice: gated.toolChoice } : incoming

		const session = sessionForRequest(options)
		if (!session.derived && !warnedMissingSession) {
			warnedMissingSession = true
			engine.diagnostics.warn(
				`[${PROVIDER}] host supplied no session identity; using process-level session ${session.id}`,
			)
		}

		// The session headers ride on the model we hand the engine rather than on a
		// wrapped `options.fetch`: `fetch` is optional, and a missing wrapper would
		// silently drop the session header and fail the upstream gate with a bare
		// 403.
		//
		// `api` is swapped back to the built-in engine, which is what stops the
		// delegation from re-entering this handler.
		const sessionHeaders = lane.sessionHeaders(
			session.id,
			messageIDForRequest(session.id, userTurnKey(normalized.messages)),
		)
		const builtin: StreamModel = {
			...model,
			api: BUILTIN_API,
			headers: { ...model.headers, ...sessionHeaders },
		}

		// The SAME session headers also go on `options.headers`, and that is not
		// redundancy — it is the only layer that survives pi.
		//
		// pi treats any provider whose baseUrl is opencode.ai as its own
		// (`core/provider-attribution.ts:67-77`) and stamps its own session id onto
		// `x-opencode-session` plus `x-opencode-client: pi` from a
		// `transformHeaders` hook. That hook runs AFTER the model headers are
		// resolved and its merge order puts the host's value last
		// (`core/sdk.ts:354-364`), so a session id set on `model.headers` alone is
		// silently replaced by pi's UUID. The upstream gate reads
		// `x-opencode-session` and requires the canonical `ses_...` layout, so the
		// request fails with a bare FreeTierError — measured 2026-10-17: identical
		// request on omp was accepted (429 = past the gate), on pi it was not.
		//
		// `options.headers` is merged into the headers the host then hands to that
		// attribution hook as its `requestHeaders` argument, and the hook applies
		// those LAST (`provider-attribution.ts:90-94`), so ours wins. omp has no such
		// hook, so there the model headers alone already sufficed; sending both is
		// what makes one code path correct on both hosts.
		const withSessionHeaders: StreamOptions = {
			...forwarded,
			headers: { ...(forwarded.headers as Record<string, string> | undefined), ...sessionHeaders },
		}

		// The exit pool rides on `options.fetch`, the seam both hosts demonstrably
		// honour (FINDINGS §2.6): a wrapper that picks its own per-request proxy
		// wins over the environment, which is what makes switching exits possible
		// mid-session at all. `poolFetch` returns `undefined` while the pool is
		// off, and then this spread adds no key — the request leaves exactly as it
		// did before the feature existed, `PI_PROXY` and all.
		//
		// It also returns `undefined` when the pool IS on and this runtime has no
		// proxy mechanism. That case used to be silent and is not any more: a
		// silent direct connection is indistinguishable, on the wire, from a
		// working pool, which is how a selected exit went on being ignored on pi
		// while the menu still showed it as active. One warning says which half of
		// it is happening.
		const proxied = poolFetch(forwarded.fetch)
		if (proxied === undefined && !warnedNoProxyMechanism && activeCandidate() !== undefined) {
			warnedNoProxyMechanism = true
			engine.diagnostics.warn(
				`[${PROVIDER}] 出口池已选中 ${activeCandidate()?.label}，但本运行时没有可用的代理机制` +
					`（${proxyBackendNote()}），请求仍走本机 IP。要换出口需在支持代理的运行时里运行，或改用 PI_PROXY。`,
			)
		}
		const upstream = engine.dispatch(
			builtin,
			normalized.withTools(gated.tools),
			proxied === undefined ? withSessionHeaders : { ...withSessionHeaders, fetch: proxied },
		)

		// Failures arrive as a stream *event*, not a rejected promise, so
		// classification means forwarding the stream and rewriting that event.
		const relayed = engine.createStream()
		let sawShapeRejection = false
		void (async () => {
			try {
				for await (const event of upstream) {
					if (event.type === 'error' && event.error !== undefined) {
						const error = event.error
						const kind = classifyUpstreamFailure(error.errorStatus, error.errorMessage ?? '').kind
						if (kind === 'SHAPE_REJECTED') sawShapeRejection = true
						// Attribute quota and geo refusals to the exit that produced
						// them. This is the pool's only automatic act, and it is
						// deliberately observation-only: rotating on failure is what
						// this repo refuses to do.
						if (kind === 'RATE_LIMIT' || kind === 'REGION_BLOCKED') await recordPassive(model.id, kind)
						relayed.push({ ...event, error: engine.explainFailure(model.id, error) })
					} else {
						relayed.push(event)
					}
				}
				relayed.end(await upstream.result())
			} catch (error) {
				engine.abort(relayed, error)
			}
			// Only after the stream has been forwarded: the current request is already
			// answered with the rejection; the switch helps the NEXT one.
			if (sawShapeRejection) await scheduleLaneSwitch(model.id, engine.diagnostics)
		})()
		return relayed
	}
}
