/**
 * `/opencode2pi pool` — the exit-pool TUI.
 *
 * The pool is a decision surface, not an automation. Quota is metered per egress
 * IP, so the moment a 429 arrives the only useful question is "which exit do we
 * leave through instead", and that question belongs to the user: a public proxy
 * sees every request, changes the egress country, and is slower than the direct
 * route. So this file offers choices, measures them, and applies exactly what
 * was chosen — it never rotates on its own (src/pool.ts explains why).
 *
 * The measurement ladder is visible in the menu because the two rungs cost
 * different things:
 *   · 屏检 (screen) — a keyless Cloudflare trace through the candidate. Free, so
 *     it can be run over everything.
 *   · 闸门探测 (gate test) — the real gate-shaped request for one model, through
 *     the candidate. Costs a sliver of quota, so it runs once, on the exit being
 *     adopted, right before the switch.
 */

import type { ExtensionCommandContext } from '@oh-my-pi/pi-coding-agent'

import {
	addCandidate,
	activeCandidate,
	candidates,
	evidenceFor,
	EXIT_TTL_MS,
	hasUsable,
	isFresh,
	isUsable,
	LIMIT_TTL_MS,
	poolEnabled,
	rejectedExits,
	removeCandidate,
	selectExit,
	setPoolEnabled,
	type ExitCandidate,
	type ExitEvidence,
	type GateVerdict,
} from './pool.ts'
import { gateTestExit, refill, screenAll } from './pool-probe.ts'
import { redactAddress } from './exits.ts'
import { dataDir } from './store.ts'
import { SEED_MODELS } from './seed.ts'

/** Model used for the pool's gate test: a verified id, not whatever is selected. */
const GATE_MODEL = SEED_MODELS[0]?.id ?? 'big-pickle'

const GATE_MARK: Readonly<Record<GateVerdict, string>> = {
	ok: '✅',
	limited: '🚧',
	region: '🌏',
	shape: '⛔',
	transport: '📡',
	inconclusive: '❔',
}

const TIER_LABEL: Readonly<Record<ExitCandidate['tier'], string>> = { manual: '手动', builtin: '内置' }

function ageText(at: number): string {
	const minutes = Math.round((Date.now() - at) / 60_000)
	if (minutes < 1) return '刚刚'
	if (minutes < 60) return `${minutes} 分钟前`
	const hours = Math.round(minutes / 60)
	return hours < 24 ? `${hours} 小时前` : `${Math.round(hours / 24)} 天前`
}

function screenText(screen: ExitEvidence['screen']): string {
	if (!screen) return '未屏检'
	if (screen.error !== undefined) return `屏检失败：${screen.error}`
	const parts = [screen.exitIP ?? '?']
	if (screen.country) parts.push(screen.country)
	if (screen.grade) parts.push(`档 ${screen.grade}`)
	if (screen.rttMs !== undefined) parts.push(`${screen.rttMs}ms`)
	const stale = isFresh(screen.at, EXIT_TTL_MS) ? '' : '（已过期）'
	return `出口 ${parts.join(' · ')}${stale}`
}

function gateText(gate: ExitEvidence['gate']): string {
	if (!gate) return '未做闸门探测'
	const status = gate.status === undefined ? '' : ` HTTP ${gate.status}`
	return `闸门 ${GATE_MARK[gate.verdict]} ${gate.modelId}${status} · ${ageText(gate.at)}`
}

/**
 * What this exit has actually been told.
 *
 * A screen says the proxy carries traffic; these marks say what the upstream
 * lane said back from this exit — including the ones a real failed request left
 * behind automatically (index.ts), which is the only record of what real traffic
 * did rather than what a probe did.
 */
function markText(evidence: ExitEvidence): string {
	const marks = Object.entries(evidence.modelMarks ?? {}).filter(([, mark]) => isFresh(mark.at, LIMIT_TTL_MS))
	if (marks.length === 0) return ''
	const rendered = marks.map(
		([model, mark]) => `${model} ${mark.kind === 'limited' ? '429 限流' : '地区拒绝'}（${ageText(mark.at)}）`,
	)
	return `最近：${rendered.join('；')}`
}

function candidateLine(index: number, candidate: ExitCandidate, selected: boolean): string {
	const evidence = evidenceFor(candidate.key)
	const parts = [
		`${selected ? '▶' : ' '} ${index + 1}. ${candidate.label}`,
		TIER_LABEL[candidate.tier],
		screenText(evidence?.screen),
		gateText(evidence?.gate),
	]
	const mark = evidence ? markText(evidence) : ''
	// "No evidence" is not the same verdict as "refused": the gate line already
	// carries the refusal marks, so this only marks the unmeasured case.
	const note = isUsable(evidence) ? '' : ' · 尚无可用证据'
	return `${parts.filter((part) => part !== '').join(' · ')}${note}${mark === '' ? '' : `\n      ${mark}`}`
}

/** Header + every candidate. The one thing the user reads before choosing. */
export function poolReport(): string {
	const list = candidates()
	const active = activeCandidate()
	const usable = list.filter((candidate) => isUsable(evidenceFor(candidate.key))).length
	const state = poolEnabled()
		? `开 · 出口 = ${active?.label ?? `未选中（直连本机 IP）`}`
		: '关 · 直连本机 IP'
	const header = `opencode2pi 出口池：${state}`
	if (list.length === 0) {
		return (
			`${header}\n没有可用出口：手动添加，或选择「补充内置免费出口」。` +
			`\n（手动出口写在 ${dataDir()}/exits.txt，一行一个。）` +
			refusalNote()
		)
	}
	const lines = list.map((candidate, index) => candidateLine(index, candidate, candidate.key === active?.key))
	const advice = hasUsable()
		? ''
		: '\n⚠️ 目前没有任何出口处于可用状态：先「重新屏检全部出口」，或「补充内置免费出口」。'
	return (
		`${header}\n出口 ${list.length} 个（可用 ${usable} 个）：\n${lines.join('\n')}\n` +
		`数据目录：${dataDir()}（pool.json 是开关与选择，exits.txt 是你的出口列表）。池关闭时请求完全按原样发出（本机 IP / PI_PROXY）。` +
		advice +
		refusalNote()
	)
}

/** Name the lines `exits.txt` refused, because only the user can fix them. */
function refusalNote(): string {
	const refused = rejectedExits()
	if (refused.length === 0) return ''
	// Redacted: a refused line is user text and can carry a password, and this
	// string ends up in the transcript.
	const rendered = refused.map((entry) => `${redactAddress(entry.line)}（${entry.reason}）`)
	return `\n已忽略 exits.txt 里 ${refused.length} 行：${rendered.join('；')}`
}

/** Ask, then measure, then ask again — the switch is never silent. */
async function applyCandidate(ctx: ExtensionCommandContext, candidate: ExitCandidate): Promise<void> {
	ctx.ui.notify(`正在通过 ${candidate.label} 跑闸门探测（一个最小形状请求，会消耗少量配额）…`)
	ctx.ui.setWorkingMessage(`闸门探测：${candidate.label}`)
	const gate = await gateTestExit(candidate, GATE_MODEL)
	ctx.ui.setWorkingMessage()
	ctx.ui.notify(`闸门探测结果：${GATE_MARK[gate.verdict]} ${gate.detail} · ${(gate.e2eMs / 1000).toFixed(1)}s`)
	if (gate.verdict === 'region' || gate.verdict === 'transport' || gate.verdict === 'shape') {
		ctx.ui.notify(
			`这个出口没有通过探测，不切换。${gate.verdict === 'region' ? '地区封锁只影响被测模型，可以换一个模型再测一次。' : '可以换下一个候选，或先重新屏检。'}`,
			'warning',
		)
		return
	}
	const confirmed = await ctx.ui.confirm(
		'切换出口？',
		`把之后的请求都从「${candidate.label}」发出？\n` +
			`已屏检：${screenText(evidenceFor(candidate.key)?.screen)}\n` +
			'这条路径上的所有请求都会经由该代理；随时可以再切回本机 IP。',
	)
	if (!confirmed) return
	await selectExit(candidate.key)
	await setPoolEnabled(true)
	ctx.ui.notify(`已切换：出口池开启，出口 = ${candidate.label}。下一个请求就从这个出口发出。`)
}

async function chooseExit(ctx: ExtensionCommandContext): Promise<void> {
	const list = candidates()
	const active = activeCandidate()
	// Options carry their position because `select` resolves to the label and two
	// exits can render identically (`http://user:***@h:1` collides with
	// `http://other:***@h:1`); picking by position cannot select the wrong exit.
	const labels = list.map(
		(candidate, index) => `${index + 1}. ${candidate.key === active?.key ? '▶ ' : ''}${candidate.label}`,
	)
	const options = labels.map((label, index) => ({
		label,
		description: [
			TIER_LABEL[list[index]?.tier ?? 'manual'],
			screenText(evidenceFor(list[index]?.key ?? '')?.screen),
			gateText(evidenceFor(list[index]?.key ?? '')?.gate),
		]
			.filter((part) => part !== '')
			.join(' · '),
	}))
	options.push({ label: '直连（清除选择，用本机 IP）', description: '池保持开启，但不再走任何代理' })
	options.push({ label: '手动添加一个出口…', description: 'host:port / http://user:pass@host:port，写入 exits.txt' })
	const choice = await ctx.ui.select('opencode2pi · 选择出口', options)
	if (choice === undefined) return

	if (choice === '直连（清除选择，用本机 IP）') {
		await selectExit(null)
		ctx.ui.notify(poolEnabled() ? '已切回本机 IP（出口池仍开启）。' : '已清除选择。出口池当前是关闭的。')
		return
	}
	if (choice === '手动添加一个出口…') {
		const entered = await ctx.ui.input('新增出口', 'http://user:pass@host:port 或 host:port')
		if (entered === undefined || entered.trim() === '') return
		const refused = await addCandidate(entered.trim())
		if (refused !== null) {
			ctx.ui.notify(`没有添加：${refused}`, 'warning')
			return
		}
		ctx.ui.notify('已写入 exits.txt。')
		// The appended line lands last in the file, which is where it appears here.
		const added = candidates().at(-1)
		if (added) await applyCandidate(ctx, added)
		return
	}

	const chosen = list[labels.indexOf(choice)]
	if (chosen) await applyCandidate(ctx, chosen)
}

async function chooseRemoval(ctx: ExtensionCommandContext): Promise<void> {
	const list = candidates()
	if (list.length === 0) {
		ctx.ui.notify('没有出口可删除。')
		return
	}
	const labels = list.map((candidate, index) => `${index + 1}. ${candidate.label}`)
	const choice = await ctx.ui.select(
		'opencode2pi · 删除出口',
	labels.map((label, index) => {
		const tier = list[index]?.tier ?? 'manual'
		// The description names the tier and the action, never the raw URL: a
		// manual exit's URL can carry a password, and a dialog is transcript.
		return { label, description: `${TIER_LABEL[tier]} · ${tier === 'builtin' ? '从池里移除' : '从 exits.txt 移除'}` }
	}),
	)
	const chosen = list[labels.indexOf(choice ?? '')]
	if (!chosen) return
	await removeCandidate(chosen.key)
	ctx.ui.notify(`已删除 ${chosen.label}。`)
}

async function refillPool(ctx: ExtensionCommandContext): Promise<void> {
	const confirmed = await ctx.ui.confirm(
		'补充内置免费出口？',
		'会拉取公开的免费 HTTP 代理列表，并用 cloudflare trace 逐个屏检（不发上游请求、不消耗配额）。\n' +
			'这些第三方代理能看到它们转发的请求，只在你的手动出口都用尽时使用。',
	)
	if (!confirmed) return
	ctx.ui.setWorkingMessage('正在拉取并屏检免费出口…')
	const report = await refill((line) => ctx.ui.notify(`· ${line}`))
	ctx.ui.setWorkingMessage()
	ctx.ui.notify(
		`补充完成：源 ${report.sourcesAttempted} 个（失败 ${report.sourcesFailed}）· 候选地址 ${report.candidates} 个 · ` +
			`屏检 ${report.screened} 个 · 新增出口 ${report.admitted} 个 · 屏检可用 ${report.usable} 个。\n${poolReport()}`,
	)
}

async function refreshScreens(ctx: ExtensionCommandContext): Promise<void> {
	const list = candidates()
	if (list.length === 0) {
		ctx.ui.notify('没有出口可屏检。')
		return
	}
	ctx.ui.setWorkingMessage(`正在屏检 ${list.length} 个出口…`)
	const sweep = await screenAll((line) => ctx.ui.notify(`· ${line}`))
	ctx.ui.setWorkingMessage()
	ctx.ui.notify(`屏检完成：${sweep.screened} 个中 ${sweep.usable} 个可用。\n${poolReport()}`)
}

async function togglePool(ctx: ExtensionCommandContext): Promise<void> {
	if (!poolEnabled()) {
		const active = activeCandidate()
		if (active === undefined) {
			ctx.ui.notify('先选择一个出口，再打开出口池。', 'warning')
			await chooseExit(ctx)
			if (activeCandidate() === undefined) return
		} else {
			await setPoolEnabled(true)
			ctx.ui.notify(`出口池已开启：之后的请求从 ${activeCandidate()?.label} 发出。`)
			return
		}
		return
	}
	await setPoolEnabled(false)
	ctx.ui.notify('出口池已关闭：请求按原样发出（本机 IP / PI_PROXY），选择保留着，随时可以再开。')
}

export async function runPoolCommand(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		// The state is worth printing headlessly; every action here needs a dialog.
		ctx.ui.notify(`${poolReport()}\n变更出口需要交互式 TUI（打印模式只读）。`)
		return
	}
	for (;;) {
		const active = activeCandidate()
		const choice = await ctx.ui.select('opencode2pi · 出口池', [
			{
				label: poolEnabled() ? '关闭出口池（回到本机 IP）' : '开启出口池',
				description: poolEnabled()
					? `当前出口 ${active?.label ?? '未选中（直连）'}；选择会保留，之后可以再开`
					: '打开后请求从选中的出口发出；关闭时请求完全按原样发出',
			},
			{ label: '选择出口并测试…', description: '列出全部出口（含屏检/闸门结论），切换到会先跑一次闸门探测' },
			{ label: '补充内置免费出口…', description: '拉取公开代理列表并屏检，用于手动出口都用尽时' },
			{ label: '重新屏检全部出口', description: '只走 cloudflare trace：不消耗上游配额，可随时刷新' },
			{ label: '删除出口…', description: '从池里移除内置出口，或从 exits.txt 移除手动出口' },
			{ label: '查看当前状态', description: '打印完整出口列表与结论，不做任何改动' },
			{ label: '返回', description: '' },
		])
		if (choice === undefined || choice === '返回') return
		if (choice === '关闭出口池（回到本机 IP）' || choice === '开启出口池') await togglePool(ctx)
		else if (choice === '选择出口并测试…') await chooseExit(ctx)
		else if (choice === '补充内置免费出口…') await refillPool(ctx)
		else if (choice === '重新屏检全部出口') await refreshScreens(ctx)
		else if (choice === '删除出口…') await chooseRemoval(ctx)
		else if (choice === '查看当前状态') ctx.ui.notify(poolReport())
	}
}
