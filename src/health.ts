/**
 * Per-model health probing (docs/PLAN.md §T5).
 *
 * The probe speaks to Zen directly rather than through the host engine, for
 * two reasons. It has to: the whole point of `doctor` is to test the *shape
 * gate* this extension hardcodes, and routing through the engine would make a
 * broken gate indistinguishable from a broken model. And it keeps the check
 * honest about cost — one aborted stream beats a full agent turn.
 *
 * Two verdicts, deliberately kept apart:
 *
 *   dead  — upstream will never serve this id again (401 / 404 / ModelError /
 *           geo-block). Sticky: a later 503 does not resurrect it.
 *   flaky — unavailable *right now* (429 / 5xx / timeout). Never promoted to
 *           dead on transient evidence, which is exactly how
 *           `ling-3.0-flash-fin-free` would get wrongly struck off the roster.
 *
 * Health is annotation only. It never removes a model from the roster.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ProviderModelConfig } from '@oh-my-pi/pi-coding-agent'

import { classifyUpstreamFailure, type UpstreamFailure } from './errors.ts'
import { sendGateProbe } from './gate.ts'

/**
 * Probe pacing.
 *
 * The anonymous lane meters per egress IP, so a sweep of 13 requests fired at
 * once spends quota the next sweep needs. Concurrency 2 with a short pause keeps
 * a sweep from starving its own follow-up.
 *
 * Measured 2026-10-06: 429 turned out to be metered *per model*, not per IP —
 * `big-pickle` answered 200 in the same minute that two other ids answered 429,
 * serially and 1.5 s apart. So pacing reduces self-inflicted pressure but does
 * not cure it, which is why a rate-limited verdict gets its own mark instead of
 * being reported as an unstable model.
 */
const PROBE_CONCURRENCY = 2
const PROBE_GAP_MS = 500

function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>()
	setTimeout(resolve, ms)
	return promise
}
/**
 * How long a verdict may be shown before `status` stops treating it as current.
 *
 * Six hours, not a day: the free pool churns on the order of hours, and a stale
 * verdict is flagged (`（已过期）`) rather than re-run — a full sweep costs real
 * inference, so it is the user's call, which is what `probe` is for.
 */
export const HEALTH_TTL_MS = 6 * 60 * 60 * 1000

export type ModelHealth = 'ok' | 'flaky' | 'dead' | 'unknown' | 'limited'

export const HEALTH_MARK: Readonly<Record<ModelHealth, string>> = {
	ok: '✅',
	flaky: '⚠️',
	dead: '❌',
	unknown: '❓',
	limited: '🚧',
}

export interface HealthRecord {
	readonly health: ModelHealth
	readonly kind: UpstreamFailure | 'OK'
	readonly detail: string
	readonly checkedAt: number
	/** Consecutive `MODEL_GONE` verdicts; two are required before ❌. */
	readonly terminalFailures: number
	/** Consecutive transient failures; hints at an outage, never at death. */
	readonly transientFailures: number
}

/** Consecutive `ModelError`s required before a model is called dead. */
export const TERMINAL_FAILURES_TO_CONDEMN = 2

/**
 * Map a classified failure onto a provisional health verdict.
 *
 * Shape and auth rejections are deliberately *not* per-model verdicts: both are
 * lane-wide, so blaming a model for them would paint ❌ across the entire roster
 * at the exact moment the gate breaks. Those surface through `doctor`.
 *
 * `MODEL_GONE` starts as ⚠️ rather than ❌, and `saveHealth` only promotes it
 * after {@link TERMINAL_FAILURES_TO_CONDEMN} consecutive hits. That is not
 * caution for its own sake — measured 2026-10-05, `nemotron-3.ultra-free`
 * answered `401 ModelError` on one probe and `200` on the next, a minute
 * apart. Promoting on the first terminal verdict would mark a working model
 * dead, which is the exact mistake this whole feature exists to avoid.
 *
 * `REGION_BLOCKED` is the exception: a geo block is deterministic for a given
 * egress, so one hit is conclusive.
 *
 * `RATE_LIMIT` is not a verdict on the model at all. The anonymous lane meters
 * quota separately per model — measured 2026-10-06, `big-pickle` answered 200
 * while two other ids answered 429 in the same minute, probed serially — so a
 * 429 says "this id is out of quota right now", which is a fact about the lane
 * and not about whether the model works. It gets its own mark so that a quota
 * pause never masquerades as an unstable model.
 */
export function healthFor(kind: UpstreamFailure | 'OK'): ModelHealth {
	switch (kind) {
		case 'OK':
			return 'ok'
		case 'MODEL_GONE':
			return 'flaky'
		// A geo block is deterministic for a given egress: the same request from
		// the same network keeps saying no.
		case 'REGION_BLOCKED':
			return 'dead'
		case 'RATE_LIMIT':
			return 'limited'
		// A request the upstream rejected is the model refusing this particular
		// round, which is evidence about the request, not a state of the model:
		// measured on `ling-3.0-flash-fin-free` it answers 400 for one input
		// and works for the next. An unrecognised failure carries no more
		// evidence than a 5xx does — the classifier simply did not recognise the
		// text — so giving it a verdict of its own would invent a fifth state
		// that only ever showed up in `status`.
	case 'REQUEST_REJECTED':
	case 'UNKNOWN':
	case 'UPSTREAM':
		return 'flaky'
		// The shape gate and the credential are lane-wide, so blaming a model
		// for them would paint ❓ across the whole roster at the exact moment
		// the gate breaks. They surface through `doctor` instead.
	case 'SHAPE_REJECTED':
	case 'AUTH':
		return 'unknown'
	}
}

export interface ProbeResult extends HealthRecord {
	readonly modelId: string
	readonly latencyMs: number
}

async function probeModel(modelId: string): Promise<ProbeResult> {
	const probe = await sendGateProbe(modelId)
	const base = { modelId, checkedAt: Date.now(), terminalFailures: 0, transientFailures: 0, latencyMs: probe.latencyMs }

	if (probe.ok) {
		return { ...base, health: 'ok', kind: 'OK', detail: `HTTP ${probe.status}` }
	}
	if (probe.transportError !== undefined) {
		// A timeout or transport failure says nothing about the model itself:
		// the 30 s budget can expire on a slow lane, or the request never left.
		return { ...base, health: 'limited', kind: 'UPSTREAM', detail: `transport: ${probe.transportError}` }
}

	const kind = classifyUpstreamFailure(probe.status, probe.body).kind
	return {
		...base,
		health: healthFor(kind),
		kind,
		detail: `HTTP ${probe.status} ${probe.body.slice(0, 200)}`,
	}
}

/** Probe every model with a bounded, paced worker pool, reporting progress as it goes. */
export async function probeAll(
	models: readonly ProviderModelConfig[],
	onProgress?: (done: number, total: number, result: ProbeResult) => void,
): Promise<ProbeResult[]> {
	const results: ProbeResult[] = []
	let cursor = 0

	async function worker(): Promise<void> {
		while (cursor < models.length) {
			const model = models[cursor++]
			if (!model) return
			const result = await probeModel(model.id)
			results.push(result)
			onProgress?.(results.length, models.length, result)
			await delay(PROBE_GAP_MS)
		}
	}

	await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, models.length) }, worker))
	results.sort((a, b) => a.modelId.localeCompare(b.modelId))
	return results
}

export type HealthStore = Readonly<Record<string, HealthRecord>>

function storeFile(): string {
	return join(tmpdir(), 'opencode2pi', 'health.json')
}

export async function loadHealth(): Promise<HealthStore> {
	try {
		const parsed: unknown = JSON.parse(await readFile(storeFile(), 'utf8'))
		if (typeof parsed !== 'object' || parsed === null) return {}
		const out: Record<string, HealthRecord> = {}
		for (const [id, value] of Object.entries(parsed)) {
			if (typeof value !== 'object' || value === null) continue
			if (!('health' in value) || !('checkedAt' in value)) continue
			const record = value as Partial<HealthRecord>
			if (typeof record.checkedAt !== 'number') continue
			if (
				record.health !== 'ok' &&
				record.health !== 'flaky' &&
				record.health !== 'dead' &&
				record.health !== 'unknown' &&
				record.health !== 'limited'
			)
				continue
			out[id] = {
				health: record.health,
				kind: record.kind ?? 'UNKNOWN',
				detail: typeof record.detail === 'string' ? record.detail : '',
				checkedAt: record.checkedAt,
				terminalFailures: typeof record.terminalFailures === 'number' ? record.terminalFailures : 0,
				transientFailures: typeof record.transientFailures === 'number' ? record.transientFailures : 0,
			}
		}
		return out
	} catch {
		return {}
	}
}

/**
 * Merge fresh probe results into the store.
 *
 * A single `MODEL_GONE` is not enough to condemn: it is promoted to ❌ only
 * after {@link TERMINAL_FAILURES_TO_CONDEMN} consecutive terminal verdicts, and
 * any success clears both counters so a model with a bad afternoon recovers on
 * its own. A model already marked dead keeps the verdict across a *transient*
 * re-probe, but a success always clears it.
 */
export function mergeHealth(previous: HealthStore, results: readonly ProbeResult[]): HealthStore {
	const merged: Record<string, HealthRecord> = { ...previous }

	for (const result of results) {
		// Read the accumulating map, not the pre-call snapshot: two terminal
		// verdicts for the same id within one batch must count as consecutive.
		const before = merged[result.modelId]
		const terminalFailures = result.kind === 'MODEL_GONE' ? (before?.terminalFailures ?? 0) + 1 : 0
		const transientFailures = result.health === 'ok' ? 0 : (before?.transientFailures ?? 0) + 1

		let health = result.health
		if (result.kind === 'MODEL_GONE' && terminalFailures >= TERMINAL_FAILURES_TO_CONDEMN) {
			health = 'dead'
		} else if (before?.health === 'dead' && result.health !== 'ok') {
			health = 'dead'
		}

		merged[result.modelId] = {
			health,
			kind: result.kind,
			detail: result.detail,
			checkedAt: result.checkedAt,
			terminalFailures,
			transientFailures,
		}
	}
	return merged
}

/**
 * Drop every model the current roster no longer contains.
 *
 * The free lane follows upstream: models get added and withdrawn, so a
 * merge-only store accumulates the whole history of ids — `no-such-model-xyz`
 * and other ids that were never real — and grows without bound. A probe covers
 * exactly the current roster (`probeAll` walks it end to end), so the ids in
 * `results` *are* the roster, and anything else is a model upstream retired.
 * Keeping those records would answer no question anyone can still ask.
 */
export function pruneHealth(store: HealthStore, keep: ReadonlySet<string>): HealthStore {
	const pruned: Record<string, HealthRecord> = {}
	for (const [id, record] of Object.entries(store)) {
		if (keep.has(id)) pruned[id] = record
	}
	return pruned
}

/**
 * Merge fresh probe results into the store and write it back.
 *
 * `keep` is the roster the caller just looked at, not the ids this batch
 * covered: `status` probes only the models it has no record of, and pruning to
 * the batch would throw away every verdict it just refused to re-run.
 */
export async function saveHealth(results: readonly ProbeResult[], keep: ReadonlySet<string>): Promise<HealthStore> {
	const merged = pruneHealth(mergeHealth(await loadHealth(), results), keep)

	try {
		await mkdir(join(tmpdir(), 'opencode2pi'), { recursive: true })
		await writeFile(storeFile(), JSON.stringify(merged), 'utf8')
	} catch {
		// An unwritable cache only costs a re-probe.
	}
	return merged
}

export function isStale(record: HealthRecord | undefined): boolean {
	return record === undefined || Date.now() - record.checkedAt > HEALTH_TTL_MS
}

/** Canonical order, so the summary reads the same way on every run. */
const VERDICT_ORDER: readonly ModelHealth[] = ['ok', 'flaky', 'limited', 'unknown', 'dead']

/**
 * Summarize the roster's verdicts as they are *displayed*.
 *
 * The store, never the raw probe results, is the source of truth here: a second
 * consecutive `ModelError` promotes ⚠️ to ❌ in {@link mergeHealth} only, so
 * counting raw results makes the summary contradict the lines right below it. A
 * model with no record is not a verdict and is not counted as one — its roster
 * line says `未探测`, which is a statement about our coverage, not about the
 * model.
 */
export function summarizeHealth(roster: readonly { readonly id: string }[], store: HealthStore): string {
	const counts: Record<ModelHealth, number> = { ok: 0, flaky: 0, dead: 0, unknown: 0, limited: 0 }
	for (const model of roster) {
		const health = store[model.id]?.health
		if (health) counts[health]++
	}
	return VERDICT_ORDER.filter((health) => counts[health] > 0)
		.map((health) => `${HEALTH_MARK[health]} ${counts[health]}`)
		.join('  ')
}
