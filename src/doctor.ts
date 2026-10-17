/**
 * `/opencode2pi doctor` (docs/PLAN.md §T5).
 *
 * The shape gate is hardcoded in this extension, and nothing about it is
 * negotiated: when upstream changes the check, *every* request starts failing
 * with a bare 403 and no model in particular looks guilty. Upstream has revised
 * its policy repeatedly, so this turns that silent total failure into one
 * explicit, classified verdict.
 *
 * Since 2026-10-17 the keyless lane is served on two origins with different
 * shapes (docs/FINDINGS.md §2.5), so the doctor probes both in preference
 * order — legacy /zen/v1 first, /inference as fallback — and reports which one
 * accepted the gate shape.
 */

import { classifyUpstreamFailure, type UpstreamFailure } from './errors.ts'
import { GATE_CONDITIONS, sendGateProbe } from './gate.ts'
import { LANE_ORDER, laneFor } from './lanes.ts'

export interface DoctorReport {
	readonly ok: boolean
	readonly kind: UpstreamFailure | 'OK'
	readonly headline: string
	readonly detail: string
	readonly latencyMs: number
	readonly modelId: string
}

export async function runDoctor(modelId: string): Promise<DoctorReport> {
	const probes = await Promise.all(LANE_ORDER.map((lane) => sendGateProbe(modelId, lane)))
	const lanes = LANE_ORDER.map((lane, index) => ({
		lane,
		baseUrl: laneFor(lane).baseUrl,
		probe: probes[index]!,
	}))
	const summary = lanes
		.map(({ lane, baseUrl, probe }) => `${lane} ${baseUrl}: HTTP ${probe.status ?? '—'}${probe.ok ? ' ✅' : ''}${probe.transportError ? ` (${probe.transportError})` : ''}`)
		.join('\n')

	const healthy = lanes.find(({ probe }) => probe.ok)
	if (healthy !== undefined) {
		return {
			ok: true,
			kind: 'OK',
			modelId,
			headline: `✅ 闸门正常（${modelId}，${healthy.lane} lane ${healthy.probe.latencyMs}ms）`,
			detail: `两条通道探测结果：\n${summary}\n当前注册在 ${healthy.lane} lane。`,
			latencyMs: healthy.probe.latencyMs,
		}
	}

	const first = lanes[0]!.probe
	if (first.transportError !== undefined) {
		return {
			ok: false,
			kind: 'UPSTREAM',
			modelId,
			headline: `无法连接匿名通道：${first.transportError}`,
			detail: `这是网络或代理问题，不是闸门问题。探测结果：\n${summary}\n检查代理 / 网络连通性后重试。`,
			latencyMs: first.latencyMs,
		}
	}

	// Both lanes answered; classify from the first (preferred) lane.
	const classification = classifyUpstreamFailure(first.status, first.body)
	const shapeBroken = classification.kind === 'SHAPE_REJECTED'

	return {
		ok: false,
		kind: classification.kind,
		modelId,
		latencyMs: first.latencyMs,
		headline: `${shapeBroken ? '🚨' : '⚠️'} 网关拒绝了这次请求：${classification.summary}`,
		detail: shapeBroken
			? `上游很可能改了形状闸门，本扩展的硬编码已过期。探测结果：\n${summary}\n本次发送的条件：\n${GATE_CONDITIONS.map((c) => `  - ${c}`).join('\n')}\n请提 issue。原始响应：${first.body.slice(0, 300)}`
			: `探测结果：\n${summary}\n原始响应（HTTP ${first.status}）：${first.body.slice(0, 300)}`,
	}
}
