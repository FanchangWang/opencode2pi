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
 * **Custom exits only.** The pool used to also pull free proxy lists and screen
 * them in bulk, but OpenCode now refuses the datacenter IP ranges those lists
 * are mostly made of with a 403, and the measured survivors were too few to pay
 * for the scan. What remains is `exits.txt`: the user's own infrastructure, one
 * proxy per line. There is no discovery, no screening and no tier split.
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
 */

import {
	exitEntries,
	exitKey,
	parseExitLines,
	readExitFile,
	writeExitFile,
	type ExitEntry,
} from './exits.ts'
import { readJson, writeJson } from './store.ts'
import { disposeProxyAgents, proxiedFetch } from './transport.ts'

const STORE_FILE = 'pool.json'
/**
 * Bumped when the shape or the meaning of the store changes.
 *
 * Version 3 removed the built-in tier: evidence for discovered exits and the
 * screen/quarantine state that only screening produced are dropped on read.
 * `exits.txt` is untouched — it was always the user's file.
 */
const STORE_VERSION = 3
/** Must be raised whenever {@link isVerified} changes meaning. */
const PROBE_VERSION = 2

/** Gate and completion verdicts older than this are shown, but no longer trusted. */
export const EXIT_TTL_MS = 6 * 60 * 60 * 1000
/**
 * How long a completed answer proves an exit works.
 *
 * Deliberately short, and much shorter than {@link EXIT_TTL_MS}. Proxies rot
 * within minutes — the user's report that a just-verified exit failed immediately
 * is the behaviour this window exists to prevent. Re-verifying costs one real
 * completion, which is cheap next to a failed turn; trusting a half-hour-old
 * answer is not.
 */
export const COMPLETION_TTL_MS = 30 * 60 * 1000
/** How long a `429` on one exit says anything: quota windows are minutes-to-a-day. */
export const LIMIT_TTL_MS = 30 * 60 * 1000

/**
 * What a gate probe through this exit said.
 *
 * `inconclusive` is not a shrug: it is the honest verdict for a failure the exit
 * cannot be blamed for (a 400 the model refuses, a 5xx, an unclassifiable body).
 * Only `region` / `transport` / `shape` falsify an exit.
 */
export type GateVerdict = 'ok' | 'limited' | 'region' | 'shape' | 'transport' | 'inconclusive'

/** A 429, a geo block, or a broken stream seen for one model on one exit. Keyed by model: see §4.4.1. */
export interface ModelMark {
	readonly at: number
	readonly kind: 'limited' | 'region' | 'transport'
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
 * A full turn through the exit: the stream was read to completion and the model
 * answered `OK`. This is the only evidence that qualifies an exit as verified.
 *
 * `received` is kept because "completed but said something else" and "the stream
 * died" are different diagnoses, and a detail string that only says `inconclusive`
 * makes the user re-run the probe to find out which one happened.
 */
export interface CompletionEvidence {
	readonly at: number
	readonly modelId: string
	readonly verdict: GateVerdict
	readonly status?: number
	readonly e2eMs: number
	readonly detail: string
	readonly received?: string
}

/** A real request that failed through the active exit, as observed on the request path. */
export interface PassiveFailure {
	readonly at: number
	readonly kind: 'limited' | 'region' | 'transport'
}

export interface ExitEvidence {
	/** Credential-free rendering; the only form that is printed. */
	readonly label: string
	readonly gate?: GateEvidence
	/**
	 * The completed turn. Absent on stores written before verification meant a
	 * completion (see {@link PROBE_VERSION}); `isVerified` never guesses from the
	 * weaker evidence.
	 */
	readonly completion?: CompletionEvidence
	/** The last real request that failed through this exit. */
	readonly lastFailure?: PassiveFailure
	readonly modelMarks?: Readonly<Record<string, ModelMark>>
}

export interface ExitCandidate {
	/** Store key: a hash of the full URL, so credentials never reach the store. */
	readonly key: string
	readonly label: string
	readonly url: string
}

export interface RejectedExit {
	readonly line: string
	readonly reason: string
}

interface PoolStore {
	readonly version: number
	/** Evidence generation; older records cannot answer the current question. */
	readonly probeVersion: number
	readonly enabled: boolean
	readonly selected: string | null
	readonly evidence: Readonly<Record<string, ExitEvidence>>
}

const EMPTY_STORE: PoolStore = {
	version: STORE_VERSION,
	probeVersion: PROBE_VERSION,
	enabled: false,
	selected: null,
	evidence: {},
}

let store: PoolStore = EMPTY_STORE
let manual: readonly ExitEntry[] = []
let rejected: readonly RejectedExit[] = []
/** Derived from `store` + `manual` on every mutation: the request path reads it per request. */
let active: ExitCandidate | undefined

/** Whether a timestamp is still treated as current under its own TTL. */
export function isFresh(at: number | undefined, ttl: number): boolean {
	return at !== undefined && Date.now() - at <= ttl
}

/**
 * Whether the exit has carried a **completed** turn recently.
 *
 * This is the pool's only claim of "usable" that survives contact with a real
 * request. A gate `200` (response headers) is a pre-filter, not proof: it can be
 * true of an exit that dies before the first token. See
 * {@link COMPLETION_TTL_MS} and {@link PROBE_VERSION}.
 *
 * A real failure observed after the verification (a 429/region event on the
 * request path, or a later gate falsification) revokes the claim immediately.
 * That is what makes "just verified, then immediately failed" visible in the menu
 * instead of leaving a stale ✅ on it.
 */
export function isVerified(evidence: ExitEvidence | undefined): boolean {
	const completion = evidence?.completion
	if (completion === undefined || completion.verdict !== 'ok') return false
	if (!isFresh(completion.at, COMPLETION_TTL_MS)) return false
	const failure = evidence?.lastFailure
	if (failure !== undefined && failure.at >= completion.at) return false
	const gate = evidence?.gate
	if (gate !== undefined && falsifiesExit(gate.verdict) && gate.at >= completion.at) return false
	return true
}

function withMark(evidence: ExitEvidence, modelId: string, kind: ModelMark['kind']): ExitEvidence {
	return { ...evidence, modelMarks: { ...(evidence.modelMarks ?? {}), [modelId]: { at: Date.now(), kind } } }
}

/**
 * Evidence for a candidate, created on first write.
 *
 * Exits deliberately have no entry in `pool.json` until something is measured
 * about them: their URL lives in `exits.txt`, and copying it into the store is
 * how a credential would end up in a second file. So the first gate test seeds
 * the record from the candidate itself.
 */
function ensureEvidence(key: string): ExitEvidence | undefined {
	const existing = store.evidence[key]
	if (existing) return existing
	const candidate = candidates().find((entry) => entry.key === key)
	return candidate === undefined ? undefined : { label: candidate.label }
}

function narrowCompletion(value: unknown): CompletionEvidence | undefined {
	if (typeof value !== 'object' || value === null) return undefined
	const record = value as Partial<CompletionEvidence>
	if (
		typeof record.at !== 'number' ||
		typeof record.modelId !== 'string' ||
		typeof record.verdict !== 'string' ||
		typeof record.e2eMs !== 'number' ||
		typeof record.detail !== 'string'
	) {
		return undefined
	}
	return {
		at: record.at,
		modelId: record.modelId,
		verdict: record.verdict as GateVerdict,
		e2eMs: record.e2eMs,
		detail: record.detail,
		...(typeof record.status === 'number' ? { status: record.status } : {}),
		...(typeof record.received === 'string' ? { received: record.received } : {}),
	}
}

function narrowGate(value: unknown): GateEvidence | undefined {
	if (typeof value !== 'object' || value === null) return undefined
	const record = value as Partial<GateEvidence>
	if (
		typeof record.at !== 'number' ||
		typeof record.modelId !== 'string' ||
		typeof record.verdict !== 'string' ||
		typeof record.e2eMs !== 'number' ||
		typeof record.detail !== 'string'
	) {
		return undefined
	}
	return {
		at: record.at,
		modelId: record.modelId,
		verdict: record.verdict as GateVerdict,
		e2eMs: record.e2eMs,
		detail: record.detail,
		...(typeof record.status === 'number' ? { status: record.status } : {}),
	}
}

function narrowFailure(value: unknown): PassiveFailure | undefined {
	if (typeof value !== 'object' || value === null) return undefined
	const record = value as Partial<PassiveFailure>
	if (
		typeof record.at !== 'number' ||
		(record.kind !== 'limited' && record.kind !== 'region' && record.kind !== 'transport')
	)
		return undefined
	return { at: record.at, kind: record.kind }
}

/**
 * Read one stored record, dropping everything the custom-only pool no longer
 * has: a `screen`, a `tier`, or a discovered exit's copied URL. Records that
 * belonged to the built-in tier are filtered out by key in {@link refreshManual},
 * because only `exits.txt` can name an exit now.
 */
function narrowEvidence(value: unknown): ExitEvidence | undefined {
	if (typeof value !== 'object' || value === null) return undefined
	const record = value as Partial<ExitEvidence> & { tier?: unknown }
	if (typeof record.label !== 'string') return undefined
	if (record.tier === 'builtin') return undefined
	const gate = narrowGate(record.gate)
	const completion = narrowCompletion(record.completion)
	const lastFailure = narrowFailure(record.lastFailure)
	return {
		label: record.label,
		...(gate === undefined ? {} : { gate }),
		...(completion === undefined ? {} : { completion }),
		...(lastFailure === undefined ? {} : { lastFailure }),
		...(record.modelMarks ? { modelMarks: record.modelMarks } : {}),
	}
}

function narrowStore(raw: unknown): { store: PoolStore; migrated: boolean } {
	if (typeof raw !== 'object' || raw === null) return { store: EMPTY_STORE, migrated: false }
	const record = raw as Partial<PoolStore>
	const version = typeof record.version === 'number' ? record.version : 0
	const evidence: Record<string, ExitEvidence> = {}
	const source = typeof record.evidence === 'object' && record.evidence !== null ? record.evidence : {}
	for (const [key, value] of Object.entries(source)) {
		const kept = narrowEvidence(value)
		if (kept) evidence[key] = kept
	}
	return {
		store: {
			version: STORE_VERSION,
			probeVersion: PROBE_VERSION,
			enabled: record.enabled === true,
			selected: typeof record.selected === 'string' ? record.selected : null,
			evidence,
		},
		migrated: version < STORE_VERSION,
	}
}

/** Every offerable exit: `exits.txt`, in file order — that is the user's own ranking. */
export function candidates(): readonly ExitCandidate[] {
	return manual.map((entry) => ({ key: entry.key, label: entry.label, url: entry.url }))
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

/** Whether any exit currently carries a completed answer. */
export function hasVerified(): boolean {
	return candidates().some((candidate) => isVerified(store.evidence[candidate.key]))
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
	const known = new Set(manual.map((entry) => entry.key))
	const evidence: Record<string, ExitEvidence> = {}
	for (const [key, value] of Object.entries(store.evidence)) {
		if (known.has(key)) evidence[key] = value
	}
	const selected = store.selected !== null && known.has(store.selected) ? store.selected : null
	// The selection can disappear behind the menu's back — the user edited
	// `exits.txt`, or a store written by the built-in tier named an exit that no
	// longer exists. Leaving `enabled: true` with no selection is the one state
	// that sends every request out of the machine's own IP while the menu says
	// the pool is on, so it is closed here rather than only in `removeCandidate`.
	const droppedSelection = store.selected !== null && selected === null
	const enabled = droppedSelection ? false : store.enabled
	// Write only when this read actually changed something. Startup calls this in
	// every process, and rewriting the store byte-identically on every launch is
	// a side effect with no reader — it would also make the extension create
	// `pool.json` for users who never open the pool.
	const changed =
		selected !== store.selected ||
		enabled !== store.enabled ||
		Object.keys(evidence).length !== Object.keys(store.evidence).length
	store = { ...store, evidence, selected, enabled }
	if (changed) await persist()
	else recompute()
}

async function persist(): Promise<void> {
	recompute()
	await writeJson(STORE_FILE, store)
}

export async function loadPool(): Promise<void> {
	const { store: loaded, migrated } = narrowStore(await readJson(STORE_FILE))
	store = loaded
	await refreshManual()
	// Only when the store shape actually moved. Startup runs in every process, so
	// the write has to stay conditional for the same reason `refreshManual` guards
	// its own: a store rewritten byte-identically on every launch is a side effect
	// with no reader.
	if (migrated) await persist()
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

/**
 * Whether a gate verdict says something about the exit or about the request.
 *
 * A region block, a dead route and a refused shape are all things a *different*
 * exit would have avoided, which is exactly what makes them worth showing as
 * refusals. A `429` is not — the proxy carried the request fine and the quota
 * behind it was already spent.
 */
function falsifiesExit(verdict: GateVerdict): boolean {
	return verdict === 'region' || verdict === 'transport' || verdict === 'shape'
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
 * Record a completed turn.
 *
 * A passing completion clears the real-failure suspicion, since the success is
 * newer than it. A `limited` completion is a quota fact, not an exit fault, and
 * neither is an `inconclusive` one (the model answered something other than OK).
 */
export async function recordCompletion(key: string, completion: CompletionEvidence): Promise<void> {
	let evidence = ensureEvidence(key)
	if (!evidence) return
	evidence = { ...evidence, completion }
	if (completion.verdict === 'ok') {
		const { lastFailure: _failure, ...rest } = evidence
		evidence = rest
	} else if (completion.verdict === 'limited') {
		evidence = withMark(evidence, completion.modelId, 'limited')
	} else if (completion.verdict === 'region') {
		evidence = withMark(evidence, completion.modelId, 'region')
	}
	store = { ...store, evidence: { ...store.evidence, [key]: evidence } }
	await persist()
}

/**
 * Attribute a real request's failure to the exit it went through.
 *
 * This is the only automatic thing the pool does, and it costs nothing: no extra
 * request, no retry, no behaviour change — it means the next `/opencode2pi pool`
 * shows what actually happened instead of a probe result that has stopped
 * describing the exit.
 *
 * `TRANSPORT` covers a stream that broke after the response headers arrived. The
 * host has already retried the underlying transport (~28 times in 120 s, §2.6),
 * so reaching here means the exit really did not carry the turn; without the
 * mark it would keep its ✅ from an earlier completion while failing every new
 * one. A user abort is filtered by the caller, not here: this function records
 * only failures another part of the code has already decided belong to the exit.
 */
export async function recordPassive(
	modelId: string,
	kind: 'RATE_LIMIT' | 'REGION_BLOCKED' | 'TRANSPORT',
): Promise<void> {
	const exit = active
	if (!exit) return
	const evidence = ensureEvidence(exit.key)
	if (!evidence) return
	const mark = kind === 'RATE_LIMIT' ? 'limited' : kind === 'REGION_BLOCKED' ? 'region' : 'transport'
	store = {
		...store,
		evidence: {
			...store.evidence,
			[exit.key]: {
				...withMark(evidence, modelId, mark),
				// Newer than the completion, so `isVerified` stops trusting it. This is
				// the difference between "verified 20 minutes ago" and "verified 20
				// minutes ago, then the very next turn was rate-limited".
				lastFailure: { at: Date.now(), kind: mark },
			},
		},
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
 * Remove one of the user's exits.
 *
 * Deleting the selected exit also closes the pool: an enabled pool with no
 * selection is the one state that silently spends the machine's own quota while
 * the menu says the pool is on. The caller may immediately select another exit,
 * which re-enables it.
 */
export async function removeCandidate(key: string): Promise<void> {
	const candidate = candidates().find((entry) => entry.key === key)
	if (!candidate) return
	const wasSelected = store.selected === key
	const { addresses } = await readExitFile()
	await writeExitFile(addresses.filter((address) => exitKey(address) !== key))
	await refreshManual()
	if (wasSelected) {
		store = { ...store, enabled: false, selected: null }
		await persist()
	}
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
