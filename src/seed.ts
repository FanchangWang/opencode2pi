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

/** Ids verified end-to-end against the anonymous lane on 2026-10-05. */
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
		id: 'mimo-v2.5-free',
		name: 'MiMo v2.5 (free)',
		reasoning: true,
		input: ['text', 'image'],
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
		id: 'nemotron-3.5-lightning-free',
		name: 'Nemotron 3.5 Lightning (free)',
		reasoning: true,
		input: ['text'],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 262_144,
	},
]

/**
 * Ids on the free lane whose *name* says nothing about it, so the free
 * judgment can never be reached by name alone. `big-pickle` is the case that
 * matters: free by pricing, invisible to `id.includes('free')`.
 */
export const VERIFIED_FREE: Readonly<Record<string, true>> = {
	'big-pickle': true,
	'mimo-v2.5-free': true,
	'mimo-v2.6-flash-free': true,
	'ling-3.0-flash-fin-free': true,
	'nemotron-3.5-lightning-free': true,
}

/**
 * Ids upstream rejects on the anonymous lane. Measured 2026-10-05:
 * `nemotron-3.5-lightning-free` works while these two do not, and both are
 * priced at zero in models.dev — so pricing metadata alone would happily
 * re-advertise them. Reasons are verbatim upstream responses.
 */
export const UNAVAILABLE: Readonly<Record<string, string>> = {
	'nemotron-3.ultra-free': '401 ModelError: not supported upstream',
	'muse-spark-1.2-contributor-free': '403 RegionError: blocked in this region',
}
