/**
 * The gate-shaped request, in one place.
 *
 * Both `doctor` and the per-model health probe need to put a minimal
 * agent-shaped request in front of Zen, and they must send *exactly* the same
 * bytes: if the two drifted, `doctor` could report a healthy gate that the real
 * path no longer satisfies, which is the one failure this code exists to catch.
 *
 * The shape is not negotiable (docs/FINDINGS.md §2). All three conditions are
 * load-bearing, and the third has two independent halves — a non-streaming
 * request is rejected even with both tools present.
 */

import { canonicalSessionID, clientProjectID, sessionHeaders } from './session.ts'
import { OPENCODE_TOOLS } from './tools.ts'

const ANONYMOUS_BASE = 'https://opencode.ai/inference/v1'
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

/**
 * The agent-shaped tool set the gate requires, with the genuine OpenCode
 * definitions: the free tier validates the DEFINITION of every tool whose name
 * it recognises, and a synthesised stub is rejected with 403 FreeTierError
 * (opencode2api #83).
 */
function gateTools() {
	return (['shell', 'read'] as const).map((name) => {
		const definition = OPENCODE_TOOLS[name]
		if (definition === undefined) {
			// A missing definition would silently ship a stub-shaped request,
			// which upstream rejects — fail loudly instead.
			throw new Error(`missing gate tool definition: ${name}`)
		}
		return {
			type: 'function' as const,
			function: {
				name,
				description: definition.description,
				parameters: definition.parameters as Record<string, unknown>,
			},
		}
	})
}


/** The three gate conditions, restated so a failing `doctor` is actionable. */
export const GATE_CONDITIONS: readonly string[] = [
	'Authorization: Bearer public',
	// Shape alone stopped being sufficient on 2026-10-13: the free tier reads
	// the low 12 bits of the 12 hex characters back as a per-millisecond
	// counter and accepts only [1, 63] (docs/FINDINGS.md §2.3, issue #62;
	// layout validated by session.ts DESCENDING_TIME_PART).
	'canonical session id  ^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$  with counter layout in [1, 63]',
	'agent-shaped body: stream:true and tools containing shell and read with genuine definitions, sent to https://opencode.ai/inference/v1',
]
/**
 * Send one minimal gate-shaped streaming request and report what came back.
 *
 * On success the stream is cancelled rather than drained: reaching a 200 *is*
 * the verdict, and reading a completion would spend tokens to learn nothing new.
 * The session id is derived per call so repeated probes do not share upstream
 * cache affinity.
 */
export async function sendGateProbe(modelId: string): Promise<GateProbe> {
	const startedAt = Date.now()
	const session = canonicalSessionID(`opencode2pi:gate:${modelId}:${startedAt}`)

	let response: Response
	try {
		response = await fetch(`${ANONYMOUS_BASE}/chat/completions`, {
			method: 'POST',
			headers: {
				'user-agent': 'opencode/latest/2.0.29/cli',
				'x-opencode-client': 'cli',
				'x-opencode-project': clientProjectID('opencode2pi:default-project'),
				authorization: `Bearer ${ANONYMOUS_KEY}`,
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				...sessionHeaders(session),
			},
			body: JSON.stringify({
				model: modelId,
				stream: true,
				max_tokens: 16,
				messages: [{ role: 'user', content: 'Reply with OK.' }],
				tools: gateTools(),
			}),
			signal: AbortSignal.timeout(GATE_TIMEOUT_MS),
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
