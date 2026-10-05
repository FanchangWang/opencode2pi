/**
 * Free-model discovery (docs/PLAN.md §T2).
 *
 * Three sources, and the ladder is deliberate:
 *
 *   S1  GET {zen}/v1/models   — who is actually for sale right now
 *   S2  models.dev            — what each one costs, and its real capabilities
 *   S3  static seed           — works with no network at all
 *
 * S1 is what keeps dead ids out. Measured 2026-10-05: 36 ids are priced at
 * zero in models.dev but only 13 of those are live on Zen — intersecting the
 * two is the difference between a useful list and 23 entries that 400 on first
 * use. S2 is what makes the judgment trustworthy: it is also the capability
 * source for T1, so both tiers share one parse.
 *
 * Everything runs concurrently and under our own deadline, because the host
 * kills `fetchDynamicModels` at a hard 15 s
 * (`RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS`) and a rejected fetch leaves the
 * provider with nothing. Returning the seed on any failure is the whole
 * contract: discovery must never be able to break the provider.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ProviderModelConfig } from '@oh-my-pi/pi-coding-agent'

import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, isFreeModel, normalizeEntry, type ModelsDevEntry } from './metadata.ts'
import { SEED_MODELS, VERIFIED_FREE } from './seed.ts'

const ZEN_BASE = 'https://opencode.ai/zen/v1'
const MODELS_DEV_URL = 'https://models.dev/api.json'
const MODELS_DEV_PROVIDER = 'opencode'
const ANONYMOUS_KEY = 'public'

/** Per-request deadline. Both run concurrently, so this is the whole budget. */
const REQUEST_TIMEOUT_MS = 9_000
/** models.dev changes sub-daily; a day-old cache costs nothing and survives outages. */
const METADATA_TTL_MS = 24 * 60 * 60 * 1000

interface MetadataCache {
	readonly fetchedAt: number
	readonly entries: readonly ModelsDevEntry[]
}

function cacheFile(): string {
	return join(tmpdir(), 'opencode2pi', `models-dev-${MODELS_DEV_PROVIDER}.json`)
}

/** Narrows an arbitrary parsed JSON blob to a models.dev entry, or drops it. */
function readEntry(raw: unknown): ModelsDevEntry | undefined {
	if (typeof raw !== 'object' || raw === null) return undefined
	if (!('id' in raw) || typeof raw.id !== 'string' || raw.id.length === 0) return undefined
	// The published shape is trusted field-by-field at use time; the container
	// is the only thing worth checking structurally, because a malformed entry
	// would otherwise surface as a confusing default-value log line.
	return raw as ModelsDevEntry
}

async function readDiskCache(): Promise<MetadataCache | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(cacheFile(), 'utf8'))
		if (typeof parsed !== 'object' || parsed === null) return undefined
		if (!('entries' in parsed) || !('fetchedAt' in parsed)) return undefined
		const { entries, fetchedAt } = parsed
		if (typeof entries !== 'object' || entries === null) return undefined
		if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) return undefined

		const restored: ModelsDevEntry[] = []
		for (const value of Object.values(entries)) {
			const entry = readEntry(value)
			if (entry) restored.push(entry)
		}
		return restored.length > 0 ? { entries: restored, fetchedAt } : undefined
	} catch {
		return undefined
	}
}

async function writeDiskCache(entries: readonly ModelsDevEntry[]): Promise<void> {
	const cache: MetadataCache = {
		fetchedAt: Date.now(),
		entries: [...entries],
	}
	try {
		await mkdir(join(tmpdir(), 'opencode2pi'), { recursive: true })
		await writeFile(cacheFile(), JSON.stringify(cache), 'utf8')
	} catch {
		// A cache we cannot write is a performance loss, never a failure.
	}
}

/** Parse the provider slice out of models.dev's whole-catalogue payload. */
function parseCatalog(payload: unknown): ModelsDevEntry[] {
	if (typeof payload !== 'object' || payload === null) return []
	if (!(MODELS_DEV_PROVIDER in payload)) return []
	const provider = payload[MODELS_DEV_PROVIDER]
	if (typeof provider !== 'object' || provider === null) return []
	if (!('models' in provider)) return []
	const models = provider.models
	if (typeof models !== 'object' || models === null) return []

	const entries: ModelsDevEntry[] = []
	for (const value of Object.values(models)) {
		const entry = readEntry(value)
		if (entry) entries.push(entry)
	}
	return entries
}

interface MetadataOutcome {
	readonly entries: readonly ModelsDevEntry[]
	readonly source: 'network' | 'cache' | 'none'
	readonly detail?: string
}

let metadataInflight: Promise<MetadataOutcome> | undefined

/**
 * Resolve models.dev entries.
 *
 * models.dev turns over sub-daily, so a cache younger than the TTL is used
 * without touching the network at all — that is what keeps the discovery
 * budget spent on the Zen catalogue, which genuinely has to be live. A stale
 * cache still beats nothing: last month's capabilities are worth more than
 * the host's silent 128000/16384 fallback.
 */
export function loadMetadata(): Promise<MetadataOutcome> {
	metadataInflight ??= (async (): Promise<MetadataOutcome> => {
		const disk = await readDiskCache()
		if (disk && Date.now() - disk.fetchedAt < METADATA_TTL_MS) {
			return { entries: disk.entries, source: 'cache', detail: 'fresh' }
		}
		try {
			const response = await fetch(MODELS_DEV_URL, {
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				headers: { accept: 'application/json' },
			})
			if (!response.ok) throw new Error(`HTTP ${response.status}`)
			const entries = parseCatalog(await response.json())
			if (entries.length === 0) throw new Error(`no models for provider ${MODELS_DEV_PROVIDER}`)
			await writeDiskCache(entries)
			return { entries, source: 'network' }
		} catch (error) {
			if (disk) return { entries: disk.entries, source: 'cache', detail: `stale: ${String(error)}` }
			return { entries: [], source: 'none', detail: String(error) }
		}
	})()
	return metadataInflight
}

/** Live catalogue straight from Zen: the authority on what exists right now. */
async function fetchLiveModelIds(): Promise<string[]> {
	const response = await fetch(`${ZEN_BASE}/models`, {
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		headers: { accept: 'application/json', authorization: `Bearer ${'public'}` },
	})
	if (!response.ok) throw new Error(`HTTP ${response.status}`)
	const payload: unknown = await response.json()
	if (typeof payload !== 'object' || payload === null) throw new Error('unexpected /models shape')
	if (!('data' in payload) || !Array.isArray(payload.data)) throw new Error('missing data[]')
	const ids: string[] = []
	for (const item of payload.data) {
		if (typeof item === 'object' && item !== null && 'id' in item && typeof item.id === 'string') {
			ids.push(item.id)
		}
	}
	return ids
}

export interface DiscoveryResult {
	readonly models: readonly ProviderModelConfig[]
	readonly diagnostics: readonly string[]
}

/**
 * Resolve the free lane. Never rejects and never returns an empty list: an
 * empty or rejected fetch would leave the provider with no models at all.
 */
export async function discoverFreeModels(): Promise<DiscoveryResult> {
	const diagnostics: string[] = []

	const [live, metadata] = await Promise.all([
		fetchLiveModelIds().catch((error: unknown) => {
			diagnostics.push(`S1 Zen /models unavailable (${String(error)}) → seed candidates`)
			return undefined
		}),
		loadMetadata(),
	])

	if (metadata.source === 'network') {
		diagnostics.push(`S2 models.dev: ${metadata.entries.length} entries (network)`)
	} else if (metadata.source === 'cache') {
		diagnostics.push(`S2 models.dev: ${metadata.entries.length} entries (disk cache, ${metadata.detail ?? 'stale'})`)
	} else {
		diagnostics.push(`S2 models.dev unavailable (${metadata.detail ?? 'unknown'}) → seed capabilities`)
	}

	const byId = new Map<string, ModelsDevEntry>()
	for (const entry of metadata.entries) byId.set(entry.id, entry)

	// S3: the seed is always a candidate, so a Zen outage cannot empty the list.
	const candidates = live ?? SEED_MODELS.map((model) => model.id)
	if (live) diagnostics.push(`S1 Zen /models: ${live.length} ids live`)

	const models: ProviderModelConfig[] = []
	const seen = new Set<string>()
	for (const id of candidates) {
		if (seen.has(id)) continue
		seen.add(id)
		if (!isFreeModel(id, byId.get(id), VERIFIED_FREE)) continue

		const entry = byId.get(id)
		if (entry) {
			const normalized = normalizeEntry(entry)
			// Capability notes are the whole point of T1: a defaulted field that
			// nobody logs is the failure mode FINDINGS §7.2 describes.
			if (normalized.notes.length > 0) diagnostics.push(`${id}: ${normalized.notes.join('; ')}`)
			const { config } = normalized
			models.push({
				...config,
				name: /free/i.test(config.name) ? config.name : `${config.name} (free)`,
			})
			continue
		}

		// No metadata for this id: the seed carries measured capabilities for the
		// ids we have actually exercised, so prefer it over guessing.
		const seed = SEED_MODELS.find((model) => model.id === id)
		if (seed) {
			models.push(seed)
			continue
		}
		// Live and free-by-name but entirely unknown (e.g. jev-1.13-free, which
		// has no models.dev entry at all). Conservative on every capability: no
		// reasoning, text only, host-generic limits — stated, not silent.
		diagnostics.push(
			`${id}: no metadata, free by name → conservative defaults ` +
				`(${DEFAULT_CONTEXT_WINDOW}/${DEFAULT_MAX_TOKENS}, text only)`,
		)
		models.push({
			id,
			name: `${id} (free)`,
			reasoning: false,
			input: ['text'],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: DEFAULT_CONTEXT_WINDOW,
			maxTokens: DEFAULT_MAX_TOKENS,
		})
	}

	if (models.length === 0) {
		diagnostics.push('discovery produced no models → seed')
		return { models: SEED_MODELS, diagnostics }
	}

	diagnostics.push(`final: ${models.length} free models`)
	return { models, diagnostics }
}
