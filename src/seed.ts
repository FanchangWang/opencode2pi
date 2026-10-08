/**
 * Static model seed — tier S3 of the discovery ladder (docs/PLAN.md §T2) and the
 * offline fallback for capability metadata (docs/PLAN.md §T1).
 *
 * Two jobs, both forced by measured host behaviour:
 *
 *  1. **`models` must be populated at registration time.** With only
 *     `fetchDynamicModels`, `--model provider/id` fails cold with
 *     `Model not found` in 0.6 s — async discovery lands too late to take part
 *     in `--model` resolution (docs/FINDINGS.md §7.3). The seed is what makes
 *     cold start work at all.
 *
 *  2. **Every entry carries real numbers.** `ProviderModelConfig` marks
 *     `contextWindow` / `maxTokens` required, and a nested `limits: {context,
 *     output}` is silently ignored, falling back to the host's generic
 *     128000/16384 with no warning (docs/FINDINGS.md §7.2). The values below
 *     are snapshots of models.dev `limit` for these ids, so an offline run
 *     gets true capabilities instead of the silent fallback.
 */

import type { ProviderModelConfig } from '@oh-my-pi/pi-coding-agent'

/** Ids verified end-to-end against the anonymous lane. */
export const SEED_MODELS: readonly ProviderModelConfig[] = [
	{
		id: 'big-pickle',
		name: 'big-pickle (free)',
		reasoning: true,
		input: ['text'],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	},
	{
		id: 'mimo-v2.6-flash-free',
		name: 'MiMo v2.6 Flash (free)',
		reasoning: true,
		input: ['text', 'image'],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	},
	{
		id: 'ling-3.0-flash-fin-free',
		name: 'Ling 3.0 Flash Fin (free)',
		reasoning: true,
		input: ['text'],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 32_768,
	},
	{
		id: 'ling-3.1-flash-free',
		name: 'Ling 3.1 Flash (free)',
		reasoning: true,
		input: ['text'],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 32_768,
	},
	{
		id: 'nemotron-3.5-lightning-free',
		name: 'Nemotron 3.5 Lightning (free)',
		reasoning: true,
		input: ['text'],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 262_144,
	},
	{
		// models.dev also declares `video`; the host models text+image only.
		id: 'space-bunny-free',
		name: 'Space Bunny (free)',
		reasoning: true,
		input: ['text', 'image'],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 524_288,
	},
	{
		id: 'fledge-alpha-free',
		name: 'Fledge Alpha (free)',
		reasoning: true,
		input: ['text', 'image'],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 131_072,
	},
	{
		id: 'longcat-2.5-preview-free',
		name: 'LongCat 2.5 Preview (free)',
		reasoning: true,
		input: ['text', 'image'],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 131_072,
	},
]

/**
 * Ids on the free lane whose *name* says nothing about it, so the free
 * judgment can never be reached by name alone. `big-pickle` is the case that
 * matters: free by pricing, invisible to `id.includes('free')`.
 */
export const VERIFIED_FREE: Readonly<Record<string, true>> = {
	'big-pickle': true,
	'mimo-v2.6-flash-free': true,
	'ling-3.0-flash-fin-free': true,
	'ling-3.1-flash-free': true,
	'nemotron-3.5-lightning-free': true,
	'space-bunny-free': true,
	'fledge-alpha-free': true,
	'longcat-2.5-preview-free': true,
}

/**
 * Ids upstream refuses on the anonymous lane. Each reason is the verbatim
 * upstream response from a gate-shaped probe.
 *
 * `mimo-v2.5-free` is the case that proves this list earns its keep: retired
 * from the live lane (gone from `/models`, `401 ModelError`) while models.dev
 * still publishes it at zero cost — metadata alone would keep re-advertising
 * a dead id.
 */
export const UNAVAILABLE: Readonly<Record<string, string>> = {
	'mimo-v2.5-free': '401 ModelError: not supported upstream (retired, measured 2026-10-08)',
	// Zen spells this with hyphens; the dotted spelling never matched a live id.
	'nemotron-3-ultra-free': '401 ModelError: not supported upstream',
	'muse-spark-1.2-contributor-free': '403 RegionError: blocked in this region',
	'muse-spark-1.3-contributor-free': '403 RegionError: blocked in this region',
}
