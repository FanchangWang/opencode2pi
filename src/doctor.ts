/**
 * `/opencode2pi doctor` (docs/PLAN.md §T5).
 *
 * The shape gate is hardcoded in this extension, and nothing about it is
 * negotiated: when upstream changes the check, *every* request starts failing
 * with a bare 403 and no model in particular looks guilty. Upstream has revised
 * its policy three times in three weeks, so this turns that silent total
 * failure into one explicit, classified verdict.
 *
 * One request, because the gate is global — a second probe would only confirm
 * what the first already decided.
 */

import { classifyUpstreamFailure, type UpstreamFailure } from './errors.ts'
import { GATE_CONDITIONS, sendGateProbe } from './gate.ts'

export interface DoctorReport {
	readonly ok: boolean
	readonly kind: UpstreamFailure | 'OK'
	readonly headline: string
	readonly detail: string
	readonly latencyMs: number
	readonly modelId: string
}

export async function runDoctor(modelId: string): Promise<DoctorReport> {
	const probe = await sendGateProbe(modelId)

	if (probe.ok) {
		return {
			ok: true,
			kind: 'OK',
			modelId,
			headline: `✅ 闸门正常（${modelId}，${probe.latencyMs}ms）`,
			detail: '三个必要条件仍然成立，匿名通道可用。',
			latencyMs: probe.latencyMs,
		}
	}

	if (probe.transportError !== undefined) {
		return {
			ok: false,
			kind: 'UPSTREAM',
			modelId,
			headline: `无法连接 Zen：${probe.transportError}`,
			detail: '这是网络或代理问题，不是闸门问题。检查 PI_PROXY / 网络连通性后重试。',
			latencyMs: probe.latencyMs,
		}
	}

	const classification = classifyUpstreamFailure(probe.status, probe.body)
	const shapeBroken = classification.kind === 'SHAPE_REJECTED'

	return {
		ok: false,
		kind: classification.kind,
		modelId,
		latencyMs: probe.latencyMs,
		headline: `${shapeBroken ? '🚨' : '⚠️'} 网关拒绝了这次请求：${classification.summary}`,
		detail: shapeBroken
			? `上游很可能改了形状闸门，本扩展的硬编码已过期。本次发送的条件：\n${GATE_CONDITIONS.map((c) => `  - ${c}`).join('\n')}\n请提 issue。原始响应：${probe.body.slice(0, 300)}`
			: `原始响应（HTTP ${probe.status}）：${probe.body.slice(0, 300)}`,
	}
}
