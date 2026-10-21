/**
 * Measuring one custom exit.
 *
 * Two probes, because there are two questions and they cost differently:
 *
 * 1. **Gate test** ({@link probeGate}) — the real gate-shaped streaming request
 *    through the candidate (gate.ts, same shape as the real path), for one model.
 *    This is the only measurement that can tell a working exit from an exit the
 *    anonymous lane refuses, because "refused" is decided upstream from the
 *    request's shape *and* its egress IP. It spends a sliver of quota.
 *
 * 2. **Completion** ({@link probeCompletion}) — the stream is read to completion
 *    and the model must answer `OK`. A gate `200` arrives at the response
 *    headers; an exit can pass it and then die before the first token, so this
 *    is the rung that makes "verified" mean "a turn travelled through it".
 *
 * The order is a cost decision: a dead exit or a region block is cheap to detect
 * from the status line, and reading its stream spends the same request again.
 * A fresh gate `ok` is reused, so re-verifying a known exit costs one completion
 * rather than two requests.
 *
 * There is no bulk screening here any more. Free public lists are gone from the
 * pool because OpenCode refuses the datacenter IPs they mostly contain; the only
 * exits are the user's own, and they are measured one at a time on demand.
 */

import { classifyUpstreamFailure, type UpstreamFailure } from './errors.ts'
import { sendCompletionProbe, sendGateProbe } from './gate.ts'
import { currentLane } from './lanes.ts'
import { SEED_MODELS } from './seed.ts'
import {
	evidenceFor,
	recordCompletion,
	recordGate,
	EXIT_TTL_MS,
	type CompletionEvidence,
	type ExitCandidate,
	type GateEvidence,
	type GateVerdict,
} from './pool.ts'

/**
 * Model used to verify exits. `big-pickle` is OpenCode's default free model and
 * the one upstream is most likely to keep serving; the fallback exists only so a
 * roster change does not break the pool outright.
 */
export const PROBE_MODEL =
	SEED_MODELS.find((model) => model.id === 'big-pickle')?.id ?? SEED_MODELS[0]?.id ?? 'big-pickle'

/** Verdict marks, defined here so the probe and the menu cannot drift apart. */
export const GATE_MARK: Readonly<Record<GateVerdict, string>> = {
	ok: '✅',
	limited: '🚧',
	region: '🌏',
	shape: '⛔',
	transport: '📡',
	inconclusive: '❔',
}

/**
 * Marks for the completion stage. `ok` is the only ✅: a gate pass shares the
 * same table but proves less, which is why the two stages must not look alike.
 */
export const COMPLETION_MARK: Readonly<Record<GateVerdict, string>> = {
	ok: '✅',
	limited: '🚧',
	region: '🌏',
	shape: '⛔',
	transport: '📡',
	inconclusive: '❔',
}

/**
 * Turn one upstream classification into a verdict about the exit.
 *
 * The interesting cases are the ones that must **not** falsify an exit: a 400 is
 * the model refusing the content, a 5xx is upstream, a model id the lane has
 * dropped is the roster's problem — none of those would have been fixed by a
 * different exit, and blaming the exit would throw away a working one.
 */
export function verdictOf(kind: UpstreamFailure): GateVerdict {
	switch (kind) {
		case 'RATE_LIMIT':
			return 'limited'
		case 'REGION_BLOCKED':
			return 'region'
		case 'SHAPE_REJECTED':
		case 'AUTH':
			return 'shape'
		case 'UNKNOWN':
		case 'UPSTREAM':
		case 'MODEL_GONE':
		case 'REQUEST_REJECTED':
			return 'inconclusive'
	}
}

/**
 * Run the gate probe for `modelId` through one address, without recording it.
 *
 * Unrecorded so the caller can decide what a verdict means before it becomes
 * evidence; {@link gateTestExit} is the recording wrapper the menu uses.
 */
async function probeGate(url: string, modelId: string): Promise<GateEvidence> {
	const startedAt = Date.now()
	const probe = await sendGateProbe(modelId, currentLane(), url)
	const base = { at: Date.now(), modelId, e2eMs: Date.now() - startedAt }
	if (probe.ok) return { ...base, status: probe.status, verdict: 'ok', detail: `HTTP ${probe.status}` }
	if (probe.transportError !== undefined) return { ...base, verdict: 'transport', detail: probe.transportError }
	const { kind, summary } = classifyUpstreamFailure(probe.status, probe.body)
	return { ...base, status: probe.status, verdict: verdictOf(kind), detail: `${summary}（HTTP ${probe.status}）` }
}

/**
 * Run the gate probe through one pool member, and record it.
 *
 * The classification is the same one the real request path uses, so a verdict
 * here and a verdict at runtime cannot disagree about what a 403 meant — which
 * matters, because a region block is not a dead proxy and the pool must not
 * throw away a good exit over a block that only affects one model.
 */
async function gateTestExit(candidate: ExitCandidate, modelId: string): Promise<GateEvidence> {
	const evidence = await probeGate(candidate.url, modelId)
	await recordGate(candidate.key, evidence)
	return evidence
}

/**
 * Read a real turn through one address, without recording it.
 *
 * A 200 with an in-band error is classified with the same
 * `classifyUpstreamFailure` the request path uses: the status alone would call a
 * `FreeTierError` delivered inside an SSE stream an unknown 200.
 */
async function probeCompletion(url: string, modelId: string): Promise<CompletionEvidence> {
	const startedAt = Date.now()
	const probe = await sendCompletionProbe(modelId, currentLane(), url)
	const base = { at: Date.now(), modelId, e2eMs: Date.now() - startedAt }
	if (probe.transportError !== undefined) return { ...base, verdict: 'transport', detail: probe.transportError }
	if (probe.matched === true) {
		return {
			...base,
			...(probe.status === undefined ? {} : { status: probe.status }),
			verdict: 'ok',
			detail: `完成并返回 OK · ${probe.latencyMs}ms`,
			...(probe.completion === undefined ? {} : { received: probe.completion }),
		}
	}
	if (probe.status !== undefined && probe.status >= 400) {
		const { kind, summary } = classifyUpstreamFailure(probe.status, probe.body)
		return { ...base, status: probe.status, verdict: verdictOf(kind), detail: `${summary}（HTTP ${probe.status}）` }
	}
	if (probe.completion === undefined) {
		// 200, but the stream carried an error or closed with nothing. The text is
		// classified because upstream failures also arrive inside a 200 stream.
		const { kind, summary } = classifyUpstreamFailure(probe.status, probe.body)
		return {
			...base,
			...(probe.status === undefined ? {} : { status: probe.status }),
			verdict: verdictOf(kind),
			detail: probe.body === '' ? '流在返回内容前结束' : summary,
		}
	}
	return {
		...base,
		...(probe.status === undefined ? {} : { status: probe.status }),
		verdict: 'inconclusive',
		detail: `完成但未返回 OK：${probe.completion.slice(0, 60)}`,
		received: probe.completion,
	}
}

/** Run the completion probe through a pool member, and record it. */
async function completionTestExit(candidate: ExitCandidate, modelId: string): Promise<CompletionEvidence> {
	const completion = await probeCompletion(candidate.url, modelId)
	await recordCompletion(candidate.key, completion)
	return completion
}

/**
 * Verify one candidate end to end: gate first, completion only if the gate passed.
 *
 * A fresh gate `ok` is reused so re-verifying a known exit costs one completion
 * rather than two requests. The completion is re-run every time on purpose: it is
 * the only stage whose freshness decides {@link isVerified}.
 */
export async function verifyExit(
	candidate: ExitCandidate,
	modelId: string,
): Promise<{ gate: GateEvidence; completion?: CompletionEvidence }> {
	const known = evidenceFor(candidate.key)?.gate
	const gate =
		known?.verdict === 'ok' && Date.now() - known.at <= EXIT_TTL_MS
			? known
			: await gateTestExit(candidate, modelId)
	if (gate.verdict !== 'ok') return { gate }
	return { gate, completion: await completionTestExit(candidate, modelId) }
}
