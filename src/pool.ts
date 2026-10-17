/**
 * The exit pool: which upstream proxy this extension's requests leave through.
 *
 * Why this exists: the anonymous lane meters quota per egress IP, so a machine
 * whose address has spent its budget answers `429` for everything until the
 * window rolls over. The host's own proxy support cannot fix that mid-session —
 * `PI_PROXY*` is read once per provider and memoized for the process lifetime
 * (host `utils/proxy.ts`), so changing it needs a restart. What *does* work is
 * the transport seam: the host engine honours a caller-supplied `options.fetch`,
 * and a caller-supplied `init.proxy` wins over the environment
 * (docs/FINDINGS.md §2.6 — measured three ways). So one wrapper on the real
 * request path is the entire switching mechanism: no re-registration, no
 * restart, no environment variable.
 *
 * Deliberately missing: **automatic rotation**. A failed request only writes a
 * mark onto the exit that produced it ({@link recordPassive}); nothing else
 * happens until the user runs `/opencode2pi pool`. Rotating on failure is what
 * opencode2dsh does and what this repo refuses: the host already retries a
 * transport failure ~28 times in 120 s (FINDINGS §2.6), so a second opinion at
 * this layer multiplies precisely the traffic the quota is counting.
 *
 * Also deliberately missing: a `direct` pool member. "Back to the local IP" is
 * what `enabled: false` means, and two states that mean the same thing is how a
 * user ends up with the pool switched "on" while egressing directly.
 *
 * Two tiers, and the split is the user's: `manual` is `exits.txt`, the user's own
 * infrastructure, tried first; `builtin` is what {@link admitDiscovered} pulls
 * out of the free public lists (src/sources.ts) once the manual list is out of
 * options. Nothing is ever fetched without the user asking for it.
 */

import {
	exitEntries,
	exitKey,
	parseExitLines,
	readExitFile,
	redactAddress,
	writeExitFile,
	type ExitEntry,
} from './exits.ts'
import { readJson, writeJson } from './store.ts'
import { disposeProxyAgents, proxiedFetch } from './transport.ts'

const STORE_FILE = 'pool.json'
const STORE_VERSION = 1

/** Screen and gate verdicts older than this are shown, but no longer trusted. */
export const EXIT_TTL_MS = 6 * 60 * 60 * 1000
/** How long a `429` on one exit says anything: quota windows are minutes-to-a-day. */
export const LIMIT_TTL_MS = 30 * 60 * 1000
/** Above this, a candidate is not worth spending a quota probe on (3 s, as opencode2dsh). */
export const SCREEN_MAX_RTT_MS = 3000
/**
 * Above this, the tunnel costs too much to build and the exit is dropped.
 *
 * Measured 2026-10-17 across the free sources (160 candidates, 7 carried traffic):
 * warm RTT was 252–1900 ms while the tunnel alone cost 491–7555 ms, so an RTT gate
 * says nothing about the number that actually makes the exit unusable. The tunnel is
 * re-established after 4 s of idle — undici's keep-alive window, and an agentic turn
 * idles past it routinely between model thinking, tool execution and human input.
 *
 * The 2500 ms figure is where the measured distribution breaks rather than a round
 * number: of 7 survivors, 2 were at or below 2500 ms and 5 were above it, with the
 * median already at 3.6 s. Below this a free exit is usable; above it the pool is
 * carrying proxies that bill seconds on every cold request. Tightening it further
 * empties the pool outright — nothing in the sweep was under 2.2 s — which is why
 * this is a ceiling on tunnel cost and not on end-to-end latency.
 */
export const SCREEN_MAX_HANDSHAKE_MS = 2500
/** Discovered free exits rot within hours: keep a handful, not a farm. */
const BUILTIN_MAX = 12

/**
 * How long a gate-falsified exit is kept out of refill.
 *
 * The reason this exists: the free lists are pulled again on every refill, and
 * they still contain every address they contained last time. Without a memory of
 * what already failed, each refill re-screens the same dead proxies, spends a
 * trace request on each, and can re-admit one the user just watched fail a gate
 * probe — the failure the user was told about, then repeated as if new. 24 hours
 * is the round trip of the lists themselves: they refresh on that cadence, so a
 * shorter ban only ever hides an address that is about to come back anyway.
 */
export const QUARANTINE_MS = 24 * 60 * 60 * 1000

/**
 * How long a *screen* failure keeps an address out of refill.
 *
 * Shorter than {@link QUARANTINE_MS}, and deliberately so: a gate-falsified exit
 * was shown to carry traffic and then be refused, which is a statement about the
 * exit. A screen failure only says the socket did not answer one trace, which is
 * a statement about that minute. Free proxies do come back, and the lists
 * themselves refresh on a daily cycle, so a ban longer than that would be hiding
 * an address that is about to be re-listed anyway.
 */
export const SCREEN_QUARANTINE_MS = 12 * 60 * 60 * 1000

/**
 * Ceiling on remembered screen failures.
 *
 * The bound is a file-size decision: the lists publish tens of thousands of
 * addresses and a run screens hundreds, so an unbounded map would grow the store
 * without ever making a second run faster. Keeping the most recent failures is
 * what pays off — the head of the list is what a random draw keeps hitting.
 */
const SCREEN_MEMORY_MAX = 4000

export type ExitTier = 'manual' | 'builtin'
export type ExitGrade = 'S' | 'A' | 'B' | 'C'
/**
 * What a gate probe through this exit said.
 *
 * `inconclusive` is not a shrug: it is the honest verdict for a failure the exit
 * cannot be blamed for (a 400 the model refuses, a 5xx, an unclassifiable body).
 * Only `region` / `transport` / `shape` falsify an exit.
 */
export type GateVerdict = 'ok' | 'limited' | 'region' | 'shape' | 'transport' | 'inconclusive'

/** A 429 or a geo block seen for one model on one exit. Keyed by model: see §4.4.1. */
export interface ModelMark {
	readonly at: number
	readonly kind: 'limited' | 'region'
}

export interface ScreenEvidence {
	readonly at: number
	readonly exitIP?: string
	readonly country?: string
	readonly rttMs?: number
	readonly grade?: ExitGrade
	/**
	 * What the tunnel itself cost, in ms: the first request on a fresh connection
	 * minus a later one that reused it. Measured 2026-10-17, because it is the
	 * number that decides usability and no existing metric could see it — see
	 * {@link SCREEN_MAX_HANDSHAKE_MS}.
	 *
	 * Kept separate from `rttMs` rather than folded into it, because the two fail
	 * differently: a proxy can be fast on the wire and still charge seconds to
	 * build a tunnel, and only the delta shows that.
	 */
	readonly handshakeMs?: number
	/** Set when the exit never produced a usable answer. */
	readonly error?: string
}

export interface GateEvidence {
	readonly at: number
	readonly modelId: string
	readonly verdict: GateVerdict
	readonly status?: number
	readonly e2eMs: number
	readonly detail: string
}

/**
 * Why an exit is being kept out of refill, and until when.
 *
 * `verdict` is kept rather than a free-text reason because the quarantine is
 * written from exactly one place — a gate verdict — and the verdict is what a
 * later run needs in order to lift the ban: a fresh `ok` means the address works
 * again, whatever was wrong with it yesterday.
 *
 * `screen` entries are the weaker kind: the address never answered a trace, so
 * nothing was learned about it except that it was dead *this time*. They earn a
 * shorter ban because the lists refresh on a 24-hour cycle and a socket that was
 * closed can reopen, but they are what stops every refill from re-testing the
 * same dead head of the list.
 */
export interface QuarantineRecord {
	readonly at: number
	readonly until: number
	readonly verdict: GateVerdict | 'screen'
}

export interface ExitEvidence {
	/** Credential-free rendering; the only form that is printed. */
	readonly label: string
	readonly tier: ExitTier
	/**
	 * Dialable URL, present only for discovered exits: they exist nowhere else,
	 * whereas a manual exit is re-read from `exits.txt` — which is what keeps a
	 * user's `user:password@` out of this file.
	 */
	readonly url?: string
	readonly addedAt?: number
	readonly screen?: ScreenEvidence
	readonly gate?: GateEvidence
	readonly modelMarks?: Readonly<Record<string, ModelMark>>
}

export interface ExitCandidate {
	/** Store key: a hash of the full URL, so credentials never reach the store. */
	readonly key: string
	readonly label: string
	readonly url: string
	readonly tier: ExitTier
}

export interface RejectedExit {
	readonly line: string
	readonly reason: string
}

interface PoolStore {
	readonly version: number
	readonly enabled: boolean
	readonly selected: string | null
	readonly evidence: Readonly<Record<string, ExitEvidence>>
	/**
	 * Addresses kept out of refill until `until`, keyed the same as `evidence`.
	 *
	 * A separate map rather than a field on {@link ExitEvidence} because the two
	 * have different lifetimes and different owners: evidence describes an exit
	 * that is in the pool, and is dropped when the exit is; quarantine has to
	 * outlive the exit, since the whole point is to remember an address the pool
	 * no longer holds so the next refill does not re-admit it.
	 */
	readonly quarantine: Readonly<Record<string, QuarantineRecord>>
}

const EMPTY_STORE: PoolStore = {
	version: STORE_VERSION,
	enabled: false,
	selected: null,
	evidence: {},
	quarantine: {},
}

let store: PoolStore = EMPTY_STORE
let manual: readonly ExitEntry[] = []
let rejected: readonly RejectedExit[] = []
/** Derived from `store` + `manual` on every mutation: the request path reads it per request. */
let active: ExitCandidate | undefined

/** Latency grade. The thresholds are opencode2dsh's, adopted rather than re-invented. */
export function gradeOf(rttMs: number): ExitGrade {
	if (rttMs <= 500) return 'S'
	if (rttMs <= 1000) return 'A'
	if (rttMs <= 2000) return 'B'
	return 'C'
}

/** Whether a timestamp is still treated as current under its own TTL. */
export function isFresh(at: number | undefined, ttl: number): boolean {
	return at !== undefined && Date.now() - at <= ttl
}

/**
 * Whether an exit is worth offering at all.
 *
 /**
 * Falsified exits — a region block, a dead route, a refused shape — are out
 * regardless of what the screen said. Otherwise two kinds of evidence qualify,
 * because both of them are true statements about the exit:
 *
 *  · a fresh gate `ok`: a real gate-shaped request came back 200 through it;
 *  · a fresh, fast, error-free screen: the proxy carries TLS traffic, which is
 *    what the screen measures. This is the only evidence a bulk-screen run
 *    produces, and it is why screening has to be cheap.
 *
 * A quota `429` does **not** disqualify an exit: quota is metered per model, so
 * the same exit is usually still good for a different one.
 */
export function isUsable(evidence: ExitEvidence | undefined): boolean {
	if (!evidence) return false
	if (evidence.gate !== undefined && falsifiesExit(evidence.gate.verdict)) return false
	if (evidence.gate?.verdict === 'ok' && isFresh(evidence.gate.at, EXIT_TTL_MS)) return true
	const screen = evidence.screen
	if (!screen || screen.error !== undefined || screen.rttMs === undefined) return false
	if (!isFresh(screen.at, EXIT_TTL_MS) || screen.rttMs > SCREEN_MAX_RTT_MS) return false
	// A fast reply on a reused tunnel says nothing about the request that follows a
	// pause, and that is the request a real conversation is mostly made of. When the
	// tunnel cost is known it gates the exit exactly as the RTT does; when it is not
	// measured (an older store, or a run that could not complete the second probe)
	// the RTT alone still stands — absence of a measurement is not evidence of a
	// slow exit, and refusing to offer those would empty the pool for a number
	// nobody took.
	if (screen.handshakeMs !== undefined && screen.handshakeMs > SCREEN_MAX_HANDSHAKE_MS) return false
	return true
}

function withMark(evidence: ExitEvidence, modelId: string, kind: ModelMark['kind']): ExitEvidence {
	return { ...evidence, modelMarks: { ...(evidence.modelMarks ?? {}), [modelId]: { at: Date.now(), kind } } }
}

/**
 * Evidence for a candidate, created on first write.
 *
 * Manual exits deliberately have no entry in `pool.json` until something is
 * measured about them: their URL lives in `exits.txt`, and copying it into the
 * store is how a credential would end up in a second file. So the first screen
 * or gate test seeds the record from the candidate itself.
 */
function ensureEvidence(key: string): ExitEvidence | undefined {
	const existing = store.evidence[key]
	if (existing) return existing
	const candidate = candidates().find((entry) => entry.key === key)
	return candidate === undefined ? undefined : { label: candidate.label, tier: candidate.tier }
}

/** Ranking key: usable first, then fastest. */
function rankOf(evidence: ExitEvidence): number {
	return (isUsable(evidence) ? 0 : 1e9) + (evidence.screen?.rttMs ?? Number.MAX_SAFE_INTEGER)
}

function narrowEvidence(value: unknown): ExitEvidence | undefined {
	if (typeof value !== 'object' || value === null) return undefined
	const record = value as Partial<ExitEvidence>
	if (typeof record.label !== 'string') return undefined
	if (record.tier !== 'manual' && record.tier !== 'builtin') return undefined
	return {
		label: record.label,
		tier: record.tier,
		...(typeof record.url === 'string' ? { url: record.url } : {}),
		...(typeof record.addedAt === 'number' ? { addedAt: record.addedAt } : {}),
		...(record.screen
			? {
					screen: {
						...record.screen,
						...(typeof (record.screen as ScreenEvidence).handshakeMs === 'number'
							? { handshakeMs: (record.screen as ScreenEvidence).handshakeMs }
							: {}),
					},
				}
			: {}),
		...(record.gate ? { gate: record.gate } : {}),
		...(record.modelMarks ? { modelMarks: record.modelMarks } : {}),
	}
}

/**
 * Keep only bans that are still in force, dropping expired ones on read.
 *
 * Returns how many were dropped so the caller can rewrite the file. Expiry is
 * enforced here rather than at each lookup so the store shrinks on its own: a
 * quarantine that outlives its window and is only ever filtered lazily would
 * accumulate every address the user has ever failed, in a file that is rewritten
 * on every probe.
 */
function narrowQuarantine(raw: unknown): { kept: Record<string, QuarantineRecord>; dropped: number } {
	if (typeof raw !== 'object' || raw === null) return { kept: {}, dropped: 0 }
	const now = Date.now()
	const kept: Record<string, QuarantineRecord> = {}
	let dropped = 0
	for (const [key, value] of Object.entries(raw)) {
		const record = typeof value === 'object' && value !== null ? (value as Partial<QuarantineRecord>) : undefined
		if (record === undefined || typeof record.until !== 'number' || record.until <= now || typeof record.verdict !== 'string') {
			dropped++
			continue
		}
		kept[key] = {
			at: typeof record.at === 'number' ? record.at : now,
			until: record.until,
			verdict: record.verdict as QuarantineRecord['verdict'],
		}
	}
	return { kept, dropped }
}

function narrowStore(raw: unknown): { store: PoolStore; expiredQuarantines: number } {
	if (typeof raw !== 'object' || raw === null) return { store: EMPTY_STORE, expiredQuarantines: 0 }
	const record = raw as Partial<PoolStore>
	const evidence: Record<string, ExitEvidence> = {}
	const source = typeof record.evidence === 'object' && record.evidence !== null ? record.evidence : {}
	for (const [key, value] of Object.entries(source)) {
		const kept = narrowEvidence(value)
		if (kept) evidence[key] = kept
	}
	const quarantine = narrowQuarantine(record.quarantine)
	return {
		store: {
			version: STORE_VERSION,
			enabled: record.enabled === true,
			selected: typeof record.selected === 'string' ? record.selected : null,
			evidence,
			quarantine: quarantine.kept,
		},
		expiredQuarantines: quarantine.dropped,
	}
}

function discoveredKeys(): readonly string[] {
	return Object.entries(store.evidence)
		.filter(([, evidence]) => evidence.tier === 'builtin')
		.map(([key]) => key)
}

/**
 * Every offerable exit, manual first.
 *
 * Manual entries keep the file's order — that is the user's own ranking.
 * Discovered ones are ranked by usability then latency, because a public proxy
 * list has no order worth preserving.
 */
export function candidates(): readonly ExitCandidate[] {
	const discovered = Object.entries(store.evidence)
		.filter(([, evidence]) => evidence.tier === 'builtin' && typeof evidence.url === 'string')
		.map(([key, evidence]) => ({
			key,
			label: evidence.label,
			url: evidence.url as string,
			tier: 'builtin' as const,
			rank: rankOf(evidence),
		}))
	discovered.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label))

	return [
		...manual.map((entry) => ({ key: entry.key, label: entry.label, url: entry.url, tier: 'manual' as const })),
		...discovered.map(({ key, label, url, tier }) => ({ key, label, url, tier })),
	]
}

export function evidenceFor(key: string): ExitEvidence | undefined {
	return store.evidence[key]
}

export function poolEnabled(): boolean {
	return store.enabled
}

export function selectedKey(): string | null {
	return store.selected
}

/** The exit this process is currently egressing through, or `undefined` for direct. */
export function activeCandidate(): ExitCandidate | undefined {
	return active
}

/** Lines `exits.txt` refused, so the TUI can name what it could not use. */
export function rejectedExits(): readonly RejectedExit[] {
	return rejected
}

export function hasUsable(): boolean {
	return candidates().some((candidate) => isUsable(store.evidence[candidate.key]))
}

/**
 * Re-derive the active candidate. Every mutation ends here.
 *
 * Switching exits also retires the previous exit's pooled sockets. `close()` is
 * undici's graceful drain rather than `destroy()`, so a request already in
 * flight on the old exit finishes instead of being cut off mid-stream — the
 * switch takes effect from the next request, which is exactly the promise the
 * pool makes.
 */
function recompute(): void {
	const previous = active
	active = store.enabled && store.selected !== null ? candidates().find((c) => c.key === store.selected) : undefined
	if (previous !== undefined && previous.url !== active?.url) {
		void disposeProxyAgents().catch(() => {})
	}
}

/** Adopt `exits.txt` and drop evidence for exits it no longer lists. */
export async function refreshManual(): Promise<void> {
	const { addresses, rejected: refused } = await readExitFile()
	manual = exitEntries(addresses)
	rejected = refused
	const known = new Set<string>([...manual.map((entry) => entry.key), ...discoveredKeys()])
	const evidence: Record<string, ExitEvidence> = {}
	for (const [key, value] of Object.entries(store.evidence)) {
		if (known.has(key)) evidence[key] = value
	}
	const selected = store.selected !== null && known.has(store.selected) ? store.selected : null
	// Write only when this read actually changed something. Startup calls this in
	// every process, and rewriting the store byte-identically on every launch is
	// a side effect with no reader — it would also make the extension create
	// `pool.json` for users who never open the pool.
	const changed = selected !== store.selected || Object.keys(evidence).length !== Object.keys(store.evidence).length
	store = { ...store, evidence, selected }
	if (changed) await persist()
	else recompute()
}

async function persist(): Promise<void> {
	recompute()
	await writeJson(STORE_FILE, store)
}

export async function loadPool(): Promise<void> {
	const { store: loaded, expiredQuarantines } = narrowStore(await readJson(STORE_FILE))
	store = loaded
	// What is in the file is now on disk; nothing is waiting to be written. Without
	// this a later `persistScreens` would rewrite a store it did not change.
	screenMemoryDirty = false
	await refreshManual()
	// Only when something actually expired. Startup runs in every process, so the
	// write has to stay conditional for the same reason `refreshManual` guards its
	// own: a store rewritten byte-identically on every launch is a side effect
	// with no reader.
	if (expiredQuarantines > 0) await persist()
}

export async function setPoolEnabled(enabled: boolean): Promise<void> {
	store = { ...store, enabled }
	await persist()
}

export async function selectExit(key: string | null): Promise<void> {
	if (key !== null && !candidates().some((candidate) => candidate.key === key)) return
	store = { ...store, selected: key }
	await persist()
}

export async function recordScreen(key: string, screen: ScreenEvidence): Promise<void> {
	const evidence = ensureEvidence(key)
	if (!evidence) return
	store = { ...store, evidence: { ...store.evidence, [key]: { ...evidence, screen } } }
	await persist()
}

/**
 * Whether a gate verdict says something about the exit or about the request.
 *
 * This is the same split `isUsable` draws when it falsifies an exit, reused
 * rather than re-listed: a region block, a dead route and a refused shape are
 * all things a *different* exit would have avoided, which is exactly what makes
 * them worth remembering. A `429` is not — the proxy carried the request fine and
 * the quota behind it was already spent, so quarantining one would throw away a
 * working exit over a condition that clears on its own.
 */
function falsifiesExit(verdict: GateVerdict): boolean {
	return verdict === 'region' || verdict === 'transport' || verdict === 'shape'
}

/**
 * Fold a gate verdict into the quarantine, lifting the ban on a pass.
 *
 * Lifting matters as much as setting: 24 hours is long, and a ban that outlived
 * the fault would keep a recovered address out of the one pool that could still
 * be using it. A fresh `ok` is direct evidence about the address now, so it wins
 * over whatever was recorded before.
 */
function applyQuarantine(key: string, gate: GateEvidence): PoolStore {
	const quarantine = { ...store.quarantine }
	if (falsifiesExit(gate.verdict)) {
		quarantine[key] = { at: Date.now(), until: Date.now() + QUARANTINE_MS, verdict: gate.verdict }
	} else if (gate.verdict === 'ok') {
		delete quarantine[key]
	}
	return { ...store, quarantine }
}

export function isQuarantined(key: string): boolean {
	return store.quarantine[key] !== undefined
}

/**
 * Set when the screen memory has changed since the last {@link persistScreens}.
 * Declared here so the two writers and the one flusher read as a set.
 */
let screenMemoryDirty = false

/**
 * Remember that an address failed to answer a trace, for the shorter of the two
 * ban windows.
 *
 * This is the memory that makes a second refill cheaper than the first. Without it
 * every run re-screens addresses it already watched time out — measured on
 * 2026-10-17, the lists yield roughly one usable exit per 40–80 screened, and a
 * shuffled draw out of tens of thousands of addresses keeps landing on the same
 * dead head.
 *
 * A passing screen lifts an older screen ban, for the same reason a gate `ok`
 * lifts a gate ban: fresh evidence about the address now beats a record about it
 * yesterday. In batch the writes are cheap but not free — one per failure — so the
 * caller batches them into a single {@link persistScreens} at the end of a run.
 */
export function noteScreenFailure(key: string): void {
	const existing = store.quarantine[key]
	// A gate ban is the stronger claim about the address; a screen must not shorten
	// it or overwrite what it says.
	if (existing !== undefined && existing.verdict !== 'screen') return
	store = {
		...store,
		quarantine: {
			...store.quarantine,
			[key]: { at: Date.now(), until: Date.now() + SCREEN_QUARANTINE_MS, verdict: 'screen' },
		},
	}
	screenMemoryDirty = true
}

/** Lift a screen-only ban, called when a later screen answered. */
export function noteScreenSuccess(key: string): void {
	const existing = store.quarantine[key]
	if (existing === undefined || existing.verdict !== 'screen') return
	const quarantine = { ...store.quarantine }
	delete quarantine[key]
	store = { ...store, quarantine }
	screenMemoryDirty = true
}

/**
 * Drop the oldest screen bans past {@link SCREEN_MEMORY_MAX}. Returns whether it
 * changed anything.
 *
 * Gate bans are never trimmed: they are few, they are evidence, and losing one
 * would let a known-falsified exit back in. Only the screen memory is expendable,
 * and it is expendable precisely because it is the weaker claim.
 */
function trimScreenMemory(): boolean {
	const screenKeys = Object.entries(store.quarantine)
		.filter(([, record]) => record.verdict === 'screen')
		.sort((left, right) => right[1].at - left[1].at)
	if (screenKeys.length <= SCREEN_MEMORY_MAX) return false
	const quarantine = { ...store.quarantine }
	for (const [key] of screenKeys.slice(SCREEN_MEMORY_MAX)) delete quarantine[key]
	store = { ...store, quarantine }
	return true
}

/**
 * Write the screen memory accumulated by {@link noteScreenFailure} /
 * {@link noteScreenSuccess}.
 *
 * Called once per refill rather than once per failure: a run that screens 320
 * addresses produces hundreds of updates, and persisting each of them would
 * rewrite the store hundreds of times for no reader.
 *
 * The dirty flag is what makes the batching pay off. Trimming on its own is not a
 * reason to write — the interesting case is the *first* few hundred failures,
 * which are exactly the ones a run is most likely to produce, and those would be
 * lost if writing were gated on having crossed the cap.
 */
export async function persistScreens(): Promise<void> {
	if (!screenMemoryDirty && !trimScreenMemory()) return
	screenMemoryDirty = false
	await persist()
}

/** How many addresses are being kept out by the screen memory alone. */
export function screenMemoryCount(): number {
	return Object.values(store.quarantine).filter((record) => record.verdict === 'screen').length
}

/** Banned addresses, earliest expiry first. For the pool view. */
export function quarantinedEntries(): readonly { key: string; record: QuarantineRecord }[] {
	return Object.entries(store.quarantine)
		.map(([key, record]) => ({ key, record }))
		.sort((left, right) => left.record.until - right.record.until)
}

/** Record a gate probe, folding its refusals into the per-model marks too. */
export async function recordGate(key: string, gate: GateEvidence): Promise<void> {
	let evidence = ensureEvidence(key)
	if (!evidence) return
	evidence = { ...evidence, gate }
	if (gate.verdict === 'limited') evidence = withMark(evidence, gate.modelId, 'limited')
	if (gate.verdict === 'region') evidence = withMark(evidence, gate.modelId, 'region')
	store = { ...applyQuarantine(key, gate), evidence: { ...store.evidence, [key]: evidence } }
	await persist()
}

/**
 * Fold a gate verdict into the quarantine for an address the pool does not hold.
 *
 * Separate from {@link recordGate} because the discovery pipeline probes **before**
 * admitting: an address that fails the gate was never in `evidence`, and
 * `recordGate`'s `ensureEvidence` would return `undefined` for it and drop the
 * verdict entirely. That silence is the whole reason this function exists — under
 * gate-first admission, every failure would be re-paid on the next run because
 * nothing remembered it.
 *
 * A passing verdict lifts an older ban, exactly as `recordGate` does, so a recovered
 * address is not kept out by a record about yesterday.
 */
export async function noteGateVerdict(key: string, gate: GateEvidence): Promise<void> {
	store = applyQuarantine(key, gate)
	await persist()
}

/**
 * Drop every discovered exit the gate has not vouched for.
 *
 * This is what makes the pool mean "exits that work" rather than "addresses that
 * answered a trace once". Two things fall out of the same pass:
 *
 *  · gate-falsified entries — a region block, a dead route, a refused shape — leave
 *    the pool instead of lingering until the next admission happens to run;
 *  · **entries with no gate verdict at all** leave too, which is how a store written
 *    by the older screen-then-probe flow heals itself instead of leaving the pool
 *    full of addresses that were only ever measured by a keyless trace.
 *
 * Manual exits are untouched: they live in `exits.txt` and belong to the user
 * whether or not anything has measured them yet.
 */
export async function pruneUnverified(): Promise<number> {
	const before = Object.values(store.evidence).filter((value) => value.tier === 'builtin').length
	const evidence = dropUnverified(store.evidence, true)
	if (evidence === store.evidence) return 0
	store = { ...store, evidence }
	await persist()
	return before - Object.values(evidence).filter((value) => value.tier === 'builtin').length
}

/**
 * Attribute a real request's failure to the exit it went through.
 *
 * This is the only automatic thing the pool does, and it costs nothing: no extra
 * request, no retry, no behaviour change — it means the next `/opencode2pi pool`
 * shows what actually happened instead of a screen result that has stopped
 * describing the exit.
 */
export async function recordPassive(modelId: string, kind: 'RATE_LIMIT' | 'REGION_BLOCKED'): Promise<void> {
	const exit = active
	if (!exit) return
	const evidence = ensureEvidence(exit.key)
	if (!evidence) return
	store = {
		...store,
		evidence: { ...store.evidence, [exit.key]: withMark(evidence, modelId, kind === 'RATE_LIMIT' ? 'limited' : 'region') },
	}
	// `persist()` rather than a bare fire-and-forget write: this runs on the
	// request path, where a plain `void writeJson` could land *after* a
	// concurrent `/pool` command's own write and resurrect a stale store — the
	// user's selection would silently disappear. Going through the same awaited
	// path keeps every write serialized on call order. It changes nothing about
	// the cost: this only ever records what already happened.
	await persist()
}

/**
 * Adopt discovered free exits, keeping the store bounded.
 *
 * `screen` travels with each url rather than being recorded afterwards, because
 * admission prunes immediately: a fresh entry written without evidence ranks
 * last ({@link rankOf} has nothing to compare) and gets cut on the very call
 * that introduced it, so the refill would report new exits while the pool kept
 * exactly the stale ones it already had.
 *
 * Quarantined addresses are refused here, not only in the refill that screens
 * them: this is the one place a discovered exit enters the pool, so a ban that
 * were enforced upstream alone would still be bypassable by any second caller —
 * and a pool that can re-admit an address the user just watched fail is the
 * behaviour the quarantine exists to prevent.
 */
export async function admitDiscovered(entries: readonly DiscoveredExit[]): Promise<AdmissionReport> {
	const known = new Set(candidates().map((candidate) => candidate.key))
	const additions: Record<string, ExitEvidence> = {}
	// One exit IP, one slot. Two ports on the same host are two URLs but a single
	// upstream quota, so keeping both spends a scarce pool slot on something that
	// cannot help: whatever makes the first one rate-limited makes the second one
	// rate-limited too. The fastest of the two is the one worth having.
	const fastestByExitIP = new Map<string, DiscoveredExit>()
	for (const entry of entries) {
		const held = fastestByExitIP.get(entry.screen.exitIP)
		if (held === undefined || rttOf(entry.screen) < rttOf(held.screen)) {
			fastestByExitIP.set(entry.screen.exitIP, entry)
		}
	}
	let refused = 0
	let alreadyKnown = 0
	// Slowest first, so that `addedAt` — which breaks ties in favour of newer
	// entries — also orders the arrivals. Two exits of identical rank would
	// otherwise be separated by object key order, which is not a ranking at all.
	const arrivals = [...fastestByExitIP.values()].sort((a, b) => rttOf(b.screen) - rttOf(a.screen))
	const base = Date.now()
	for (const [rank, entry] of arrivals.entries()) {
		const key = exitKey(entry.url)
		if (isQuarantined(key)) {
			refused++
			continue
		}
		if (known.has(key)) {
			alreadyKnown++
			continue
		}
		known.add(key)
		additions[key] = {
			label: redactAddress(entry.url),
			tier: 'builtin',
			url: entry.url,
			addedAt: base + rank,
			screen: entry.screen,
			...(entry.gate ? { gate: entry.gate } : {}),
		}
	}
	const admitted = Object.keys(additions).length
	if (admitted > 0) {
		const evidence = { ...store.evidence, ...additions }
		store = { ...store, evidence: evictFalsified(evidence) }
		pruneDiscovered()
		await persist()
	}
	return { admitted, duplicates: entries.length - fastestByExitIP.size, refused, alreadyKnown }
}

function rttOf(screen: ScreenEvidence): number {
	return screen.rttMs ?? Number.MAX_SAFE_INTEGER
}

/**
 * Remove discovered exits a gate probe has already falsified, before new arrivals
 * compete for the bounded pool.
 *
 * Waiting for {@link pruneDiscovered} to reach them does not work: it only trims
 * once the pool is over {@link BUILTIN_MAX}, so a full pool of stale addresses
 * keeps every slot while a refill that just proved six working exits has nowhere
 * to put them. Evicting first is what makes a refill actually replace what it
 * found dead.
 *
 * Only falsified-by-gate entries go. A screen failure on its own is not enough:
 * the lists are pulled again every refill, so an address that times out once may
 * be the same address that works on the next pass, and dropping it would lose an
 * exit without having learned anything about it.
 */
function evictFalsified(evidence: Record<string, ExitEvidence>): Record<string, ExitEvidence> {
	return dropUnverified(evidence, false)
}

/**
 * One pass over the store: keep the discovered exits worth keeping.
 *
 * `requireGate` is the difference between the two callers. Admission runs it off,
 * because an entry is being introduced right now and judging it before the gate has
 * spoken would evict the very arrival being admitted. {@link pruneUnverified} runs
 * it on, which is the invariant the pool is supposed to hold.
 *
 * Manual entries are never touched — they are the user's file, not our measurements.
 */
function dropUnverified(evidence: Record<string, ExitEvidence>, requireGate: boolean): Record<string, ExitEvidence> {
	const kept: Record<string, ExitEvidence> = {}
	let dropped = 0
	for (const [key, value] of Object.entries(evidence)) {
		if (value.tier === 'builtin') {
			const gate = value.gate
			if (gate !== undefined && falsifiesExit(gate.verdict)) {
				dropped++
				continue
			}
			if (requireGate && gate === undefined) {
				dropped++
				continue
			}
		}
		kept[key] = value
	}
	if (dropped === 0) return evidence
	// A pool whose selected exit has just been evicted would keep reporting that
	// selection while resolving to nothing.
	const selected = store.selected !== null && kept[store.selected] === undefined ? null : store.selected
	store = { ...store, selected }
	return kept
}

/**
 * A discovered address together with what screening already proved about it.
 *
 * `exitIP` is required rather than inherited as optional: it is the identity that
 * {@link admitDiscovered} deduplicates on, and an entry without one would either
 * all collide on `undefined` or silently escape the check.
 *
 * `gate` is optional because this is a store primitive, not the policy that decides
 * what belongs in the pool. The discovery pipeline ({@link import('./pool-probe.ts').discoverExit})
 * admits only what the gate accepted, and {@link pruneUnverified} enforces that
 * afterwards; keeping the verdict here is what lets an arrival land in the pool
 * already carrying the evidence that admitted it, rather than being written bare
 * and measured again.
 */
export interface DiscoveredExit {
	readonly url: string
	readonly screen: ScreenEvidence & { readonly exitIP: string }
	readonly gate?: GateEvidence
}

/**
 * What one admission did, in enough detail to explain a refill that added
 * nothing. "0 new exits" is ambiguous on its own — the causes call for opposite
 * reactions, so the numbers are kept rather than collapsed.
 */
export interface AdmissionReport {
	/** Landed in the pool. */
	readonly admitted: number
	/** Shared an exit IP with a faster address, so it was dropped. */
	readonly duplicates: number
	/** Still serving a 24-hour ban. */
	readonly refused: number
	/** Already a candidate before this admission. */
	readonly alreadyKnown: number
}

/** Drop the worst discovered exits once there are more than {@link BUILTIN_MAX}. */
function pruneDiscovered(): void {
	const discovered = Object.entries(store.evidence).filter(([, evidence]) => evidence.tier === 'builtin')
	if (discovered.length <= BUILTIN_MAX) return
	discovered.sort((a, b) => rankOf(a[1]) - rankOf(b[1]) || (b[1].addedAt ?? 0) - (a[1].addedAt ?? 0))
	const evidence = { ...store.evidence }
	let selected = store.selected
	for (const [key] of discovered.slice(BUILTIN_MAX)) {
		delete evidence[key]
		if (selected === key) selected = null
	}
	store = { ...store, evidence, selected }
}

/** Remove a candidate: a discovered one from the store, a manual one from the file. */
export async function removeCandidate(key: string): Promise<void> {
	const candidate = candidates().find((entry) => entry.key === key)
	if (!candidate) return
	if (candidate.tier === 'builtin') {
		const evidence = { ...store.evidence }
		delete evidence[key]
		store = { ...store, evidence, selected: store.selected === key ? null : store.selected }
		await persist()
		return
	}
	const { addresses } = await readExitFile()
	await writeExitFile(addresses.filter((address) => exitKey(address) !== key))
	await refreshManual()
}

/** Append one exit to the user's file. Returns the reason it could not, or null. */
export async function addCandidate(line: string): Promise<string | null> {
	const parsed = parseExitLines(line)
	const url = parsed.addresses[0]
	if (url === undefined) return parsed.rejected[0]?.reason ?? '无法解析这一行'
	const { addresses } = await readExitFile()
	if (addresses.includes(url)) return '这个出口已经在列表里'
	await writeExitFile([...addresses, url])
	await refreshManual()
	return null
}

export type ExitFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * The transport wrapper, or `undefined` when nothing should change.
 *
 * That return value is load-bearing: the handler spreads it into `options`, so a
 * pool that is off leaves the host's own fetch — and therefore `PI_PROXY` —
 * exactly as it was. "Off behaves like the feature was never installed" is a
 * property of the code, not a promise in a document.
 *
 * A second `undefined` case joins it: the pool is on and an exit is selected,
 * but this runtime has no per-request proxy mechanism (`transport.ts` resolves
 * that once at startup). Returning nothing there is deliberate. Returning a
 * function that quietly fetched directly is the bug this replaced — measured on
 * pi 1.3.0, where every request ignored the selected exit while the menu still
 * showed it as active. The caller warns once instead.
 *
 * A caller-supplied proxy deliberately beats the environment's: that is the
 * entire switching mechanism (FINDINGS §2.6).
 */
export function poolFetch(base?: ExitFetch): ExitFetch | undefined {
	const exit = active
	if (!exit) return undefined
	const proxied = proxiedFetch(exit.url, base)
	if (proxied === undefined) return undefined
	return (input, init) => {
		const target = targetURL(input)
		if (target === null || isBypassedHost(target.hostname)) return (base ?? globalThis.fetch)(input, init)
		return proxied(input, init)
	}
}

function targetURL(input: string | URL | Request): URL | null {
	try {
		return typeof input === 'string' || input instanceof URL ? new URL(input.toString()) : new URL(input.url)
	} catch {
		return null
	}
}

/**
 * Local traffic stays local.
 *
 * `NO_PROXY` is deliberately not consulted here: that variable exists to bypass
 * proxies configured elsewhere, while this fetch only ever carries the provider
 * traffic the user has just asked to route through a pool exit — honouring a
 * bypass rule here would silently un-pool exactly that traffic.
 */
function isBypassedHost(hostname: string): boolean {
	const host = hostname.toLowerCase()
	if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
	if (host === '[::1]' || host === '::1') return true
	return (
		/^127\./.test(host) ||
		/^10\./.test(host) ||
		/^192\.168\./.test(host) ||
		/^169\.254\./.test(host) ||
		/^172\.(?:1[6-9]|2\d|3[01])\./.test(host)
	)
}
