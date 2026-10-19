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

/**
 * A real completion gets more room than the gate probe.
 *
 * The gate probe stops at response headers, so its 20 s only covers the tunnel
 * and the upstream's first byte. This one waits for the model to finish a turn
 * *and* for the stream to close, which is the one number the pool was missing:
 * a 200 proves the request shape was accepted, not that the exit can carry an
 * answer. 30 s is still bounded — a free proxy that cannot deliver "OK" inside
 * it is not an exit worth keeping, and the scan must not wait forever on one.
 */
const COMPLETION_TIMEOUT_MS = 30_000

/** The answer the completion probe demands. Whitespace and trailing punctuation only. */
const COMPLETION_MATCH = /^\s*OK[.!。！]?\s*$/i

/** Stop reading an unbounded stream once it can no longer change the verdict. */
const COMPLETION_MAX_BYTES = 256 * 1024

export interface GateProbe {
	readonly ok: boolean
	readonly status: number | undefined
	readonly body: string
	readonly latencyMs: number
	/** Set when the request never produced an HTTP response. */
	readonly transportError?: string
	/** Assistant text accumulated from a completion probe. */
	readonly completion?: string
	/** Whether {@link completion} matched the demanded answer. */
	readonly matched?: boolean
}

interface ProbeOptions {
	/** Prompt for a completion probe; ignored by the gate probe. */
	readonly prompt?: string
	/** Read the stream to completion instead of stopping at the headers. */
	readonly readCompletion?: boolean
	readonly timeoutMs?: number
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
	return probe(modelId, lane, exit, {})
}

/**
 * Ask the exit for a real answer, not merely an accepted request.
 *
 * Why this exists: a gate `200` arrives at the response headers, and the pool
 * used to stop there. That is a statement about the request shape, not about the
 * exit: an upstream can send 200 and then an SSE error event, a proxy can die
 * between the headers and the first token, and a shared free IP can spend its
 * quota after the probe. Measured consequence: an exit the menu marked ✅ could
 * fail the very next real turn. This probe drains the stream and requires the
 * model to finish with the demanded answer, so "verified" means "a completion
 * travelled through this exit", which is what the user is buying.
 *
 * The request body is the gate body in every other respect. Keeping the shape in
 * one builder is what stops doctor, health, and the pool from drifting apart.
 */
export async function sendCompletionProbe(modelId: string, lane: LaneKey, exit?: string): Promise<GateProbe> {
	return probe(modelId, lane, exit, {
		prompt: 'Reply with exactly OK',
		readCompletion: true,
		timeoutMs: COMPLETION_TIMEOUT_MS,
	})
}

async function probe(modelId: string, lane: LaneKey, exit: string | undefined, options: ProbeOptions): Promise<GateProbe> {
	const startedAt = Date.now()
	const session = canonicalSessionID(`opencode2pi:gate:${modelId}:${startedAt}:${lane}`)
	const shape = laneFor(lane)
	const timeoutMs = options.timeoutMs ?? GATE_TOTAL_TIMEOUT_MS

	// A candidate exit is judged on the whole request, tunnel included. There is no
	// separate tunnel-stage cap: see GATE_TOTAL_TIMEOUT_MS for the measurement that
	// removed it, and for why dead exits turn out not to need one.
	const proxied = exit === undefined ? undefined : proxiedFetch(exit)
	const via = proxied ?? globalThis.fetch
	const signal = AbortSignal.timeout(timeoutMs)

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
				max_tokens: options.readCompletion === true ? 24 : 16,
				messages: [{ role: 'user', content: options.prompt ?? 'Reply with OK.' }],
				tools: gateTools(lane),
			}),
			signal,
		})
	} catch (error) {
		return { ok: false, status: undefined, body: '', latencyMs: Date.now() - startedAt, transportError: String(error) }
	}

	if (!response.ok) {
		const body = await response.text().catch(() => '')
		return { ok: false, status: response.status, body, latencyMs: Date.now() - startedAt }
	}

	if (options.readCompletion !== true) {
		// Reaching the headers *is* the gate verdict; reading a completion would
		// spend tokens to learn nothing the caller asked about.
		await response.body?.cancel()
		return { ok: true, status: response.status, body: '', latencyMs: Date.now() - startedAt }
	}

	const read = await readCompletion(response)
	const latencyMs = Date.now() - startedAt
	const completion = read.content.trim()
	// A 200 is not a pass here: the stream has to end with the demanded answer.
	// An in-band error is returned as `body` so the caller classifies it with the
	// same code the real request path uses (a 200 + RegionError is still a region
	// block, and a 200 + FreeTierError is still a shape rejection).
	if (read.error !== undefined) {
		return { ok: false, status: response.status, body: read.error, latencyMs, completion }
	}
	return {
		ok: COMPLETION_MATCH.test(completion),
		status: response.status,
		body: completion,
		latencyMs,
		completion,
		matched: COMPLETION_MATCH.test(completion),
	}
}

/**
 * Drain an SSE completion and return its assistant text.
 *
 * Deliberately tolerant: providers on this lane have emitted both `delta.content`
 * and a non-streaming `message.content`, and older shapes put the text in a bare
 * `data:` line. Anything unparseable is skipped rather than treated as a failure
 * — the failure this probe cares about is an *error event*, which is captured
 * separately so the caller can classify it.
 */
async function readCompletion(response: Response): Promise<{ content: string; error?: string }> {
	const reader = response.body?.getReader()
	if (reader === undefined) return { content: '' }
	const decoder = new TextDecoder()
	let buffer = ''
	let content = ''
	let error: string | undefined
	let bytes = 0
	const consume = (line: string): void => {
		const trimmed = line.trim()
		if (!trimmed.startsWith('data:')) return
		const data = trimmed.slice(5).trim()
		if (data === '' || data === '[DONE]') return
		let payload: unknown
		try {
			payload = JSON.parse(data)
		} catch {
			return
		}
		if (typeof payload !== 'object' || payload === null) return
		const record = payload as {
			error?: { message?: string } | string
			message?: string
			type?: string
			choices?: { delta?: { content?: string }; message?: { content?: string } }[]
		}
		if (record.error !== undefined) {
			error =
				typeof record.error === 'string'
					? record.error
					: (record.error.message ?? '上游在流内返回了错误事件')
		} else if (record.type === 'error' && typeof record.message === 'string') {
			error = record.message
		}
		const choice = record.choices?.[0]
		content += choice?.delta?.content ?? choice?.message?.content ?? ''
	}

	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			bytes += value.byteLength
			buffer += decoder.decode(value, { stream: true })
			const lines = buffer.split('\n')
			buffer = lines.pop() ?? ''
			for (const line of lines) consume(line)
			if (bytes >= COMPLETION_MAX_BYTES) {
				await reader.cancel().catch(() => {})
				break
			}
		}
		buffer += decoder.decode()
		if (buffer !== '') consume(buffer)
	} catch (failure) {
		// A stream that dies mid-answer is a transport verdict: the exit did not
		// carry the turn to completion. The caller turns this into one.
		return { content, error: `流中断：${String(failure)}` }
	}
	return { content, ...(error === undefined ? {} : { error }) }
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
