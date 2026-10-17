/**
 * Invariants for the exit pool — the parts where being wrong is silent.
 *
 * Three of these are the reason the feature can exist at all:
 *
 *  · **Off means untouched.** `poolFetch` returns `undefined` while the pool is
 *    closed, and the caller then adds no `fetch` key at all. That is a property
 *    of the return value, so it is testable here instead of being a claim in a
 *    document.
 *  · **A credential never reaches the store.** Manual exits live in `exits.txt`
 *    and are re-read from it; `pool.json` addresses them by hash only. A user's
 *    `http://user:secret@host:port` line must not be copied into a second file.
 *  · **A quota refusal is not a dead exit.** The verdict mapping decides which
 *    failures falsify an exit, and a region block or a 429 means something about
 *    one model on one IP — not about the proxy being broken.
 *
 * The data directory is redirected per test process, so the suite never touches
 * the user's real `exits.txt` or `pool.json` (see `OPENCODE2PI_DATA_DIR`).
 */

import { beforeEach, describe, expect, test } from 'bun:test'

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { exitKey, parseExitLines, redactAddress } from '../src/exits.ts'
import { parseProxyLine } from '../src/sources.ts'
import {
	activeCandidate,
	addCandidate,
	admitDiscovered,
	candidates,
	evidenceFor,
	EXIT_TTL_MS,
	gradeOf,
	isUsable,
	LIMIT_TTL_MS,
	loadPool,
	poolEnabled,
	poolFetch,
	recordPassive,
	rejectedExits,
	removeCandidate,
	selectExit,
	selectedKey,
	setPoolEnabled,
	type ExitEvidence,
	type GateVerdict,
} from '../src/pool.ts'
import { parseTrace, verdictOf } from '../src/pool-probe.ts'
import type { UpstreamFailure } from '../src/errors.ts'

const DIR = join(tmpdir(), 'opencode2pi-test-pool')
process.env.OPENCODE2PI_DATA_DIR = DIR

const EXIT = 'http://1.2.3.4:8080'

async function writeExits(text: string): Promise<void> {
	await mkdir(DIR, { recursive: true })
	await writeFile(join(DIR, 'exits.txt'), text, 'utf8')
}

async function storeText(): Promise<string> {
	return readFile(join(DIR, 'pool.json'), 'utf8')
}

/** Fresh directory, fresh module state: no test inherits another's selection. */
beforeEach(async () => {
	await rm(DIR, { recursive: true, force: true })
	await loadPool()
	await writeExits(`${EXIT}\n`)
	await loadPool()
})

describe('exits.txt grammar', () => {
	test('canonicalizes bare host:port and drops duplicates with a reason', () => {
		const parsed = parseExitLines('1.2.3.4:8080\nhttp://1.2.3.4:8080\n5.6.7.8:3128\n')
		expect(parsed.addresses).toEqual(['http://1.2.3.4:8080', 'http://5.6.7.8:3128'])
		// Silently collapsing two identical lines would hide a typo the user can fix.
		expect(parsed.rejected.map((entry) => entry.reason)).toEqual(['与前面的出口重复'])
	})

	test('refuses socks and junk instead of dropping them quietly', () => {
		const parsed = parseExitLines('socks5://1.2.3.4:1080\nnot-an-address\nftp://1.2.3.4:21\n')
		expect(parsed.addresses).toEqual([])
		expect(parsed.rejected).toHaveLength(3)
		expect(parsed.rejected[0]?.reason).toContain('不支持的协议')
	})

	test('ignores comments, blanks and a BOM', () => {
		const parsed = parseExitLines('\uFEFF# mine\n\n  9.9.9.9:80  // fast one\n')
		expect(parsed.addresses).toEqual(['http://9.9.9.9:80'])
		expect(parsed.rejected).toEqual([])
	})

	test('hides a password but keeps the address reversible', () => {
		const url = parseProxyLine('user:secret@1.2.3.4:8080')
		expect(url).toBe('http://user:secret@1.2.3.4:8080')
		const redacted = redactAddress(url as string)
		expect(redacted).toBe('http://user:***@1.2.3.4:8080')
		expect(redacted).not.toContain('secret')
		// The key addresses the same exit regardless of how it is displayed.
		expect(exitKey(url as string)).not.toContain('secret')
	})

	test('masks a password even when the text does not parse as a proxy URL', () => {
		// Both of these reach the display path as *refused* lines, where the raw
		// text is user input rather than a canonical address.
		expect(redactAddress('user:secret@1.2.3.4:8080')).toBe('user:***@1.2.3.4:8080')
		expect(redactAddress('socks5://user:secret@1.2.3.4:1080')).not.toContain('secret')
		expect(redactAddress('not-an-address')).toBe('not-an-address')
		expect(redactAddress('1.2.3.4:8080')).toBe('1.2.3.4:8080')
	})
})

describe('pool.json holds no credentials', () => {
	test('a credentialed exits.txt line is hashed, never copied into the store', async () => {
		await writeExits('http://user:secret@1.2.3.4:8080\n')
		await loadPool()
		const [candidate] = candidates()
		expect(candidate?.label).not.toContain('secret')
		await selectExit(candidate?.key ?? '')
		await setPoolEnabled(true)
		expect(await storeText()).not.toContain('secret')
	})
})

describe('latency grades and usability', () => {
	test('grade boundaries are inclusive at the top of each band', () => {
		expect(gradeOf(1)).toBe('S')
		expect(gradeOf(500)).toBe('S')
		expect(gradeOf(501)).toBe('A')
		expect(gradeOf(1000)).toBe('A')
		expect(gradeOf(1001)).toBe('B')
		expect(gradeOf(2000)).toBe('B')
		expect(gradeOf(2001)).toBe('C')
	})

	const screen = { at: Date.now(), exitIP: '5.6.7.8', rttMs: 300 }

	test('requires a screen result inside the latency budget', () => {
		expect(isUsable(undefined)).toBe(false)
		expect(isUsable({ label: 'x', tier: 'manual' })).toBe(false)
		expect(isUsable({ label: 'x', tier: 'manual', screen: { ...screen, error: 'connect ECONNREFUSED' } })).toBe(false)
		expect(isUsable({ label: 'x', tier: 'manual', screen: { ...screen, rttMs: 3001 } })).toBe(false)
		expect(isUsable({ label: 'x', tier: 'manual', screen: { ...screen, at: Date.now() - EXIT_TTL_MS - 1 } })).toBe(false)
		expect(isUsable({ label: 'x', tier: 'manual', screen })).toBe(true)
	})

	test('a passing gate test is enough on its own', () => {
		// Screening is a bulk filter, not a prerequisite: a request that came back
		// 200 through the exit is stronger evidence than a trace through it.
		expect(
			isUsable({ label: 'x', tier: 'manual', gate: { at: Date.now(), modelId: 'm', verdict: 'ok', e2eMs: 900, detail: '' } }),
		).toBe(true)
		expect(
			isUsable({
				label: 'x',
				tier: 'manual',
				gate: { at: Date.now() - EXIT_TTL_MS - 1, modelId: 'm', verdict: 'ok', e2eMs: 900, detail: '' },
			}),
		).toBe(false)
	})

	test('a quota refusal is not a dead exit, but a region block is', () => {
		const withGate = (verdict: GateVerdict): ExitEvidence => ({
			label: 'x',
			tier: 'manual' as const,
			screen,
			gate: { at: Date.now(), modelId: 'm', verdict, e2eMs: 900, detail: '' },
		})
		expect(isUsable(withGate('ok'))).toBe(true)
		// 429 and an unclassifiable failure say nothing about the exit's fitness.
		expect(isUsable(withGate('limited'))).toBe(true)
		expect(isUsable(withGate('inconclusive'))).toBe(true)
		expect(isUsable(withGate('region'))).toBe(false)
		expect(isUsable(withGate('transport'))).toBe(false)
		expect(isUsable(withGate('shape'))).toBe(false)
	})
})

describe('gate verdict mapping', () => {
	test('only failures a different exit would have fixed falsify the exit', () => {
		const expected: Readonly<Record<UpstreamFailure, GateVerdict>> = {
			RATE_LIMIT: 'limited',
			REGION_BLOCKED: 'region',
			SHAPE_REJECTED: 'shape',
			AUTH: 'shape',
			MODEL_GONE: 'inconclusive',
			REQUEST_REJECTED: 'inconclusive',
			UPSTREAM: 'inconclusive',
			UNKNOWN: 'inconclusive',
		}
		for (const [kind, verdict] of Object.entries(expected)) {
			expect(verdictOf(kind as UpstreamFailure)).toBe(verdict)
		}
	})

	test('reads the exit IP and country out of a trace body', () => {
		const fields = parseTrace('fl=abc\nip=203.0.113.7\nloc=JP\nts=1\n')
		expect(fields).toEqual({ ip: '203.0.113.7', loc: 'JP' })
		expect(parseTrace('fl=abc\n')).toEqual({})
	})
})

describe('the transport wrapper', () => {
	test('is absent while the pool is closed, so nothing about the request changes', async () => {
		expect(poolFetch()).toBeUndefined()
		await selectExit(candidates()[0]?.key ?? '')
		// Selected but closed is still off: only `enabled` decides.
		expect(poolFetch()).toBeUndefined()
		expect(activeCandidate()).toBeUndefined()
	})

	test('injects the exit for upstream hosts and leaves loopback and private hosts alone', async () => {
		await selectExit(candidates()[0]?.key ?? '')
		await setPoolEnabled(true)
		const seen: { url: string; proxy: string | undefined }[] = []
		const base = async (input: string | URL | Request, init?: RequestInit) => {
			seen.push({ url: String(input), proxy: (init as { proxy?: string } | undefined)?.proxy })
			return new Response('{}')
		}
		const wrapper = poolFetch(base)
		expect(wrapper).toBeDefined()
		await wrapper?.('https://opencode.ai/zen/v1/chat/completions', { method: 'POST' })
		await wrapper?.('http://127.0.0.1:11434/v1/models')
		await wrapper?.('http://192.168.31.50:7890/x')
		await wrapper?.('http://localhost:3000/x')
		expect(seen.map((entry) => entry.proxy)).toEqual([EXIT, undefined, undefined, undefined])
	})

	test('attributes an observed quota failure to the active exit, and to nobody when closed', async () => {
		await selectExit(candidates()[0]?.key ?? '')
		await recordPassive('model-a', 'RATE_LIMIT')
		expect(evidenceFor(exitKey(EXIT))?.modelMarks).toBeUndefined()

		await setPoolEnabled(true)
		await recordPassive('model-a', 'RATE_LIMIT')
		await recordPassive('model-b', 'REGION_BLOCKED')
		const marks = evidenceFor(exitKey(EXIT))?.modelMarks
		expect(marks?.['model-a']?.kind).toBe('limited')
		expect(marks?.['model-b']?.kind).toBe('region')
		expect(LIMIT_TTL_MS).toBeLessThan(EXIT_TTL_MS)
	})
})

describe('selection, persistence and pruning', () => {
	test('refuses an unknown key and an already-listed exit', async () => {
		await selectExit('deadbeef1234')
		expect(selectedKey()).toBeNull()
		expect(await addCandidate(EXIT)).toBe('这个出口已经在列表里')
		expect(await addCandidate('socks5://1.2.3.4:1080')).toContain('不支持的协议')
		expect(candidates()).toHaveLength(1)
	})

	test('round-trips through the store, and keeps the file order as the ranking', async () => {
		await addCandidate('9.9.9.9:3128')
		expect(candidates().map((candidate) => candidate.url)).toEqual([EXIT, 'http://9.9.9.9:3128'])
		await selectExit(candidates()[1]?.key ?? '')
		await setPoolEnabled(true)
		await loadPool()
		expect(poolEnabled()).toBe(true)
		expect(activeCandidate()?.url).toBe('http://9.9.9.9:3128')
	})

	test('removing the selected exit clears the selection instead of leaving a dangling key', async () => {
		await addCandidate('9.9.9.9:3128')
		const key = candidates()[0]?.key ?? ''
		await selectExit(key)
		await removeCandidate(key)
		expect(selectedKey()).toBeNull()
		expect((await readFile(join(DIR, 'exits.txt'), 'utf8')).trim()).toBe('http://9.9.9.9:3128')
		expect(rejectedExits()).toEqual([])
	})

	test('a launch that changes nothing writes no store', async () => {
		// Users who never open the pool must not find a `pool.json` in their data
		// directory: the file is only created by an actual choice.
		await loadPool()
		expect(await Bun.file(join(DIR, 'pool.json')).exists()).toBe(false)
	})

	test('drops discovered exits when the file no longer lists a manual one', async () => {
		await admitDiscovered(['http://8.8.8.8:8888'])
		expect(candidates().some((candidate) => candidate.tier === 'builtin')).toBe(true)
		await writeExits('')
		await loadPool()
		// The manual list is the user's file: emptying it must not leave the
		// discovered entries looking like the user's own choices.
		expect(candidates()).toHaveLength(1)
		expect(candidates()[0]?.tier).toBe('builtin')
	})
})
