/**
 * Per-conversation session identity (docs/PLAN.md §T3).
 *
 * Upstream does prompt-cache affinity per session id, so sharing one id across
 * every conversation in a process makes unrelated sessions evict each other's
 * cache. The previous implementation used a process-level constant.
 *
 * `options.sessionId` was **probed**, not assumed: a dump of the custom-API
 * handler's runtime `options` (omp 18.6.1, 2026-10-05) shows a real per-session
 * UUID (`01a10bfe-…`), mirrored in `options.metadata.user_id`. Neither is
 * declared in the host's published `SimpleStreamOptions` type, so both are read
 * through runtime narrowing rather than trusted casts.
 *
 * The id must be attached per *request*: `ProviderConfig.headers` is fixed at
 * registration time and cannot vary by conversation, so the caller merges these
 * onto the model it hands the engine — the model is rebuilt on every request,
 * which is the seam that actually varies.
 *
 * Issue #62 (upstream live-probed 2026-10-13, reproduced in this repo
 * 2026-10-14): matching the canonical SHAPE stopped being sufficient. The 12
 * hex characters are not an arbitrary blob — the free tier reads their low 12
 * bits back as a per-millisecond counter and accepts only `[1, 63]`; the high
 * 36 clock bits are not checked at all (an id whose clock decodes to 1970
 * still passes; issue #65 corrected the first wall-clock-plausibility reading
 * of the mechanism). A digest-derived prefix lands in that window ~1.5% of the
 * time, so it 403s nearly always while every shape assertion stays green.
 *
 * 2026-10-15 (opencode2api #70): since only the low 12 bits are checked, the
 * timestamp half needs no real clock. It is re-derived deterministically from
 * the hash — a 36-bit pseudo-clock shifted into the top of a 48-bit word,
 * ORed with counter 1, then bitwise-NOT-ed — so a session is stable per
 * conversation with no memo, no clock and no state. Sessions that already
 * carry a genuine OpenCode layout (counter in [1, 63]) pass through unchanged;
 * any other ses_ shape (raw hash, ascending id) is re-encoded rather than
 * forwarded, because a wrong layout 403s.
 */

import { createHash } from 'node:crypto'

import type { StreamOptions } from './host/contract.ts'

const CANONICAL_SESSION = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
/**
 * The time-part layout the free tier actually validates: the low 12 bits
 * decode (after bitwise NOT) to a per-millisecond counter and only `[1, 63]`
 * is accepted — which is hex `[0xFC0, 0xFFF]` on the wire. A genuine counter-1
 * session therefore ends its time segment in `ffe` (opencode2api #70).
 */
const DESCENDING_TIME_PART = /^[0-9a-f]{9}f[c-f][0-9a-f]$/
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function base62Fixed(value: bigint, width: number): string {
	let out = ''
	let v = value
	for (let i = 0; i < width; i++) {
		out = BASE62[Number(v % 62n)] + out
		v /= 62n
	}
	return out
}

/**
 * Renders six hash bytes as the official client's `Identifier.descending()`
 * layout (ported from opencode2api #70): a 36-bit pseudo-clock shifted into
 * the top of a 48-bit word, ORed with counter 1, then bitwise-NOT-ed so the
 * low 12 hex digits read `ffe`.
 *
 * Counter 1 is pinned: this extension is the only writer of its own sessions,
 * so a per-millisecond counter would only add state. Because the derivation is
 * deterministic, a conversation keeps one stable id with no memo and no clock.
 *
 * Exported for the regression test that pins this against upstream's own
 * encoder; not part of the wire contract.
 */
export function descendingTimePart(hash: Uint8Array): string {
	// noUncheckedIndexedAccess: defensive defaults; the caller always passes
	// six bytes, so the fallbacks are unreachable.
	const b0 = hash[0] ?? 0
	const b1 = hash[1] ?? 0
	const b2 = hash[2] ?? 0
	const b3 = hash[3] ?? 0
	const b4 = hash[4] ?? 0
	const current = (BigInt(b0) << 28n | BigInt(b1) << 20n | BigInt(b2) << 12n | BigInt(b3) << 4n | BigInt(b4) >> 4n) << 12n
	const inverted = ~(current | 1n) & 0xffffffffffffn
	return inverted.toString(16).padStart(12, '0')
}

/**
 * OpenCode's canonical session shape, ported from opencode2api `identity`.
 *
 * A signal that already carries a genuine OpenCode session (canonical shape
 * AND the validated counter layout) passes through unchanged, preserving
 * upstream prompt-cache affinity. Any other identity — the host's UUIDs, a
 * foreign `ses_` shape (raw hash or ascending id), legacy gateway sessions —
 * is deterministically re-encoded into the client's layout with the
 * conversation identity folded into the Base62 tail.
 */
export function canonicalSessionID(signal: string): string {
	if (CANONICAL_SESSION.test(signal) && DESCENDING_TIME_PART.test(signal.slice(4, 16))) return signal

	const sum = createHash('sha256').update(`ses\0${signal}`).digest()
	return `ses_${descendingTimePart(sum.subarray(0, 6))}${base62Fixed(BigInt(`0x${sum.subarray(6, 16).toString('hex')}`), 14)}`
}

/** Process-level fallback, used when the host gives us no session identity. */
export const PROCESS_SESSION = canonicalSessionID(`omp:${process.pid}:${new Date().toISOString().slice(0, 10)}`)

/**
 * Resolve the signal to derive this request's session id from.
 *
 * Preference order: the host's own `sessionId`, then the `user_id` blob it
 * mirrors into metadata, then the process constant. Returns null when nothing
 * usable is present so the caller can log the fallback rather than pretend.
 */
function sessionSignal(options: StreamOptions | undefined): string | null {
	if (!options) return null

	if ('sessionId' in options && typeof options.sessionId === 'string' && options.sessionId.length > 0) {
		return options.sessionId
	}

	if ('metadata' in options) {
		const metadata = options.metadata
		if (typeof metadata === 'object' && metadata !== null && 'user_id' in metadata) {
			const userId = metadata.user_id
			if (typeof userId === 'string') {
				try {
					const parsed: unknown = JSON.parse(userId)
					if (
						typeof parsed === 'object' &&
						parsed !== null &&
						'session_id' in parsed &&
						typeof parsed.session_id === 'string' &&
						parsed.session_id.length > 0
					) {
						return parsed.session_id
					}
				} catch {
					// Not JSON: fall through to the process constant.
				}
			}
		}
	}

	return null
}

/**
 * Canonical session id for this request, stable across every turn of one
 * conversation and distinct between conversations in the same process.
 */
export function sessionForRequest(options: StreamOptions | undefined): {
	readonly id: string
	readonly derived: boolean
} {
	const signal = sessionSignal(options)
	if (signal === null) return { id: PROCESS_SESSION, derived: false }
	return { id: canonicalSessionID(`omp:${signal}`), derived: true }
}

/**
 * Renders the project header the way the OpenCode client does: a bare
 * 40-character lowercase hex id rather than a `prj_`-prefixed one. The value
 * itself is not checked upstream, only its shape, but hashing keeps one
 * conversation pinned to one project (opencode2api #70/#83).
 */
export function clientProjectID(project: string): string {
	return createHash('sha256').update(`opencode-project\x00${project}`).digest('hex').slice(0, 40)
}
