/**
 * The two anonymous free-tier lanes and their request shapes.
 *
 * Upstream serves the keyless lane on two origins that gate DIFFERENT shapes
 * (docs/FINDINGS.md §2.4/§2.5, opencode2api v1.4.1):
 *
 *   legacy /zen/v1       pre-2.x OpenCode 1.18.x shape: legacy User-Agent,
 *                        x-opencode-request, canonical prj_* project id, and a
 *                        single "read" tool is enough (definitions are NOT
 *                        validated; a stub passes). Preferred first.
 *
 *   /inference           OpenCode 2.x shape: opencode/latest/2.0.29/cli UA,
 *                        bare 40-hex project id, four session headers, and
 *                        shell+read with GENUINE definitions (stubs 403).
 *
 * The host engine resolves the request URL from the provider registration,
 * so lane switching is registration-level: this extension registers the
 * currently-healthy lane and re-registers on a shape rejection (403
 * FreeTierError), which is why both shapes are constructed here.
 */

import { randomBytes, createHash } from 'node:crypto'

import { clientProjectID } from './session.ts'
import { gateTool, OPENCODE_TOOLS } from './tools.ts'

export const LEGACY_BASE = 'https://opencode.ai/zen/v1'
export const INFERENCE_BASE = 'https://opencode.ai/inference/v1'
/** Preference order: legacy first, inference as the fallback. */
export const LANE_ORDER = ['legacy', 'inference'] as const
export type LaneKey = (typeof LANE_ORDER)[number]

export interface AnonymousLane {
	readonly key: LaneKey
	readonly baseUrl: string
	/** Registration-level static headers (UA, client, project). */
	readonly headers: (project: string) => Record<string, string>
	/** Per-request headers that vary with the conversation session id. */
	readonly sessionHeaders: (sessionId: string) => Record<string, string>
	/** Normalize the tools the host declared into the wire shape this lane gates. */
	readonly gateTools: (declared: readonly HostTool[]) => { tools: HostTool[]; toolChoice?: 'none' }
}

export interface HostTool {
	readonly name: string
	description: string
	parameters?: unknown
}

/** Pre-2.x User-Agent, matching upstream's v1.3.7 shape (FINDINGS §2.5). */
function legacyUserAgent(): string {
	return `opencode/1.18.31 (${process.platform} ${process.arch}; node${process.versions.node})`
}

/** Canonical prj_<24hex> project id accepted by the legacy origin. */
function legacyProjectID(project: string): string {
	return 'prj_' + createHash('sha256').update(project).digest('hex').slice(0, 24)
}

/** The single tool name the legacy /zen/v1 gate requires; descriptions are not checked. */
const LEGACY_READ_STUB: HostTool = {
	name: 'read',
	description:
		'DEPRECATED: This tool is deprecated and disabled. Do NOT call or reference this tool under any circumstances; ignore it completely.',
	parameters: { type: 'object', properties: {} },
}

/**
 * Legacy lane tool normalization: the gate needs one tool named "read" and
 * validates nothing else about it. A client-declared "read" is left untouched;
 * otherwise a deprecated stub is injected. Unlike the upstream gateway we do
 * NOT rename read-like client tools (read_file etc.) — that would break the
 * host's own tool dispatch, since the model would then emit "read" calls the
 * host cannot service.
 */
function legacyGateTools(declared: readonly HostTool[]): { tools: HostTool[]; toolChoice?: 'none' } {
	if (declared.some((tool) => tool.name === 'read')) return { tools: [...declared] }
	if (declared.length === 0) return { tools: [LEGACY_READ_STUB], toolChoice: 'none' }
	return { tools: [...declared, LEGACY_READ_STUB] }
}

/**
 * Inference lane tool normalization: the gate validates the DEFINITION of
 * every tool whose name it recognises (opencode2api #83), so declared tools
 * with a known OpenCode name are replaced with the genuine definition and
 * missing shell/read are appended. Unknown tools stay exactly as declared so
 * the host's dispatch keeps working.
 */
function inferenceGateTools(declared: readonly HostTool[]): { tools: HostTool[]; toolChoice?: 'none' } {
	const upgraded = declared.map((tool) => {
		const definition = OPENCODE_TOOLS[tool.name]
		if (!definition) return tool
		return { ...tool, description: definition.description, parameters: definition.parameters as Record<string, unknown> }
	})
	const names = new Set(upgraded.map((tool) => tool.name))
	const missing = (['shell', 'read'] as const)
		.filter((name) => !names.has(name))
		.map((name) => gateTool(name))
	if (missing.length === 0 && upgraded.every((tool, index) => tool === declared[index])) {
		return { tools: [...declared] }
	}
	const tools = [...upgraded, ...missing]
	if (declared.length === 0) return { tools, toolChoice: 'none' }
	return { tools }
}

export const LANES: Readonly<Record<LaneKey, AnonymousLane>> = {
	legacy: {
		key: 'legacy',
		baseUrl: LEGACY_BASE,
		headers: (project) => ({
			'user-agent': legacyUserAgent(),
			'x-opencode-client': 'cli',
			'x-opencode-project': legacyProjectID(project),
		}),
		sessionHeaders: (sessionId) => ({
			'x-opencode-session': sessionId,
			'x-opencode-request': `req_${randomBytes(8).toString('hex')}`,
			'x-session-affinity': sessionId,
			'X-Session-Id': sessionId,
		}),
		gateTools: legacyGateTools,
	},
	inference: {
		key: 'inference',
		baseUrl: INFERENCE_BASE,
		headers: (project) => ({
			'user-agent': 'opencode/latest/2.0.29/cli',
			'x-opencode-client': 'cli',
			'x-opencode-project': clientProjectID(project),
		}),
		sessionHeaders: (sessionId) => ({
			'x-opencode-session': sessionId,
			'x-opencode-session-id': sessionId,
			'x-session-affinity': sessionId,
			'X-Session-Id': sessionId,
		}),
		gateTools: inferenceGateTools,
	},
}

export function laneFor(key: LaneKey): AnonymousLane {
	return LANES[key]
}

/**
 * The lane the provider is currently registered against. Lives here (not in
 * index.ts) so health probes can mirror the real request path without a
 * circular import: index, gate and health all read it from one place.
 */
let activeLane: LaneKey = 'legacy'

export function currentLane(): LaneKey {
	return activeLane
}

export function setCurrentLane(lane: LaneKey): void {
	activeLane = lane
}
