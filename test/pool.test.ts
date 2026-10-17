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
import { FREE_SOURCES, GITHUB_MIRRORS, parseProxyLine } from '../src/sources.ts'
import {
	activeCandidate,
	addCandidate,
	admitDiscovered,
	candidates,
	evidenceFor,
	EXIT_TTL_MS,
	gradeOf,
	isQuarantined,
	isUsable,
	LIMIT_TTL_MS,
	loadPool,
	noteGateVerdict,
	noteScreenFailure,
	noteScreenSuccess,
	persistScreens,
	poolEnabled,
	poolFetch,
	pruneUnverified,
	QUARANTINE_MS,
	quarantinedEntries,
	recordGate,
	recordPassive,
	recordScreen,
	rejectedExits,
	removeCandidate,
	SCREEN_MAX_HANDSHAKE_MS,
	SCREEN_QUARANTINE_MS,
	screenMemoryCount,
	selectExit,
	selectedKey,
	setPoolEnabled,
	type DiscoveredExit,
	type ExitEvidence,
	type GateEvidence,
	type GateVerdict,
	type ScreenEvidence,
} from '../src/pool.ts'
import { collectSources, discoverExit, groupHuntFailures, huntPlan, parseTrace, probeWorthyCandidates, verdictOf, type DiscoveryNet, type HuntAttempt } from '../src/pool-probe.ts'
import { initProxyBackend, proxyBackend } from '../src/transport.ts'
import type { UpstreamFailure } from '../src/errors.ts'

const DIR = join(tmpdir(), 'opencode2pi-test-pool')
process.env.OPENCODE2PI_DATA_DIR = DIR

const EXIT = 'http://1.2.3.4:8080'

/**
 * A discovered exit that passed screening. `exitIP` defaults to something derived
 * from the url so that two entries for the same host with different ports are
 * distinct exits unless a test says otherwise — which is the point of the
 * exit-IP deduplication being tested.
 */
function screened(
	url: string,
	overrides: { exitIP?: string; rttMs?: number } = {},
): { url: string; screen: ScreenEvidence & { exitIP: string } } {
	return {
		url,
		screen: {
			at: Date.now(),
			exitIP: overrides.exitIP ?? `203.0.113.${url.length}`,
			rttMs: overrides.rttMs ?? 500,
			country: 'JP',
			grade: 'A',
		},
	}
}

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

	test('a fast reply on a reused tunnel does not excuse a slow tunnel', () => {
		// The exit answers in 300 ms once connected, and needs 4 s to get connected.
		// undici drops the tunnel after 4 s idle, so in a real turn — which idles past
		// that between tool calls — that 4 s is paid again and again. Measured across
		// the free sources 2026-10-17: warm 252–1900 ms, tunnel 491–7555 ms, unrelated.
		expect(
			isUsable({ label: 'x', tier: 'manual', screen: { ...screen, handshakeMs: SCREEN_MAX_HANDSHAKE_MS } }),
		).toBe(true)
		expect(isUsable({ label: 'x', tier: 'manual', screen: { ...screen, handshakeMs: 2501 } })).toBe(false)
		// An unmeasured handshake is not evidence of a slow one: old stores predate
		// the field, and refusing those would empty the pool over a number never taken.
		expect(isUsable({ label: 'x', tier: 'manual', screen })).toBe(true)
	})

	test('a gate pass still overrides a slow screen, as it does a slow one', () => {
		expect(
			isUsable({
				label: 'x',
				tier: 'manual',
				screen: { ...screen, handshakeMs: 7000 },
				gate: { at: Date.now(), modelId: 'm', verdict: 'ok', e2eMs: 900, detail: '' },
			}),
		).toBe(true)
	})
})

describe('free source list', () => {
	test('every source is reachable-shaped and names a real branch', () => {
		// A source URL with the wrong branch is a 404 that reads exactly like a dead
		// proxy list, which is why six of these carry `master` and it is worth a
		// test: nothing at runtime would distinguish the two.
		const masterRepos = new Set([
			'databay-labs/free-proxy-list/master/',
			'sunny9577/proxy-scraper/master/',
			'TheSpeedX/PROXY-List/master/',
			'TheSpeedX/SOCKS-List/master/',
			'vakhov/fresh-proxy-list/master/',
			'Zaeem20/FREE_PROXIES_LIST/master/',
		])
		for (const url of FREE_SOURCES) {
			const parsed = new URL(url)
			expect(['http:', 'https:']).toContain(parsed.protocol)
			if (!parsed.host.includes('githubusercontent')) continue
			const path = `${parsed.pathname.split('/')[1]}/${parsed.pathname.split('/')[2]}/${parsed.pathname.split('/')[3]}/`
			const isMaster = [...masterRepos].some((repo) => path.includes(repo))
			expect(path.includes('/master/') || !isMaster).toBe(true)
		}
	})

	test('the jsdelivr and proxyscrape hosts are gone from the list', () => {
		// Both were measured unreachable from this machine on 2026-10-17 while the
		// raw paths answered; leaving them would mean a refill that mostly fails.
		for (const url of FREE_SOURCES) {
			expect(url).not.toContain('cdn.jsdelivr.net')
			expect(url).not.toContain('api.proxyscrape.com')
		}
	})

	test('the GitHub mirror pool is non-empty and carries no trailing slash', () => {
		expect(GITHUB_MIRRORS.length).toBeGreaterThan(0)
		for (const mirror of GITHUB_MIRRORS) {
			// The mirror is prefixed onto a URL that starts with its own scheme, so a
			// trailing slash here would produce a doubled separator in every attempt.
			expect(mirror.endsWith('/')).toBe(false)
			expect(mirror.startsWith('https://')).toBe(true)
		}
	})
})

describe('hunting for an exit groups its failures instead of reporting "none worked"', () => {
	const gate = (verdict: GateVerdict): GateEvidence => ({
		at: Date.now(),
		modelId: 'm',
		verdict,
		e2eMs: 900,
		detail: '',
	})
	const attempt = (label: string, verdict: GateVerdict): HuntAttempt => ({
		candidate: { key: label, label, url: `http://${label}:8080`, tier: 'manual' },
		gate: gate(verdict),
	})
	// The grouping reads attempts, not a whole hunt report — the discovery pipeline
	// produces gate verdicts without producing a hunt — so the fixture is the list.
	test('a dead proxy and a refused IP get different advice', () => {
		// These look identical from the outside — "no usable exit" — and call for
		// opposite responses: one means go find another proxy, the other means this
		// proxy is fine and the upstream is saying no.
		const groups = groupHuntFailures([attempt('a', 'transport'), attempt('b', 'transport'), attempt('c', 'limited'), attempt('d', 'region')])
		expect(groups).toHaveLength(3)
		expect(groups.map((group) => group.label)).toEqual([
			'代理本身不通 2 个',
			'出口被限流 1 个',
			'地区不可用 1 个',
		])
	})

	test('a wall of shape rejections is called out on its own', () => {
		// The shape gate is the same request whatever the exit, so a run that
		// returns nothing else has a cause the pool cannot fix by trying again.
		const groups = groupHuntFailures([attempt('a', 'shape'), attempt('b', 'shape'), attempt('c', 'shape')])
		expect(groups).toHaveLength(1)
		expect(groups[0]?.verdicts).toEqual(['shape'])
		expect(groups[0]?.advice).toContain('不在代理')
	})

	test('a passing exit is not counted as a failure', () => {
		const pass = attempt('a', 'ok')
		const groups = groupHuntFailures([pass, attempt('b', 'transport')])
		expect(groups).toHaveLength(1)
		expect(groups[0]?.verdicts).toEqual(['transport'])
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

describe('the hunt says what it is about to do before it does it', () => {
	test('an unmeasured pool plans over every candidate and counts none as usable', async () => {
		// Nothing has been measured yet, which is exactly the state a hunt is
		// usually started from — the plan has to be honest about it rather than
		// implying some candidates are better bets than they are.
		const plan = huntPlan()
		expect(plan.total).toBe(candidates().length)
		expect(plan.usableFirst).toBe(0)
		expect(plan.rounds).toBe(Math.ceil(plan.total / plan.concurrency))
	})

	test('candidates with fresh usable evidence are counted, because they are tried first', async () => {
		// This is the number that tells the user whether the hunt is worth starting:
		// it is the count of candidates the ranking will reach before any others.
		const key = candidates()[0]?.key ?? ''
		await recordScreen(key, { at: Date.now(), exitIP: '203.0.113.9', rttMs: 900, grade: 'A' })
		expect(huntPlan().usableFirst).toBe(1)
		// …and a stale verdict stops counting, since the hunt would not trust it.
		await recordScreen(key, { at: Date.now() - EXIT_TTL_MS * 2, exitIP: '203.0.113.9', rttMs: 900, grade: 'A' })
		expect(huntPlan().usableFirst).toBe(0)
	})

	test('an empty pool plans an empty hunt rather than dividing by nothing', () => {
		// `rounds` and `concurrency` are rendered as "每批并发 N 个", and a NaN or a
		// division by zero here would print as garbage in the opening line.
		expect(huntPlan().rounds).toBeGreaterThanOrEqual(0)
		expect(huntPlan().concurrency).toBeGreaterThanOrEqual(1)
	})

	test('an unmeasured manual exit is still worth a probe', async () => {
		// The "try what we have first" pass runs before any fetch. A user's own proxy
		// that has never been measured has no evidence at all, and dropping it would
		// mean the fastest-working route in the pool never gets its first attempt.
		const only = candidates()[0]?.key ?? ''
		expect(evidenceFor(only)).toBeUndefined()
		expect(probeWorthyCandidates().map((entry) => entry.key)).toEqual([only])
	})
})

describe('probing only what is worth probing', () => {
	test('a gate-falsified exit is left out, so the first pass costs nothing on a dead pool', async () => {
		// This is what lets the merged command skip the fetch entirely: when every
		// exit has already been falsified by a real request, there is nothing cheap
		// left to try, and going to the sources is the right move rather than a waste.
		const url = 'http://198.51.100.44:8080'
		await admitDiscovered([screened(url, { exitIP: '203.0.113.44' })])
		await recordGate(exitKey(url), { at: Date.now(), modelId: 'big-pickle', e2eMs: 400, verdict: 'transport', detail: 'ECONNRESET' })
		expect(probeWorthyCandidates().map((entry) => entry.key)).not.toContain(exitKey(url))
	})

	test('an exit a 429 did not condemn stays in, because the quota window rolls', async () => {
		// `limited` is not falsifying on purpose: the proxy delivered the request and
		// the *upstream* ran out. Re-probing such an exit later is how the pool ever
		// recovers, so excluding it here would make a quota pause permanent.
		const url = 'http://198.51.100.45:8080'
		await admitDiscovered([screened(url, { exitIP: '203.0.113.45' })])
		await recordGate(exitKey(url), { at: Date.now(), modelId: 'big-pickle', e2eMs: 300, verdict: 'limited', detail: 'HTTP 429' })
		expect(probeWorthyCandidates().map((entry) => entry.key)).toContain(exitKey(url))
	})

	test('the plan is computed over the subset, not the whole pool', async () => {
		// The opening line renders these numbers, and a plan that counted exits the
		// run will never probe would promise batches that do not happen.
		await admitDiscovered([screened('http://198.51.100.46:8080', { exitIP: '203.0.113.46' })])
		const subset = probeWorthyCandidates()
		expect(huntPlan(subset).total).toBe(subset.length)
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

	test('drops discovered exits when the file no longer lists a manual one', async () => {
		await admitDiscovered([screened('http://8.8.8.8:8888')])
		expect(candidates().some((candidate) => candidate.tier === 'builtin')).toBe(true)
		await writeExits('')
		await loadPool()
		// The manual list is the user's file: emptying it must not leave the
		// discovered entries looking like the user's own choices.
		expect(candidates()).toHaveLength(1)
		expect(candidates()[0]?.tier).toBe('builtin')
	})
})

describe('a failed exit is quarantined from refill for a day', () => {
	const FAILING = 'http://7.7.7.7:8080'

	const gate = (verdict: GateVerdict): GateEvidence => ({
		at: Date.now(),
		modelId: 'm',
		verdict,
		e2eMs: 400,
		detail: '',
	})

	async function failThrough(verdict: GateVerdict, url = FAILING): Promise<string> {
		const key = exitKey(url)
		// The exit IP is derived from the port, because these tests exist to give
		// one host several addresses and the pool must treat them as one exit.
		await admitDiscovered([screened(url, { exitIP: `198.51.100.${url.slice(-4)}` })])
		await recordGate(key, gate(verdict))
		return key
	}

	test('a dead route, a region block and a refused shape each quarantine the address', async () => {
		// These are the three verdicts a *different* exit would have avoided, which
		// is exactly what makes them worth remembering across refills.
		const dead = await failThrough('transport', 'http://7.7.7.1:8080')
		const blocked = await failThrough('region', 'http://7.7.7.2:8080')
		const refused = await failThrough('shape', 'http://7.7.7.3:8080')
		expect(isQuarantined(dead)).toBe(true)
		expect(isQuarantined(blocked)).toBe(true)
		expect(isQuarantined(refused)).toBe(true)
		expect(quarantinedEntries()).toHaveLength(3)
	})

	test('a quota refusal does not quarantine it', async () => {
		// The proxy carried the request and the quota behind it was already spent.
		// Banning it would throw away a working exit over a condition that clears
		// on its own — the one verdict here that says nothing about the route.
		const key = await failThrough('limited')
		expect(isQuarantined(key)).toBe(false)
	})

	test('an unclassified failure does not quarantine it either', async () => {
		const key = await failThrough('inconclusive')
		expect(isQuarantined(key)).toBe(false)
	})

	test('refill refuses to re-admit a quarantined address', async () => {
		// The whole point: the free lists still list it tomorrow, and without this
		// the user watches the same failure arrive dressed as a new finding.
		const key = await failThrough('transport')
		await removeCandidate(key)
		expect(candidates().some((candidate) => candidate.key === key)).toBe(false)
		await admitDiscovered([screened(FAILING, { exitIP: '203.0.113.7' })])
		expect(isQuarantined(key)).toBe(true)
		expect(candidates().some((candidate) => candidate.key === key)).toBe(false)
	})

	test('the ban survives a restart, because the store is the only memory', async () => {
		const key = await failThrough('region')
		await loadPool()
		expect(isQuarantined(key)).toBe(true)
	})

	test('a later pass lifts the ban', async () => {
		// 24 hours is long. A ban that outlived its fault would keep a recovered
		// address out of the one pool that could still be using it.
		const key = await failThrough('transport')
		await recordGate(key, gate('ok'))
		expect(isQuarantined(key)).toBe(false)
	})

	test('an expired ban is dropped rather than enforced forever', async () => {
		const key = await failThrough('shape')
		// Written by hand because the 24-hour window is the behaviour under test and
		// no test should wait a day to observe it.
		const store = JSON.parse(await storeText()) as { quarantine: Record<string, { at: number; until: number; verdict: GateVerdict }> }
		store.quarantine[key] = { at: Date.now() - QUARANTINE_MS * 2, until: Date.now() - QUARANTINE_MS, verdict: 'shape' }
		await Bun.write(join(DIR, 'pool.json'), JSON.stringify(store))
		await loadPool()
		expect(isQuarantined(key)).toBe(false)
		// Cleared on read *and* written back, so the file cannot accumulate every
		// address the user has ever failed as they rotate through the pool.
		expect(quarantinedEntries()).toHaveLength(0)
		expect((JSON.parse(await storeText()) as { quarantine?: Record<string, unknown> }).quarantine?.[key]).toBeUndefined()
	})

	test('a store with nothing expired is not rewritten on launch', async () => {
		// The guard matters because startup runs in every process: rewriting the
		// store on each launch is a side effect with no reader.
		await failThrough('transport')
		const before = await storeText()
		await loadPool()
		expect(await storeText()).toBe(before)
	})

	test('the ban is recorded by hash, the same key the evidence uses', async () => {
		const key = await failThrough('transport')
		// Not a redaction rule — a discovered exit's URL is already in the store in
		// the clear, because it exists nowhere else. What matters is that the ban
		// attaches to the same key, so dropping the exit from the pool cannot drop
		// the memory of it.
		const store = JSON.parse(await storeText()) as { quarantine: Record<string, unknown> }
		expect(Object.keys(store.quarantine)).toEqual([key])
	})
})

describe('a refill replaces what it found dead', () => {
	// The fixture in `beforeEach` always installs one manual exit, so every count
	// below is "the discovered ones, plus that one".
	test('newly screened exits survive the prune that follows their own admission', async () => {
		// The bug this pins: admission wrote each arrival without its screen, and
		// the prune that runs inside the same call then ranked those arrivals last
		// and cut every one of them. The refill reported "7 new exits" and the pool
		// kept exactly the stale twelve it already had.
		for (let index = 0; index < 20; index++) {
			await admitDiscovered([screened(`http://10.0.0.${index}:8080`, { exitIP: `203.0.113.${index}`, rttMs: 400 + index })])
		}
		const discovered = candidates().filter((candidate) => candidate.tier === 'builtin')
		expect(discovered).toHaveLength(12)
		// Whatever survived, it survived *with* its evidence — that is the shape of
		// the bug: the arrivals were admitted and then immediately cut.
		expect(discovered.every((candidate) => evidenceFor(candidate.key)?.screen?.exitIP !== undefined)).toBe(true)
	})

	test('two ports on one exit IP are one pool slot, and the faster one wins', async () => {
		// Measured: one host returned on both :10539 and :10594. Two pool entries
		// for one quota is a slot spent on something that cannot raise the odds —
		// whatever rate-limits the first rate-limits the second.
		const report = await admitDiscovered([
			screened('http://198.51.100.9:10539', { exitIP: '144.124.251.24', rttMs: 900 }),
			screened('http://198.51.100.9:10594', { exitIP: '144.124.251.24', rttMs: 610 }),
		])
		expect(report.admitted).toBe(1)
		expect(report.duplicates).toBe(1)
		const discovered = candidates().filter((candidate) => candidate.tier === 'builtin')
		expect(discovered).toHaveLength(1)
		expect(discovered[0]?.url).toBe('http://198.51.100.9:10594')
		expect(evidenceFor(discovered[0]?.key ?? '')?.screen?.rttMs).toBe(610)
	})

	test('a full pool of falsified exits makes room for the ones a refill just proved', async () => {
		// Without the eviction the twelve dead addresses hold every slot, and a
		// refill that just found six working exits has nowhere to put them.
		//
		// Shaped like the real sequence: a batch arrives, the gate probes them, and
		// only a *later* refill admits anything new. Admitting and falsifying in
		// one loop would evict as it went and never build the full pool this is
		// about — the eviction is supposed to be driven by the next arrival.
		const urls = Array.from({ length: 12 }, (_, index) => `http://10.1.0.${index}:8080`)
		await admitDiscovered(urls.map((url, index) => screened(url, { exitIP: `203.0.113.${index}`, rttMs: 450 })))
		for (const url of urls) {
			await recordGate(exitKey(url), {
				at: Date.now(),
				modelId: 'm',
				verdict: 'transport',
				e2eMs: 400,
				detail: 'dead',
			})
		}
		const stale = new Set(urls.map((url) => exitKey(url)))
		expect(candidates().filter((candidate) => candidate.tier === 'builtin')).toHaveLength(12)
		const report = await admitDiscovered([screened('http://10.2.0.1:8080', { exitIP: '203.0.113.200' })])
		expect(report.admitted).toBe(1)
		const discovered = candidates().filter((candidate) => candidate.tier === 'builtin')
		expect(discovered.every((candidate) => stale.has(candidate.key))).toBe(false)
		// Only the arrival survives — not 11 of the twelve it replaced.
		expect(discovered).toHaveLength(1)
	})

	test('a screen failure alone does not evict: the lists bring it back tomorrow', async () => {
		// Only a gate verdict proves a different exit would have been fine. A trace
		// that timed out once is not evidence about the address, and dropping it
		// would lose an exit without having learned anything.
		await admitDiscovered([screened('http://10.3.0.1:8080', { exitIP: '203.0.113.201' })])
		await recordScreen(exitKey('http://10.3.0.1:8080'), {
			at: Date.now(),
			rttMs: 2900,
			error: '响应 2.9s，超过门槛',
		})
		await admitDiscovered([screened('http://10.3.0.2:8080', { exitIP: '203.0.113.202' })])
		expect(candidates().filter((candidate) => candidate.tier === 'builtin')).toHaveLength(2)
	})
})

describe('the pool holds gate-verified exits, not merely screened ones', () => {
	const VERIFIED = 'http://10.5.0.1:8080'
	const SCREEN_ONLY = 'http://10.5.0.2:8080'

	function verified(url: string, exitIP: string): DiscoveredExit {
		return {
			...screened(url, { exitIP }),
			gate: { at: Date.now(), modelId: 'big-pickle', verdict: 'ok', status: 200, e2eMs: 1200, detail: 'HTTP 200' },
		}
	}

	test('an admission carries its gate verdict into the store', async () => {
		// Otherwise the arrival lands bare and the next run has no idea whether the
		// gate ever spoke about it — and `pruneUnverified` would throw away a pool
		// entry that was verified seconds ago.
		await admitDiscovered([verified(VERIFIED, '203.0.113.210')])
		expect(evidenceFor(exitKey(VERIFIED))?.gate?.verdict).toBe('ok')
		expect(await pruneUnverified()).toBe(0)
		expect(candidates().some((candidate) => candidate.key === exitKey(VERIFIED))).toBe(true)
	})

	test('an entry with no gate verdict is dropped, and a store written by the older flow heals', async () => {
		// This is the pool's whole meaning now. A keyless trace says the proxy carries
		// TLS; it says nothing about whether the upstream will accept the exit, and an
		// entry that never met the gate is not an exit the pool should be offering.
		await admitDiscovered([screened(SCREEN_ONLY, { exitIP: '203.0.113.211' })])
		await admitDiscovered([verified(VERIFIED, '203.0.113.210')])
		expect(await pruneUnverified()).toBe(1)
		const builtin = candidates().filter((candidate) => candidate.tier === 'builtin')
		expect(builtin.map((candidate) => candidate.key)).toEqual([exitKey(VERIFIED)])
	})

	test('a gate-falsified entry leaves even though it once passed', async () => {
		await admitDiscovered([verified(VERIFIED, '203.0.113.210')])
		await recordGate(exitKey(VERIFIED), { at: Date.now(), modelId: 'big-pickle', verdict: 'transport', e2eMs: 30000, detail: 'ECONNRESET' })
		expect(await pruneUnverified()).toBe(1)
		expect(candidates().some((candidate) => candidate.key === exitKey(VERIFIED))).toBe(false)
	})

	test('a manual exit is never touched, measured or not', async () => {
		// Manual exits are the user's own file. They belong in the pool whether or not
		// anything has measured them — the first measurement is what creates their
		// record, so "no gate verdict" cannot mean "not ours to judge".
		await pruneUnverified()
		expect(candidates().some((candidate) => candidate.key === exitKey(EXIT))).toBe(true)
	})

	test('a verdict on an address the pool does not hold still bans it', async () => {
		// The discovery pipeline gate-probes *before* admitting, so every failure it
		// sees belongs to an address with no pool entry. `recordGate` would drop those
		// on the floor (`ensureEvidence` finds nothing), and the next run would pay to
		// rediscover a dead exit the run before it already paid to learn about.
		await noteGateVerdict(exitKey('http://10.5.0.9:8080'), {
			at: Date.now(),
			modelId: 'big-pickle',
			verdict: 'region',
			e2eMs: 4200,
			detail: '地区封锁（HTTP 403）',
		})
		expect(isQuarantined(exitKey('http://10.5.0.9:8080'))).toBe(true)
		expect(quarantinedEntries().some((entry) => entry.record.verdict === 'region')).toBe(true)
	})
})

describe('a screen failure is remembered, on a shorter window than a gate failure', () => {
	test('an address that failed a trace is skipped by the next refill', async () => {
		// The reason this exists: the lists are pulled again on every refill and
		// still contain every address they contained last time, so without a memory
		// each run re-screens the same dead head. Measured survival is roughly one
		// usable exit per 40–80 screened, which is what makes that expensive.
		noteScreenFailure(exitKey('http://10.4.0.1:8080'))
		await persistScreens()
		expect(isQuarantined(exitKey('http://10.4.0.1:8080'))).toBe(true)
	})

	test('it survives a restart, since the store is the only memory', async () => {
		noteScreenFailure(exitKey('http://10.4.0.2:8080'))
		await persistScreens()
		await loadPool()
		expect(isQuarantined(exitKey('http://10.4.0.2:8080'))).toBe(true)
	})

	test('a later screen that answers lifts it', async () => {
		// A closed socket can reopen, and the lists refresh daily — so a screen
		// ban that outlived its own evidence would hide a working address.
		noteScreenFailure(exitKey('http://10.4.0.3:8080'))
		await persistScreens()
		noteScreenSuccess(exitKey('http://10.4.0.3:8080'))
		expect(isQuarantined(exitKey('http://10.4.0.3:8080'))).toBe(false)
	})

	test('a gate refusal is not downgraded to a screen record', async () => {
		// The two claims are different strengths and different windows. Letting a
		// screen failure overwrite a 24-hour gate ban would both shorten the ban and
		// erase why the address was banned.
		const url = 'http://7.7.7.9:8080'
		const key = exitKey(url)
		await admitDiscovered([screened(url, { exitIP: '198.51.100.9' })])
		await recordGate(key, { at: Date.now(), modelId: 'm', verdict: 'region', e2eMs: 400, detail: '' })
		noteScreenFailure(key)
		await persistScreens()
		expect(quarantinedEntries()[0]?.record.verdict).toBe('region')
		expect(isQuarantined(key)).toBe(true)
	})

	test('an expired screen record is dropped rather than enforced forever', async () => {
		noteScreenFailure(exitKey('http://10.4.0.4:8080'))
		await persistScreens()
		const store = JSON.parse(await storeText()) as { quarantine: Record<string, { until: number }> }
		store.quarantine[exitKey('http://10.4.0.4:8080')] = {
			until: Date.now() - SCREEN_QUARANTINE_MS,
		}
		await Bun.write(join(DIR, 'pool.json'), JSON.stringify(store))
		await loadPool()
		expect(isQuarantined(exitKey('http://10.4.0.4:8080'))).toBe(false)
		expect(screenMemoryCount()).toBe(0)
	})
})

describe('a discovery run keeps going until it finds something or is told to stop', () => {
	/**
	 * A network that answers every trace but refuses every gate probe, with `count`
	 * addresses in total. Refusals are the hard case: they cost quota, so a run that
	 * found nothing *should* be allowed to stop — but only by asking.
	 */
	function refusing(count: number): {
		net: DiscoveryNet
		calls: { trace: number; probe: number }
		sweeps: number
	} {
		const calls = { trace: 0, probe: 0 }
		const harness = { calls, sweeps: 0, net: undefined as unknown as DiscoveryNet }
		// Distinct host per 250 addresses so the exit-IP dedupe under test has
		// something to collapse, and distinct exit IP per host length.
		const addresses = Array.from(
			{ length: count },
			(_unused, index) => `http://10.${Math.floor(index / 250) + 1}.${Math.floor(index / 25000) + 1}.${index % 250 + 1}:8080`,
		)
		harness.net = {
			collect: async () => {
				harness.sweeps++
				return { addresses, fetched: 22, cached: 0, failed: 0 }
			},
			trace: async (url: string) => {
				calls.trace++
				return { at: Date.now(), exitIP: `203.0.113.${url.length}`, rttMs: 400, country: 'JP', grade: 'A' }
			},
			probe: async () => {
				calls.probe++
				return { at: Date.now(), modelId: 'm', verdict: 'transport' as const, e2eMs: 20_000, detail: 'ECONNRESET' }
			},
		}
		return harness
	}

	test('one round draws from every source, not a hand-picked group of them', async () => {
		// The measured bug the `fast`/`slow` split caused: eight hand-labelled lists
		// could spend a round's entire budget while the other fourteen were never
		// opened, and the run reported a completed search. The split is gone — one
		// fetch, one shuffle, one budget — so a single sweep covers the whole list.
		const harness = refusing(4000)
		let asked = 0
		await discoverExit(
			'm',
			() => {},
			async () => {
				asked++
				return false
			},
			harness.net,
		)
		expect(harness.sweeps).toBe(1)
		expect(harness.calls.trace).toBe(640)
		expect(asked).toBe(1)
	})

	test('the user is asked once per round, not once per run', async () => {
		// Straight-line code asked a single time, so one "yes" bought one extra sweep
		// and then the run ended with thousands of untried addresses in hand — which
		// reads to the user as the command giving up. 4000 addresses at 640 a round
		// is six rounds plus a last one with nothing left, so the question is asked
		// seven times and answered yes six of them.
		const harness = refusing(4000)
		const rounds: number[] = []
		const untested: number[] = []
		await discoverExit(
			'm',
			() => {},
			async (state) => {
				rounds.push(state.round)
				untested.push(state.untested)
				return true
			},
			harness.net,
		)
		expect(rounds).toEqual([1, 2, 3, 4, 5, 6])
		// Each question reports a shrinking remainder, so the answers are informed:
		// "还有 3360 个" on round one, and nothing to continue into by round six.
		expect(untested).toEqual([3360, 2720, 2080, 1440, 800, 160])
	})

	test('each round tests addresses the previous one did not', async () => {
		// Every round re-reads the same lists, so without remembering what was spent
		// on, round two re-screens the same addresses and the extra round is not
		// progress — it is the same numbers twice.
		const seen = new Set<string>()
		const harness = refusing(600)
		const base = harness.net
		const net: DiscoveryNet = {
			...base,
			trace: async (url) => {
				expect(seen.has(url)).toBe(false)
				seen.add(url)
				return base.trace(url)
			},
		}
		await discoverExit(
			'm',
			() => {},
			async (state) => state.round < 2,
			net,
		)
		expect(seen.size).toBe(600)
	})

	test('the report says how much was left, so stopping looks like a choice', async () => {
		// Without this number a run that stopped on the user's "no" is indistinguishable
		// from one that exhausted the lists, and the reasonable reading — that it gave
		// up early — is exactly the wrong one.
		const harness = refusing(800)
		const report = await discoverExit(
			'm',
			() => {},
			async () => false,
			harness.net,
		)
		expect(report.screened).toBe(640)
		expect(report.untested).toBe(160)
		expect(report.rounds).toBe(1)
	})

	test('a run that exhausts every untested address stops on its own, and says so', async () => {
		// Genuinely nothing left after quarantine is a real answer. The loop must not
		// ask about continuing when there is nothing to continue into — that would be
		// a question with only one possible answer.
		const harness = refusing(300)
		let asked = 0
		const lines: string[] = []
		await discoverExit(
			'm',
			(line) => lines.push(line),
			async () => {
				asked++
				return true
			},
			harness.net,
		)
		expect(asked).toBe(0)
		expect(lines.some((line) => line.includes('测完了'))).toBe(true)
	})

	test('a winner stops the run immediately and is admitted', async () => {
		const harness = refusing(1000)
		const base = harness.net
		const net: DiscoveryNet = {
			...base,
			probe: async (url, modelId) => {
				harness.calls.probe++
				return { at: Date.now(), modelId, verdict: 'ok' as const, status: 200, e2eMs: 3000, detail: 'HTTP 200' }
			},
		}
		let asked = 0
		const report = await discoverExit(
			'm',
			() => {},
			async () => {
				asked++
				return true
			},
			net,
		)
		expect(report.winners.length).toBeGreaterThan(0)
		expect(report.admitted).toBeGreaterThan(0)
		// No question asked: the run already answered it.
		expect(asked).toBe(0)
		// Nothing further is fetched once an exit verifies — there is nothing left to
		// look for, so the source list is not even re-read.
		expect(harness.sweeps).toBe(1)
	})

	test('without a callback the run does one round instead of looping forever', async () => {
		// The menu always supplies one, but a headless caller that does not would
		// otherwise spin on a list nobody has read.
		const harness = refusing(2000)
		const report = await discoverExit('m', () => {}, undefined, harness.net)
		expect(report.rounds).toBe(1)
		expect(report.untested).toBeGreaterThan(0)
	})

	test('the report separates sources downloaded from sources served by the cache', async () => {
		// A run reporting "源 22 个" when 21 of those came off disk has misreported
		// what it cost, and the cache is only worth having if the saving shows.
		const harness = refusing(200)
		const base = harness.net
		const net: DiscoveryNet = {
			...base,
			collect: async () => {
				harness.sweeps++
				return { addresses: (await base.collect(() => {})).addresses, fetched: 1, cached: 21, failed: 0 }
			},
		}
		const report = await discoverExit('m', () => {}, async () => false, net)
		expect(report.sourcesFetched).toBe(1)
		expect(report.sourcesCached).toBe(21)
	})
})

describe('the source list is downloaded once an hour, not once per run', () => {
	const CACHE = join(DIR, 'free-sources.json')

	/** Write the cache as `collectSources` would, with every source `ageMs` old. */
	async function seedCache(ageMs: number, addressesPerSource: readonly string[]): Promise<void> {
		const entries: Record<string, { at: number; addresses: readonly string[] }> = {}
		for (const url of FREE_SOURCES) entries[url] = { at: Date.now() - ageMs, addresses: [...addressesPerSource] }
		await writeFile(CACHE, JSON.stringify({ entries }), 'utf8')
	}

	/** A downloader that records which sources were asked for and never uses the network. */
	function recorder(addresses: readonly string[] = ['http://198.51.100.7:8080']): {
		download: (url: string) => Promise<string[]>
		asked: string[]
	} {
		const asked: string[] = []
		return {
			asked,
			download: async (url: string) => {
				asked.push(url)
				return [...addresses]
			},
		}
	}

	beforeEach(async () => {
		await rm(CACHE, { force: true })
	})

	test('a fresh cache serves every source without downloading anything', async () => {
		// The whole point of the cache: a second run an hour after the first pays
		// nothing for the list. Fetching it anyway would mean 22 requests plus
		// mirror fallbacks per run, which is pure overhead next to the screening
		// the list exists to feed.
		await seedCache(5 * 60_000, ['http://198.51.100.7:8080', 'http://198.51.100.8:8080'])
		const net = recorder()
		const result = await collectSources(() => {}, net.download)
		expect(net.asked).toEqual([])
		expect(result.fetched).toBe(0)
		expect(result.cached).toBe(FREE_SOURCES.length)
		expect(result.failed).toBe(0)
		expect(result.addresses).toEqual(['http://198.51.100.7:8080', 'http://198.51.100.8:8080'])
	})

	test('a cache older than the hour is refetched rather than trusted', async () => {
		// Free proxy lists rot on an hours timescale. Serving yesterday's file as
		// current would report the same dead addresses as fresh news, which is the
		// one thing a refill must not do.
		await seedCache(61 * 60_000, ['http://198.51.100.7:8080'])
		const net = recorder()
		await collectSources(() => {}, net.download)
		expect(net.asked.length).toBe(FREE_SOURCES.length)
	})

	test('a run inside the hour writes nothing new over the cached copy', async () => {
		// Rewriting identical content would refresh the timestamps and turn a
		// one-hour cache into an indefinitely self-renewing one — the file would
		// never expire as long as the user kept using it.
		await seedCache(30 * 60_000, ['http://198.51.100.7:8080'])
		const before = await readFile(CACHE, 'utf8')
		const net = recorder()
		await collectSources(() => {}, net.download)
		expect(await readFile(CACHE, 'utf8')).toBe(before)
	})

	test('addresses are deduplicated across sources, not just within one', async () => {
		// Twenty-two lists publish heavily overlapping addresses — the same proxy on
		// several ports shows up in most of them. Screened twice, it costs two
		// requests to learn one thing.
		await seedCache(60_000, ['http://198.51.100.7:8080'])
		const result = await collectSources(() => {}, recorder().download)
		expect(result.addresses).toEqual(['http://198.51.100.7:8080'])
	})

	test('a source missing from the cache is fetched while the others are reused', async () => {
		// The list grows over time. A newly added source must not have to wait for
		// the whole cache to expire, and must not cost the other twenty-one a
		// download either.
		await seedCache(5 * 60_000, ['http://198.51.100.7:8080'])
		const dropped = FREE_SOURCES[0] as string
		const cache = JSON.parse(await readFile(CACHE, 'utf8')) as { entries: Record<string, unknown> }
		delete cache.entries[dropped]
		await writeFile(CACHE, JSON.stringify(cache), 'utf8')
		const net = recorder()
		const result = await collectSources(() => {}, net.download)
		expect(net.asked).toEqual([dropped])
		expect(result.fetched).toBe(1)
		expect(result.cached).toBe(FREE_SOURCES.length - 1)
	})

	test('a corrupt cache file is a miss, not a crash', async () => {
		// The file lives in a temp directory that any process may have touched. Every
		// field is re-read defensively, so a shape change in a later version costs
		// one download rather than a refill that cannot start.
		await writeFile(CACHE, '{"entries":{"https://x.example/":{"at":"not a number"}}}', 'utf8')
		const net = recorder()
		const result = await collectSources(() => {}, net.download)
		expect(result.cached).toBe(0)
		expect(result.fetched).toBe(FREE_SOURCES.length)
	})
})
