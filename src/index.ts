/**
 * opencode2pi — OpenCode Zen's anonymous free lane as a pi/omp provider.
 *
 * The built-in `opencode-zen` provider requires a paid `OPENCODE_API_KEY`.
 * This extension needs none: the upstream gate is a request-shape check, not
 * a credential check. The keyless lane is served on TWO origins with
 * DIFFERENT shapes (confirmed live 2026-10-17, docs/FINDINGS.md §2.4/§2.5):
 *
 *   1. `Authorization: Bearer public`  (anonymous credential)
 *   2. canonical session id  `^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$` with a
 *      validated counter layout (low 12 bits decode to a counter in [1, 63])
 *   3. an agent-shaped body: on the legacy /zen/v1 origin a single "read"
 *      tool (definitions not checked); on /inference, `shell` + `read` with
 *      the GENUINE OpenCode definitions (stubs are rejected)
 *
 * Non-streaming requests are rejected with FreeTierError. Host streaming is
 * inherent to the openai-completions engine, so condition 3 is the only body
 * change this extension has to make.
 *
 * The host resolves the request URL from the provider registration — a
 * `model.baseUrl` set at request time cannot redirect it (probed 2026-10-17) —
 * so lane preference is registration-level: the legacy /zen/v1 lane is
 * registered first, and a shape rejection re-probes both lanes and
 * re-registers against the healthy one. The transport is a different story:
 * `options.fetch` IS honoured, so a caller-supplied `init.proxy` picks the
 * egress per request (FINDINGS §2.6).
 *
 * ## Two hosts, one registration
 *
 * pi 1.3.0 and omp 18.11.3 both take a provider registration and both accept a
 * custom streaming function in it, so this extension registers once and adapts
 * the four places they genuinely differ — the context shape the handler
 * receives, the presence of a logger, the `select` argument shape, and the
 * per-model effort spelling. That adaptation lives in `src/host/`; see
 * `src/host/contract.ts` for what differs and why, and `src/request.ts` for the
 * request path both hosts share.
 *
 * Integration seam, re-verified against both hosts (docs/FINDINGS.md §3):
 *   - `pi.registerProvider(name, { api, streamSimple })` is the ONLY portable
 *     registration. omp's registry forwards it to `registerCustomApi`
 *     internally; pi has no process-wide custom-API registry at all, so calling
 *     `registerCustomApi` at module scope is what used to crash pi with
 *     `(0, _piAi.registerCustomApi) is not a function`.
 *   - The handler receives a structured context on omp (`systemPrompt`,
 *     `messages`, `tools` as separate fields) and a *transcript* on pi, where
 *     the prompt and tool declarations live in the leading system message. Both
 *     are shaped, then delegated to the host engine with `model.api` swapped
 *     back to `openai-completions` to avoid recursion.
 *   - `toolChoice` lives on the *options* object on both hosts, not on the
 *     context; setting it on the context is a silent no-op.
 */

import { discoverFreeModels } from './discovery.ts'
import { handleCommand } from './commands.ts'
import { hidden, loadFilters, onHiddenChange, publishFilters, publishHealth } from './filters.ts'
import { loadHealth } from './health.ts'
import { activeCandidate, loadPool, poolEnabled } from './pool.ts'
import { laneFor, currentLane } from './lanes.ts'
import { onRepublishReady } from './request.ts'
import { PROCESS_SESSION } from './session.ts'
import { SEED_MODELS, UNAVAILABLE, VERIFIED_FREE } from './seed.ts'
import { initProxyBackend, proxyBackend, proxyBackendNote } from './transport.ts'
import {
	API_ID,
	PROJECT_ID,
	PROVIDER,
	type ExtensionApiLike,
	type HostAdapter,
	type ModelSpec,
} from './host/contract.ts'

/**
 * The catalog we publish. Starts as the seed — the only thing that can exist
 * before discovery — and is replaced by the discovered list once it lands.
 */
let catalog: readonly ModelSpec[] = SEED_MODELS

/**
 * Write the provider registry from the catalog minus what the user hid.
 *
 * This is the *only* place the model list is written, and it writes the whole
 * list every time: re-registering a provider name replaces its entire model
 * slice (host contract on both sides — omp `src/config/model-registry.ts`, pi
 * `applyExtension` in `core/provider-composer.ts`), which is what makes a filter
 * choice reach `/model` and `--model`.
 *
 * Discovery is ours to run, not the host's. Registering `refreshModels` /
 * `fetchDynamicModels` looked equivalent and is not: the host caches a dynamic
 * result under a fingerprint of its *own* empty static list, so a warm cache
 * never calls the fetcher again, and a re-registration inside a session never
 * re-runs discovery — the models merged at startup stay in the registry no
 * matter what we filter. Both were measured: a hidden model came straight back
 * after `/opencode2pi filter`, and one that had never been in the seed survived.
 */
function applyProvider(pi: ExtensionApiLike, adapter: HostAdapter): void {
	const excluded = hidden()
	const models = catalog.filter((model) => !excluded.has(model.id))
	if (models.length === 0) {
		// The host reads a provider with no models as a URL override and keeps the
		// previous list, so a filter that hides everything would silently do
		// nothing. Say so instead.
		adapter.diagnostics.warn(
			`[${PROVIDER}] 过滤规则隐藏了全部模型，模型列表不会缩小；用 /opencode2pi filter 放宽`,
		)
	}

	const lane = laneFor(currentLane())
	pi.registerProvider(PROVIDER, adapter.providerConfig(models, lane.baseUrl, lane.headers(PROJECT_ID)))
}

/** Re-discover the free lane and republish. A failure keeps what we have. */
async function refreshCatalog(pi: ExtensionApiLike, adapter: HostAdapter): Promise<void> {
	const { models, diagnostics } = await discoverFreeModels()
	for (const line of diagnostics) adapter.diagnostics.info(`[${PROVIDER}] ${line}`)
	if (models.length === 0) return
	catalog = models
	applyProvider(pi, adapter)
}

/**
 * Which host is loading this extension, and its adapter.
 *
 * Feature detection on the extension API object, not a version string: `pi.logger`
 * exists on omp 18.11.3 and does not exist at all on pi 1.3.0 (grep for `logger`
 * in pi's extension types returns nothing), so its presence is the one signal
 * that separates them without hard-coding a version that will be wrong by the
 * time anyone reads it. `pi` has no such property, so the check is a plain
 * `'logger' in pi` rather than a comparison.
 *
 * The adapter is loaded with a dynamic import on purpose. A static import would
 * pull BOTH adapters in on either host, and each one reads the other's runtime
 * surface at module scope — which is exactly the kind of coupling that let the
 * original `registerCustomApi` call crash pi. With this, omp never even loads
 * `pi.ts`, so a divergence in one adapter cannot break the other host.
 */
async function detectAdapter(pi: ExtensionApiLike): Promise<HostAdapter> {
	if ('logger' in pi && pi.logger !== undefined) {
		const { ompAdapter } = await import('./host/omp.ts')
		return ompAdapter(pi)
	}
	const { piAdapter } = await import('./host/pi.ts')
	return piAdapter(pi)
}

export default async function (pi: ExtensionApiLike): Promise<void> {
	const adapter = await detectAdapter(pi)
	const reapply = () => applyProvider(pi, adapter)
	onRepublishReady(reapply)

	// The stored choices are part of what the roster is, so they are adopted
	// before the first registration rather than applied on the next probe.
	publishFilters(await loadFilters())
	publishHealth(await loadHealth())
	// How this runtime proxies a single request is resolved before the pool is
	// adopted, because both the request path and the pool's own probes go through
	// it and neither may start before it is known. Doing it after `loadPool()`
	// would leave a window where a request could be sent direct while an exit is
	// selected — the exact silent failure this ordering exists to prevent.
	await initProxyBackend()
	await loadPool()
	onHiddenChange(() => reapply())
	applyProvider(pi, adapter)

	// The pool persists across sessions, which is useful and also the one state a
	// user can forget about overnight: the next morning's requests would leave
	// through yesterday's proxy without a word. `session_start` is the only hook
	// that runs when the TUI is already live on both hosts, so the notice is
	// emitted there and only when the model actually selected is ours — a user
	// chatting on another provider is not using this pool at all.
	pi.on?.('session_start', (_event, ctx) => {
		try {
			const model = adapter.currentModel(ctx)
			if (model?.provider !== PROVIDER && model?.api !== API_ID) return
			if (!poolEnabled()) return
			const ui = adapter.ui(ctx)
			if (!ui.hasUI) return
			const exit = activeCandidate()
			ui.notify(
				proxyBackend() === 'none'
					? 'opencode2pi：出口池处于开启状态，但当前运行时没有可用的代理机制，请求会从本机 IP 发出。用 /opencode2pi pool 关闭出口池，或换用带 undici 的 Node / Bun 运行。'
					: exit === undefined
						? 'opencode2pi：出口池处于开启状态，但没有有效的已选出口，请求会从本机 IP 发出。用 /opencode2pi pool 选择或关闭。'
						: `opencode2pi：出口池处于开启状态，当前出口 ${exit.label}（请求会经由该代理）。用 /opencode2pi pool 查看、切换或关闭。`,
				'warning',
			)
		} catch (error) {
			adapter.diagnostics.warn(`[${PROVIDER}] 启动时出口池提示失败：${String(error)}`)
		}
	})

	// The host awaits extension factories and only then drains the registration
	// queue, so waiting here is what lets `--model provider/id` resolve an id that
	// discovery found and the seed does not carry. The seed is already registered,
	// so a discovery failure costs nothing but the wait — and that wait is the one
	// the host imposed on itself back when it owned discovery.
	await refreshCatalog(pi, adapter)

	pi.registerCommand('opencode2pi', {
		description:
			'opencode2pi 诊断：doctor 检查形状闸门，status 显示上次探测结果，probe 重新探测全部模型，filter 设置隐藏规则',
		handler: (args, ctx) => handleCommand(args, adapter.ui(ctx)),
	})

	adapter.diagnostics.info(
		`[${PROVIDER}] registered on ${adapter.name} · process session ${PROCESS_SESSION} · ` +
			`seed ${SEED_MODELS.length} models · ` +
			`verified-free ${Object.keys(VERIFIED_FREE).length} · known-rejected ${Object.keys(UNAVAILABLE).length} · ` +
			`hidden ${hidden().size} · ` +
			`per-request proxy ${proxyBackend()} (${proxyBackendNote()}) · ` +
			(poolEnabled() ? `exit pool on (${activeCandidate()?.label ?? '未选中出口，直连'})` : 'exit pool off'),
	)
}

export {
	API_ID,
	PROJECT_ID,
	PROVIDER,
	PROCESS_SESSION,
	SEED_MODELS,
	UNAVAILABLE,
	VERIFIED_FREE,
}
