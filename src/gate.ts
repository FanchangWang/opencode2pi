/**
 * The gate-shaped request, in one place.
 *
 * Both `doctor` and the per-model health probe need to put a minimal
 * agent-shaped request in front of the anonymous free tier, and they must send
 * *exactly* the same bytes as the real path: if they drifted, `doctor` could
 * report a healthy gate that the real path no longer satisfies, which is the
 * one failure this code exists to catch.
 *
 * Since 2026-10-17 the keyless lane is served on two origins with different
 * shapes (docs/FINDINGS.md §2.4/§2.5): the legacy /zen/v1 origin takes the
 * pre-2.x shape (single "read" tool, definitions not checked) and is probed
 * first; /inference takes the 2.x shape (genuine shell/read definitions) as
 * the fallback. The shapes are not negotiable — all conditions are load-
 * bearing, and the third has two independent halves — a non-streaming request
 * is rejected even with the required tools present.
 */

import { canonicalSessionID } from './session.ts'
import { LANES, laneFor, LANE_ORDER, type LaneKey } from './lanes.ts'
import { proxiedFetch } from './transport.ts'

const ANONYMOUS_KEY = 'public'

/**
 * One budget, and the reason there is only one.
 *
 * This used to carry a second, shorter cap on the tunnel stage — 10 s, then 6 s,
 * on the reasoning that a proxy which cannot produce response headers inside it is
 * not carrying traffic and there is nothing to gain from waiting. Measured on
 * 2026-10-17, that reasoning was wrong in the expensive direction: of seven exits
 * that had just screened clean, three returned HTTP 200 after 9.6 s, 10.4 s and
 * 14.3 s, and all three were reported as `transport` failures. The 6 s cap did not
 * separate dead exits from slow ones, because it was measuring the wrong stage.
 *
 * What the same measurement shows is that a dead proxy does not need a cap at all.
 * Broken ones failed in 425 ms (`ECONNRESET`), 721 ms (bad certificate) and
 * 1332 ms (`HTTP 403`, a verdict, not a hang). The only genuinely stuck case is a
 * connect that never completes, and it burns the full budget either way. So the
 * shorter cap bought nothing except turning working exits into dead-looking ones,
 * and the total cap below already bounds the wait.
 *
 * The stage being timed is the upstream's first byte, not the tunnel: the same
 * exits answered a trace to Cloudflare in 212–2736 ms while taking 9–14 s here.
 * That latency is not a property of the proxy and not stable over time, so it
 * cannot be budgeted against from the client side.
 */
const GATE_TOTAL_TIMEOUT_MS = 20_000

export interface GateProbe {
	readonly ok: boolean
	readonly status: number | undefined
	readonly body: string
	readonly latencyMs: number
	/** Set when the request never produced an HTTP response. */
	readonly transportError?: string
}

/** OpenAI wire shape for the gate tools of one lane. */
function gateTools(lane: LaneKey) {
	const { tools } = LANES[lane].gateTools([])
	return tools.map((tool) => ({
		type: 'function' as const,
		function: {
			name: tool.name,
			description: tool.description ?? '',
			parameters: (tool.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>,
		},
	}))
}


/** The gate conditions, restated so a failing `doctor` is actionable. */
export const GATE_CONDITIONS: readonly string[] = [
	'Authorization: Bearer public',
	// Shape alone stopped being sufficient on 2026-10-13: the free tier reads
	// the low 12 bits of the 12 hex characters back as a per-millisecond
	// counter and accepts only [1, 63] (docs/FINDINGS.md §2.3, issue #62;
	// layout validated by session.ts DESCENDING_TIME_PART).
	'canonical session id  ^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$  with counter layout in [1, 63]',
	'agent-shaped body: stream:true; on legacy /zen/v1 a single "read" tool (definitions not checked), on /inference genuine shell+read definitions',
]
/**
 * Send one minimal gate-shaped streaming request down one lane and report what
 * came back.
 *
 * On success the stream is cancelled rather than drained: reaching a 200 *is*
 * the verdict, and reading a completion would spend tokens to learn nothing new.
 * The session id is derived per call so repeated probes do not share upstream
 * cache affinity.
 *
 * `exit` routes this one request through a candidate proxy, on exactly the
 * transport the real path uses (`transport.ts` via `poolFetch`). Screening an
 * exit with anything other than the real request shape — or the real runtime
 * mechanism — would answer a question nobody asked: the pool exists because
 * quota and geo blocks are per egress IP, so the only honest measurement is the
 * gate request itself, from that IP, over the code path that will carry it.
 */
export async function sendGateProbe(modelId: string, lane: LaneKey, exit?: string): Promise<GateProbe> {
	const startedAt = Date.now()
	const session = canonicalSessionID(`opencode2pi:gate:${modelId}:${startedAt}:${lane}`)
	const shape = laneFor(lane)

	// A candidate exit is judged on the whole request, tunnel included. There is no
	// separate tunnel-stage cap: see GATE_TOTAL_TIMEOUT_MS for the measurement that
	// removed it, and for why dead exits turn out not to need one.
	const proxied = exit === undefined ? undefined : proxiedFetch(exit)
	const via = proxied ?? globalThis.fetch
	const signal = AbortSignal.timeout(GATE_TOTAL_TIMEOUT_MS)

	let response: Response
	try {
		response = await via(`${shape.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: {
				...shape.headers('opencode2pi:default-project'),
				...shape.sessionHeaders(session),
				authorization: `Bearer ${ANONYMOUS_KEY}`,
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
			},
			body: JSON.stringify({
				model: modelId,
				stream: true,
				max_tokens: 16,
				messages: [{ role: 'user', content: 'Reply with OK.' }],
				tools: gateTools(lane),
			}),
			signal,
		})
	} catch (error) {
		return { ok: false, status: undefined, body: '', latencyMs: Date.now() - startedAt, transportError: String(error) }
	}

	const latencyMs = Date.now() - startedAt
	if (response.ok) {
		await response.body?.cancel()
		return { ok: true, status: response.status, body: '', latencyMs }
	}

	const body = await response.text().catch(() => '')
	return { ok: false, status: response.status, body, latencyMs }
}

/**
 * Probe both lanes in preference order and return the first that accepts the
 * gate shape, or null when neither does. This is the lane-selection probe the
 * provider re-registration uses after a shape rejection.
 */
export async function findHealthyLane(modelId: string): Promise<LaneKey | null> {
	for (const lane of LANE_ORDER) {
		const probe = await sendGateProbe(modelId, lane)
		if (probe.ok) return lane
	}
	return null
}
