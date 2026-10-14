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
 * bits back as a per-millisecond counter and accepts only `[0, 63]`; the high
 * 36 clock bits are not checked at all (an id whose clock decodes to 1970
 * still passes; issue #65 corrected the first wall-clock-plausibility reading
 * of the mechanism). A digest-derived prefix lands in that window ~1.5% of the
 * time, so it 403s nearly always while every shape assertion stays green. The
 * time segment now comes from upstream's own generator and the conversation
 * identity survives in the Base62 tail alone.
 */

import { createHash } from 'node:crypto'

import type { SimpleStreamOptions } from '@earendil-works/pi-ai'

const CANONICAL_SESSION = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
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
 * The 12 hex characters a genuine OpenCode client emits, ported from
 * upstream's identifier generator (opencode2dsh `ids.ts`, itself a port of
 * `packages/schema/src/identifier.ts`): the millisecond clock with a
 * per-millisecond sequence in the low 12 bits, the whole thing inverted
 * bitwise so ids sort newest-first as plain strings.
 *
 * Counter 1 is pinned: this extension is the only writer of its own sessions,
 * so a per-millisecond counter would only add state. The inversion flips the
 * low bits, which is why a counter-1 session ends its time segment in `ffe` —
 * a structural consequence, not a magic marker, but the string-level tell that
 * separates a real clock from a digest (docs/FINDINGS.md §2).
 *
 * Exported for the regression test that pins this against upstream's own
 * encoder; not part of the wire contract.
 */
export function invertedTimestampHex(now: number = Date.now()): string {
	const current = BigInt(now) * 0x1000n + 1n
	const inverted = ~current & 0xffffffffffffn
	return inverted.toString(16).padStart(12, '0')
}

/**
 * A synthesized session, memoized per conversation signal.
 *
 * The clock half must be minted ONCE per conversation, not per request: a
 * retry, or any second call in the same conversation, has to reuse the
 * identical `ses_` id. Upstream groups the free tier's quota and prompt cache
 * by session, so a fresh clock on every request would forfeit cache reuse
 * across turns. Capped and oldest-evicted, so a long-lived process cannot
 * grow the map without bound.
 */
const SESSION_MEMO_LIMIT = 1024
const sessionMemo = new Map<string, string>()

/** OpenCode's canonical session shape, ported from opencode2dsh `ids.ts`. */
export function canonicalSessionID(signal: string): string {
	if (CANONICAL_SESSION.test(signal)) return signal

	const memoized = sessionMemo.get(signal)
	if (memoized !== undefined) return memoized

	const sum = createHash('sha256').update(`ses\0${signal}`).digest()
	const session = `ses_${invertedTimestampHex()}${base62Fixed(BigInt(`0x${sum.subarray(6, 16).toString('hex')}`), 14)}`

	// Evict the oldest entry rather than clearing. Insertion-ordered Map, so
	// this is FIFO by first mint, NOT LRU: a hit returns early above and does
	// not re-insert. That is fine here — 1024 live conversations is far past
	// any realistic window, and a re-minted id only costs cache affinity.
	if (sessionMemo.size >= SESSION_MEMO_LIMIT) {
		const oldest = sessionMemo.keys().next()
		if (!oldest.done) sessionMemo.delete(oldest.value)
	}
	sessionMemo.set(signal, session)
	return session
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
function sessionSignal(options: SimpleStreamOptions | undefined): string | null {
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
export function sessionForRequest(options: SimpleStreamOptions | undefined): {
	readonly id: string
	readonly derived: boolean
} {
	const signal = sessionSignal(options)
	if (signal === null) return { id: PROCESS_SESSION, derived: false }
	return { id: canonicalSessionID(`omp:${signal}`), derived: true }
}

/** Headers the upstream shape check and cache affinity both key on. */
export function sessionHeaders(sessionId: string): Record<string, string> {
	return {
		'x-opencode-session': sessionId,
		'x-session-affinity': sessionId,
		'x-session-id': sessionId,
	}
}
