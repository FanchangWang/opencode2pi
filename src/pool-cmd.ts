/**
 * `/opencode2pi pool` — the exit-pool TUI.
 *
 * The pool is a decision surface, not an automation. Quota is metered per egress
 * IP, so the moment a 429 arrives the only useful question is "which exit do we
 * leave through instead", and that question belongs to the user: a public proxy
 * sees every request, changes the egress country, and is slower than the direct
 * route. So this file offers choices, measures them, and applies exactly what was
 * chosen — it never rotates on its own (src/pool.ts explains why).
 *
 * Eight items, because the menu is where a user decides, and a menu that lists
 * every internal step makes them do the ordering themselves:
 *
 * · **开启/关闭出口池** — off means every request goes out exactly as the host
 *   would have sent it (own IP, or `PI_PROXY`). The selection survives. Opening
 *   with no selection asks *which route to find an exit by* rather than assuming
 *   the user already has one, because the pool cannot be open without an exit:
 *   an enabled pool with nothing selected is the one state that silently spends
 *   the machine's own quota.
 * · **选择自定义出口** — the user's own proxies, one row each, named by position.
 *   Selecting one shows a fresh completion if there is one, otherwise measures a
 *   gate probe and a real answer before switching.
 * · **选择内置出口** — the exits a scan has already admitted, so the result of a
 *   scan can be chosen later instead of only at the moment it was found. A fresh
 *   completion is reused; stale or partial evidence is re-measured first, for the
 *   same reason the custom path is.
 * · **自动扫描内置出口池** — find working free exits. One command because the two
 *   halves are one decision: fetching and screening only says a proxy carries TLS,
 *   so "补充完" and "选哪个" are a single question with a single answer.
 * · **删除自定义出口** — removes a line from `exits.txt`.
 * · **设置免费源** — enable or disable one built-in list.
 * · **清空内置结果** — delete discovered exits and their evidence.
 * · **查看当前状态** — prints the pool and its evidence, changes nothing.
 *
 * There is deliberately no "re-screen everything" item: screening is free and runs
 * on every fill, so a standalone refresh duplicates work the fill already does.
 *
 * The measurement ladder is visible in the output because the two rungs cost
 * different things:
 *   · 屏检 (screen) — a keyless Cloudflare trace through the candidate. Free, so
 *     it can be run over everything.
 *   · 闸门探测 (gate test) — the real gate-shaped request for one model, through
 *     the candidate. Costs a sliver of quota, so it runs once, on the exit being
 *     adopted, right before the switch.
 */

import type { CommandUi } from './host/contract.ts'

import {
	addCandidate,
	activeCandidate,
	candidates,
	clearBuiltinExits,
	disabledSources,
	evidenceFor,
	EXIT_TTL_MS,
	hasUsable,
	hasVerified,
	isFresh,
	isUsable,
	isVerified,
	LIMIT_TTL_MS,
	poolEnabled,
	quarantinedEntries,
	rejectedExits,
	removeCandidate,
	selectExit,
	selectedKey,
	setPoolEnabled,
	setSourceDisabled,
	type ExitCandidate,
	type ExitEvidence,
	type GateVerdict,
} from './pool.ts'
import {
	discoverExit,
	COMPLETION_MARK,
	GATE_MARK,
	groupHuntFailures,
	huntPlan,
	huntUsableExit,
	probeWorthyCandidates,
	SCAN_MODEL,
	SCAN_TARGET,
	verifyExit,
	type HuntProgress,
} from './pool-probe.ts'
import { redactAddress } from './exits.ts'
import { FREE_SOURCES } from './sources.ts'
import { dataDir } from './store.ts'
import { proxyBackend, proxyBackendNote } from './transport.ts'

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
	// Shown beside the RTT because the two answer different questions and the pool
	// now refuses an exit on the second one: RTT is the reused tunnel, handshake is
	// what every request after a 4 s pause has to pay again (see pool.ts).
	if (screen.handshakeMs !== undefined) parts.push(`握手 ${screen.handshakeMs}ms`)
	const stale = isFresh(screen.at, EXIT_TTL_MS) ? '' : '（已过期）'
	return `出口 ${parts.join(' · ')}${stale}`
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
	const completion = completionText(evidence?.completion)
	if (completion !== '') parts.push(completion)
	const mark = evidence ? markText(evidence) : ''
	// "No evidence" is not the same verdict as "refused": the gate line already
	// carries the refusal marks, so this only marks the unmeasured case.
	const usable = isUsable(evidence) ? '' : ' · 尚无可用证据'
	const verified = evidence !== undefined && isVerified(evidence) ? '' : ' · 未完成验证'
	return `${parts.filter((part) => part !== '').join(' · ')}${usable || verified}${mark === '' ? '' : `\n      ${mark}`}`
}

/**
 * Addresses currently held out of refill, and why.
 *
 * Shown because the alternative is silent: without this, a proxy the user just
 * watched fail a gate probe quietly fails to reappear in the next refill, and
 * "it vanished" is indistinguishable from a bug. Naming the count and the
 * remaining time turns that into a visible, expiring decision.
 */
function quarantineNote(): string {
	const entries = quarantinedEntries()
	if (entries.length === 0) return ''
	const soonest = Math.min(...entries.map((entry) => entry.record.until))
	const hours = Math.max(1, Math.round((soonest - Date.now()) / 3_600_000))
	const kinds = new Map<string, number>()
	for (const entry of entries) kinds.set(entry.record.verdict, (kinds.get(entry.record.verdict) ?? 0) + 1)
	// `screen` is not a gate verdict and has no mark: it means "never answered a
	// trace", which is a weaker claim on a shorter window than a gate refusal.
	const label = (verdict: string): string => (verdict === 'screen' ? '屏检没通' : (GATE_MARK[verdict as GateVerdict] ?? verdict))
	const breakdown = [...kinds].map(([verdict, count]) => `${label(verdict)} ${count}`).join(' ')
	// The two windows differ, so one expiry figure would misstate one of them.
	const gateCount = entries.filter((entry) => entry.record.verdict !== 'screen').length
	const screenCount = entries.length - gateCount
	const windows = [
		gateCount > 0 ? `闸门失败 ${gateCount} 个 · 禁 24 小时` : '',
		screenCount > 0 ? `屏检没通 ${screenCount} 个 · 禁 12 小时` : '',
	].filter((part) => part !== '')
	return `\n已记住的坏地址 ${entries.length} 个（${breakdown}）：补充时会被跳过，最早 ${hours} 小时后恢复。${windows.join('；')}。`
}

/** Header + every candidate. The one thing the user reads before choosing. */
export function poolReport(): string {
	const list = candidates()
	const active = activeCandidate()
	const usable = list.filter((candidate) => isUsable(evidenceFor(candidate.key))).length
	const verified = list.filter((candidate) => isVerified(evidenceFor(candidate.key))).length
	const state = poolEnabled()
		? `开 · 出口 = ${active?.label ?? `未选中（直连本机 IP）`}`
		: '关 · 直连本机 IP'
	const header = `opencode2pi 出口池：${state}`
	if (list.length === 0) {
		return (
			`${header}\n没有可用出口：手动添加，或选「自动扫描内置出口池」。` +
			`\n（手动出口写在 ${dataDir()}/exits.txt，一行一个。）` +
			quarantineNote() +
			refusalNote()
		)
	}
	const lines = list.map((candidate, index) => candidateLine(index, candidate, candidate.key === active?.key))
	const advice = hasUsable()
		? ''
		: '\n⚠️ 目前没有任何出口处于可用状态：先「自动扫描内置出口池」拉一批并实测。'
	// Stated here as well as in the startup note because this is the screen where
	// the user decides to trust an exit. A pool that cannot proxy is worse than no
	// pool: the menu would show an exit as selected while every request left from
	// the machine's own address, which is the one address whose quota is spent.
	const mechanism =
		proxyBackend() === 'none'
			? `\n⚠️ 本运行时没有可用的逐请求代理机制（${proxyBackendNote()}）：出口池在这里不生效，请求仍走本机 IP。`
			: proxyBackend() === 'unresolved'
				? '\n⚠️ 代理机制尚未初始化：出口池不可用，重启会话后再试。'
				: ''
	return (
		`${header}\n出口 ${list.length} 个（可用 ${usable} 个，已完成验证 ${verified} 个）：\n${lines.join('\n')}\n` +
		`逐请求代理机制：${proxyBackend()}（${proxyBackendNote()}）\n` +
		`数据目录：${dataDir()}（pool.json 是开关与选择，exits.txt 是你的出口列表）。池关闭时请求完全按原样发出（本机 IP / PI_PROXY）。` +
		quarantineNote() +
		mechanism +
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

/**
 * The user's own exits, in file order — the "自定义池" slots.
 *
 * Position, not identity, and that is the whole design. `exits.txt` is an ordered
 * list whose order *is* the user's ranking, so "自定义池 2" is its second line and
 * stays correct as the list grows: adding a fourth exit makes a fourth slot rather
 * than silently pushing the third off the menu. Fixed slots would have needed
 * empty-slot bookkeeping and hole handling for no gain — the rows are already
 * numbered, which is what makes a position readable as a name.
 */
function customSlots(): readonly ExitCandidate[] {
	return candidates().filter((candidate) => candidate.tier === 'manual')
}

function slotLabel(index: number): string {
	return `自定义池 ${index + 1}`
}

/**
 * Scanned exits that still have usable evidence.
 *
 * Only admitted built-ins can appear here, and admission already requires a
 * completed answer — this filter is about *now*: a screen or completion record
 * that aged out, or a later failure, takes the row away. The scan's results stay
 * selectable after the command that found them, which is the whole point: the
 * moment a scan ends used to be the only chance to take one of its exits.
 */
function usableBuiltinSlots(): readonly ExitCandidate[] {
	return candidates().filter(
		(candidate) => candidate.tier === 'builtin' && isUsable(evidenceFor(candidate.key)),
	)
}

/** Rows for a built-in selection menu: position, address, and the evidence it has. */
function builtinOptions(slots: readonly ExitCandidate[]): readonly { label: string; description: string }[] {
	return slots.map((candidate, index) => {
		const evidence = evidenceFor(candidate.key)
		const verified = isVerified(evidence) ? '✅ 已验证' : '尚未完成验证，切换前会重新验证'
		return {
			label: `内置出口 ${index + 1}`,
			description: [
				candidate.label,
				screenText(evidence?.screen),
				gateText(evidence?.gate),
				completionText(evidence?.completion),
				verified,
			]
				.filter((part) => part !== '')
				.join(' · '),
		}
	})
}

/**
 * Ask, then measure, then ask again — the switch is never silent.
 *
 * A completion is the strongest evidence this tool can have, and it is only 30
 * minutes old at most (`COMPLETION_TTL_MS`). Re-probing an exit the scan just
 * verified would spend the same scarce quota to learn the same fact, precisely
 * when the user is acting on a result they just paid for. In that window the
 * dialog shows the existing evidence instead of measuring again; anything older
 * or weaker is re-measured before the switch.
 */
async function applyCandidate(ctx: CommandUi, candidate: ExitCandidate): Promise<void> {
	const known = evidenceFor(candidate.key)
	if (isVerified(known)) {
		const screen = screenText(known?.screen)
		const confirmed = await ctx.confirm(
			'切换出口？',
			`「${candidate.label}」最近一次完整验证已跑完一次真实回答（${completionText(known?.completion)}）。\n${
				screen === '' ? '' : `已屏检：${screen}\n`
			}` + '这条路径上的所有请求都会经由该代理；随时可以再切回本机 IP。',
		)
		if (!confirmed) return
		await selectExit(candidate.key)
		await setPoolEnabled(true)
		ctx.notify(`已切换：出口池开启，出口 = ${candidate.label}。下一个请求就从这个出口发出。`)
		return
	}
	ctx.notify(`正在通过 ${candidate.label} 跑闸门探测（一个最小形状请求，会消耗少量配额）…`)
	ctx.setWorkingMessage(`闸门探测：${candidate.label}`)
	const { gate, completion } = await verifyExit(candidate, SCAN_MODEL)
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
			`已屏检：${screenText(evidenceFor(candidate.key)?.screen)}\n` +
			'这条路径上的所有请求都会经由该代理；随时可以再切回本机 IP。',
	)
	if (!confirmed) return
	await selectExit(candidate.key)
	await setPoolEnabled(true)
	ctx.notify(`已切换：出口池开启，出口 = ${candidate.label}。下一个请求就从这个出口发出。`)
}

/** Pick one of the user's own exits, or add a new one. */
async function chooseCustomExit(ctx: CommandUi): Promise<void> {
	const slots = customSlots()
	const labels = slots.map((_, index) => slotLabel(index))
	// Options carry their position because `select` resolves to the label, and two
	// exits can render identically (`http://user:***@h:1` collides with
	// `http://other:***@h:1`); the slot name is unique where the address is not.
	const options = slots.map((candidate, index) => ({
		label: labels[index] ?? slotLabel(index),
		description: [
			candidate.label,
			screenText(evidenceFor(candidate.key)?.screen),
			gateText(evidenceFor(candidate.key)?.gate),
		]
			.filter((part) => part !== '')
			.join(' · '),
	}))
	options.push({ label: '手动输入自定义 IP…', description: 'host:port 或 http://user:pass@host:port，写入 exits.txt' })
	const choice = await ctx.select('选择自定义出口', options)
	if (choice === undefined) return

	if (choice === '手动输入自定义 IP…') {
		const entered = await ctx.input('新增出口', 'http://user:pass@host:port 或 host:port')
		if (entered === undefined || entered.trim() === '') return
		const refused = await addCandidate(entered.trim())
		if (refused !== null) {
			ctx.notify(`没有添加：${refused}`, 'warning')
			return
		}
		ctx.notify('已写入 exits.txt。')
		// The appended line lands last in the file, which is where it appears here.
		const added = customSlots().at(-1)
		if (added) await applyCandidate(ctx, added)
		return
	}

	const chosen = slots[labels.indexOf(choice)]
	if (chosen) await applyCandidate(ctx, chosen)
}

/**
 * Pick one of the exits a scan already admitted.
 *
 * This is deliberately separate from the scan. A scan asks "use this one?" while
 * it is still running, and declining used to be the end of the road: the exits it
 * had just verified stayed in the pool but the menu gave no way back to them. The
 * list is built from current evidence, so it also cannot offer an exit that has
 * since failed; a fresh completion is reused, an older or partial record is
 * measured again by {@link applyCandidate}.
 */
async function chooseBuiltinExit(ctx: CommandUi): Promise<void> {
	const slots = usableBuiltinSlots()
	if (slots.length === 0) {
		ctx.notify('还没有扫描出可用的内置出口。先运行「自动扫描内置出口池」。', 'warning')
		return
	}
	const options = builtinOptions(slots)
	const choice = await ctx.select('选择内置出口（扫描结果）', options)
	if (choice === undefined) {
		ctx.notify('未切换，出口池保持原样。')
		return
	}
	const chosen = slots[options.findIndex((option) => option.label === choice)]
	if (chosen) await applyCandidate(ctx, chosen)
}

/** Remove one of the user's own exits. */
async function removeCustomExit(ctx: CommandUi): Promise<void> {
	const slots = customSlots()
	if (slots.length === 0) {
		ctx.notify('exits.txt 里没有出口可删除。')
		return
	}
	const labels = slots.map((_, index) => slotLabel(index))
	const choice = await ctx.select(
		'删除自定义出口',
		slots.map((candidate, index) => ({
			label: labels[index] ?? slotLabel(index),
			// The description names the address, never the tier: these are all
			// manual, and a manual exit's URL can carry a password.
			description: `${candidate.label}（从 exits.txt 移除）`,
		})),
	)
	const chosen = slots[labels.indexOf(choice ?? '')]
	if (!chosen) return
	await removeCandidate(chosen.key)
	ctx.notify(`已删除 ${chosen.label}（${choice}）。`)
}

/** One hunt's progress lines, tagged with the phase they belong to. */
function huntProgress(ctx: CommandUi, phase: string): (progress: HuntProgress) => void {
	return ({ attempt, index, total, remaining }) => {
		const gate = `闸门 ${GATE_MARK[attempt.gate.verdict]} ${attempt.gate.detail.slice(0, 50)} · ${(attempt.gate.e2eMs / 1000).toFixed(1)}s`
		const completion =
			attempt.completion === undefined
				? ''
				: ` → 完成 ${COMPLETION_MARK[attempt.completion.verdict]} ${attempt.completion.detail.slice(0, 50)}`
		ctx.notify(
			`[${index} / ${total}] ${attempt.candidate.label} → ${gate}${completion}` +
				(remaining > 0 ? `（还剩 ${remaining} 个未探测）` : phase === '' ? '' : ` · ${phase}`),
		)
	}
}

/**
 * Find a working free exit: measure what we have, then fetch more only if needed.
 *
 * One command, because "补充" and "选哪个" are halves of a single decision — a
 * screen says the proxy carries TLS, not that the upstream accepts its IP, so a
 * filled pool still leaves the user with no exit to use. Two commands made them
 * run both and remember which was which.
 *
 * The order inside is the part worth arguing about, and it is deliberately the
 * reverse of "fetch, then pick". Filling first costs a full source pull and a few
 * hundred trace requests *unconditionally*, which is pure latency on the common
 * morning-after case where an exit admitted earlier is still good. Probing the
 * existing ones first costs one gate probe each and stops at the first hit, so a
 * healthy pool answers in seconds and only a pool with nothing usable pays for a
 * fetch. The user's own exits go in the first pass too: they are the routes the
 * pool exists to fall back to, and an unmeasured one deserves its first
 * measurement more than a fetched one does.
 *
 * Both halves now hold the same thing — a gate-verified exit. Pass 1 re-probes what
 * is already verified (free proxies rot, and a verdict from this morning is not
 * evidence about now); pass 2 admits a fetch only once the gate has accepted it, so
 * a pool that has just been filled is not asking the user to take a proxy on the
 * strength of a keyless trace.
 */
async function scanBuiltinPool(ctx: CommandUi): Promise<void> {
	const confirmed = await ctx.confirm(
		'扫描免费出口池？',
		'会先在池里已有的出口中按证据顺序分批并发跑闸门探测（每个候选一个最小形状请求，消耗少量配额），' +
			'一旦找到可用出口就停下。\n' +
			'如果已有的都不行，才去拉取公开的免费代理列表，逐个预筛、屏测，每屏测通过一个就立刻做闸门探测 —— ' +
			'只有闸门通过的才会进池。\n' +
			'这些第三方代理能看到它们转发的请求，只在你的手动出口都用尽时使用。\n' +
			'每轮结束都会问你要不要继续；找到后会把可用出口列成一张表让你选，不会自动切换。',
	)
	if (!confirmed) return

	// ── Pass 1: what the pool already holds ────────────────────────────────
	const worthy = probeWorthyCandidates()
	if (worthy.length > 0) {
		const plan = huntPlan(worthy)
		// Printed before the first probe, not after it. A hunt's opening probe can be
		// a tunnel through a dead proxy and spend the whole budget before it reports
		// anything, so without this line the command looks unresponsive for several
		// seconds — long enough that a user cancels what is in fact working.
		ctx.notify(
			`先试池里已有的 ${plan.total} 个候选（${plan.usableFirst} 个闸门通过过，优先），` +
				`每批并发 ${plan.concurrency} 个，最坏 ${plan.rounds} 批。`,
		)
		ctx.setWorkingMessage('正在探测池中已有出口…')
		const first = await huntUsableExit(SCAN_MODEL, huntProgress(ctx, '已有出口这一轮全没过，去拉新源'), worthy)
		ctx.setWorkingMessage()
		if (first.winner !== undefined) {
			ctx.notify(`✅ 找到可用出口：${first.winner.candidate.label}（已入池）。`)
			await chooseBuiltinExit(ctx)
			return
		}
		// The transition has to be visible because the next phase is minutes long and
		// opens with source downloads. Without this line the run looks like it is
		// still probing the old pool — and if it then finds an exit there, the user
		// has no way to tell which phase produced it.
		ctx.notify(`池里已有的 ${first.attempts.length} 个都试过了，没有一个通过。去拉新的免费源。`)
	} else {
		ctx.notify('池里没有闸门通过过的出口，直接去拉取免费源。')
	}

	// ── Pass 2: fetch, screen, gate-probe and complete each survivor ───────
	ctx.setWorkingMessage('正在拉取并屏检免费出口…')
	// Asked once per round, and only while the target is unmet — so the question is
	// asked as often as there is left to test, and never answered for the user. The
	// counts in the body are what make the answer informed: without them "继续吗"
	// is a question about whether to give up, which is not what it is.
	const report = await discoverExit(SCAN_MODEL, (line) => ctx.notify(`· ${line}`), {
		target: SCAN_TARGET,
		askContinue: async (state) => {
			ctx.setWorkingMessage()
			const more = await ctx.confirm(
				'继续检测更多地址？',
				`第 ${state.round} 轮结束：累计预筛 ${state.tested} 个地址，` +
					`${state.passed} 个通过屏检，${state.verified}/${state.roundTarget} 个已完整验证。\n` +
					`源里还有 ${state.untested} 个地址没测过（已排除被隔离的）。\n` +
					'免费代理存活率很低，多跑几轮常常就能碰到一个闸门愿意接受的。\n' +
					'可以继续，也可以就此停下。',
			)
			ctx.setWorkingMessage('正在拉取并屏检免费出口…')
			return more
		},
	})
	ctx.setWorkingMessage()

	// The skip count is stated here as well as inline: a run that finds fewer exits
	// than last time is otherwise indistinguishable from the lists having gone
	// quiet, and this is the one case where the cause is our own memory.
	const skipped =
		report.skippedQuarantined === 0 ? '' : ` · 跳过已知坏地址 ${report.skippedQuarantined} 个`
	// Said because it changes what the other numbers mean: several addresses that
	// screened fine are one exit wearing several ports, so "屏检通过 N" overstates
	// how many distinct upstreams this run reached.
	const merged = report.duplicates === 0 ? '' : ` · 同一出口合并 ${report.duplicates} 个（多端口同 IP，共用同一份配额）`
	// "还剩 N 个没测" is the number that makes the ending legible. Without it a run
	// that stopped on the user's "no" looks exactly like a run that exhausted the
	// lists, and the reasonable conclusion — that the command gave up early — is
	// exactly what it must not look like.
	const rounds = report.rounds > 1 ? ` · ${report.rounds} 轮` : ''
	const left = report.untested > 0 ? ` · 源里还有 ${report.untested} 个没测` : ''
	// Said because it changes what the run cost: a run served from the source
	// cache spent no requests on the lists at all, so "源 18 个" would otherwise
	// read as eighteen downloads that never happened.
	const fromCache = report.sourcesCached === 0 ? '' : `（其中 ${report.sourcesCached} 个来自本地缓存）`
	const stopped = report.stopReason === 'budget' ? ' · 完成探测预算用尽' : report.stopReason === 'cancelled' ? ' · 已取消' : ''
	ctx.notify(
		`检测完成：源 ${report.sourcesFetched + report.sourcesCached} 个${fromCache}（下载失败 ${report.sourcesFailed}）· 候选地址 ${report.candidates} 个 · ` +
			`预筛 ${report.screened} 个${rounds} · 进入屏检 ${report.prefilterPassed} 个 · 通过屏检 ${report.screenPassed} 个 · 闸门探测 ${report.gateProbed} 次 · ` +
			`完成验证 ${report.completionProbed} 次（消耗配额）· 新出口入池 ${report.admitted} 个${skipped}${merged}${left}${stopped}。`,
	)

	if (report.winners.length === 0) {
		if (report.attempts.length === 0) {
			// Nothing even passed the gate, so there is no candidate to pick and no
			// verdict to group. Saying so plainly is the useful answer: the failure was
			// upstream of the exit entirely. Whether anything was left untried has to
			// be said too — "no usable exit" and "no address left to try" call for
			// different amounts of patience, and only the second one is a reason to
			// stop rather than to keep going.
			ctx.notify(
				'这一轮没有找到闸门能接受的出口（免费代理存活率本来就很低，通常是源不新鲜或这几分钟网络不通）。\n' +
					(report.untested > 0
						? `源里还有 ${report.untested} 个地址没测过，再跑一次会继续往后找。`
						: '源里没有被隔离过滤掉的地址了，等隔离期过后（6–24 小时）再试会更快。'),
				'warning',
			)
			return
		}
		// "Nothing worked" is not a useful thing to say on its own. Which failures
		// occurred says whether to look for another proxy, wait for a quota window,
		// or suspect the request itself — and a run that produced only one of those
		// kinds deserves a different next step than one that produced all of them.
		// Grouped off the gate probes the pipeline already spent, not a second hunt.
		const groups = groupHuntFailures(report.attempts)
		const detail = groups.map((group) => `${group.label} —— ${group.advice}`).join('\n')
		const onlyShape = groups.length === 1 && groups[0]?.verdicts[0] === 'shape'
		ctx.notify(
			`闸门探测了 ${report.attempts.length} 个通过屏检的出口，没有一个通过。${onlyShape ? '' : '未切换。'}\n${detail}` +
				(report.untested > 0 ? `\n源里还有 ${report.untested} 个地址没测过，再跑一次会继续往后找。` : ''),
			'warning',
		)
		return
	}

	// The scan's output is a set, not a single answer: in-flight probes when the
	// target was met also land in the pool, and the user is the one who decides
	// which route to take. The list is the same one the menu's "选择内置出口"
	// opens, so the decision does not change shape just because a scan happened
	// to produce it.
	ctx.notify(`✅ 本轮测通 ${report.winners.length} 个出口，均已入池；请选择接下来使用哪个。`)
	await chooseBuiltinExit(ctx)
}

/**
 * The exit the user picked earlier, whether or not the pool is currently on.
 *
 * Not `activeCandidate()`: that one is `store.enabled && selected`, so it goes
 * undefined the moment the pool is switched off — which is exactly the moment
 * this matters. Turning the pool off is supposed to preserve the choice, and
 * turning it back on is supposed to reuse it; reading it through `activeCandidate`
 * would report "nothing is selected" for a pool that has a perfectly good
 * selection, and push the user through the re-choose flow every single time.
 *
 * Membership is re-checked because `selected` is persisted while `candidates()`
 * is rebuilt from `exits.txt` and the admitted exits: a key can outlive the
 * candidate it named (line deleted, builtin pruned), and then there is genuinely
 * nothing to turn on.
 */
function selectedCandidate(): ExitCandidate | undefined {
	const key = selectedKey()
	return key === null ? undefined : candidates().find((candidate) => candidate.key === key)
}

/**
 * Open or close the pool.
 *
 * Closing is one line. Opening has a fork, because the pool cannot be opened
 * without an exit selected — an enabled pool with nothing selected still sends
 * every request out of the machine's own address, which is the one address whose
 * quota is already spent, so the menu must not present that as success.
 *
 * The fork appears only when there is nothing to turn on. With a selection that
 * survived (pool off, choice kept) opening is one click with no dialog, because
 * that is what "关闭时选择保留着" promises. With no selection at all, the menu asks
 * *which route to find an exit by* instead of dropping straight into the manual
 * prompt: "开启出口池" is where anyone without an `exits.txt` lands, and asking
 * those users for manual input reads as a tool that assumes a proxy they do not
 * have. Both branches end the same way — each route's own confirm/switch calls
 * `setPoolEnabled(true)` — so there is no third "enable it now" path that could
 * produce the state this is guarding against.
 */
async function togglePool(ctx: CommandUi): Promise<void> {
	if (poolEnabled()) {
		await setPoolEnabled(false)
		ctx.notify('出口池已关闭：请求按原样发出（本机 IP / PI_PROXY），选择保留着，随时可以再开。')
		return
	}

	const active = selectedCandidate()
	if (active !== undefined) {
		await setPoolEnabled(true)
		ctx.notify(`出口池已开启：之后的请求从 ${active.label} 发出。`)
		return
	}

	const builtins = usableBuiltinSlots()
	const route = await ctx.select('开启出口池 — 先选一个出口', [
		{
			label: '选择内置出口…',
			description:
				builtins.length === 0
					? '还没有扫描出的可用内置出口；先扫描，或从自定义出口里选'
					: `${builtins.length} 个已扫描且当前可用的内置出口`,
		},
		{
			label: '自动扫描内置出口池…',
			description: '先测池里已有的出口（闸门 + 完整回答），没有可用的才拉取免费代理列表；找到后列出结果让你选',
		},
		{
			label: '从自定义出口中选择…',
			description: `${customSlots().length} 个你自己的出口（exits.txt），或手动输入新的 IP`,
		},
		{ label: '返回', description: '不开启出口池' },
	])
	if (route === undefined || route === '返回') return
	if (route === '选择内置出口…') {
		await chooseBuiltinExit(ctx)
		return
	}
	if (route === '自动扫描内置出口池…') {
		await scanBuiltinPool(ctx)
		return
	}
	await chooseCustomExit(ctx)
}

/**
 * Enable or disable one built-in source.
 *
 * Disabled means *not consulted at all*: no download, and no addresses from a
 * cached copy. A source the user switched off must not come back through the
 * hour-old cache, which is why the filter lives in `collectSources` rather than
 * only in the downloader.
 */
async function toggleSources(ctx: CommandUi): Promise<void> {
	const disabled = disabledSources()
	const choice = await ctx.select(
		'免费源（关闭的不下载，缓存也不采用）',
		FREE_SOURCES.map((url) => ({
			label: url,
			description: disabled.has(url) ? '已关闭 —— 选中后重新启用' : '已启用 —— 选中后关闭',
		})),
	)
	if (choice === undefined) return
	const off = !disabled.has(choice)
	await setSourceDisabled(choice, off)
	ctx.notify(`${off ? '已关闭' : '已启用'}免费源：${choice}`)
}

/** Clear discovered exits without touching the user's own list or their source settings. */
async function clearBuiltin(ctx: CommandUi): Promise<void> {
	const confirmed = await ctx.confirm(
		'清空自动发现的内置出口？',
		'只会删除自动发现的出口与其证据；exits.txt、出口选择和源设置都保留。\n' +
			'下次「自动扫描内置出口池」会重新拉取并验证。',
	)
	if (!confirmed) return
	const removed = await clearBuiltinExits()
	ctx.notify(removed === 0 ? '没有自动发现的内置出口。' : `已清空 ${removed} 个内置出口。`)
}

export async function runPoolCommand(ctx: CommandUi): Promise<void> {
	if (!ctx.hasUI) {
		// The state is worth printing headlessly; every action here needs a dialog.
		ctx.notify(`${poolReport()}\n变更出口需要交互式 TUI（打印模式只读）。`)
		return
	}
	for (;;) {
		const active = selectedCandidate()
		const builtins = usableBuiltinSlots()
		const choice = await ctx.select('opencode2pi · 出口池', [
			{
				label: poolEnabled() ? '关闭出口池（回到本机 IP）' : '开启出口池',
				// Three descriptions, because the row does three different things: with
				// the pool on it stops it, with a selection kept it restarts through
				// that exit, and with neither it has to ask which route to find one by.
				// Reading the selection from `activeCandidate()` here would render the
				// first two cases identically and tell a user with a saved exit that
				// nothing is selected.
				description: poolEnabled()
					? `当前出口 ${active?.label ?? '未选中（直连）'}；关闭后请求按原样发出，选择保留着`
					: active === undefined
						? '还没有选中的出口；会先让你选一条路：已扫描的内置出口、自动扫描，或从 exits.txt 里选 / 手动输入'
						: `开启后从 ${active.label} 发出（之前选过）；当前关闭，请求按原样发出`,
			},
			{
				label: '选择自定义出口',
				description: `${customSlots().length} 个你自己的出口（exits.txt），切换前会跑闸门探测和一次真实回答`,
			},
			{
				label: '选择内置出口',
				description:
					builtins.length === 0
						? '还没有扫描出的可用内置出口；先运行「自动扫描内置出口池」'
						: `${builtins.length} 个已扫描且当前可用的结果；刚验证过的直接询问是否切换，过期的会重新验证`,
			},
			{
				label: '自动扫描内置出口池',
				description: '先测池里已有的（闸门 + 完整回答），没有可用的才拉取免费代理列表；找到后列出结果让你选',
			},
			{ label: '删除自定义出口', description: '从 exits.txt 移除一个出口' },
			{ label: '设置免费源', description: '启停内置免费代理源；关闭的源不下载，缓存里的地址也不采用' },
			{ label: '清空内置结果', description: '只删除自动发现的出口，保留 exits.txt 与源设置' },
			{ label: '查看当前状态', description: '打印完整出口列表与结论，不做任何改动' },
			{ label: '返回', description: '' },
		])
		if (choice === undefined || choice === '返回') return
		if (choice === '关闭出口池（回到本机 IP）' || choice === '开启出口池') await togglePool(ctx)
		else if (choice === '选择自定义出口') await chooseCustomExit(ctx)
		else if (choice === '选择内置出口') await chooseBuiltinExit(ctx)
		else if (choice === '自动扫描内置出口池') await scanBuiltinPool(ctx)
		else if (choice === '删除自定义出口') await removeCustomExit(ctx)
		else if (choice === '设置免费源') await toggleSources(ctx)
		else if (choice === '清空内置结果') await clearBuiltin(ctx)
		else if (choice === '查看当前状态') ctx.notify(poolReport())
	}
}