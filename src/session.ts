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

/** OpenCode's canonical session shape, ported from opencode2dsh `ids.ts`. */
export function canonicalSessionID(signal: string): string {
	if (CANONICAL_SESSION.test(signal)) return signal
	const sum = createHash('sha256').update(`ses\0${signal}`).digest()
	return `ses_${sum.subarray(0, 6).toString('hex')}${base62Fixed(BigInt(`0x${sum.subarray(6, 16).toString('hex')}`), 14)}`
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
