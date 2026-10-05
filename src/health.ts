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

/** Probes hit the same anonymous IP quota as real traffic, so stay polite. */
const PROBE_CONCURRENCY = 4
/** How long a stored verdict is shown before it is refreshed. */
export const HEALTH_TTL_MS = 6 * 60 * 60 * 1000

export type ModelHealth = 'ok' | 'flaky' | 'dead' | 'unknown'

export const HEALTH_MARK: Readonly<Record<ModelHealth, string>> = {
	ok: '✅',
	flaky: '⚠️',
	dead: '❌',
	unknown: '❓',
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
 */
function healthFor(kind: UpstreamFailure | 'OK'): ModelHealth {
	switch (kind) {
		case 'OK':
			return 'ok'
		case 'MODEL_GONE':
			return 'flaky'
		case 'REGION_BLOCKED':
			return 'dead'
		case 'RATE_LIMIT':
		case 'UPSTREAM':
			return 'flaky'
		default:
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
		// A timeout or transport failure says nothing about the model itself.
		return { ...base, health: 'flaky', kind: 'UPSTREAM', detail: `transport: ${probe.transportError}` }
	}

	const kind = classifyUpstreamFailure(probe.status, probe.body).kind
	return {
		...base,
		health: healthFor(kind),
		kind,
		detail: `HTTP ${probe.status} ${probe.body.slice(0, 200)}`,
	}
}

/** Probe every model with a bounded worker pool, reporting progress as it goes. */
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
			if (record.health !== 'ok' && record.health !== 'flaky' && record.health !== 'dead' && record.health !== 'unknown') continue
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

export async function saveHealth(results: readonly ProbeResult[]): Promise<HealthStore> {
	const merged = mergeHealth(await loadHealth(), results)

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
const VERDICT_ORDER: readonly ModelHealth[] = ['ok', 'flaky', 'unknown', 'dead']

/**
 * Summarize the roster's verdicts as they are *displayed*.
 *
 * The store, never the raw probe results, is the source of truth here: a
 * second consecutive `ModelError` promotes ⚠️ to ❌ in {@link mergeHealth} only,
 * so counting raw results makes the summary contradict the lines right below it.
 */
export function summarizeHealth(roster: readonly { readonly id: string }[], store: HealthStore): string {
	const counts: Record<ModelHealth, number> = { ok: 0, flaky: 0, dead: 0, unknown: 0 }
	for (const model of roster) counts[store[model.id]?.health ?? 'unknown']++
	return VERDICT_ORDER.filter((health) => counts[health] > 0)
		.map((health) => `${HEALTH_MARK[health]} ${counts[health]}`)
		.join('  ')
}
