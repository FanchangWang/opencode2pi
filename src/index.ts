/**
 * opencode2pi — OpenCode Zen's anonymous free lane as an omp/pi provider.
 *
 * The built-in `opencode-zen` provider requires a paid `OPENCODE_API_KEY`.
 * This extension needs none: the upstream gate is a request-shape check, not
 * a credential check. Three conditions, all confirmed live on 2026-10-05:
 *
 *   1. `Authorization: Bearer public`  (anonymous credential)
 *   2. canonical session id  `^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`
 *   3. an agent-shaped body: `tools` containing `bash` and `read`
 *
 * Non-streaming requests are rejected with FreeTierError. Host streaming is
 * inherent to the openai-completions engine, so condition 3 is the only body
 * change this extension has to make.
 *
 * Integration seam (verified against omp 18.6.1 — see docs/FINDINGS.md):
 *   - `pi.registerProvider` config accepts `onPayload` / `prepareRequest`
 *     WITHOUT ERROR but NEVER CALLS THEM. Do not use them.
 *   - The working seam is `registerCustomApi(apiId, streamSimple, sourceId)`,
 *     which receives `(model, context, options)` — a structured context, not a
 *     serialized body. Shape the context, then delegate to the host engine
 *     with `model.api` swapped back to `openai-completions` to avoid recursion.
 */

import { createHash } from 'node:crypto'

import { registerCustomApi, streamSimple } from '@earendil-works/pi-ai'
import type { AssistantContext, Context, Model } from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent'

const PROVIDER = 'opencode-zen-free'
const API_ID = 'openai-completions-zen-free'
const ZEN_BASE = 'https://opencode.ai/zen/v1'
const ANONYMOUS_KEY = 'public'
const SOURCE_ID = 'opencode2pi'

const CANONICAL_SESSION = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** Verified against the anonymous lane with a real streaming chat (2026-10-05). */
const FREE_MODELS = [
	{ id: 'big-pickle', name: 'big-pickle (free)', reasoning: true },
	{ id: 'mimo-v2.5-free', name: 'MiMo v2.5 (free)', reasoning: true },
	{ id: 'mimo-v2.6-flash-free', name: 'MiMo v2.6 Flash (free)', reasoning: true },
	{ id: 'ling-3.0-flash-fin-free', name: 'Ling 3.0 Flash Fin (free)', reasoning: false },
	{ id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning (free)', reasoning: true },
] as const

/** Upstream 401/403s these; excluded so the picker only lists working ids. */
const UNAVAILABLE: Record<string, string> = {
	'nemotron-3.ultra-free': '401 ModelError: not supported upstream',
	'muse-spark-1.2-contributor-free': '403 RegionError: blocked in this region',
}

function base62Fixed(value: bigint, width: number): string {
	let out = ''
	let v = value
	for (let i = 0; i < width; i++) {
		out = BASE62[Number(v % 62n)] + out
		v /= 62n
	}
	return out
}

/** OpenCode's canonical session shape, ported from opencode2dsh `ids.ts`. */
function canonicalSessionID(signal: string): string {
	if (CANONICAL_SESSION.test(signal)) return signal
	const sum = createHash('sha256').update(`ses\0${signal}`).digest()
	return `ses_${sum.subarray(0, 6).toString('hex')}${base62Fixed(BigInt(`0x${sum.subarray(6, 16).toString('hex')}`), 14)}`
}

const SESSION = canonicalSessionID(`omp:${process.pid}:${new Date().toISOString().slice(0, 10)}`)

const DISGUISE_HEADERS: Record<string, string> = {
	'user-agent': 'opencode/1.18.31 (win32 x64; node24.19.0)',
	'x-opencode-client': 'cli',
	'x-opencode-session': SESSION,
	'x-session-affinity': SESSION,
	'X-Session-Id': SESSION,
	'x-opencode-project': 'prj_' + createHash('sha256').update('omp:default-project').digest('hex').slice(0, 24),
}

/** The upstream gate demands a `bash` and a `read` function in `tools`. */
const GATE_TOOL_NAMES = ['bash', 'read'] as const

const GATE_TOOLS = GATE_TOOL_NAMES.map((name) => ({
	name,
	description: 'Reserved for the host runtime; do not call it.',
	parameters: { type: 'object' as const, properties: {} },
}))

function withGateTools(context: Context): Context {
	const existing = context.tools ?? []
	const names = new Set(existing.map((tool) => tool.name))
	const missing = GATE_TOOLS.filter((tool) => !names.has(tool.name))
	if (missing.length === 0) return context

	// No host tools at all: pin tool_choice so the model never calls a stub
	// the host has no implementation for.
	const toolChoice = existing.length === 0 ? ('none' as const) : context.toolChoice
	return {
		...context,
		tools: [...existing, ...missing],
		toolChoice,
	}
}

/**
 * Custom API handler: shapes the context, then hands the request to the
 * host's own openai-completions engine.
 */
registerCustomApi(API_ID, (model: Model, context: AssistantContext, options: Context) => {
	const builtin: Model = { ...model, api: 'openai-completions' as Model['api'] }
	return streamSimple(builtin, withGateTools(context as Context), options as never)
}, SOURCE_ID)

export default function (pi: ExtensionAPI): void {
	pi.registerProvider(PROVIDER, {
		baseUrl: ZEN_BASE,
		api: API_ID,
		apiKey: ANONYMOUS_KEY,
		auth: 'apiKey',
		authHeader: true,
		headers: DISGUISE_HEADERS,
		fetchDynamicModels: async () => [...FREE_MODELS],
	})

	pi.logger.info(`[${PROVIDER}] registered · session ${SESSION} · ${FREE_MODELS.length} free models`)
}

export { canonicalSessionID, withGateTools, UNAVAILABLE, PROVIDER, API_ID, SESSION, FREE_MODELS }