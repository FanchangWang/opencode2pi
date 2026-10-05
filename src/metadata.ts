/**
 * Capability metadata for the free lane (docs/PLAN.md §T1), sourced from
 * models.dev.
 *
 * Why this file exists at all: a provider that under-reports capabilities does
 * not fail loudly. It fails by *quietly truncating* — the host falls back to a
 * generic 128000/16384 and the request dies somewhere deep in a long context
 * with nothing pointing at the real cause (docs/FINDINGS.md §7.2). So every
 * value this module emits is either measured or explicitly defaulted *here*,
 * and each default carries a reason string that reaches the log.
 *
 * The mapping is deliberately flat. The host adopts `contextWindow`,
 * `maxTokens`, `cost`, `input`, `reasoning` and `thinking` verbatim and
 * silently ignores a nested `limits: {context, output}` (docs/FINDINGS.md
 * §7.1/§7.2), so models.dev's `limit.context` / `limit.output` must be renamed
 * on the way through rather than passed through.
 */

import type { Effort } from '@earendil-works/pi-ai'
import type { ProviderModelConfig } from '@oh-my-pi/pi-coding-agent'

import { UNAVAILABLE } from './seed.ts'

/**
 * Fallbacks used only when models.dev has nothing usable for a field. These
 * mirror the host's generic values on purpose: matching them keeps behaviour
 * identical to today, while emitting them explicitly (with a logged reason)
 * removes the silent part.

 */
export const DEFAULT_CONTEXT_WINDOW = 128_000
export const DEFAULT_MAX_TOKENS = 16_384

/** Effort levels the host accepts; anything else is dropped rather than forwarded. */
const KNOWN_EFFORTS: ReadonlySet<string> = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function isEffort(value: unknown): value is Effort {
	return typeof value === 'string' && KNOWN_EFFORTS.has(value)
}

/**
 * A models.dev entry, read defensively: this is third-party JSON, so every
 * field is `unknown` until proven otherwise.
 */
export interface ModelsDevEntry {
	readonly id: string
	readonly name?: string
	readonly limit?: { readonly context?: unknown; readonly output?: unknown }
	readonly cost?: { readonly input?: unknown; readonly output?: unknown; readonly cache_read?: unknown; readonly cache_write?: unknown }
	readonly modalities?: { readonly input?: unknown }
	readonly reasoning?: unknown
	readonly reasoning_options?: unknown
	readonly deprecated?: unknown
}

/** Reads a token limit, falling back to `fallback` and recording why. */
function readLimit(raw: unknown, label: string, fallback: number, notes: string[]): number {
	if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
		notes.push(`${label} missing or invalid → ${fallback}`)
		return fallback
	}
	return raw
}

/** Reads a price component, falling back to free (0) and recording why. */
function readCost(raw: unknown, label: string, notes: string[]): number {
	if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
		notes.push(`${label} missing or invalid → 0`)
		return 0
	}
	return raw
}

/** Text + image are the only input kinds the host models; audio/video are dropped. */
function inputModalities(entry: ModelsDevEntry, notes: string[]): ('text' | 'image')[] {
	const raw = entry.modalities?.input
	if (!Array.isArray(raw)) {
		notes.push('modalities.input missing or invalid → text')
		return ['text']
	}
	const declared = raw.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image')
	const unsupported = raw.filter(
		(value) => typeof value === 'string' && value !== 'text' && value !== 'image',
	)
	if (unsupported.length > 0) notes.push(`input modalities not host-modellable, dropped: ${unsupported.join(', ')}`)
	if (declared.includes('text')) return declared
	notes.push('modalities.input declares no text → forcing text')
	return ['text', ...declared]
}

/**
 * Effort control surface. models.dev expresses this as a list of option
 * objects; only `{type: 'effort', values: [...]}` maps onto the host's
 * `thinking.efforts`. A `toggle` model has no effort axis, so it gets
 * `thinking: undefined` and the host derives its default four levels from
 * `reasoning: true` — which is exactly what an empty efforts list must NOT do,
 * since the host contract requires efforts to be non-empty.
 */
function thinkingConfig(entry: ModelsDevEntry, reasoning: boolean): ProviderModelConfig['thinking'] {
	if (!reasoning || !Array.isArray(entry.reasoning_options)) return undefined

	const efforts: Effort[] = []
	for (const option of entry.reasoning_options) {
		if (typeof option !== 'object' || option === null) continue
		if (!('type' in option) || option.type !== 'effort') continue
		if (!('values' in option) || !Array.isArray(option.values)) continue
		for (const value of option.values) {
			if (isEffort(value) && !efforts.includes(value)) efforts.push(value)
		}
	}
	if (efforts.length === 0) return undefined
	return { mode: 'effort', efforts }
}

export interface NormalizedModel {
	readonly config: ProviderModelConfig
	/** Reasons any field fell back to a default. Empty when the entry was complete. */
	readonly notes: readonly string[]
}

/**
 * Project one models.dev entry onto the host's model config contract.
 *
 * `maxTokens` is clamped to `contextWindow`: `nemotron-3.5-lightning-free`
 * reports `output == context == 262144`, and a per-response cap that exceeds
 * the model's own window is nonsense even when upstream publishes it.
 */
export function normalizeEntry(entry: ModelsDevEntry): NormalizedModel {
	const notes: string[] = []

	const contextWindow = readLimit(entry.limit?.context, 'limit.context', DEFAULT_CONTEXT_WINDOW, notes)
	const declaredMax = readLimit(entry.limit?.output, 'limit.output', DEFAULT_MAX_TOKENS, notes)
	let maxTokens = declaredMax
	if (maxTokens > contextWindow) {
		notes.push(`limit.output ${maxTokens} exceeds context ${contextWindow} → clamped`)
		maxTokens = contextWindow
	}

	const reasoning = entry.reasoning === true
	const thinking = thinkingConfig(entry, reasoning)
	if (reasoning && Array.isArray(entry.reasoning_options) && thinking === undefined) {
		notes.push('reasoning_options carries no effort axis → host defaults')
	}

	const name = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : entry.id
	if (name === entry.id) notes.push('name missing → using id')

	const config: ProviderModelConfig = {
		id: entry.id,
		name,
		reasoning,
		input: inputModalities(entry, notes),
		cost: {
			input: readCost(entry.cost?.input, 'cost.input', notes),
			output: readCost(entry.cost?.output, 'cost.output', notes),
			cacheRead: readCost(entry.cost?.cache_read, 'cost.cache_read', notes),
			cacheWrite: readCost(entry.cost?.cache_write, 'cost.cache_write', notes),
		},
		contextWindow,
		maxTokens,
	}
	if (thinking) config.thinking = thinking

	return { config, notes }
}

/**
 * Free-lane judgment for one id.
 *
 * Order is the whole point (docs/PLAN.md §T2):
 *
 *  1. a verified-rejected id never ships, whatever its price says — both are
 *     priced at zero upstream and would otherwise be re-advertised forever;
 *  2. `deprecated` vetoes, including a `*-free` name: upstream retiring a
 *     model outranks the name it was published under;
 *  3. verified ids pass unconditionally, because their name carries no signal
 *     (`big-pickle` is the case that matters);
 *  4. **metadata decides when it is complete.** `deepseek-v4-flash-free` stayed
 *     in opencode2dsh's list forever precisely because name-matching ran
 *     first, so price outranks name here;
 *  5. only when metadata is absent or incomplete does the `free` name
 *     heuristic apply — `jev-1.13-free` is live upstream with no models.dev
 *     entry at all, and is exactly this case.
 */
export function isFreeModel(
	id: string,
	entry: ModelsDevEntry | undefined,
	verifiedFree: Readonly<Record<string, true>>,
): boolean {
	if (id in UNAVAILABLE) return false
	if (entry?.deprecated) return false
	if (verifiedFree[id] === true) return true

	const costInput = entry?.cost?.input
	const costOutput = entry?.cost?.output
	if (typeof costInput !== 'number' || typeof costOutput !== 'number') return id.includes('free')
	return costInput === 0 && costOutput === 0
}
