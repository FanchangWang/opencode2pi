/**
 * `/opencode2pi pool` — the exit-pool TUI.
 *
 * The pool is a decision surface, not an automation. Quota is metered per egress
 * IP, so the moment a 429 arrives the only useful question is "which exit do we
 * leave through instead", and that question belongs to the user: a proxy sees
 * every request, changes the egress country, and is slower than the direct
 * route. So this file offers choices, measures them, and applies exactly what was
 * chosen — it never rotates on its own (src/pool.ts explains why).
 *
 * Custom exits only. The built-in free list is gone: OpenCode refuses the
 * datacenter IPs those lists mostly publish, so scanning them cost more quota
 * than it ever returned. What is left is `exits.txt`, and the menu is built
 * around the one operation that matters — pick one of your own proxies, verify
 * it, then switch.
 *
 * The menu:
 *
 * · **开启/关闭出口池** — off means every request goes out exactly as the host
 *   would have sent it (own IP, or `PI_PROXY`). The selection survives. Opening
 *   with no selection goes straight to the exit list, because the pool cannot be
 *   open without an exit: an enabled pool with nothing selected is the one state
 *   that silently spends the machine's own quota.
 * · **选择或新增出口** — the user's own proxies, one row each, named by position,
 *   plus an inline "add" row. Selecting one shows a fresh completion if there is
 *   one, otherwise measures a gate probe and a real answer before switching.
 * · **删除出口** — removes a line from `exits.txt`. Deleting the selected exit
 *   closes the pool; if others remain, the user is offered a replacement.
 * · **查看当前状态** — prints the pool and its evidence, changes nothing.
 *
 * The measurement ladder is visible because the two rungs cost different things:
 *   · 闸门探测 (gate test) — the real gate-shaped request for one model, through
 *     the candidate. Costs a sliver of quota.
 *   · 完成探测 (completion) — a real short answer, which is what makes an exit
 *     verified. Costs a little more, and only runs after the gate passed.
 */

import type { CommandUi } from './host/contract.ts'

import {
	addCandidate,
	activeCandidate,
	candidates,
	evidenceFor,
	EXIT_TTL_MS,
	isFresh,
	isVerified,
	LIMIT_TTL_MS,
	poolEnabled,
	removeCandidate,
	rejectedExits,
	selectExit,
	selectedKey,
	setPoolEnabled,
	type ExitCandidate,
	type ExitEvidence,
	type ModelMark,
} from './pool.ts'
import {
	COMPLETION_MARK,
	GATE_MARK,
	PROBE_MODEL,
	verifyExit,
} from './pool-probe.ts'
import { redactAddress } from './exits.ts'
import { dataDir } from './store.ts'
import { proxyBackend, proxyBackendNote } from './transport.ts'

const MENU_TITLE = 'opencode2pi · 出口池'
const TOGGLE_ON = '开启出口池'
const TOGGLE_OFF = '关闭出口池（回到本机 IP）'
const CHOOSE = '选择或新增出口…'
const REMOVE = '删除出口…'
const STATUS = '查看当前状态'
const BACK = '返回'

function ageText(at: number): string {
	const minutes = Math.round((Date.now() - at) / 60_000)
	if (minutes < 1) return '刚刚'
	if (minutes < 60) return `${minutes} 分钟前`
	const hours = Math.round(minutes / 60)
	return hours < 24 ? `${hours} 小时前` : `${Math.round(hours / 24)} 天前`
}

function gateText(gate: ExitEvidence['gate']): string {
	if (!gate) return '未做闸门探测'
	const status = gate.status === undefined ? '' : ` HTTP ${gate.status}`
	return `闸门 ${GATE_MARK[gate.verdict]} ${gate.modelId}${status} · ${ageText(gate.at)}`
}

/**
 * What a full turn through the exit said.
 *
 * Kept separate from {@link gateText} because the two are the pool's two rungs,
 * and a row that shows only the gate is the row that made a ✅ mean "the request
 * shape was accepted" — which is not what the user is buying. A missing line
 * means the stage has not run, not that it passed.
 */
function completionText(completion: ExitEvidence['completion']): string {
	if (!completion) return ''
	const status = completion.status === undefined ? '' : ` HTTP ${completion.status}`
	const stale = isFresh(completion.at, EXIT_TTL_MS) ? '' : '（已过期）'
	return `完成 ${COMPLETION_MARK[completion.verdict]}${status} · ${ageText(completion.at)}${stale}`
}

/**
 * What this exit has actually been told by real traffic.
 *
 * These marks are the only record of what requests did rather than what a probe
 * did; they are written automatically by the request path (index.ts).
 */
function markText(evidence: ExitEvidence): string {
	const marks = Object.entries(evidence.modelMarks ?? {}).filter(([, mark]) => isFresh(mark.at, LIMIT_TTL_MS))
	if (marks.length === 0) return ''
	const label: Record<ModelMark['kind'], string> = {
		limited: '429 限流',
		region: '地区拒绝',
		transport: '流中断',
	}
	const rendered = marks.map(([model, mark]) => `${model} ${label[mark.kind]}（${ageText(mark.at)}）`)
	return `最近：${rendered.join('；')}`
}

function candidateLine(index: number, candidate: ExitCandidate, selected: boolean): string {
	const evidence = evidenceFor(candidate.key)
	const parts = [
		`${selected ? '▶' : ' '} ${index + 1}. ${candidate.label}`,
		gateText(evidence?.gate),
		completionText(evidence?.completion),
	]
	const verified = evidence !== undefined && isVerified(evidence) ? '' : ' · 未完成验证'
	const mark = evidence ? markText(evidence) : ''
	return `${parts.filter((part) => part !== '').join(' · ')}${verified}${mark === '' ? '' : `\n      ${mark}`}`
}

/** Header + every exit. The one thing the user reads before choosing. */
export function poolReport(): string {
	const list = candidates()
	const active = activeCandidate()
	const verified = list.filter((candidate) => isVerified(evidenceFor(candidate.key))).length
	const state = poolEnabled()
		? `开 · 出口 = ${active?.label ?? '未选中（直连本机 IP）'}`
		: '关 · 直连本机 IP'
	const header = `${MENU_TITLE}：${state}`
	if (list.length === 0) {
		return (
			`${header}\n没有自定义出口：在菜单里「${CHOOSE}」添加，` +
			`或直接编辑 ${dataDir()}/exits.txt（一行一个）。` +
			refusalNote()
		)
	}
	const lines = list.map((candidate, index) => candidateLine(index, candidate, candidate.key === active?.key))
	// Stated here as well as in the startup note because this is the screen where
	// the user decides to trust an exit. A pool that cannot proxy is worse than no
	// pool: the menu would show an exit as selected while every request left from
	// the machine's own address.
	const mechanism =
		proxyBackend() === 'none'
			? `\n⚠️ 本运行时没有可用的逐请求代理机制（${proxyBackendNote()}）：出口池在这里不生效，请求仍走本机 IP。`
			: proxyBackend() === 'unresolved'
				? '\n⚠️ 代理机制尚未初始化：出口池不可用，重启会话后再试。'
				: ''
	return (
		`${header}\n自定义出口 ${list.length} 个（已完成验证 ${verified} 个）：\n${lines.join('\n')}\n` +
		`逐请求代理机制：${proxyBackend()}（${proxyBackendNote()}）\n` +
		`数据目录：${dataDir()}（pool.json 是开关与选择，exits.txt 是你的出口列表）。池关闭时请求完全按原样发出（本机 IP / PI_PROXY）。` +
		mechanism +
		(refusalNote() === '' ? '' : `\n${refusalNote()}`)
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

/**
 * The user's exits, in file order — the slots the menu names by position.
 *
 * Position, not identity, and that is the whole design. `exits.txt` is an ordered
 * list whose order *is* the user's ranking, so "出口 2" is its second line and
 * stays correct as the list grows: adding a fourth exit makes a fourth slot rather
 * than silently pushing the third off the menu. Fixed slots would have needed
 * empty-slot bookkeeping and hole handling for no gain — the rows are already
 * numbered, which is what makes a position readable as a name.
 */
function slots(): readonly ExitCandidate[] {
	return candidates()
}

function slotLabel(index: number): string {
	return `出口 ${index + 1}`
}

/**
 * Ask, then measure, then ask again — the switch is never silent.
 *
 * A completion is the strongest evidence this tool can have, and it is only 30
 * minutes old at most (`COMPLETION_TTL_MS`). Re-probing an exit the user just
 * verified would spend the same scarce quota to learn the same fact, precisely
 * when they are acting on a result they just paid for. In that window the dialog
 * shows the existing evidence instead of measuring again; anything older or
 * weaker is re-measured before the switch.
 */
async function applyCandidate(ctx: CommandUi, candidate: ExitCandidate): Promise<void> {
	const known = evidenceFor(candidate.key)
	if (isVerified(known)) {
		const confirmed = await ctx.confirm(
			'切换出口？',
			`「${candidate.label}」最近一次完整验证已跑完一次真实回答（${completionText(known?.completion)}）。\n` +
				'这条路径上的所有请求都会经由该代理；随时可以再切回本机 IP。',
		)
		if (!confirmed) return
		await selectExit(candidate.key)
		await setPoolEnabled(true)
		ctx.notify(`已切换：出口池开启，出口 = ${candidate.label}。下一个请求就从这个出口发出。`)
		return
	}
	ctx.notify(`正在通过 ${candidate.label} 跑闸门探测（一个最小形状请求，会消耗少量配额）…`)
	ctx.setWorkingMessage(`闸门探测：${candidate.label}`)
	const { gate, completion } = await verifyExit(candidate, PROBE_MODEL)
	ctx.setWorkingMessage()
	ctx.notify(`闸门探测结果：${GATE_MARK[gate.verdict]} ${gate.detail} · ${(gate.e2eMs / 1000).toFixed(1)}s`)
	if (gate.verdict === 'region' || gate.verdict === 'transport' || gate.verdict === 'shape') {
		ctx.notify(
			`这个出口没有通过探测，不切换。${gate.verdict === 'region' ? '地区封锁只影响被测模型，可以换一个模型再测一次。' : '可以换一个出口再试。'}`,
			'warning',
		)
		return
	}
	// A gate pass is not an exit: without the completion, a proxy that answers the
	// gate and then dies mid-stream would be offered as working.
	if (completion !== undefined) {
		ctx.notify(`完成探测结果：${COMPLETION_MARK[completion.verdict]} ${completion.detail} · ${(completion.e2eMs / 1000).toFixed(1)}s`)
		if (completion.verdict !== 'ok') {
			ctx.notify('这个出口能过闸门，但没能完整跑完一次真实回答，不切换。', 'warning')
			return
		}
	}
	const confirmed = await ctx.confirm(
		'切换出口？',
		`把之后的请求都从「${candidate.label}」发出？\n` +
			'这条路径上的所有请求都会经由该代理；随时可以再切回本机 IP。',
	)
	if (!confirmed) return
	await selectExit(candidate.key)
	await setPoolEnabled(true)
	ctx.notify(`已切换：出口池开启，出口 = ${candidate.label}。下一个请求就从这个出口发出。`)
}

/** Pick one of the user's own exits, or add a new one. */
async function chooseCustomExit(ctx: CommandUi): Promise<void> {
	const list = slots()
	const labels = list.map((_, index) => slotLabel(index))
	// Options carry their position because `select` resolves to the label, and two
	// exits can render identically (`http://user:***@h:1` collides with
	// `http://other:***@h:1`); the slot name is unique where the address is not.
	const options = list.map((candidate, index) => ({
		label: labels[index] ?? slotLabel(index),
		description: [
			candidate.label,
			gateText(evidenceFor(candidate.key)?.gate),
			completionText(evidenceFor(candidate.key)?.completion),
			isVerified(evidenceFor(candidate.key)) ? '✅ 已验证' : '未完成验证（选择后先验证）',
		]
			.filter((part) => part !== '')
			.join(' · '),
	}))
	options.push({ label: '＋ 新增自定义出口…', description: 'host:port 或 http://user:pass@host:port，写入 exits.txt' })
	options.push({ label: BACK, description: '' })
	const choice = await ctx.select('选择出口（切换前会验证）', options)
	if (choice === undefined || choice === BACK) return

	if (choice === '＋ 新增自定义出口…') {
		const entered = await ctx.input('新增出口', 'http://user:pass@host:port 或 host:port')
		if (entered === undefined || entered.trim() === '') return
		const refused = await addCandidate(entered.trim())
		if (refused !== null) {
			ctx.notify(`没有添加：${refused}`, 'warning')
			return
		}
		ctx.notify('已写入 exits.txt。')
		// The appended line lands last in the file, which is where it appears here.
		const added = slots().at(-1)
		if (added) await applyCandidate(ctx, added)
		return
	}

	const chosen = list[labels.indexOf(choice)]
	if (chosen) await applyCandidate(ctx, chosen)
}

/** Remove one of the user's own exits, then leave the pool in a consistent state. */
async function removeCustomExit(ctx: CommandUi): Promise<void> {
	const list = slots()
	if (list.length === 0) {
		ctx.notify('exits.txt 里没有出口可删除。')
		return
	}
	const labels = list.map((_, index) => slotLabel(index))
	const choice = await ctx.select(
		'删除出口',
		list.map((candidate, index) => ({
			label: labels[index] ?? slotLabel(index),
			// The description names the address, never a tier: a proxy URL can carry
			// a password.
			description: `${candidate.label}（从 exits.txt 移除）`,
		})),
	)
	const chosen = list[labels.indexOf(choice ?? '')]
	if (!chosen) return
	const wasSelected = selectedKey() === chosen.key
	await removeCandidate(chosen.key)
	ctx.notify(`已删除 ${chosen.label}（${choice}）。`)
	if (!wasSelected) return
	const remaining = slots()
	if (remaining.length === 0) {
		ctx.notify('已删除最后一个出口：出口池已关闭，请求回到本机 IP。')
		return
	}
	// `removeCandidate` already closed the pool. Asking here keeps the menu from
	// leaving the user with a pool they thought was on and no exit behind it.
	const replace = await ctx.confirm(
		'出口池已关闭',
		`当前选中的出口被删除了，所以出口池自动关闭，请求回到本机 IP。\n还有 ${remaining.length} 个出口，要现在选一个继续用吗？`,
	)
	if (replace) await chooseCustomExit(ctx)
}

/**
 * Open or close the pool.
 *
 * Closing is one line. Opening with a selection that survived (pool off, choice
 * kept) is one click: that is what "关闭时选择保留着" promises. With no selection
 * at all it goes straight to the exit list — custom exits are the only route now,
 * so the old "which route to find an exit by" fork has nothing left to ask.
 */
async function togglePool(ctx: CommandUi): Promise<void> {
	if (poolEnabled()) {
		await setPoolEnabled(false)
		ctx.notify('出口池已关闭：请求按原样发出（本机 IP / PI_PROXY），选择保留着，随时可以再开。')
		return
	}

	const active = selectedKey() === null ? undefined : candidates().find((candidate) => candidate.key === selectedKey())
	if (active !== undefined) {
		await setPoolEnabled(true)
		ctx.notify(`出口池已开启：之后的请求从 ${active.label} 发出。`)
		return
	}

	ctx.notify('出口池需要先选一个出口。')
	await chooseCustomExit(ctx)
}

export async function runPoolCommand(ctx: CommandUi): Promise<void> {
	if (!ctx.hasUI) {
		// The state is worth printing headlessly; every action here needs a dialog.
		ctx.notify(`${poolReport()}\n变更出口需要交互式 TUI（打印模式只读）。`)
		return
	}
	for (;;) {
		const active = selectedKey() === null ? undefined : candidates().find((candidate) => candidate.key === selectedKey())
		const choice = await ctx.select(MENU_TITLE, [
			{
				label: poolEnabled() ? TOGGLE_OFF : TOGGLE_ON,
				// Two descriptions, because the row does two different things: with the
				// pool on it stops it; with a selection kept it restarts through that
				// exit. Reading the selection through `activeCandidate()` here would
				// render every closed pool as "nothing selected", which is exactly the
				// moment the selection matters most.
				description: poolEnabled()
					? `当前出口 ${active?.label ?? '未选中（直连）'}；关闭后请求按原样发出，选择保留着`
					: active === undefined
						? '还没有选中的出口；会先让你从 exits.txt 里选一个或新增'
						: `开启后从 ${active.label} 发出（之前选过）；当前关闭，请求按原样发出`,
			},
			{
				label: CHOOSE,
				description: `${slots().length} 个你自己的出口（exits.txt），切换前会跑闸门探测和一次真实回答`,
			},
			{ label: REMOVE, description: '从 exits.txt 移除一个出口' },
			{ label: STATUS, description: '打印完整出口列表与结论，不做任何改动' },
			{ label: BACK, description: '' },
		])
		if (choice === undefined || choice === BACK) return
		if (choice === TOGGLE_ON || choice === TOGGLE_OFF) await togglePool(ctx)
		else if (choice === CHOOSE) await chooseCustomExit(ctx)
		else if (choice === REMOVE) await removeCustomExit(ctx)
		else if (choice === STATUS) ctx.notify(poolReport())
	}
}
