/**
 * The user's exit list — `exits.txt`, one upstream proxy per line.
 *
 * The grammar is ported from opencode2api's proxyfile reader
 * (`internal/config/proxy.go`) because it is already the right shape: a BOM is
 * tolerated, blank lines are skipped, and a comment marker only counts when
 * whitespace precedes it — otherwise `https://host:port` would parse as a `//`
 * comment, which is the one way a comment rule can silently eat a proxy.
 *
 * Only `http://` and `https://` exits are accepted. That is a measured limit of
 * this runtime, not a preference: Bun 1.4.3 `fetch(url, { proxy })` throws
 * `UnsupportedProxyProtocol` for `socks5://` and `socks5h://` (2026-10-17,
 * FINDINGS §2.6 — verified against a live mixed-port proxy that answers over
 * HTTP on the same address). The pool rides on exactly that option, so a socks
 * line is rejected **with that reason** rather than silently dropped or
 * downgraded to something that does not dial the same route.
 *
 * Credentials may appear in a URL and are dialled as given, but they never leave
 * this file: the pool store, the TUI and every log line go through
 * {@link redactAddress}, and the store keys are hashes ({@link exitKey}).
 */

import { createHash } from 'node:crypto'

import { parseProxyLine } from './sources.ts'
import { readText, writeText } from './store.ts'

/** Schemes this runtime can actually dial through `fetch(…, { proxy })`. */
const DIALABLE: Record<string, true> = { 'http:': true, 'https:': true }

/** A line we refused, with the reason, so the user can fix the file. */
export interface RejectedExit {
	readonly line: string
	readonly reason: string
}

export interface ParsedExits {
	readonly addresses: readonly string[]
	readonly rejected: readonly RejectedExit[]
}

/** One exit from the user's file: the URL, a store key, and a safe rendering. */
export interface ExitEntry {
	readonly key: string
	readonly url: string
	/** Credential-free rendering, safe to log and store. */
	readonly label: string
}

/**
 * Store key for an exit: a hash of the full URL.
 *
 * Not the URL itself, because URLs carry credentials and the store is written to
 * disk and shown in the TUI. Not the redacted URL either, because two exits on
 * one host that differ only by credential are two different routes and would
 * collide on one key.
 */
export function exitKey(url: string): string {
	return createHash('sha256').update(url).digest('hex').slice(0, 12)
}

/** Hide a password in a proxy URL. Never throws, never returns the secret. */
export function redactAddress(url: string): string {
	try {
		const parsed = new URL(url)
		// A string can parse and still be hiding credentials in the scheme slot:
		// `user:secret@host:1080` reads as protocol `user:`, not as a username.
		if (parsed.password === '') return maskCredentials(url)
		return `${parsed.protocol}//${parsed.username}:***@${parsed.host}`
	} catch {
		// Unparseable means we cannot trust ourselves to rebuild it: mask anything
		// that looks like `user:secret@` and hand the rest back.
		return maskCredentials(url)
	}
}

function maskCredentials(text: string): string {
	return text.replace(/([^/@:\s]+):([^/@\s]+)@/g, '$1:***@')
}

/** Strip a trailing comment (whitespace + `#` / `;` / `//`) and the BOM. */
function stripComment(line: string): string {
	return line.replace(/\s+(?:#|;|\/\/).*$/, '').trim()
}

/**
 * Parse the file body into canonical addresses.
 *
 * Duplicates are dropped with a reason instead of being silently collapsed: two
 * lines dialling the same route are one exit, and the user should be told which
 * line went away.
 */
export function parseExitLines(text: string): ParsedExits {
	const addresses: string[] = []
	const rejected: RejectedExit[] = []
	const seen = new Set<string>()

	for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
		const line = stripComment(raw)
		if (line === '' || /^#|^;|^\/\//.test(line)) continue

		const scheme = /^([a-z0-9+.-]+):\/\//i.exec(line)?.[1]?.toLowerCase()
		if (scheme !== undefined && DIALABLE[`${scheme}:`] !== true) {
			rejected.push({
				line,
				reason: `不支持的协议 ${scheme}://：本运行时只支持 http:// 与 https://（socks5 实测 UnsupportedProxyProtocol）`,
			})
			continue
		}

		const address = parseProxyLine(line)
		if (address === null) {
			rejected.push({ line, reason: '不是有效的 host:port' })
			continue
		}
		if (seen.has(address)) {
			rejected.push({ line, reason: '与前面的出口重复' })
			continue
		}
		seen.add(address)
		addresses.push(address)
	}

	return { addresses, rejected }
}

/** Wrap addresses as entries, preserving the file's order (the user's ranking). */
export function exitEntries(addresses: readonly string[]): readonly ExitEntry[] {
	return addresses.map((url) => ({ key: exitKey(url), url, label: redactAddress(url) }))
}

export async function readExitFile(): Promise<ParsedExits> {
	return parseExitLines((await readText('exits.txt')) ?? '')
}

/** Rewrite the file, one canonical address per line. Called only on add/remove. */
export async function writeExitFile(addresses: readonly string[]): Promise<void> {
	await writeText('exits.txt', addresses.length ? `${addresses.join('\n')}\n` : '')
}
