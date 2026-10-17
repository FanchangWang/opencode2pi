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

const STORE_FILE = 'pool.json'
const STORE_VERSION = 1

/** Screen and gate verdicts older than this are shown, but no longer trusted. */
export const EXIT_TTL_MS = 6 * 60 * 60 * 1000
/** How long a `429` on one exit says anything: quota windows are minutes-to-a-day. */
export const LIMIT_TTL_MS = 30 * 60 * 1000
/** Above this, a candidate is not worth spending a quota probe on (3 s, as opencode2dsh). */
export const SCREEN_MAX_RTT_MS = 3000
/** Discovered free exits rot within hours: keep a handful, not a farm. */
const BUILTIN_MAX = 12

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
}

const EMPTY_STORE: PoolStore = { version: STORE_VERSION, enabled: false, selected: null, evidence: {} }

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
	const gate = evidence.gate
	if (gate !== undefined && (gate.verdict === 'region' || gate.verdict === 'transport' || gate.verdict === 'shape')) {
		return false
	}
	if (gate?.verdict === 'ok' && isFresh(gate.at, EXIT_TTL_MS)) return true
	const screen = evidence.screen
	if (!screen || screen.error !== undefined || screen.rttMs === undefined) return false
	return isFresh(screen.at, EXIT_TTL_MS) && screen.rttMs <= SCREEN_MAX_RTT_MS
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
		...(record.screen ? { screen: record.screen } : {}),
		...(record.gate ? { gate: record.gate } : {}),
		...(record.modelMarks ? { modelMarks: record.modelMarks } : {}),
	}
}

function narrowStore(raw: unknown): PoolStore {
	if (typeof raw !== 'object' || raw === null) return EMPTY_STORE
	const record = raw as Partial<PoolStore>
	const evidence: Record<string, ExitEvidence> = {}
	const source = typeof record.evidence === 'object' && record.evidence !== null ? record.evidence : {}
	for (const [key, value] of Object.entries(source)) {
		const kept = narrowEvidence(value)
		if (kept) evidence[key] = kept
	}
	return {
		version: STORE_VERSION,
		enabled: record.enabled === true,
		selected: typeof record.selected === 'string' ? record.selected : null,
		evidence,
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

/** Re-derive the active candidate. Every mutation ends here. */
function recompute(): void {
	active = store.enabled && store.selected !== null
		? candidates().find((candidate) => candidate.key === store.selected)
		: undefined
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
	store = narrowStore(await readJson(STORE_FILE))
	await refreshManual()
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

/** Record a gate probe, folding its refusals into the per-model marks too. */
export async function recordGate(key: string, gate: GateEvidence): Promise<void> {
	let evidence = ensureEvidence(key)
	if (!evidence) return
	evidence = { ...evidence, gate }
	if (gate.verdict === 'limited') evidence = withMark(evidence, gate.modelId, 'limited')
	if (gate.verdict === 'region') evidence = withMark(evidence, gate.modelId, 'region')
	store = { ...store, evidence: { ...store.evidence, [key]: evidence } }
	await persist()
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

/** Adopt discovered free exits, keeping the store bounded. Returns how many landed. */
export async function admitDiscovered(urls: readonly string[]): Promise<number> {
	const known = new Set(candidates().map((candidate) => candidate.key))
	const additions: Record<string, ExitEvidence> = {}
	for (const url of urls) {
		const key = exitKey(url)
		if (known.has(key)) continue
		known.add(key)
		additions[key] = { label: redactAddress(url), tier: 'builtin', url, addedAt: Date.now() }
	}
	if (Object.keys(additions).length === 0) return 0
	store = { ...store, evidence: { ...store.evidence, ...additions } }
	pruneDiscovered()
	await persist()
	return Object.keys(additions).length
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

/** `RequestInit` plus the option Bun's fetch uses for a per-request proxy. */
type ProxiedInit = RequestInit & { proxy?: string }

/**
 * The transport wrapper, or `undefined` when nothing should change.
 *
 * That return value is load-bearing: the handler spreads it into `options`, so a
 * pool that is off leaves the host's own fetch — and therefore `PI_PROXY` —
 * exactly as it was. "Off behaves like the feature was never installed" is a
 * property of the code, not a promise in a document.
 *
 * A caller-supplied `init.proxy` deliberately beats the environment's: that is
 * the entire switching mechanism (FINDINGS §2.6).
 */
export function poolFetch(base?: ExitFetch): ExitFetch | undefined {
	const exit = active
	if (!exit) return undefined
	const inner = base ?? globalThis.fetch
	return (input, init) => {
		const target = targetURL(input)
		if (target === null || isBypassedHost(target.hostname)) return inner(input, init)
		const proxied: ProxiedInit = { ...(init ?? {}), proxy: exit.url }
		return inner(input, proxied)
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
