/**
 * Invariants for the custom-exit pool — the parts where being wrong is silent.
 *
 * Three of these are the reason the feature can exist at all:
 *
 *  · **Off means untouched.** `poolFetch` returns `undefined` while the pool is
 *    closed, and the caller then adds no `fetch` key at all. That is a property
 *    of the return value, so it is testable here instead of being a claim in a
 *    document.
 *  · **A credential never reaches the store.** Exits live in `exits.txt` and are
 *    re-read from it; `pool.json` addresses them by hash only. A user's
 *    `http://user:secret@host:port` line must not be copied into a second file.
 *  · **A quota refusal is not a dead exit.** The verdict mapping decides which
 *    failures falsify an exit, and a region block or a 429 means something about
 *    one model on one IP — not about the proxy being broken.
 *
 * The built-in tier is gone: only `exits.txt` can name an exit, and a store
 * written by the old scanner is migrated by dropping what it discovered.
 *
 * The data directory is redirected per test process, so the suite never touches
 * the user's real `exits.txt` or `pool.json` (see `OPENCODE2PI_DATA_DIR`).
 */

import { beforeEach, describe, expect, test } from 'bun:test'

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { exitKey, parseExitLines, parseProxyLine, redactAddress } from '../src/exits.ts'
import {
	activeCandidate,
	addCandidate,
	candidates,
	COMPLETION_TTL_MS,
	EXIT_TTL_MS,
	evidenceFor,
	hasVerified,
	isVerified,
	LIMIT_TTL_MS,
	loadPool,
	poolEnabled,
	poolFetch,
	recordCompletion,
	recordGate,
	recordPassive,
	rejectedExits,
	removeCandidate,
	selectExit,
	selectedKey,
	setPoolEnabled,
	type CompletionEvidence,
	type GateEvidence,
} from '../src/pool.ts'
import { verdictOf } from '../src/pool-probe.ts'
import { initProxyBackend, proxyBackend } from '../src/transport.ts'
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

function gate(overrides: Partial<GateEvidence> = {}): GateEvidence {
	return { at: Date.now(), modelId: 'big-pickle', verdict: 'ok', status: 200, e2eMs: 900, detail: 'HTTP 200', ...overrides }
}

function completion(overrides: Partial<CompletionEvidence> = {}): CompletionEvidence {
	return {
		at: Date.now(),
		modelId: 'big-pickle',
		verdict: 'ok',
		status: 200,
		e2eMs: 800,
		detail: '完成并返回 OK',
		received: 'OK',
		...overrides,
	}
}

/** Fresh directory, fresh module state: no test inherits another's selection. */
beforeEach(async () => {
	await rm(DIR, { recursive: true, force: true })
	// The transport has to know how this runtime proxies before `poolFetch` can
	// answer, and the suite runs under Bun — which is the `init.proxy` mechanism.
	await initProxyBackend()
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
		const parsed = parseExitLines('\uFEFF# comment\n\n   \n1.2.3.4:8080 # trailing\n; bye\n')
		expect(parsed.addresses).toEqual(['http://1.2.3.4:8080'])
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
		await recordCompletion(candidate?.key ?? '', completion())
		expect(await storeText()).not.toContain('secret')
		expect(evidenceFor(candidate?.key ?? '')?.label).not.toContain('secret')
	})
})

describe('only a completed answer verifies an exit', () => {
	test('a gate pass alone is not verification', async () => {
		await recordGate(exitKey(EXIT), gate())
		expect(isVerified(evidenceFor(exitKey(EXIT)))).toBe(false)
		expect(hasVerified()).toBe(false)
	})

	test('a fresh completion verifies, survives a reload, and is what hasVerified reads', async () => {
		await recordCompletion(exitKey(EXIT), completion())
		expect(isVerified(evidenceFor(exitKey(EXIT)))).toBe(true)
		expect(hasVerified()).toBe(true)
		await loadPool()
		expect(evidenceFor(exitKey(EXIT))?.completion?.received).toBe('OK')
	})

	test('a completion older than the verification window is shown but not trusted', async () => {
		await recordCompletion(exitKey(EXIT), completion({ at: Date.now() - COMPLETION_TTL_MS - 1 }))
		expect(evidenceFor(exitKey(EXIT))?.completion?.verdict).toBe('ok')
		expect(isVerified(evidenceFor(exitKey(EXIT)))).toBe(false)
	})

	test('a later real failure revokes it without deleting the context', async () => {
		await recordCompletion(exitKey(EXIT), completion())
		await selectExit(exitKey(EXIT))
		await setPoolEnabled(true)
		await recordPassive('big-pickle', 'RATE_LIMIT')
		const evidence = evidenceFor(exitKey(EXIT))
		expect(evidence?.completion?.verdict).toBe('ok')
		expect(isVerified(evidence)).toBe(false)
		expect(hasVerified()).toBe(false)
		// The quota mark and the failure share the same event, but one is the
		// per-model view and the other is the exit's verification state.
		expect(evidence?.modelMarks?.['big-pickle']?.kind).toBe('limited')
	})

	test('a new completion clears the previous real-failure suspicion', async () => {
		await selectExit(exitKey(EXIT))
		await setPoolEnabled(true)
		await recordPassive('big-pickle', 'TRANSPORT')
		expect(isVerified(evidenceFor(exitKey(EXIT)))).toBe(false)
		await recordCompletion(exitKey(EXIT), completion())
		expect(evidenceFor(exitKey(EXIT))?.lastFailure).toBeUndefined()
		expect(isVerified(evidenceFor(exitKey(EXIT)))).toBe(true)
	})

	test('a falsifying gate newer than the completion revokes it', async () => {
		await recordCompletion(exitKey(EXIT), completion())
		await recordGate(exitKey(EXIT), gate({ at: Date.now() + 1, verdict: 'region' }))
		expect(isVerified(evidenceFor(exitKey(EXIT)))).toBe(false)
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
		// Under Bun that mechanism is `init.proxy`. The Node half of the same
		// contract is asserted in transport.test.ts, against the dispatcher, so
		// neither runtime is only covered by the other's test.
		expect(proxyBackend()).toBe('bun')
		expect(seen.map((entry) => entry.proxy)).toEqual([EXIT, undefined, undefined, undefined])
	})

	test('attributes observed quota, region and transport failures to the active exit, and to nobody when closed', async () => {
		await selectExit(candidates()[0]?.key ?? '')
		await recordPassive('model-a', 'RATE_LIMIT')
		expect(evidenceFor(exitKey(EXIT))?.modelMarks).toBeUndefined()

		await setPoolEnabled(true)
		await recordPassive('model-a', 'RATE_LIMIT')
		await recordPassive('model-b', 'REGION_BLOCKED')
		await recordPassive('model-c', 'TRANSPORT')
		const marks = evidenceFor(exitKey(EXIT))?.modelMarks
		expect(marks?.['model-a']?.kind).toBe('limited')
		expect(marks?.['model-b']?.kind).toBe('region')
		expect(marks?.['model-c']?.kind).toBe('transport')
		expect(LIMIT_TTL_MS).toBeLessThan(EXIT_TTL_MS)
	})
})

describe('selection, persistence and removal', () => {
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

	test('removing the selected exit clears the selection and closes the pool', async () => {
		await addCandidate('9.9.9.9:3128')
		const key = candidates()[0]?.key ?? ''
		await selectExit(key)
		await setPoolEnabled(true)
		await removeCandidate(key)
		expect(selectedKey()).toBeNull()
		expect(poolEnabled()).toBe(false)
		expect(activeCandidate()).toBeUndefined()
		expect(poolFetch()).toBeUndefined()
		expect((await readFile(join(DIR, 'exits.txt'), 'utf8')).trim()).toBe('http://9.9.9.9:3128')
		expect(rejectedExits()).toEqual([])
	})

	test('removing the last exit leaves nothing that could keep the pool on', async () => {
		const key = candidates()[0]?.key ?? ''
		await selectExit(key)
		await setPoolEnabled(true)
		await removeCandidate(key)
		expect(candidates()).toHaveLength(0)
		expect(selectedKey()).toBeNull()
		expect(poolEnabled()).toBe(false)
		expect((await readFile(join(DIR, 'exits.txt'), 'utf8')).trim()).toBe('')
	})

	test('removing an unselected exit leaves the active route alone', async () => {
		await addCandidate('9.9.9.9:3128')
		const [first, second] = candidates()
		await selectExit(first?.key ?? '')
		await setPoolEnabled(true)
		await removeCandidate(second?.key ?? '')
		expect(selectedKey()).toBe(first?.key ?? null)
		expect(poolEnabled()).toBe(true)
		expect(activeCandidate()?.url).toBe(EXIT)
	})

	test('turning the pool off keeps the selection, but `activeCandidate` stops reporting it', async () => {
		// This is the trap `pool-cmd.ts` reads around: `active` is derived as
		// `store.enabled && selected`, so with the pool off it is undefined no matter
		// what the user picked. Using it to decide "is there an exit to turn on?"
		// made the direct-enable branch of `togglePool` unreachable — the menu could
		// only ever report "nothing selected" while the pool was off, which is the
		// one moment the selection matters most.
		await selectExit(candidates()[0]?.key ?? '')
		await setPoolEnabled(true)
		await setPoolEnabled(false)
		expect(selectedKey()).not.toBeNull()
		expect(activeCandidate()).toBeUndefined()
		// `poolFetch` is the other thing gated on `active`, and this is what that
		// means in practice: off, the host's own fetch is returned untouched.
		expect(poolFetch()).toBeUndefined()
	})

	test('a launch that changes nothing writes no store', async () => {
		// Users who never open the pool must not find a `pool.json` in their data
		// directory: the file is only created by an actual choice.
		await loadPool()
		expect(await Bun.file(join(DIR, 'pool.json')).exists()).toBe(false)
	})

	test('editing the file behind the menu drops the exit, its selection and the pool state', async () => {
		await selectExit(exitKey(EXIT))
		await setPoolEnabled(true)
		await writeExits('')
		await loadPool()
		expect(candidates()).toHaveLength(0)
		expect(selectedKey()).toBeNull()
		// An enabled pool with no selection is the one state that silently spends
		// the machine's own quota while the menu says the pool is on.
		expect(poolEnabled()).toBe(false)
		expect(poolFetch()).toBeUndefined()
	})
})

describe('a store written by the built-in scanner is migrated, not resurrected', () => {
	test('discovered evidence, screen state and source settings are dropped', async () => {
		const manualKey = exitKey(EXIT)
		const builtinKey = exitKey('http://8.8.8.8:8888')
		await writeFile(
			join(DIR, 'pool.json'),
			JSON.stringify({
				version: 2,
				probeVersion: 2,
				enabled: true,
				selected: builtinKey,
				evidence: {
					[manualKey]: { label: EXIT, tier: 'manual', gate: gate(), completion: completion() },
					[builtinKey]: {
						label: '8.8.8.8:8888',
						tier: 'builtin',
						url: 'http://8.8.8.8:8888',
						screen: { at: Date.now(), exitIP: '203.0.113.9', rttMs: 120 },
						gate: gate(),
						completion: completion(),
					},
				},
				disabledSources: ['https://example.invalid/list.txt'],
				quarantine: { [builtinKey]: { at: Date.now(), until: Date.now() + 60_000, verdict: 'transport' } },
			}),
			'utf8',
		)
		await loadPool()
		expect(candidates().map((candidate) => candidate.key)).toEqual([manualKey])
		expect(evidenceFor(builtinKey)).toBeUndefined()
		expect(isVerified(evidenceFor(manualKey))).toBe(true)
		// The selected exit no longer exists, so the pool must not stay "on".
		expect(selectedKey()).toBeNull()
		expect(poolEnabled()).toBe(false)
		const stored = await storeText()
		expect(stored).not.toContain('disabledSources')
		expect(stored).not.toContain('quarantine')
		expect(stored).not.toContain('builtin')
		expect(stored).toContain('"version":3')
	})
})

describe('gate verdict mapping', () => {
	test('only failures a different exit would have fixed falsify the exit', () => {
		const falsify: UpstreamFailure[] = ['SHAPE_REJECTED', 'REGION_BLOCKED']
		for (const kind of falsify) expect(['region', 'shape']).toContain(verdictOf(kind))
		// A 400 is the request's fault, a 5xx is upstream's, and a 429 is quota:
		// none of them says the proxy is broken.
		expect(verdictOf('REQUEST_REJECTED')).toBe('inconclusive')
		expect(verdictOf('UPSTREAM')).toBe('inconclusive')
		expect(verdictOf('MODEL_GONE')).toBe('inconclusive')
		expect(verdictOf('UNKNOWN')).toBe('inconclusive')
		expect(verdictOf('RATE_LIMIT')).toBe('limited')
		expect(verdictOf('AUTH')).toBe('shape')
	})
})
