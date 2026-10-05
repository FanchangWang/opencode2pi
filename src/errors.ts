/**
 * Upstream failure classification (docs/PLAN.md §T4).
 *
 * Without this the user sees `Error from provider (Console): ...` and has to
 * guess. On the anonymous lane the difference is not cosmetic: a region block
 * and a broken shape gate produce *both* a 403, and telling someone their
 * "API key is invalid" when their network is geo-blocked sends them looking in
 * exactly the wrong place. opencode2dsh shipped that same bug until 0.3.5.
 *
 * So the classifier is ordered by how much the distinction costs when missed:
 * region and credential are checked before the generic auth verdict, because
 * both are 403/401 responses that otherwise collapse into "auth problem".
 */

export type UpstreamFailure =
	| 'SHAPE_REJECTED'
	| 'REGION_BLOCKED'
	| 'MODEL_GONE'
	| 'RATE_LIMIT'
	| 'REQUEST_REJECTED'
	| 'UPSTREAM'
	| 'AUTH'
	| 'UNKNOWN'

export interface Classification {
	readonly kind: UpstreamFailure
	/** Operator-facing explanation; this replaces the raw provider string. */
	readonly summary: string
}

const ADVICE: Readonly<Record<UpstreamFailure, string>> = {
	SHAPE_REJECTED: '上游形状闸门拒绝（FreeTierError）：通常是本扩展的 bug，请提 issue。闸门需要 Bearer public + 规范 session id + tools 里同时有 bash 和 read。',
	REGION_BLOCKED: '该模型在当前网络地区不可用（RegionError）：这是地区封锁，不是凭据问题，换一个模型或网络节点。',
	MODEL_GONE: '模型已下线（ModelError）：上游已不再支持该模型，请查看可用模型列表。',
	RATE_LIMIT: '匿名配额按出口 IP 限流（429）：等待配额恢复，或设置 PI_PROXY_OPENCODE_ZEN_FREE 换出口（宿主按 provider id 派生命名：opencode-zen-free → OPENCODE_ZEN_FREE）。',
	REQUEST_REJECTED: '上游拒绝了请求（400）：该模型无法处理这次输入。最常见的是给只支持文本的模型发图片 —— 本扩展按 models.dev 的 modalities 声明放行，换一个支持对应输入的模型即可。',
	UPSTREAM: '上游暂时不可用（5xx）：稍后重试，或换一个模型。',
	AUTH: '匿名凭据被拒：本扩展不需要 API key，出现这个说明上游认证方式变了，请提 issue。',
	UNKNOWN: '未分类的上游错误。',
}

/**
 * Classify a failed response.
 *
 * `status` is the provider-reported HTTP status, which every provider in the
 * host populates on the error message. Marker strings are checked first and are
 * the stronger signal: they name the upstream failure mode outright, and they
 * survive a change in how the status is surfaced.
 */
export function classifyUpstreamFailure(status: number | undefined, message: string): Classification {
	const text = message.toLowerCase()

	// Region before everything auth-shaped: a geo block is a 403, so any
	// status-driven auth verdict reached first would mislabel it.
	if (text.includes('regionerror') || text.includes('not available in your country') || text.includes('geo-block')) {
		return { kind: 'REGION_BLOCKED', summary: ADVICE.REGION_BLOCKED }
	}
	if (text.includes('freetiererror') || text.includes('free tier') || text.includes('missingsessionid')) {
		return { kind: 'SHAPE_REJECTED', summary: ADVICE.SHAPE_REJECTED }
	}
	if (text.includes('modelerror') || text.includes('model is unavailable') || text.includes('not supported')) {
		return { kind: 'MODEL_GONE', summary: ADVICE.MODEL_GONE }
	}
	if (status === 429 || text.includes('rate limit') || text.includes('too many requests')) {
		return { kind: 'RATE_LIMIT', summary: ADVICE.RATE_LIMIT }
	}
	if (status === 401) return { kind: 'AUTH', summary: ADVICE.AUTH }
	if (status !== undefined && status >= 500) return { kind: 'UPSTREAM', summary: ADVICE.UPSTREAM }

	// An unmarked 403 on this lane is overwhelmingly the shape gate: the
	// anonymous credential is a fixed literal, so there is no key to have got
	// wrong. Saying "auth" here would send users hunting for a key they do not
	// have and never needed.
	if (status === 403) return { kind: 'SHAPE_REJECTED', summary: ADVICE.SHAPE_REJECTED }

	// A 400 is the model refusing the *content*, not the lane: measured on a
	// text-only model handed a PNG, it arrives as "400 ... Endpoint is
	// unavailable." — the same phrase a genuine outage uses. Status decides,
	// because "retry later" advice for a request that can never succeed sends
	// the user into a pointless loop.
	if (status === 400) return { kind: 'REQUEST_REJECTED', summary: ADVICE.REQUEST_REJECTED }

	// Only with no status at all does the free text decide between an outage
	// and something unrecognized.
	if (text.includes('endpoint is unavailable') || text.includes('service unavailable') || text.includes('bad gateway')) {
		return { kind: 'UPSTREAM', summary: ADVICE.UPSTREAM }
	}

	return { kind: 'UNKNOWN', summary: `${ADVICE.UNKNOWN} ${message}` }
}

/** Compose the message the host will display for a classified failure. */
export function formatFailure(modelId: string, classification: Classification): string {
	return `[opencode2pi/${modelId}] ${classification.summary}`
}
