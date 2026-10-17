/**
 * Measuring candidate exits.
 *
 * Two instruments, because there are two questions and only one of them costs
 * quota:
 *
 * 1. **Screen** ({@link screenExit}) — one `GET` to Cloudflare's `/cdn-cgi/trace`
 *    *through the candidate*. It needs no key, spends no Zen quota, and answers
 *    "does this proxy carry traffic at all, what exit IP does it present, how
 *    fast is it". A public free proxy list is mostly dead entries, so this is
 *    run over candidates in bulk and is the cheapest possible filter. The
 *    thresholds and the S/A/B/C grades come from opencode2dsh rather than from a
 *    fresh guess: they were tuned against the same free lists this file pulls
 *    from.
 *
 * 2. **Gate test** ({@link gateTestExit}) — the real gate-shaped streaming
 *    request through the candidate (gate.ts, same shape as the real path), for
 *    one model. This is the only measurement that can tell a good exit from an
 *    exit the anonymous lane refuses, because "refused" is decided upstream from
 *    the request's shape *and* its egress IP. It costs a little quota by
 *    construction, so it happens **once per switch**, on the one exit the user is
 *    about to adopt — never as a background sweep of the pool.
 *
 * Screening a public proxy list is not worker-exhaustive on purpose: the lists
 * are long, most entries are dead, and a handful of usable exits is as good as a
 * hundred. {@link refill} stops as soon as it has enough.
 */

import { classifyUpstreamFailure, type UpstreamFailure } from './errors.ts'
import { exitKey } from './exits.ts'
import { sendGateProbe } from './gate.ts'
import { currentLane } from './lanes.ts'
import {
	admitDiscovered,
	candidates,
	gradeOf,
	recordGate,
	recordScreen,
	SCREEN_MAX_RTT_MS,
	type ExitCandidate,
	type GateEvidence,
	type GateVerdict,
	type ScreenEvidence,
} from './pool.ts'
import { dedupeAddresses, FREE_SOURCES, parseProxyLine } from './sources.ts'

/** Keyless, no quota, and it reports the exit IP as the world sees it. */
const TRACE_URL = 'https://cloudflare.com/cdn-cgi/trace'
const SCREEN_TIMEOUT_MS = 8000
const SOURCE_TIMEOUT_MS = 10_000
/** Sources are independent hosts; a few at a time is polite and enough. */
const SOURCE_CONCURRENCY = 6
/** Free proxies are mostly dead sockets: screen wide, or the search never ends. */
const SCREEN_CONCURRENCY = 16
/** Enough screened candidates for one refill before giving up on the lists. */
const REFILL_TARGET = 6
const REFILL_SCREEN_BUDGET = 160
/** After two failures a source is skipped for a while. In-memory: advice, not truth. */
const SOURCE_COOLDOWN_MS = 10 * 60 * 1000
const SOURCE_FAILURE_LIMIT = 2

export interface TraceFields {
	readonly ip?: string
	readonly loc?: string
}

/** Parse `k=v` lines of a Cloudflare trace response. */
export function parseTrace(text: string): TraceFields {
	const fields: Record<string, string> = {}
	for (const line of text.split('\n')) {
		const separator = line.indexOf('=')
		if (separator <= 0) continue
		fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
	}
	return { ...(fields.ip ? { ip: fields.ip } : {}), ...(fields.loc ? { loc: fields.loc } : {}) }
}

/**
 * What the world sees when this process egresses through `proxyUrl`, or directly
 * when it is omitted.
 *
 * Never returns a rejection: a failure *is* the finding here, and it is recorded
 * in the result rather than thrown, because a candidate that cannot carry a
 * plain HTTPS request is a candidate the user needs to see fail.
 */
export async function traceEgress(proxyUrl?: string): Promise<ScreenEvidence> {
	const startedAt = Date.now()
	try {
		const response = await fetch(TRACE_URL, {
			signal: AbortSignal.timeout(SCREEN_TIMEOUT_MS),
			...(proxyUrl === undefined ? {} : { proxy: proxyUrl }),
		} as RequestInit)
		const rttMs = Date.now() - startedAt
		const at = Date.now()
		if (!response.ok) return { at, rttMs, error: `trace HTTP ${response.status}` }
		const fields = parseTrace(await response.text())
		if (fields.ip === undefined) return { at, rttMs, error: 'trace 响应里没有 ip 字段' }
		const seen = { at, rttMs, exitIP: fields.ip, ...(fields.loc ? { country: fields.loc } : {}) }
		if (rttMs > SCREEN_MAX_RTT_MS) {
			return { ...seen, error: `响应 ${(rttMs / 1000).toFixed(1)}s，超过 ${SCREEN_MAX_RTT_MS / 1000}s 门槛` }
		}
		return { ...seen, grade: gradeOf(rttMs) }
	} catch (error) {
		return { at: Date.now(), rttMs: Date.now() - startedAt, error: String(error) }
	}
}

/** Screen one candidate and keep the result. Returns it for the caller too. */
async function screenExit(candidate: ExitCandidate): Promise<ScreenEvidence> {
	const screen = await traceEgress(candidate.url)
	await recordScreen(candidate.key, screen)
	return screen
}

export interface ScreenSweep {
	readonly screened: number
	readonly usable: number
}

/**
 * Re-screen every candidate in the pool.
 *
 * This is the "refresh" action and costs nothing upstream, so it is one dialog
 * away at all times: public proxies die within hours, and a stored verdict from
 * this morning is not evidence about now.
 */
export async function screenAll(onProgress: (line: string) => void = () => {}): Promise<ScreenSweep> {
	const list = candidates()
	const queue = [...list]
	let screened = 0
	let usable = 0
	const workers = Array.from({ length: Math.min(SCREEN_CONCURRENCY, queue.length) }, async () => {
		for (;;) {
			const candidate = queue.shift()
			if (candidate === undefined) return
			const screen = await screenExit(candidate)
			screened++
			if (screen.error === undefined && screen.exitIP !== undefined) {
				usable++
				onProgress(`${candidate.label} → ${screen.exitIP}（${screen.country ?? '??'} · ${screen.grade ?? '?'} · ${screen.rttMs}ms）`)
			} else {
				onProgress(`${candidate.label} → ${screen.error ?? '屏检失败'}`)
			}
		}
	})
	await Promise.all(workers)
	return { screened, usable }
}

/**
 * Turn one upstream classification into a verdict about the exit.
 *
 * The interesting cases are the ones that must **not** falsify an exit: a 400 is
 * the model refusing the content, a 5xx is upstream, a model id the lane has
 * dropped is the roster's problem — none of those would have been fixed by a
 * different exit, and blaming the exit would throw away a working one.
 */
export function verdictOf(kind: UpstreamFailure): GateVerdict {
	switch (kind) {
		case 'RATE_LIMIT':
			return 'limited'
		case 'REGION_BLOCKED':
			return 'region'
		case 'SHAPE_REJECTED':
		case 'AUTH':
			return 'shape'
		case 'UNKNOWN':
		case 'UPSTREAM':
		case 'MODEL_GONE':
		case 'REQUEST_REJECTED':
			return 'inconclusive'
	}
}

/**
 * Run the gate probe for `modelId` through one candidate.
 *
 * The classification is the same one the real request path uses, so a verdict
 * here and a verdict at runtime cannot disagree about what a 403 meant — which
 * matters, because a region block is not a dead proxy and the pool must not
 * throw away a good exit over a block that only affects one model.
 */
export async function gateTestExit(candidate: ExitCandidate, modelId: string): Promise<GateEvidence> {
	const startedAt = Date.now()
	const probe = await sendGateProbe(modelId, currentLane(), candidate.url)
	const base = { at: Date.now(), modelId, e2eMs: Date.now() - startedAt }
	let evidence: GateEvidence
	if (probe.ok) {
		evidence = { ...base, status: probe.status, verdict: 'ok', detail: `HTTP ${probe.status}` }
	} else if (probe.transportError !== undefined) {
		evidence = { ...base, verdict: 'transport', detail: probe.transportError }
	} else {
		const { kind, summary } = classifyUpstreamFailure(probe.status, probe.body)
		evidence = { ...base, status: probe.status, verdict: verdictOf(kind), detail: `${summary}（HTTP ${probe.status}）` }
	}
	await recordGate(candidate.key, evidence)
	return evidence
}

export interface RefillReport {
	readonly sourcesAttempted: number
	readonly sourcesFailed: number
	readonly candidates: number
	readonly screened: number
	readonly admitted: number
	readonly usable: number
}

const sourceHealth = new Map<string, { failures: number; disabledAt: number }>()

/** Skip a source that just failed twice; two failures are almost always the host, not us. */
function sourceAvailable(url: string): boolean {
	const health = sourceHealth.get(url)
	return health === undefined || Date.now() - health.disabledAt > SOURCE_COOLDOWN_MS
}

function noteSourceFailure(url: string): void {
	const health = sourceHealth.get(url)
	const failures = (health?.failures ?? 0) + 1
	sourceHealth.set(url, { failures, disabledAt: failures >= SOURCE_FAILURE_LIMIT ? Date.now() : (health?.disabledAt ?? 0) })
}

function noteSourceSuccess(url: string): void {
	sourceHealth.delete(url)
}

async function fetchSource(url: string): Promise<string[]> {
	const response = await fetch(url, {
		signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
		headers: { accept: 'text/plain,*/*' },
		redirect: 'follow',
	})
	if (!response.ok) throw new Error(`HTTP ${response.status}`)
	const text = await response.text()
	const addresses: string[] = []
	for (const line of text.split('\n')) {
		const address = parseProxyLine(line)
		if (address !== null) addresses.push(address)
	}
	return addresses
}

/** Fetch every source of one tier, a few at a time, skipping sources in cooldown. */
async function collectAddresses(
	tier: 'fast' | 'slow',
	onProgress: (line: string) => void,
): Promise<{ addresses: readonly string[]; attempted: number; failed: number }> {
	const sources = FREE_SOURCES.filter((source) => source.tier === tier && sourceAvailable(source.url))
	const collected: string[] = []
	let attempted = 0
	let failed = 0
	const queue = [...sources]
	const workers = Array.from({ length: Math.min(SOURCE_CONCURRENCY, queue.length) }, async () => {
		for (;;) {
			const source = queue.shift()
			if (source === undefined) return
			attempted++
			try {
				const addresses = await fetchSource(source.url)
				noteSourceSuccess(source.url)
				collected.push(...addresses)
				onProgress(`源 ${source.url} → ${addresses.length} 个地址`)
			} catch (error) {
				failed++
				noteSourceFailure(source.url)
				onProgress(`源 ${source.url} 取用失败：${String(error)}`)
			}
		}
	})
	await Promise.all(workers)
	return { addresses: dedupeAddresses(collected), attempted, failed }
}

/**
 * Screen `urls` in parallel until {@link REFILL_TARGET} pass or the budget runs
 * out, then admit the ones that passed.
 *
 * Admitted set is deliberately "screened and alive", not "everything collected":
 * storing thousands of dead addresses would make the pool view useless and the
 * per-request candidate list long for no benefit.
 */
async function screenAndAdmit(
	urls: readonly string[],
	onProgress: (line: string) => void,
): Promise<{ screened: number; usable: readonly { url: string; screen: ScreenEvidence }[] }> {
	const queue = [...urls]
	const budget = Math.min(queue.length, REFILL_SCREEN_BUDGET)
	let screened = 0
	const usable: { url: string; screen: ScreenEvidence }[] = []
	const workers = Array.from({ length: Math.min(SCREEN_CONCURRENCY, budget) }, async () => {
		for (;;) {
			if (screened >= budget || usable.length >= REFILL_TARGET) return
			const url = queue.shift()
			if (url === undefined) return
			screened++
			const screen = await traceEgress(url)
			if (screen.error === undefined && screen.exitIP !== undefined) {
				usable.push({ url, screen })
				onProgress(`可用出口 ${screen.exitIP}（${screen.country ?? '??'} · ${screen.grade ?? '?'} · ${screen.rttMs}ms）`)
			}
		}
	})
	await Promise.all(workers)
	return { screened, usable }
}

/**
 * Pull the free lists and keep whatever screens clean.
 *
 * The order is fixed fast-then-slow, unlike opencode2dsh's random pick, because
 * the two tiers in sources.ts already encode "verified live upstream" versus
 * "long tail". Screened addresses are shuffled first: every refill sees the same
 * list order, so screening it in order would re-test the same dead head forever.
 */
export async function refill(onProgress: (line: string) => void = () => {}): Promise<RefillReport> {
	const attemptedAddresses: string[] = []
	let screens = 0
	const usable: { url: string; screen: ScreenEvidence }[] = []
	let sourcesAttempted = 0
	let sourcesFailed = 0

	for (const tier of ['fast', 'slow'] as const) {
		if (usable.length >= REFILL_TARGET) break
		onProgress(`拉取${tier === 'fast' ? '快速' : '慢速'}档免费源…`)
		const collected = await collectAddresses(tier, onProgress)
		sourcesAttempted += collected.attempted
		sourcesFailed += collected.failed
		attemptedAddresses.push(...collected.addresses)
		const result = await screenAndAdmit(shuffle(collected.addresses), onProgress)
		screens += result.screened
		usable.push(...result.usable)
	}

	const admitted = await admitDiscovered(usable.map((entry) => entry.url))
	// Screen evidence is keyed by candidate key and only kept for candidates that
	// exist, so it is written after admission, not while screening.
	for (const entry of usable) await recordScreen(exitKey(entry.url), entry.screen)
	return {
		sourcesAttempted,
		sourcesFailed,
		candidates: attemptedAddresses.length,
		screened: screens,
		admitted,
		usable: usable.length,
	}
}

function shuffle<T>(values: readonly T[]): T[] {
	return [...values]
		.map((value) => ({ value, key: Math.random() }))
		.sort((left, right) => left.key - right.key)
		.map((entry) => entry.value)
}
