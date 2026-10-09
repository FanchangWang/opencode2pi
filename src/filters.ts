/**
 * Which models the roster hides, decided by the user rather than by us.
 *
 * Health is annotation by default: a model that failed one probe stays in the
 * list, because the evidence says verdicts move (docs/FINDINGS.md §8 —
 * `nemotron-3.ultra-free` answered `401 ModelError` and then `200` a minute
 * apart). Anything automatic would therefore be wrong half the time, so the rule
 * set is opt-in and the user picks it in the TUI.
 *
 * What is *never* offered is hiding on a quota pause or an unreachable lane:
 * those are facts about the channel, not about the model, and hiding on them
 * empties the roster at exactly the moment it is worth having.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HealthStore, ModelHealth } from './health.ts'

export interface ProbeFilters {
	/** Hide models the upstream refuses from this egress. */
	readonly hideRegionBlocked: boolean
	/** Hide models that failed for a reason attributable to them. */
	readonly hideFailed: boolean
}

export const DEFAULT_FILTERS: ProbeFilters = { hideRegionBlocked: false, hideFailed: false }

/**
 * Verdicts that belong to the model rather than to the lane.
 *
 * Keyed on the *displayed* verdict rather than on the failure kind, because that
 * is what the roster line shows and what the promise has to hold against:
 * `RATE_LIMIT` and a transport timeout are both 🚧 `limited`, and a 400 or an
 * unrecognised 5xx is ⚠️ `flaky`. Keying on the verdict makes "配额与链路故障
 * 永远不隐藏任何模型" true by construction instead of by a list someone can
 * forget to update.
 */
const HIDDEN_VERDICTS: ReadonlySet<ModelHealth> = new Set<ModelHealth>(['dead', 'flaky'])

/** Ids the roster should not advertise under these filters. */
export function hiddenFromStore(store: HealthStore, filters: ProbeFilters): ReadonlySet<string> {
	if (!filters.hideFailed && !filters.hideRegionBlocked) return new Set()
	const hidden = new Set<string>()
	for (const [id, record] of Object.entries(store)) {
		if (filters.hideFailed && HIDDEN_VERDICTS.has(record.health)) hidden.add(id)
		else if (filters.hideRegionBlocked && record.kind === 'REGION_BLOCKED') hidden.add(id)
	}
	return hidden
}

function storeFile(): string {
	return join(tmpdir(), 'opencode2pi', 'filters.json')
}

export async function loadFilters(): Promise<ProbeFilters> {
	try {
		const parsed: unknown = JSON.parse(await readFile(storeFile(), 'utf8'))
		if (typeof parsed !== 'object' || parsed === null) return DEFAULT_FILTERS
		const record = parsed as Partial<ProbeFilters>
		return {
			hideRegionBlocked: record.hideRegionBlocked === true,
			hideFailed: record.hideFailed === true,
		}
	} catch {
		return DEFAULT_FILTERS
	}
}

export async function saveFilters(filters: ProbeFilters): Promise<void> {
	try {
		await mkdir(join(tmpdir(), 'opencode2pi'), { recursive: true })
		await writeFile(storeFile(), JSON.stringify(filters), 'utf8')
	} catch {
		// An unwritable filter file costs one re-selection, never a wrong roster.
	}
}

let activeFilters: ProbeFilters = DEFAULT_FILTERS
let activeHealth: HealthStore = {}
let activeHidden: ReadonlySet<string> = new Set()

const listeners: (() => void)[] = []

/** Ids the roster must not advertise right now. */
export function hidden(): ReadonlySet<string> {
	return activeHidden
}

/** Re-derive the hidden set and tell the provider registry when it moved. */
function republish(): void {
	const next = hiddenFromStore(activeHealth, activeFilters)
	if (next.size === activeHidden.size && [...next].every((id) => activeHidden.has(id))) return
	activeHidden = next
	for (const listener of listeners) listener()
}

/**
 * Adopt the user's choice. The caller has already asked; this only records the
 * answer and re-derives what it hides.
 */
export function publishFilters(filters: ProbeFilters): void {
	activeFilters = filters
	republish()
}

/** Adopt a fresh verdict store, so the hidden set follows every probe. */
export function publishHealth(store: HealthStore): void {
	activeHealth = store
	republish()
}

/** Called by the provider registration when the roster it advertises changes. */
export function onHiddenChange(listener: () => void): () => void {
	listeners.push(listener)
	return () => {
		const index = listeners.indexOf(listener)
		if (index >= 0) listeners.splice(index, 1)
	}
}