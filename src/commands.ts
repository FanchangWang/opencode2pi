/**
 * `/opencode2pi` — the extension's only interface (docs/PLAN.md §T5).
 *
 * omp has no settings page for extensions, so a slash command plus the TUI is
 * the whole surface. Four capabilities, each answering a question the user
 * cannot answer any other way once the lane lives inside omp:
 *
 *   doctor — the shape gate is hardcoded here, so when upstream changes it the
 *            only symptom is a silent wall of 403s. This turns that into one
 *            explicit alarm.
 *   status — report the last sweep: models it has never asked about are probed
 *            on the spot, and aged verdicts are flagged rather than re-run.
 *   probe  — sweep the whole roster, because that costs real inference and is
 *            therefore the user's call, not a side effect of looking.
 *   filter — ask what the roster should hide, and remember the answer.
 */

import type { ExtensionCommandContext, ProviderModelConfig } from '@oh-my-pi/pi-coding-agent'

import { discoverFreeModels } from './discovery.ts'
import { runDoctor } from './doctor.ts'
import { hidden, publishFilters, publishHealth, saveFilters } from './filters.ts'
import {
	HEALTH_MARK,
	HEALTH_TTL_MS,
	isStale,
	loadHealth,
	probeAll,
	saveHealth,
	summarizeHealth,
	type HealthRecord,
	type HealthStore,
	type ProbeResult,
} from './health.ts'
import { SEED_MODELS } from './seed.ts'

/** Model used for the gate check: a verified id, not whatever is selected. */
const DOCTOR_MODEL = SEED_MODELS[0]?.id ?? 'big-pickle'

const USAGE = '用法：/opencode2pi <doctor|status|probe|filter>'

const AGE = (record: HealthRecord): string => {
	const minutes = Math.max(0, Math.round((Date.now() - record.checkedAt) / 60_000))
	if (minutes < 1) return '刚刚探测'
	if (minutes < 60) return `${minutes} 分钟前探测`
	const hours = Math.round(minutes / 60)
	return hours < 24 ? `${hours} 小时前探测` : `${Math.round(hours / 24)} 天前探测`
}

/**
 * Render one roster line. Every model appears, whatever its verdict, and every
 * line carries the reason: a mark alone leaves the reader to guess whether ⚠️
 * means a 503, a 400 or a timeout, and those have different remedies.
 *
 * A model we hold no record for says so in words instead of borrowing a verdict
 * mark. `·` is not one of the five verdicts — it says we have not asked, which
 * is a fact about the last probe, not about the model.
 */
function rosterLine(model: ProviderModelConfig, record: HealthRecord | undefined): string {
	if (!record) return `· ${model.id} — ${model.name} · 未探测`
	const stale = isStale(record) ? '（已过期）' : ''
	return `${HEALTH_MARK[record.health]} ${model.id} — ${model.name} · ${record.detail} · ${AGE(record)}${stale}`
}

/** Render one finished probe: the verdict, the reason, and what it cost. */
function resultLine(result: ProbeResult, done: number, total: number): string {
	const seconds = (result.latencyMs / 1000).toFixed(1)
	return `[${done}/${total}] ${HEALTH_MARK[result.health]} ${result.modelId} — ${result.detail} · ${seconds}s`
}

async function currentRoster(): Promise<readonly ProviderModelConfig[]> {
	// Never throws and never returns empty, so the roster is always showable.
	const { models } = await discoverFreeModels()
	return models.length > 0 ? models : SEED_MODELS
}

/**
 * Probe a slice of the roster, printing each verdict as it lands.
 *
 * A sweep costs minutes of real inference, so batching the output until the end
 * means a user staring at an unchanged screen cannot tell "slow model" from
 * "hung". One line per model, immediately, answers that as it goes.
 *
 * `keep` is the whole roster, not the slice being probed: pruning to the batch
 * would delete every verdict a partial sweep deliberately left alone.
 */
async function sweep(
	models: readonly ProviderModelConfig[],
	keep: ReadonlySet<string>,
	ctx: ExtensionCommandContext,
): Promise<HealthStore> {
	const results = await probeAll(models, (done, total, result) => {
		ctx.ui.setWorkingMessage(`正在探测 ${done}/${total}：${result.modelId}`)
		ctx.ui.notify(resultLine(result, done, total))
	})
	ctx.ui.setWorkingMessage()
	const merged = await saveHealth(results, keep)
	publishHealth(merged)
	return merged
}

/**
 * Report the roster, probing only what we have never asked about.
 *
 * `status` answers "what does the last probe say", and the store is that answer:
 * re-probing the whole roster on every `status` would burn minutes of real
 * inference to redraw a picture the user already has. Two cases are exceptions,
 * because they are gaps rather than pictures — a model that has never been probed
 * (which includes every model discovered since the last sweep) is probed right
 * here, because showing `未探测` for something we could have asked about is a
 * worse answer than asking. A verdict that has merely aged out is not a gap: it
 * is a real result that has stopped being current, so it is reported with its
 * age and one line pointing at `probe`. Re-probing on age would make `status` a
 * `probe` with extra steps.
 */
async function showStatus(ctx: ExtensionCommandContext): Promise<void> {
	const roster = await currentRoster()
	const stored = await loadHealth()
	publishHealth(stored)

	const unprobed = roster.filter((model) => !stored[model.id])
	const aged = roster.filter((model) => stored[model.id] && isStale(stored[model.id]))
	const keep = new Set(roster.map((model) => model.id))

	let merged = stored
	if (unprobed.length) {
		if (!ctx.hasUI) {
			// Print mode cannot render a progress indicator for minutes at a
			// time; say so rather than hang a headless run on nothing.
			ctx.ui.notify(
				`有 ${unprobed.length} 个模型从未探测（${unprobed.map((model) => model.id).join(', ')}）。` +
					'逐模型探测需要交互式 TUI，请在 TUI 里运行 status 或 probe。',
				'warning',
			)
		} else {
			ctx.ui.notify(
				`正在探测 ${unprobed.length} 个尚未探测过的模型（${unprobed.map((model) => model.id).join(', ')}）…`,
			)
			merged = await sweep(unprobed, keep, ctx)
		}
	}

	ctx.ui.notify(
		`opencode2pi 模型状态：${summarizeHealth(roster, merged)}\n` +
			`${roster.map((model) => rosterLine(model, merged[model.id])).join('\n')}` +
			hiddenNote() +
			staleNote(aged.map((model) => model.id)),
	)
}

/** A trailing line pointing at `probe` when the report it just showed has aged. */
function staleNote(aged: readonly string[]): string {
	if (!aged.length) return ''
	return (
		`\n⚠️ ${aged.length} 个模型的结果已超过 ${HEALTH_TTL_MS / 3_600_000} 小时（${aged.join(', ')}）。` +
		'免费池波动很快，运行 /opencode2pi probe 重新探测全部模型。'
	)
}

/** Probe the whole roster, report it, and ask about hiding. */
async function runProbe(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify('逐模型探测需要交互式 TUI（打印模式下不可用）。')
		return
	}

	const roster = await currentRoster()
	const keep = new Set(roster.map((model) => model.id))
	ctx.ui.notify(
		`正在探测 ${roster.length} 个模型（每个模型一条结果，陆续输出；全部结束后给出汇总与完整列表）…`,
	)
	const merged = await sweep(roster, keep, ctx)
	// The per-model lines stream in completion order; this closing block is the
	// canonical snapshot — every model, in roster order, with verdict and reason.
	ctx.ui.notify(
		`探测完成：${summarizeHealth(roster, merged)}\n` +
			`${roster.map((model) => rosterLine(model, merged[model.id])).join('\n')}` +
			hiddenNote(),
	)
	// The verdicts are only useful if they can change something, and whether to
	// hide is the one decision we refuse to make on the user's behalf.
	await chooseFilters(ctx)
}

/** A trailing line saying what the current filters remove, or that they do not. */
function hiddenNote(): string {
	const excluded = [...hidden()]
	return excluded.length ? `\n已从列表隐藏：${excluded.join(', ')}（用 /opencode2pi filter 调整）` : ''
}

/**
 * Ask what the roster should hide, and apply the answer.
 *
 * This is the user's call, not ours: the same model can answer ✅ on one lane and
 * be region-blocked on another, so an automatic rule would be wrong half the
 * time. Cancelling changes nothing — the default is to hide nothing.
 */
async function chooseFilters(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify('过滤设置需要交互式 TUI（打印模式下不可用）。')
		return
	}
	const choice = await ctx.ui.select('opencode2pi · 模型过滤', [
		{ label: '全部保留（只标注，不隐藏）', description: '默认：任何模型都不从列表里移除' },
		{ label: '隐藏地区封锁的', description: '上游按当前出口拒绝的模型（403 · not available in your country）' },
		{ label: '隐藏所有探测失败的', description: '下线、地区封锁、请求被拒、上游故障；配额与链路问题不算' },
	])
	const next =
		choice === '隐藏地区封锁的'
			? { hideRegionBlocked: true, hideFailed: false }
			: choice === '隐藏所有探测失败的'
				? { hideRegionBlocked: true, hideFailed: true }
				: choice === '全部保留（只标注，不隐藏）'
					? { hideRegionBlocked: false, hideFailed: false }
					: undefined
	if (!next) return
	await saveFilters(next)
	publishFilters(next)
	ctx.ui.notify(`已更新过滤：当前隐藏 ${hidden().size} 个模型（/model 与 --model 里不再出现）`)
}

async function showMenu(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(USAGE)
		return
	}
	const choice = await ctx.ui.select('opencode2pi', [
		{ label: 'doctor', description: '检查形状闸门是否仍然成立（发一个最小闸门形状请求）' },
		{ label: 'status', description: '显示上次探测的结果；从未探测过的模型会自动补测' },
		{ label: 'probe', description: '重新探测全部模型（并发，2 并发）' },
		{ label: 'filter', description: '选择要在 /model 里隐藏哪些模型（默认一个都不隐藏）' },
	])
	// `select` resolves to the chosen label, so the labels double as the keys.
	if (choice === 'doctor') await runDoctorCommand(ctx)
	else if (choice === 'status') await showStatus(ctx)
	else if (choice === 'probe') await runProbe(ctx)
	else if (choice === 'filter') await chooseFilters(ctx)
}

async function runDoctorCommand(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.hasUI) ctx.ui.notify('正在检查形状闸门…')
	const report = await runDoctor(DOCTOR_MODEL)
	ctx.ui.notify(`${report.headline}\n${report.detail}`, report.ok ? 'info' : 'error')
}

export async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
	if (sub === 'doctor') return runDoctorCommand(ctx)
	if (sub === 'status') return showStatus(ctx)
	if (sub === 'probe') return runProbe(ctx)
	if (sub === 'filter') return chooseFilters(ctx)
	if (sub === '') return showMenu(ctx)
	ctx.ui.notify(USAGE, 'warning')
}