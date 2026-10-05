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

import { canonicalSessionID, sessionHeaders } from './session.ts'

const ZEN_BASE = 'https://opencode.ai/zen/v1'
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

/** Tool stubs the gate requires; never meant to be called. */
function gateTools() {
	const stub = (name: string) => ({
		type: 'function' as const,
		function: {
			name,
			description: 'Reserved for the host runtime; do not call it.',
			parameters: { type: 'object', properties: {} },
		},
	})
	return [stub('bash'), stub('read')]
}


/** The three gate conditions, restated so a failing `doctor` is actionable. */
export const GATE_CONDITIONS: readonly string[] = [
	'Authorization: Bearer public',
	'canonical session id  ^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$',
	'agent-shaped body: stream:true and tools containing bash and read',
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
		response = await fetch(`${ZEN_BASE}/chat/completions`, {
			method: 'POST',
			headers: {
				'user-agent': 'opencode/1.18.31 (win32 x64; node24.19.0)',
				'x-opencode-client': 'cli',
				'x-opencode-project': 'prj_opencode2pi00000000000000',
				authorization: `Bearer ${ANONYMOUS_KEY}`,
				'content-type': 'application/json',
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
