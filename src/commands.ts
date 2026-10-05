/**
 * `/opencode2pi` — the extension's only interface (docs/PLAN.md §T5).
 *
 * omp has no settings page for extensions, so a slash command plus the TUI is
 * the whole surface. Two things justify its existence:
 *
 *   doctor — the shape gate is hardcoded here, so when upstream changes it the
 *            only symptom is a silent wall of 403s. This turns that into one
 *            explicit alarm.
 *   status — per-model health, annotated onto the roster and never used to
 *            remove a model from it. A lane this volatile cannot be trusted
 *            without evidence, but neither should a bad afternoon delete a
 *            model a user relies on.
 */

import type { ExtensionCommandContext, ProviderModelConfig } from '@oh-my-pi/pi-coding-agent'

import { discoverFreeModels } from './discovery.ts'
import { runDoctor } from './doctor.ts'
import {
	HEALTH_MARK,
	isStale,
	loadHealth,
	probeAll,
	saveHealth,
	summarizeHealth,
	type HealthRecord,
	type ModelHealth,
} from './health.ts'
import { SEED_MODELS } from './seed.ts'

/** Model used for the gate check: a verified id, not whatever is selected. */
const DOCTOR_MODEL = SEED_MODELS[0]?.id ?? 'big-pickle'

const AGE = (record: HealthRecord): string => {
	const minutes = Math.round((Date.now() - record.checkedAt) / 60_000)
	if (minutes < 1) return '刚刚'
	if (minutes < 60) return `${minutes} 分钟前`
	const hours = Math.round(minutes / 60)
	return hours < 24 ? `${hours} 小时前` : `${Math.round(hours / 24)} 天前`
}

/** Render one roster line. Every model appears, whatever its verdict. */
function rosterLine(model: ProviderModelConfig, record: HealthRecord | undefined): string {
	const health: ModelHealth = record?.health ?? 'unknown'
	const suffix = record ? ` ${AGE(record)}` : ''
	return `${HEALTH_MARK[health]} ${model.id} — ${model.name}${suffix}`
}

async function currentRoster(): Promise<readonly ProviderModelConfig[]> {
	// Never throws and never returns empty, so the roster is always showable.
	const { models } = await discoverFreeModels()
	return models.length > 0 ? models : SEED_MODELS
}

async function showStatus(ctx: ExtensionCommandContext, runProbe: boolean): Promise<void> {
	const roster = await currentRoster()
	const stored = await loadHealth()
	const stale = roster.some((model) => isStale(stored[model.id]))

	if (!runProbe && !stale) {
		const lines = roster.map((model) => rosterLine(model, stored[model.id]))
		ctx.ui.notify(`opencode2pi 模型状态：\n${lines.join('\n')}`)
		return
	}

	if (!ctx.hasUI) {
		// Print mode cannot render a progress dialog; say so rather than hang.
		ctx.ui.notify('逐模型探测需要交互式 TUI（打印模式下不可用）。')
		return
	}

	ctx.ui.notify(`正在探测 ${roster.length} 个模型…`)
	const results = await probeAll(roster)
	const merged = await saveHealth(results)

	const lines = roster.map((model) => rosterLine(model, merged[model.id]))
	const summary = summarizeHealth(roster, merged)
	ctx.ui.notify(`探测完成：${summary}\n${lines.join('\n')}`)
}

async function showMenu(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify('用法：/opencode2pi <doctor|status|probe>')
		return
	}
	const choice = await ctx.ui.select('opencode2pi', [
		{ label: 'doctor', description: '检查形状闸门是否仍然成立（发一个最小闸门形状请求）' },
		{ label: 'status', description: '查看模型健康状态（必要时自动重新探测）' },
		{ label: 'probe', description: '重新探测全部模型（并发，4 并发）' },
	])
	// `select` resolves to the chosen label, so the labels double as the keys.
	if (choice === 'doctor') await runDoctorCommand(ctx)
	else if (choice === 'status') await showStatus(ctx, false)
	else if (choice === 'probe') await showStatus(ctx, true)
}

async function runDoctorCommand(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.hasUI) ctx.ui.notify('正在检查形状闸门…')
	const report = await runDoctor(DOCTOR_MODEL)
	ctx.ui.notify(`${report.headline}\n${report.detail}`, report.ok ? 'info' : 'error')
}

export async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
	if (sub === 'doctor') return runDoctorCommand(ctx)
	if (sub === 'status') return showStatus(ctx, false)
	if (sub === 'probe') return showStatus(ctx, true)
	if (sub === '') return showMenu(ctx)
	ctx.ui.notify('用法：/opencode2pi <doctor|status|probe>', 'warning')
}
