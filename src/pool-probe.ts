/**
 * Measuring candidate exits.
 *
 * Two instruments, because there are two questions and only one of them costs
 * quota:
 *
 * 1. **Screen** ({@link traceEgress}) — one `GET` to Cloudflare's `/cdn-cgi/trace`
 *    *through the candidate*. It needs no key, spends no Zen quota, and answers
 *    "does this proxy carry traffic at all, what exit IP does it present, how
 *    fast is it". A public free proxy list is mostly dead entries, so this is
 *    run over candidates in bulk and is the cheapest possible filter. The
 *    thresholds and the S/A/B/C grades come from opencode2dsh rather than from a
 *    fresh guess: they were tuned against the same free lists this file pulls
 *    from.
 *
 * 2. **Gate test** ({@link probeGate}) — the real gate-shaped streaming request
 *    through the candidate (gate.ts, same shape as the real path), for one model.
 *    This is the only measurement that can tell a good exit from an exit the
 *    anonymous lane refuses, because "refused" is decided upstream from the
 *    request's shape *and* its egress IP. It costs a little quota by construction,
 *    so it runs on a **bounded** number of candidates and never over the whole
 *    pool.
 *
 * The order is the design, and it was the other way round until 2026-10-17. The
 * earlier flow screened a batch, collected six survivors, admitted them, and only
 * then probed — which made the user wait through a full screening batch to learn
 * whether anything they had was usable, and left the pool holding addresses that a
 * keyless trace had blessed and nothing else had. Now a screen that passes goes
 * straight to the gate ({@link discoverExit}), and **only what the gate accepts is
 * admitted**, so the pool means "exits that work" and the first usable exit ends
 * the run.
 *
 * Screening a public proxy list is not worker-exhaustive on purpose: the lists
 * are long, most entries are dead, and a handful of usable exits is as good as a
 * hundred. {@link discoverExit} stops as soon as one is verified.
 */

import { classifyUpstreamFailure, type UpstreamFailure } from './errors.ts'
import { exitKey, redactAddress } from './exits.ts'
import { sendCompletionProbe, sendGateProbe } from './gate.ts'
import { currentLane } from './lanes.ts'
import { SEED_MODELS } from './seed.ts'
import {
	admitDiscovered,
	candidates,
	disabledSources,
	evidenceFor,
	gradeOf,
	isQuarantined,
	isUsable,
	isVerified,
	noteCompletionVerdict,
	noteGateVerdict,
	noteScreenFailure,
	noteScreenSuccess,
	persistScreens,
	pruneUnverified,
	recordCompletion,
	recordGate,
	recordScreen,
	EXIT_TTL_MS,
	SCREEN_MAX_HANDSHAKE_MS,
	SCREEN_MAX_RTT_MS,
	selectedKey,
	type CompletionEvidence,
	type DiscoveredExit,
	type ExitCandidate,
	type GateEvidence,
	type GateVerdict,
	type ScreenEvidence,
} from './pool.ts'
import { dedupeAddresses, FREE_SOURCES, GITHUB_MIRRORS, parseProxyLine } from './sources.ts'
import { prefilterExit, type PrefilterResult } from './prefilter.ts'
import { readJson, writeJson } from './store.ts'
import { proxyBackend, proxyBackendNote, proxiedFetch } from './transport.ts'
import type { FetchLike } from './host/contract.ts'

/** Keyless, no quota, and it reports the exit IP as the world sees it. */
const TRACE_URL = 'https://cloudflare.com/cdn-cgi/trace'
/**
 * Per-request budget for screening, i.e. each of the two trace calls.
 *
 * Deliberately not the gate's 20 s. Screening and gate-probing answer different
 * questions and are paid for differently: screening runs wide over addresses that
 * already opened a CONNECT tunnel and asks only "can this socket carry a small HTTPS
 * request at all", while the gate spends one 20 s budget per *survivor* to see
 * whether a real model turn works. A slow gate verdict is the expensive kind of
 * wrong — it throws away an exit that works — so that one keeps its room.
 *
 * 5 s still clears both screening thresholds with headroom: RTT must land
 * ≤ {@link SCREEN_MAX_RTT_MS} (3 s) and the handshake ≤
 * {@link SCREEN_MAX_HANDSHAKE_MS} (2.5 s), so anything past 5 s was going to be
 * rejected on the number anyway and the request was only buying delay. Measured
 * 2026-10-17: of 160 screened free addresses, the ones that answered at all did
 * so in 0.3–2.9 s; nothing lived in the 5–8 s band this used to spend time on.
 */
const SCREEN_TIMEOUT_MS = 5000
const SOURCE_TIMEOUT_MS = 10_000
/** Sources are independent hosts; a few at a time is polite and enough. */
const SOURCE_CONCURRENCY = 6
/**
 * Workers per sweep, split by what each stage costs.
 *
 * The prefilter is one TCP connect and a CONNECT line, so its width is bounded by
 * the OS socket table, not by the upstream: measured at 254 addresses/s with 512
 * in flight, which turns the 4096-address round into sixteen seconds instead of
 * the sixty-five the old shared width of 128 produced. Only the addresses that
 * open a tunnel reach the screen, and the screen is a real TLS handshake and
 * HTTPS request through the proxy — 128 of those at once is already aggressive
 * against a free proxy, so the wider prefilter does not multiply the expensive
 * requests. Dead addresses leave after one TCP round-trip.
 */
const PREFILTER_CONCURRENCY = 512
const SCREEN_CONCURRENCY = 128
/**
 * Addresses one round may prefilter.
 *
 * One number for the whole run, over all eighteen sources at once. It used to
 * be 640, which was forty waves at the old width and made the user answer "keep
 * going?" every few minutes while tens of thousands of addresses remained. The
 * budget is what makes a round self-limiting, not what bounds the run; at the
 * measured 1.6% trace-pass rate this is roughly sixty full screens per round and
 * five rounds for the whole published list.
 */
const DISCOVERY_ROUND_BUDGET = 4096
/** After two failures a source is skipped for a while. In-memory: advice, not truth. */
const SOURCE_COOLDOWN_MS = 10 * 60 * 1000
const SOURCE_FAILURE_LIMIT = 2

/**
 * How long a downloaded source list is reused before it is fetched again.
 *
 * Fetching all eighteen sources costs eighteen requests, four mirrors' worth
 * of fallback attempts, and up to {@link SOURCE_TIMEOUT_MS} per host that is
 * merely slow — tens of seconds in the worst case, paid again on every single
 * run, to fetch lists that change a few times a day at most. Meanwhile the
 * addresses inside them are what get screened, and screening one is the thing
 * that actually costs time. So the download is cached and the screening is not:
 * an hour-old list still describes a live proxy population, and within that
 * hour the run can reach screening without touching the network at all.
 *
 * An hour rather than "the whole session" because free proxy lists rot on a
 * timescale of hours, and a run that kept re-screening the same frozen file
 * would report the same dead addresses as fresh news.
 */
const SOURCE_CACHE_TTL_MS = 60 * 60 * 1000
/** Where the cached lists live. Part of the data dir, so it dies with the rest of the cache. */
const SOURCE_CACHE_FILE = 'free-sources.json'

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
 *
 * The proxy goes through {@link proxiedFetch} rather than an `init.proxy` of its
 * own, and that is not tidiness — it is the whole measurement. Screening has to
 * travel the identical path the real request will, on the same runtime, or the
 * verdict describes a different route than the one traffic takes. Measured
 * consequence of getting this wrong: on pi under Node every candidate screened
 * as "usable", because `init.proxy` was ignored and the probe was really testing
 * the machine's own address — six exits including a US one all reported the
 * same exit IP, and the pool adopted that as evidence.
 *
 * When the runtime offers no proxy mechanism at all, the probe reports the
 * direct result and says so, rather than quietly screening the local route and
 * letting the caller record it as a property of the exit.
 */
export async function traceEgress(proxyUrl?: string): Promise<ScreenEvidence> {
	const startedAt = Date.now()
	try {
		const via = proxyUrl === undefined ? globalThis.fetch : proxiedFetch(proxyUrl)
		if (proxyUrl !== undefined && via === undefined) {
			return {
				at: Date.now(),
				rttMs: Date.now() - startedAt,
				error:
					proxyBackend() === 'unresolved'
						? '代理机制尚未初始化（扩展启动流程被绕过），屏检中止'
						: `本运行时没有可用的代理机制（${proxyBackendNote()}），屏检中止`,
			}
		}
		const response = await (via ?? globalThis.fetch)(TRACE_URL, {
			signal: AbortSignal.timeout(SCREEN_TIMEOUT_MS),
		})
		const rttMs = Date.now() - startedAt
		const at = Date.now()
		if (!response.ok) return { at, rttMs, error: `trace HTTP ${response.status}` }
		const fields = parseTrace(await response.text())
		if (fields.ip === undefined) return { at, rttMs, error: 'trace 响应里没有 ip 字段' }
		const seen = { at, rttMs, exitIP: fields.ip, ...(fields.loc ? { country: fields.loc } : {}) }
		if (rttMs > SCREEN_MAX_RTT_MS) {
			return { ...seen, error: `响应 ${(rttMs / 1000).toFixed(1)}s，超过 ${SCREEN_MAX_RTT_MS / 1000}s 门槛` }
		}

		// Second probe, same connection. Only reached by an exit that just answered,
		// so the dead ones — 153 of 160 in the measured sweep — still cost one request.
		//
		// The purpose is to separate two costs that a single measurement merges: what
		// the exit is like to talk to, and what building the tunnel cost. Measured
		// across the free sources 2026-10-17, these are unrelated numbers: of 7 exits
		// that carried traffic, warm RTT was 252–1900 ms while the tunnel itself cost
		// 491–7555 ms. One proxy was faster than another on the wire and still slower
		// to set up by 7 seconds.
		//
		// Why the tunnel cost is the one that decides usability: undici keeps a tunnel
		// alive for 4 s of idle and no longer (measured — 1 s idle reused, 3 s reused,
		// 6 s and 10 s did not, and the requests that re-established paid the full cost
		// again). An agentic turn idles far longer than 4 s between requests — model
		// thinking, tool execution, a human typing — so the cold cost is what a real
		// conversation pays, repeatedly, and not once.
		const handshakeMs = await measureWarm(via ?? globalThis.fetch)
		const graded = { ...seen, ...(handshakeMs === undefined ? {} : { handshakeMs }) }
		if (handshakeMs !== undefined && handshakeMs > SCREEN_MAX_HANDSHAKE_MS) {
			return { ...graded, error: `握手 ${(handshakeMs / 1000).toFixed(1)}s，超过 ${SCREEN_MAX_HANDSHAKE_MS / 1000}s 门槛` }
		}
		return { ...graded, grade: gradeOf(rttMs) }
	} catch (error) {
		return { at: Date.now(), rttMs: Date.now() - startedAt, error: String(error) }
	}
}

/**
 * A second request on the already-open tunnel, or `undefined` when it could not be
 * measured. Absent is not a pass: the caller simply has no handshake figure, and
 * the thresholds are applied to what was measured.
 *
 * This reuses whatever connection the first request left behind, which is the point
 * — the runtime's transport, not a hand-rolled socket, because a hand-rolled one
 * would measure a tunnel the real path never builds.
 */
async function measureWarm(via: FetchLike): Promise<number | undefined> {
	try {
		const startedAt = Date.now()
		const response = await via(TRACE_URL, { signal: AbortSignal.timeout(SCREEN_TIMEOUT_MS) })
		const elapsed = Date.now() - startedAt
		await response.body?.cancel()
		return response.ok ? elapsed : undefined
	} catch {
		return undefined
	}
}

/** The tunnel cost in a progress line, next to the RTT it is easily confused with. */
function handshakeNote(screen: ScreenEvidence): string {
	return screen.handshakeMs === undefined ? '' : ` · 握手 ${screen.handshakeMs}ms`
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
 * Run the gate probe for `modelId` through one address, without recording it.
 *
 * Deliberately unrecorded: the discovery pipeline probes an address **before** the
 * pool holds it, and {@link noteGateVerdict} decides what a verdict means for an
 * address that is not a member (a ban) versus one that is (evidence on its entry).
 * Folding that recording into the probe would force one of the two to be skipped.
 */
export async function probeGate(url: string, modelId: string): Promise<GateEvidence> {
	const startedAt = Date.now()
	const probe = await sendGateProbe(modelId, currentLane(), url)
	const base = { at: Date.now(), modelId, e2eMs: Date.now() - startedAt }
	if (probe.ok) return { ...base, status: probe.status, verdict: 'ok', detail: `HTTP ${probe.status}` }
	if (probe.transportError !== undefined) return { ...base, verdict: 'transport', detail: probe.transportError }
	const { kind, summary } = classifyUpstreamFailure(probe.status, probe.body)
	return { ...base, status: probe.status, verdict: verdictOf(kind), detail: `${summary}（HTTP ${probe.status}）` }
}

/**
 * Run the gate probe for `modelId` through one pool member, and record it.
 *
 * The classification is the same one the real request path uses, so a verdict
 * here and a verdict at runtime cannot disagree about what a 403 meant — which
 * matters, because a region block is not a dead proxy and the pool must not
 * throw away a good exit over a block that only affects one model.
 */
export async function gateTestExit(candidate: ExitCandidate, modelId: string): Promise<GateEvidence> {
	const evidence = await probeGate(candidate.url, modelId)
	await recordGate(candidate.key, evidence)
	return evidence
}

/**
 * Read a real turn through one address, without recording it.
 *
 * The gate stage asks "will upstream accept this exit"; this stage asks "can a
 * completion travel through it". They are different questions and the pool used
 * to answer only the first, which is why a ✅ could fail the next real turn.
 *
 * A 200 with an in-band error is classified with the same `classifyUpstreamFailure`
 * the request path uses: the status alone would call a `FreeTierError` delivered
 * inside an SSE stream an unknown 200.
 */
export async function probeCompletion(url: string, modelId: string): Promise<CompletionEvidence> {
	const startedAt = Date.now()
	const probe = await sendCompletionProbe(modelId, currentLane(), url)
	const base = { at: Date.now(), modelId, e2eMs: Date.now() - startedAt }
	if (probe.transportError !== undefined) return { ...base, verdict: 'transport', detail: probe.transportError }
	if (probe.matched === true) {
		return {
			...base,
			...(probe.status === undefined ? {} : { status: probe.status }),
			verdict: 'ok',
			detail: `完成并返回 OK · ${probe.latencyMs}ms`,
			...(probe.completion === undefined ? {} : { received: probe.completion }),
		}
	}
	if (probe.status !== undefined && probe.status >= 400) {
		const { kind, summary } = classifyUpstreamFailure(probe.status, probe.body)
		return { ...base, status: probe.status, verdict: verdictOf(kind), detail: `${summary}（HTTP ${probe.status}）` }
	}
	if (probe.completion === undefined) {
		// 200, but the stream carried an error or closed with nothing. The text is
		// classified because upstream failures also arrive inside a 200 stream.
		const { kind, summary } = classifyUpstreamFailure(probe.status, probe.body)
		return {
			...base,
			...(probe.status === undefined ? {} : { status: probe.status }),
			verdict: verdictOf(kind),
			detail: probe.body === '' ? '流在返回内容前结束' : summary,
		}
	}
	return {
		...base,
		...(probe.status === undefined ? {} : { status: probe.status }),
		verdict: 'inconclusive',
		detail: `完成但未返回 OK：${probe.completion.slice(0, 60)}`,
		received: probe.completion,
	}
}

/** Run the completion probe through a pool member, and record it. */
export async function completionTestExit(candidate: ExitCandidate, modelId: string): Promise<CompletionEvidence> {
	const completion = await probeCompletion(candidate.url, modelId)
	await recordCompletion(candidate.key, completion)
	return completion
}

/**
 * Verify one candidate end to end: gate first, completion only if the gate passed.
 *
 * The order is a cost decision, not a formality. A dead proxy and a region block
 * are cheap to detect from the status line; reading their stream to completion
 * spends the same request again and learns nothing. A fresh gate `ok` is reused
 * so re-verifying a known exit costs one completion rather than two requests.
 */
export async function verifyExit(
	candidate: ExitCandidate,
	modelId: string,
): Promise<{ gate: GateEvidence; completion?: CompletionEvidence }> {
	const known = evidenceFor(candidate.key)?.gate
	const gate =
		known?.verdict === 'ok' && Date.now() - known.at <= EXIT_TTL_MS
			? known
			: await gateTestExit(candidate, modelId)
	if (gate.verdict !== 'ok') return { gate }
	return { gate, completion: await completionTestExit(candidate, modelId) }
}

/**
 * What one discovery run did, in enough detail to explain a run that found nothing.
 *
 * `winners` is a list rather than a single winner on purpose. Probes run four-wide,
 * so the run that finds the first usable exit usually has up to three more in
 * flight; those finish, they pass or fail on their own merits, and the ones that
 * pass are admitted too. That is where the pool's reserve comes from — one run
 * banks a few verified exits, and the next run spends nothing to re-find them.
 */
export interface DiscoveryReport {
	/** Sources downloaded over the network this run. */
	readonly sourcesFetched: number
	/**
	 * Sources served from the local cache instead of being downloaded. A run with
	 * a high number here did not pay for its address list, which is the whole point
	 * of caching it: the screening still costs the same, but the twenty-odd
	 * requests (plus mirror fallbacks) that produce the list do not repeat.
	 */
	readonly sourcesCached: number
	readonly sourcesFailed: number
	readonly candidates: number
	/** Addresses this run attempted the tunnel prefilter (or the screen, in fixtures without one) on. */
	readonly screened: number
	/** Of {@link screened}, the ones that opened a CONNECT tunnel and reached the full screen. */
	readonly prefilterPassed: number
	/** Addresses a trace answered for, and which therefore earned a gate probe. */
	readonly screenPassed: number
	/** Quota spent on gate probes. */
	readonly gateProbed: number
	/** Quota spent on real completions (the stage that decides admission). */
	readonly completionProbed: number
	/** How many completed exits this run was asked to find. */
	readonly target: number
	/** Why the run stopped, so "found nothing" is not confused with "gave up". */
	readonly stopReason: DiscoveryStopReason
	/** Verified exits that landed in the pool this run, winner and extras alike. */
	readonly admitted: number
	/**
	 * Screen passes skipped because their exit IP is already in the pool. Kept
	 * separate from {@link screenPassed} because a list returning many ports per host
	 * would otherwise report a healthy-looking count for what is really one exit
	 * sharing one quota.
	 */
	readonly duplicates: number
	/** Addresses held back because they failed recently. */
	readonly skippedQuarantined: number
	/**
	 * Fresh addresses the sources still hold that this run never reached — stopped
	 * early by the target, the completion budget, the user, or cancellation, not by
	 * the lists running dry. This is the number that separates "there was nothing
	 * left to try" from "we stopped looking", and a finished run that leaves it at
	 * zero has to say so itself rather than implying the lists were empty.
	 */
	readonly untested: number
	/**
	 * How many rounds ran. Each round is one sweep of every tier plus one question,
	 * so this is also how many times the user was asked whether to keep going.
	 */
	readonly rounds: number
	/** Every gate verdict this run produced, for grouping when nothing passed. */
	readonly attempts: readonly HuntAttempt[]
	/** Verified exits, fastest first. Empty means the run found nothing usable. */
	readonly winners: readonly HuntAttempt[]
}

/** `budget` is the completion-probe cap, not a wall-clock limit. */
export type DiscoveryStopReason = 'target' | 'exhausted' | 'budget' | 'cancelled' | 'user' | 'error'

/** The default number of completed exits a scan aims to bank. */
export const SCAN_TARGET = 3
/**
 * Model used to verify exits. `big-pickle` is OpenCode's default free model and
 * the one upstream is most likely to keep serving; the fallback exists only so a
 * roster change does not break the pool outright.
 */
export const SCAN_MODEL =
	SEED_MODELS.find((model) => model.id === 'big-pickle')?.id ?? SEED_MODELS[0]?.id ?? 'big-pickle'
/**
 * Real completions allowed per desired exit. Four leaves room for dead proxies
 * without letting one unlucky sweep consume the whole quota.
 */
export const COMPLETION_BUDGET_FACTOR = 4

/** Mutable totals carried across every tier of every round of one discovery run. */
interface DiscoveryState {
	/** Addresses the prefilter or trace was actually attempted on. */
	screened: number
	/** Addresses that opened a CONNECT tunnel and moved on to the full screen. */
	prefilterPassed: number
	screenPassed: number
	gateProbed: number
	completions: number
	duplicates: number
	skipped: number
	announcedSkip: boolean
	/** Completed exits the run is trying to reach. */
	target: number
	/** Upper bound on real completions, so a pathological source cannot spend forever. */
	completionBudget: number
	/** Exit IPs already spoken for, seeded from the pool and grown by each winner. */
	claimed: Set<string>
	/** Candidates the caller asked the run not to touch (the active exit, typically). */
	skip: Set<string>
	aborted: () => boolean
	/** Gate probes allowed in flight at once. */
	slots: Semaphore
	attempts: HuntAttempt[]
	winners: HuntAttempt[]
	verified: DiscoveredExit[]
	/**
	 * Every address a source has handed over this run that was not already
	 * quarantined — i.e. genuinely available to screen.
	 */
	offered: Set<string>
	/** Of {@link offered}, the ones a trace was actually spent on. */
	reached: Set<string>
	/** Rounds completed so far. */
	rounds: number
}

/**
 * A counting semaphore, because the gate probes are the quota-spending kind and
 * need their own ceiling while screening stays wide.
 *
 * The screen workers are deliberately *not* gated by it: they are what finds the
 * candidates, and throttling discovery to the gate's rate would make the whole run
 * as slow as the slowest probe.
 */
class Semaphore {
	private free: number
	private readonly waiting: (() => void)[] = []
	constructor(size: number) {
		this.free = size
	}
	async acquire(): Promise<void> {
		if (this.free > 0) {
			this.free--
			return
		}
		await new Promise<void>((resolve) => this.waiting.push(resolve))
	}
	release(): void {
		const next = this.waiting.shift()
		// Handing the slot straight to the next waiter rather than incrementing and
		// letting it race for the count: otherwise a release can be stolen between
		// the two steps and the ceiling is briefly exceeded.
		if (next === undefined) this.free++
		else next()
	}
}

/**
 * How many exits to probe at once when hunting for a usable one.
 *
 * Concurrent because serial does not work here: a gate probe costs a fraction of a
 * second on a live exit but the full 20 s budget on a dead one, and the discovery
 * pipeline has no idea which of the addresses a screen just passed will be which.
 * Serial probing would make the wait for the first answer as long as the sum of
 * every failure before it.
 *
 * 8 rather than "all of them" because these spend real quota and open real
 * tunnels, and the point is to stop at the first hit — running every screen-pass at
 * once would spend quota on candidates the user never needed measured. It is also
 * the ceiling on how many spare verified exits a single discovery run can bank:
 * once the winner lands, the probes already in flight still finish, and those are
 * exactly the extras the next run gets to try first. It was 4 while a round only
 * produced a handful of survivors; a 4096-address round produces ten times that,
 * so the old ceiling turned the 20 s bad-candidate budget into five minutes of
 * waiting after the cheap stage had already finished.
 */
const HUNT_CONCURRENCY = 8

/** Verdict marks, defined here so the probe and the menu cannot drift apart. */
export const GATE_MARK: Readonly<Record<GateVerdict, string>> = {
	ok: '✅',
	limited: '🚧',
	region: '🌏',
	shape: '⛔',
	transport: '📡',
	inconclusive: '❔',
}

/**
 * Marks for the completion stage. `ok` is the only ✅: a gate pass shares the
 * same table but proves less, which is why the two stages must not look alike.
 */
export const COMPLETION_MARK: Readonly<Record<GateVerdict, string>> = {
	ok: '✅',
	limited: '🚧',
	region: '🌏',
	shape: '⛔',
	transport: '📡',
	inconclusive: '❔',
}

/** One candidate's outcome in a hunt, kept with the candidate that produced it. */
export interface HuntAttempt {
	readonly candidate: ExitCandidate
	readonly gate: GateEvidence
	/** Present when the gate passed and the completion probe ran. */
	readonly completion?: CompletionEvidence
}

/** Did this attempt verify the exit? Only a completed `OK` does. */
export function attemptVerified(attempt: HuntAttempt): boolean {
	return attempt.completion?.verdict === 'ok'
}

/**
 * What a hunt is about to do, reported before any of it happens.
 *
 * This exists because silence at the start reads as a hang. The hunt's first
 * probe is a tunnel through a proxy that may well be dead, so on the pool's own
 * numbers the first line of feedback can be six seconds away — long enough that
 * a user who has seen nothing conclude the command did not register. Saying the
 * size and shape of the job up front costs one line and answers "is this even
 * doing anything".
 */
export interface HuntPlan {
	/** Candidates that will be probed, i.e. everything the hunt might reach. */
	readonly total: number
	/** How many of those already carry usable evidence, and so are tried first. */
	readonly usableFirst: number
	/** How many will be in flight at once. */
	readonly concurrency: number
	/** Rounds this will take if nothing passes early. */
	readonly rounds: number
}

export interface HuntProgress {
	readonly attempt: HuntAttempt
	/** 1-based position within the whole hunt. */
	readonly index: number
	readonly total: number
	/** Candidates deliberately not probed because an earlier one answered. */
	readonly remaining: number
}

export interface HuntReport {
	readonly attempts: readonly HuntAttempt[]
	/** The first exit that passed, or `undefined` when none did. */
	readonly winner: HuntAttempt | undefined
	/** How many candidates were never probed, because an earlier one answered. */
	readonly skipped: number
	/** The plan this run followed, echoed back so the caller can label its output. */
	readonly plan: HuntPlan
}

/** How many candidates already look usable — the ones the hunt will reach first. */
export function huntPlan(only: readonly ExitCandidate[] = candidates()): HuntPlan {
	const usable = only.filter((candidate) => isUsable(evidenceFor(candidate.key))).length
	return {
		total: only.length,
		usableFirst: usable,
		concurrency: Math.min(HUNT_CONCURRENCY, Math.max(only.length, 1)),
		rounds: Math.ceil(only.length / HUNT_CONCURRENCY),
	}
}

/**
 * The candidates worth a quota probe right now: the ones already carrying usable
 * evidence.
 *
 * This is what makes "try what we have, then go fetch more" cost the right amount.
 * The alternative — probe everything in the pool — spends a real request per
 * candidate on exits with no reason to expect them to work, and each one costs up
 * to the full gate budget when the proxy is dead. Filtering by {@link isUsable}
 * first means an empty result is a cheap, meaningful answer ("nothing here is
 * worth measuring") rather than an expensive one, and it is what lets the caller
 * skip the fetch entirely when the pool has nothing to offer.
 *
 * Manual exits are included even with no evidence at all: they are the user's own
 * routes, they are what the pool exists to fall back to, and their first
 * measurement is the one that creates their record (`ensureEvidence`).
 */
export function probeWorthyCandidates(): readonly ExitCandidate[] {
	return candidates().filter((candidate) => {
		const evidence = evidenceFor(candidate.key)
		return evidence === undefined || isUsable(evidence)
	})
}

/**
 * Probe candidates until one passes, then stop.
 *
 * Stopping is the entire point. A hunt exists because picking from a menu means
 * probing the ones the user did not pick, and every probe spends a sliver of the
 * anonymous quota — so once an exit is known good there is nothing left to learn
 * from the rest.
 *
 * `onProgress` fires per verdict so the caller can show progress; there is no
 * attempt this hides, and each one carries its position because a hunt over a
 * dozen candidates is long enough that "which one am I on" is a real question.
 * The report keeps every attempt because the failures are themselves evidence: an
 * exit falsified by a transport error is worth knowing about, and a run where
 * everything came back `shape` says something quite different from one where
 * everything was a dead socket.
 */
export async function huntUsableExit(
	modelId: string,
	onProgress: (progress: HuntProgress) => void = () => {},
	overrides?: readonly ExitCandidate[],
): Promise<HuntReport> {
	// Order is the user's evidence, already ranked: `candidates()` puts manual
	// exits first in file order, then discovered exits by usability then latency.
	// Probing the best-measured ones first is what makes the early stop pay off.
	const ordered = [...(overrides ?? candidates())]
	const attempts: HuntAttempt[] = []
	let winner: HuntAttempt | undefined

	for (let start = 0; start < ordered.length && winner === undefined; start += HUNT_CONCURRENCY) {
		const batch = ordered.slice(start, start + HUNT_CONCURRENCY)
		const settled = await Promise.all(
			batch.map(async (candidate): Promise<HuntAttempt> => {
				const gate = await gateTestExit(candidate, modelId)
				// Only a gate pass is worth a completion; a dead or refused address
				// would spend the same request to learn the same thing.
				if (gate.verdict !== 'ok') return { candidate, gate }
				return { candidate, gate, completion: await completionTestExit(candidate, modelId) }
			}),
		)
		// Report in the order the user would expect them listed, not in whatever
		// order the sockets happened to resolve.
		for (const attempt of settled) {
			attempts.push(attempt)
			onProgress({
				attempt,
				index: attempts.length,
				total: ordered.length,
				remaining: Math.max(ordered.length - attempts.length, 0),
			})
		}
		// Within a batch, prefer the faster of the passes: both are usable, and
		// latency is the only thing left to choose between them.
		winner = settled
			.filter(attemptVerified)
			.sort((left, right) => (left.completion?.e2eMs ?? 0) - (right.completion?.e2eMs ?? 0))[0]
	}

	// A hunt that just falsified pool members has changed what the pool *is*, and
	// the pool means "exits that work" — so the entries that failed leave now
	// rather than waiting for some later admission to happen to run. Admission
	// prunes for the same reason and cannot be reused here: it only runs when
	// something new is being added, and the common case is a hunt that adds nothing.
	await pruneUnverified()

	return {
		attempts,
		winner,
		skipped: ordered.length - attempts.length,
		plan: huntPlan(ordered),
	}
}

/**
 * Failures grouped by what they mean for the next step.
 *
 * The grouping is the reason the hunt reports a failure at all rather than saying
 * "nothing worked". Three very different situations all present as "no usable
 * exit", and they call for opposite responses:
 *
 *  · **transport** — the proxy is dead or is mangling TLS. A different exit would
 *    very likely work, so the advice is to keep looking or re-screen.
 *  · **limited / region** — the proxy is fine and the *upstream* is refusing
 *    this IP. Re-probing the same exits wastes quota; the answer is a quota
 *    window or another model.
 *  · **shape** — every exit was refused identically. Measured 2026-10-17 on a
 *    run where four of five exits came back this way: the shape gate is the same
 *    request whatever the exit, so a wall of these points at the request rather
 *    than at the exits. Saying "try another proxy" there sends the user in a
 *    circle, so it is called out separately.
 */
export interface HuntFailureGroup {
	readonly verdicts: readonly GateVerdict[]
	readonly label: string
	readonly advice: string
}

/**
 * Group a run's failures by what they mean for the next step.
 *
 * Takes the attempts rather than a whole {@link HuntReport}, because the discovery
 * pipeline produces gate verdicts without producing a hunt: it probes each survivor
 * as it screens it and stops on the first winner, so its failures are worth exactly
 * the same grouping and there is no report object to hand over.
 */
export function groupHuntFailures(attempts: readonly HuntAttempt[]): readonly HuntFailureGroup[] {
	const counts = new Map<GateVerdict, number>()
	for (const attempt of attempts) {
		// The completion is the newer, stronger statement when it exists: a gate
		// pass followed by a dead stream is a transport failure of that exit, not a
		// success. Grouping by the gate alone would hide exactly those.
		const verdict = attempt.completion?.verdict ?? attempt.gate.verdict
		if (verdict === 'ok') continue
		counts.set(verdict, (counts.get(verdict) ?? 0) + 1)
	}
	const groups: HuntFailureGroup[] = []
	for (const [verdict, count] of counts) {
		switch (verdict) {
			case 'transport':
				groups.push({ verdicts: ['transport'], label: `代理本身不通 ${count} 个`, advice: '这些代理已经连不通，会被隔离 24 小时不再重测；换一个出口，或重新跑一次「自动扫描内置出口池」拉新源。' })
				break
			case 'limited':
				groups.push({ verdicts: ['limited'], label: `出口被限流 ${count} 个`, advice: '代理是通的，但这些 IP 的配额已用尽；等配额窗口滚动，或换一个出口。' })
				break
			case 'region':
				groups.push({ verdicts: ['region'], label: `地区不可用 ${count} 个`, advice: '代理是通的，但上游不接受这些 IP 所在地区；换一个模型或地区再试。' })
				break
			case 'shape':
				groups.push({
					verdicts: ['shape'],
					label: `上游按出口 IP 拒绝 ${count} 个`,
					advice: '这次请求形状对每个出口都一样，若全部候选都是这一类，问题多半不在代理：换一个模型再试，或先直连确认形状本身是否可用。',
				})
				break
			default:
				groups.push({ verdicts: ['inconclusive'], label: `结果不明确 ${count} 个`, advice: '上游没有给出可分类的答复，可以重试一次。' })
				break
		}
	}
	return groups
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

/**
 * Whether a host has been proved unreachable in this process, and the mirror
 * that last worked.
 *
 * Keyed by host rather than by full URL, because the twenty GitHub sources share
 * one host: if `raw.githubusercontent.com` is blocked here, every one of them fails
 * the same way, and remembering per-URL would mean paying for that discovery
 * twenty times over instead of once. A mirror that worked once is tried first for
 * the next source, so the fallback costs one extra request per source at worst
 * rather than three.
 */
const hostHealth = new Map<string, { failures: number; disabledUntil: number }>()

/** Proven to work in this process; `undefined` until one does. */
let preferredMirror: string | undefined

const RAW_HOST = 'raw.githubusercontent.com'

/** A host that has failed this often is assumed blocked, not merely slow. */
const HOST_FAILURE_LIMIT = 2

function hostBlocked(host: string): boolean {
	const health = hostHealth.get(host)
	return health !== undefined && health.failures >= HOST_FAILURE_LIMIT && Date.now() < health.disabledUntil
}

function noteHostFailure(host: string): void {
	const health = hostHealth.get(host)
	const failures = (health?.failures ?? 0) + 1
	hostHealth.set(host, { failures, disabledUntil: failures >= HOST_FAILURE_LIMIT ? Date.now() + SOURCE_COOLDOWN_MS : 0 })
}

function noteHostSuccess(host: string): void {
	hostHealth.delete(host)
}

/**
 * Every URL worth trying for one source, best first.
 *
 * Direct first, because when it works it is the fastest path and the mirrors add a
 * hop. A GitHub-hosted source that cannot reach `raw.githubusercontent.com` gets
 * each mirror in turn, in the order `GITHUB_MIRRORS` declares; anything else
 * (proxyspace, openproxylist) gets only itself, since prefixing a mirror onto a
 * non-GitHub URL would be meaningless.
 */
function sourceAttempts(url: string): readonly string[] {
	const { host, protocol } = new URL(url)
	if (host !== RAW_HOST) return [url]
	// `https://ghproxy.net/https://raw.githubusercontent.com/…` — the mirror takes
	// the whole raw URL, so the scheme stays on the front of it.
	const viaMirror = GITHUB_MIRRORS.map((mirror) => `${mirror}/${url}`)
	return preferredMirror === undefined ? [url, ...viaMirror] : [url, `${preferredMirror}/${url}`, ...viaMirror.filter((u) => !u.startsWith(preferredMirror as string))]
}

async function fetchText(url: string): Promise<string> {
	const response = await fetch(url, {
		signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
		headers: { accept: 'text/plain,*/*' },
		redirect: 'follow',
	})
	if (!response.ok) throw new Error(`HTTP ${response.status}`)
	return response.text()
}

/**
 * Fetch one source, falling back through the GitHub mirrors.
 *
 * `onProgress` names the URL that actually answered, because the fallback is
 * invisible otherwise: a refill that only works because of a mirror must not look
 * identical to one that reached GitHub directly.
 */
async function fetchSource(url: string, onProgress: (line: string) => void): Promise<string[]> {
	const host = new URL(url).host
	const attempts = sourceAttempts(url)
	const failures: string[] = []
	for (const attempt of attempts) {
		if (hostBlocked(new URL(attempt).host)) continue
		try {
			const text = await fetchText(attempt)
			noteHostSuccess(new URL(attempt).host)
			if (attempt !== url) {
				preferredMirror = GITHUB_MIRRORS.find((mirror) => attempt.startsWith(mirror))
				onProgress(`源 ${url} 经镜像取到：${attempt}`)
			}
			const addresses: string[] = []
			for (const line of text.split('\n')) {
				const address = parseProxyLine(line)
				if (address !== null) addresses.push(address)
			}
			return addresses
		} catch (error) {
			failures.push(`${new URL(attempt).host}: ${String(error).replace(/^Error:\s*/, '').slice(0, 40)}`)
			noteHostFailure(new URL(attempt).host)
		}
	}
	throw new Error(failures.length === 0 ? '所有取用途径都被本进程判定为不可达' : failures.join('；'))
}

/**
 * What one fetch of the source list produced: the addresses, plus how the fetch
 * itself went, so the run can report "源 18 个（失败 0）" honestly.
 */
export interface CollectedSources {
	readonly addresses: readonly string[]
	/** Sources that were fetched over the network this time. */
	readonly fetched: number
	/** Sources served from the on-disk cache instead. */
	readonly cached: number
	readonly failed: number
}

/** One cached source: its addresses, and when they were downloaded. */
interface SourceCacheEntry {
	readonly at: number
	readonly addresses: readonly string[]
}

/** The cache file, as stored: entries keyed by source URL. */
interface SourceCacheFile {
	readonly entries: Record<string, SourceCacheEntry>
}

async function readSourceCache(): Promise<Map<string, SourceCacheEntry>> {
	const raw = await readJson(SOURCE_CACHE_FILE)
	const entries = (raw as SourceCacheFile | undefined)?.entries
	if (entries === undefined || typeof entries !== 'object' || entries === null) return new Map()
	// Every field is re-validated rather than trusted: the file is a cache in a
	// temp directory, and a shape change in a later version must degrade to a
	// miss instead of to `undefined.length`.
	const out = new Map<string, SourceCacheEntry>()
	for (const [url, entry] of Object.entries(entries)) {
		if (typeof entry?.at !== 'number' || !Array.isArray(entry.addresses)) continue
		out.set(url, { at: entry.at, addresses: entry.addresses.filter((value): value is string => typeof value === 'string') })
	}
	return out
}

async function writeSourceCache(cache: Map<string, SourceCacheEntry>): Promise<void> {
	const entries: Record<string, SourceCacheEntry> = {}
	for (const [url, entry] of cache) entries[url] = entry
	await writeJson(SOURCE_CACHE_FILE, { entries } satisfies SourceCacheFile)
}

/**
 * Fetch every source, a few at a time, skipping sources in cooldown.
 *
 * All eighteen in one pass, merged and deduplicated into a single list. There
 * used to be a `'fast'` and a `'slow'` group fetched separately and swept in
 * turn; that split was an unmeasured guess inherited from another codebase, and
 * all it bought was a budget divided in two and fourteen sources permanently
 * second. One pass means every source is in the same shuffled pool, so a round
 * samples the whole list instead of working through a hand-picked eighth of it.
 *
 * Each source is downloaded at most once an hour
 * ({@link SOURCE_CACHE_TTL_MS}) and reused after that, because the download is
 * pure overhead next to the screening it feeds. A source that fails is retried
 * even inside the TTL — a cached copy is a fallback for a network that was
 * already healthy once, not a reason to keep serving yesterday's file after the
 * source itself has gone bad.
 *
 * `download` is the seam the cache tests drive: the expiry rule is about which
 * sources get fetched, and asserting that against the real network would make a
 * unit test depend on eighteen third-party hosts answering.
 */
export async function collectSources(
	onProgress: (line: string) => void,
	download: (url: string, onProgress: (line: string) => void) => Promise<string[]> = fetchSource,
	disabled: ReadonlySet<string> = new Set(),
): Promise<CollectedSources> {
	const enabled = FREE_SOURCES.filter((url) => !disabled.has(url))
	const cache = await readSourceCache()
	const now = Date.now()
	/** Sources whose copy is too old to serve, or that are not cached at all. */
	const stale = enabled.filter((url) => {
		const entry = cache.get(url)
		return entry === undefined || now - entry.at >= SOURCE_CACHE_TTL_MS
	})

	// Start from every usable cached copy, so a source that is skipped by cooldown
	// or fails to fetch still contributes what was already downloaded.
	const collected: string[] = []
	let cached = 0
	for (const [url, entry] of cache) {
		if (disabled.has(url)) continue
		if (stale.includes(url)) continue
		if (now - entry.at >= SOURCE_CACHE_TTL_MS) continue
		cached++
		collected.push(...entry.addresses)
	}

	const queue = stale.filter((url) => sourceAvailable(url))
	let fetched = 0
	let failed = 0
	const workers = Array.from({ length: Math.min(SOURCE_CONCURRENCY, queue.length) }, async () => {
		for (;;) {
			const url = queue.shift()
			if (url === undefined) return
			try {
				const addresses = await download(url, onProgress)
				noteSourceSuccess(url)
				collected.push(...addresses)
				cache.set(url, { at: Date.now(), addresses })
				fetched++
				onProgress(`源 ${url} → ${addresses.length} 个地址`)
			} catch (error) {
				failed++
				noteSourceFailure(url)
				onProgress(`源 ${url} 取用失败：${String(error)}`)
			}
		}
	})
	await Promise.all(workers)

	// Written even when some sources failed: the ones that succeeded are the
	// expensive part, and a partial cache beats re-downloading nineteen lists to
	// replace one. `writeJson` swallows its own failure, so an unwritable cache
	// directory costs the next run a download and nothing else.
	await writeSourceCache(cache)
	if (cached > 0) {
		const minutes = Math.round(Math.max(...[...cache.values()].map((entry) => now - entry.at)) / 60_000)
		onProgress(`复用 ${cached} 个源的本地缓存（最旧约 ${minutes} 分钟前下载，1 小时内不再联网拉取）`)
	}
	return { addresses: dedupeAddresses(collected), fetched, cached, failed }
}

/**
 * Ask every selected address for a CONNECT tunnel, in parallel.
 *
 * The prefilter answers the only question a dead socket cannot fake: did the
 * proxy open a tunnel at all? It is deliberately before the trace, because the
 * trace costs a TLS handshake and an HTTPS request through a proxy that is
 * usually gone. A failure is the same dead-address fact the screen records, so
 * it shares the screen quarantine.
 *
 * Run to completion before the screen starts rather than feeding it one result at
 * a time: at 512 wide the whole round finishes in about sixteen seconds, and the
 * screen then sees the complete survivor list instead of racing a producer. A
 * fixture without a prefilter passes everything through, so the offline tests
 * exercise the same queue.
 */
async function prefilterRound(
	urls: readonly string[],
	state: DiscoveryState,
	net: DiscoveryNet,
): Promise<string[]> {
	const passed: string[] = []
	let index = 0
	const worker = async (): Promise<void> => {
		for (;;) {
			const url = urls[index++]
			if (url === undefined) return
			if (state.aborted()) return
			state.screened++
			if (net.prefilter === undefined) {
				state.prefilterPassed++
				passed.push(url)
				continue
			}
			const result = await net.prefilter(url)
			if (!result.ok) {
				noteScreenFailure(exitKey(url))
				continue
			}
			state.prefilterPassed++
			passed.push(url)
		}
	}
	await Promise.all(Array.from({ length: Math.min(PREFILTER_CONCURRENCY, urls.length) }, worker))
	return passed
}

/**
 * Screen one address, and if it survives, gate-probe it there and then.
 *
 * This is why screening does not buffer its passes: the old flow collected every
 * screen pass of a batch, admitted them, and probed afterwards; this one spends the
 * quota probe the moment a trace answers, so the first verified exit is available
 * as soon as the first *usable* address is found rather than after the slowest of
 * its neighbours. The prefilter stage before it is a different split — dead sockets
 * leave early — and does not defer this probe.
 */
async function screenAndVerify(
	url: string,
	modelId: string,
	state: DiscoveryState,
	net: DiscoveryNet,
	onProgress: (line: string) => void,
): Promise<void> {
	const key = exitKey(url)
	// Cheap exit before spending anything: a run that already met its target, or was
	// cancelled, has no use for another answer.
	if (state.aborted() || state.winners.length >= state.target) return
	const screen = await net.trace(url)
	if (screen.error !== undefined || screen.exitIP === undefined) {
		// Remembered for the next run, so this run's dead addresses are not the next
		// run's first candidates. Batched into one write at the end.
		noteScreenFailure(key)
		return
	}
	const exitIP = screen.exitIP
	// A live answer clears an older dead record: fresh evidence about the address
	// beats a memory of it from a previous run.
	noteScreenSuccess(key)
	state.screenPassed++

	// One exit IP, one slot in the pool and one quota at the upstream. A second port
	// on the same host passes the trace just as well and would cost another probe to
	// learn the same thing, so it is dropped here rather than after.
	if (state.claimed.has(exitIP)) {
		state.duplicates++
		onProgress(`· 出口 ${exitIP} 已在池中（同一出口 IP 共用一份配额），不再探测`)
		return
	}

	onProgress(`· 屏检通过 ${exitIP}（${screen.country ?? '??'} · ${screen.grade ?? '?'} · ${screen.rttMs}ms${handshakeNote(screen)}）→ 闸门探测`)

	await state.slots.acquire()
	try {
		// Checked again after waiting for a slot: by the time this worker got one, a
		// sibling may have finished, or the run may have met its target, and a probe
		// now would spend quota to learn something the caller no longer needs.
		if (state.aborted() || state.winners.length >= state.target) return
		const candidate: ExitCandidate = { key, label: redactAddress(url), url, tier: 'builtin' }
		const gate = await net.probe(url, modelId)
		state.gateProbed++
		onProgress(
			`· 闸门 ${candidate.label} → ${GATE_MARK[gate.verdict]} ${gate.detail.slice(0, 50)} · ${(gate.e2eMs / 1000).toFixed(1)}s`,
		)
		if (gate.verdict !== 'ok') {
			state.attempts.push({ candidate, gate })
			// The address is not in the pool and must not go in it, so the verdict's
			// only durable effect is the ban that keeps the next run off it.
			await noteGateVerdict(key, gate)
			return
		}
		// A gate 200 means the shape was accepted, not that an answer travelled. The
		// pool's ✅ is reserved for the latter; without this stage a shared proxy that
		// answers the gate and dies mid-stream is indistinguishable from a working exit.
		if (net.complete === undefined) {
			state.attempts.push({ candidate, gate })
			return
		}
		if (state.completions >= state.completionBudget) {
			state.attempts.push({ candidate, gate })
			return
		}
		state.completions++
		const completion = await net.complete(url, modelId)
		const attempt: HuntAttempt = { candidate, gate, completion }
		state.attempts.push(attempt)
		onProgress(
			`· 完成 ${candidate.label} → ${COMPLETION_MARK[completion.verdict]} ${completion.detail.slice(0, 50)} · ${(completion.e2eMs / 1000).toFixed(1)}s${extraNote(state)}`,
		)
		if (completion.verdict !== 'ok') {
			await noteCompletionVerdict(key, completion)
			return
		}
		state.claimed.add(exitIP)
		state.verified.push({ url, screen: { ...screen, exitIP }, gate, completion })
		state.winners.push(attempt)
	} finally {
		state.slots.release()
	}
}

function extraNote(state: DiscoveryState): string {
	return state.winners.length === 0 ? '' : ` · 备用出口 #${state.winners.length + 1}`
}

/**
 * Prefilter and screen `urls` in parallel until an exit verifies, the queue
 * empties, or this round's budget is spent.
 *
 * Quarantined addresses are dropped *before* screening, not after. They are already
 * known answers, and a screen costs one request each — on a run where the user has
 * failed a dozen candidates by hand, re-asking the same dozen questions is the
 * slowest part of an operation the user already paid for.
 *
 * The budget is this round's, counted against this sweep only: `taken` is the whole
 * allowance for the call, so the tens of thousands of addresses the sources publish
 * cannot all be screened by one round no matter how many there are.
 *
 * The prefilter workers run at 512 and the screen workers at 128; only the gate
 * probes queue behind a semaphore, because those are the ones that spend quota.
 */
async function sweepRound(
	urls: readonly string[],
	modelId: string,
	state: DiscoveryState,
	net: DiscoveryNet,
	onProgress: (line: string) => void,
): Promise<number> {
	const fresh = urls.filter((url) => {
		const key = exitKey(url)
		if (state.skip.has(key)) return false
		if (isQuarantined(key)) {
			state.skipped++
			return false
		}
		// Reachable but already spent on this run. Every round re-pulls the same
		// lists, so without this a second round re-screens the same head of the
		// queue and reports progress that is not progress. It is not counted as
		// quarantined: those addresses are only skipped for the rest of *this* run,
		// and a later run should try them again.
		if (state.reached.has(url)) return false
		return true
	})
	if (state.skipped > 0 && !state.announcedSkip) {
		state.announcedSkip = true
		onProgress(`跳过 ${state.skipped} 个已知坏地址（近期闸门失败或屏检没通的）`)
	}
	for (const url of fresh) state.offered.add(url)
	let taken = 0
	const selected: string[] = []
	while (
		taken < fresh.length &&
		taken < DISCOVERY_ROUND_BUDGET &&
		!state.aborted() &&
		state.winners.length < state.target
	) {
		const url = fresh[taken++] as string
		state.reached.add(url)
		selected.push(url)
	}
	if (selected.length === 0) return 0
	const attemptedBefore = state.screened
	const passed = await prefilterRound(selected, state, net)
	if (passed.length > 0 && !state.aborted() && state.winners.length < state.target) {
		onProgress(`预筛完成 ${selected.length} 个地址 · ${passed.length} 个打开隧道，进入屏检`)
	}
	let next = 0
	const workers = Array.from({ length: Math.min(SCREEN_CONCURRENCY, passed.length) }, async () => {
		for (;;) {
			const url = passed[next++]
			if (url === undefined) return
			await screenAndVerify(url, modelId, state, net, onProgress)
		}
	})
	await Promise.all(workers)
	// Addresses this tier offered that cancellation kept out of reach. The caller
	// uses it to tell the user whether stopping was a choice.
	return Math.max(0, fresh.length - (state.screened - attemptedBefore))
}

/**
 * The network primitives a discovery run is built from, replaceable so the
 * loop can be driven offline.
 *
 * The round loop is the part worth testing — what one round covers, when the user
 * is asked, when it stops — and it is also the part unreachable without a real list
 * of real proxies. Injecting these rather than the whole sweep keeps the real
 * logic under test: dedupe by exit IP, the winner check after acquiring a probe
 * slot, quarantine writes, the early stop all still execute, only the answers are
 * synthetic. Overriding the sweep instead would test nothing but the loop.
 */
export interface DiscoveryNet {
	/** Addresses every source publishes, already deduplicated. */
	readonly collect: (onProgress: (line: string) => void) => Promise<CollectedSources>
	/**
	 * Cheap tunnel check. Optional only so gate/screen-only fixtures keep
	 * compiling; the real network always supplies it, and an absent
	 * implementation means "no prefilter", never a rejection.
	 */
	readonly prefilter?: (url: string) => Promise<PrefilterResult>
	/** Screen one address. */
	readonly trace: (url: string) => Promise<ScreenEvidence>
	/** Ask the gate whether it accepts this address. */
	readonly probe: (url: string, modelId: string) => Promise<GateEvidence>
	/**
	 * Ask for a real answer through this address. Optional only so older test
	 * fixtures that exercise the gate half keep compiling; the real network always
	 * supplies it, and the pipeline treats an absent implementation as "cannot
	 * verify" rather than as a pass.
	 */
	readonly complete?: (url: string, modelId: string) => Promise<CompletionEvidence>
}

/** The real network. */
const REAL_NET: DiscoveryNet = {
	collect: (onProgress) => collectSources(onProgress, fetchSource, disabledSources()),
	prefilter: prefilterExit,
	trace: traceEgress,
	probe: probeGate,
	complete: probeCompletion,
}

/** Options for one discovery run. */
export interface DiscoveryOptions {
	/** Stop once this many completed exits are in hand. Defaults to {@link SCAN_TARGET}. */
	target?: number
	/**
	 * Asked between rounds. Omitting it keeps going until the target, exhaustion or
	 * cancellation — a background sweep has no user to ask, and stopping at the first
	 * exit after one round is exactly the behaviour this option removes.
	 */
	askContinue?: (state: {
		tested: number
		passed: number
		untested: number
		round: number
		roundTarget: number
		verified: number
	}) => Promise<boolean>
	/** Checked between rounds and inside workers; `true` stops the run. */
	isCancelled?: () => boolean
	/** Candidates not to touch this run — the active exit, typically. */
	skip?: Iterable<string>
	/** Network overrides for offline tests. */
	net?: DiscoveryNet
}

/**
 * Pull the free lists until `target` exits have carried a real answer, the lists
 * run dry, or the completion budget/cancellation stops the run.
 *
 * All eighteen sources go into one pool, shuffled as a whole, and each round
 * screens up to {@link DISCOVERY_ROUND_BUDGET} of them. The sources used to be
 * split into a `fast` and a `slow` group that were fetched and swept in turn,
 * which meant a round could spend its entire budget on the eight hand-labelled
 * "fast" lists while the other fourteen were never opened; the split is gone and
 * the shuffle is over everything, so a round samples the whole list instead of
 * working through a hand-picked fraction of it. Within the pool the order is
 * shuffled anyway, since every run sees the same list order and screening it in
 * order would re-test the same dead head forever.
 *
 * A winner is a *completed* exit, not merely a gate pass: the gates of this run
 * are what make the pool usable, and a shared proxy that answers the gate and dies
 * mid-stream is exactly the case that used to turn ✅ into a failed first turn.
 *
 * Every verified exit is admitted, not just the first: probes already in flight
 * when the target is met still finish, and those are the reserve the next run
 * re-probes first. That is why this returns a list of winners rather than one.
 *
 * Rounds repeat until the target, exhaustion or the completion budget. The sources are
 * re-read each round but not re-downloaded inside {@link SOURCE_CACHE_TTL_MS},
 * and addresses already screened this run are never screened twice, so a round is
 * always new ground — which is what makes asking "继续吗" per round a real offer
 * rather than the same numbers again.
 */
export async function discoverExit(
	modelId: string,
	onProgress: (line: string) => void = () => {},
	options: DiscoveryOptions = {},
): Promise<DiscoveryReport> {
	const {
		target = SCAN_TARGET,
		askContinue,
		isCancelled = () => false,
		skip = [],
		net = REAL_NET,
	} = options
	const attemptedAddresses = new Set<string>()
	let sourcesFetched = 0
	let sourcesCached = 0
	let sourcesFailed = 0
	let stopReason: DiscoveryStopReason = 'exhausted'
	let admitted = 0
	const aborted = (): boolean => isCancelled()

	// Seeded from the pool: an exit IP that is already verified costs nothing to
	// notice and must not be re-probed. This is what makes the second run of the day
	// cheap — the first run's winners are sitting here, and `huntUsableExit` tries
	// them before any of this runs.
	const claimed = new Set<string>()
	for (const candidate of candidates()) {
		if (candidate.tier !== 'builtin') continue
		const ip = evidenceFor(candidate.key)?.screen?.exitIP
		if (ip !== undefined) claimed.add(ip)
	}

	const state: DiscoveryState = {
		screened: 0,
		prefilterPassed: 0,
		screenPassed: 0,
		gateProbed: 0,
		completions: 0,
		duplicates: 0,
		skipped: 0,
		announcedSkip: false,
		target,
		// Real completions are the scarce resource. Four candidates per desired
		// exit leaves room for dead proxies without letting one lucky source eat the
		// whole quota.
		completionBudget: Math.max(target * COMPLETION_BUDGET_FACTOR, target),
		claimed,
		skip: new Set(skip),
		aborted,
		slots: new Semaphore(HUNT_CONCURRENCY),
		attempts: [],
		winners: [],
		verified: [],
		offered: new Set(),
		reached: new Set(),
		rounds: 0,
	}

	const sweep = async (): Promise<void> => {
		const collected = await net.collect(onProgress)
		sourcesFetched += collected.fetched
		sourcesCached += collected.cached
		sourcesFailed += collected.failed
		for (const address of collected.addresses) attemptedAddresses.add(address)
		await sweepRound(shuffle(collected.addresses), modelId, state, net, onProgress)
	}

	// A round is one sweep of everything. It ends early when the run has enough
	// verified exits or is cancelled.
	//
	// The loop, rather than a straight-line sweep-then-ask-then-sweep, is the whole
	// fix for "it stopped on its own with nothing". Straight-line only ever asked
	// once, so a single "yes" bought one extra sweep and then the run ended with
	// thousands of untested addresses still in hand — and the report said nothing
	// about them, so it read as "the sources are exhausted".
	try {
		for (;;) {
			if (isCancelled()) {
				stopReason = 'cancelled'
				break
			}
			state.rounds++
			await sweep()
			if (state.winners.length >= state.target) {
				stopReason = 'target'
				break
			}
			if (state.completions >= state.completionBudget) {
				stopReason = 'budget'
				break
			}
			if (isCancelled()) {
				stopReason = 'cancelled'
				break
			}

			const untested = untestedAddresses(state)
			// Nothing left anywhere and no question to ask: the lists genuinely ran dry
			// after quarantine, which is a real answer and not a premature stop.
			if (untested === 0) {
				onProgress('源里没有被隔离过滤掉的地址了，这一轮是真的测完了。')
				break
			}
			if (askContinue === undefined) {
				// No one to ask and the target is not met: keep sweeping. This is the
				// difference between a chip that stalls at one exit and a scan that
				// keeps looking for a reserve.
				continue
			}
			const more = await askContinue({
				tested: state.screened,
				passed: state.screenPassed,
				untested,
				round: state.rounds,
				roundTarget: state.target,
				verified: state.winners.length,
			})
			if (!more) {
				stopReason = 'user'
				break
			}
		}
	} catch (error) {
		stopReason = 'error'
		throw error
	} finally {
		// Admission must happen even on cancellation: a verified exit this run paid
		// for is real evidence, and throwing it away would make the next run repeat
		// the spend. The report still says the run was cancelled.
		await admitAndReport()
	}

	async function admitAndReport(): Promise<void> {
		const admission = await admitDiscovered(state.verified)
		const evicted = await pruneUnverified()
		if (evicted > 0) onProgress(`清掉 ${evicted} 个没有完成证据的旧出口（只通过闸门的不再算数）`)
		// One write for every screen failure this run observed, instead of one each.
		await persistScreens()
		admitted = admission.admitted
	}

	return {
		sourcesFetched,
		sourcesCached,
		sourcesFailed,
		candidates: attemptedAddresses.size,
		screened: state.screened,
		prefilterPassed: state.prefilterPassed,
		screenPassed: state.screenPassed,
		gateProbed: state.gateProbed,
		completionProbed: state.completions,
		target: state.target,
		stopReason,
		admitted,
		duplicates: state.duplicates,
		skippedQuarantined: state.skipped,
		untested: untestedAddresses(state),
		rounds: state.rounds,
		attempts: state.attempts,
		// Fastest first: when several probes pass, latency is the only thing left to
		// choose between them.
		winners: [...state.winners].sort((left, right) => (left.completion?.e2eMs ?? 0) - (right.completion?.e2eMs ?? 0)),
	}
}

/**
 * Addresses the sources offered that no trace was spent on.
 *
 * Counted across the whole run rather than per round: re-pulling a source returns
 * the same list, so a per-round count would add the same addresses back every time
 * and claim there was more left than there is.
 */
function untestedAddresses(state: DiscoveryState): number {
	let untested = 0
	for (const url of state.offered) if (!state.reached.has(url)) untested++
	return untested
}

function shuffle<T>(values: readonly T[]): T[] {
	return [...values]
		.map((value) => ({ value, key: Math.random() }))
		.sort((left, right) => left.key - right.key)
		.map((entry) => entry.value)
}
