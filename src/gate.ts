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

const ANONYMOUS_KEY = 'public'
const GATE_TIMEOUT_MS = 30_000

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
 * `exit` routes this one request through a candidate proxy, using the very same
 * `init.proxy` the real path uses (pool.ts). Screening an exit with anything
 * other than the real request shape would answer a question nobody asked: the
 * pool exists because quota and geo blocks are per egress IP, so the only honest
 * measurement is the gate request itself, from that IP.
 */
export async function sendGateProbe(modelId: string, lane: LaneKey, exit?: string): Promise<GateProbe> {
	const startedAt = Date.now()
	const session = canonicalSessionID(`opencode2pi:gate:${modelId}:${startedAt}:${lane}`)
	const shape = laneFor(lane)

	let response: Response
	try {
		response = await fetch(`${shape.baseUrl}/chat/completions`, {
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
			signal: AbortSignal.timeout(GATE_TIMEOUT_MS),
			...(exit === undefined ? {} : { proxy: exit }),
		} as RequestInit)
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
