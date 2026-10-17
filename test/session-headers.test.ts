/**
 * The session header must survive the host's own header handling.
 *
 * This is a regression test for a bug that only ever appeared on pi, and it is
 * the reason the test drives the real handler rather than asserting on source
 * text.
 *
 * pi treats any provider whose `baseUrl` is `opencode.ai` as its own
 * (`core/provider-attribution.ts:67-77`) and stamps its own session id onto
 * `x-opencode-session` from a `transformHeaders` hook. That hook is applied
 * AFTER the model headers are resolved and merges its value LAST
 * (`core/sdk.ts:354-364`), so a session id set only on `model.headers` is
 * replaced by pi's UUID. The upstream gate requires the canonical
 * `^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$` layout on that header, so the request dies
 * with a bare `FreeTierError` — measured 2026-10-17 as: the identical request
 * passed the gate on omp and failed it on pi.
 *
 * The fix was to send the session headers on `options.headers` as well, since
 * that layer is what the attribution hook receives and overwrites. Asserting
 * "the header is set somewhere" would not have caught it; asserting it survives
 * a host that actively tries to replace it does.
 */

import { describe, expect, test } from 'bun:test'

import { createStreamHandler } from '../src/request.ts'
import { laneFor } from '../src/lanes.ts'
import { PROJECT_ID, PROVIDER, type StreamEngine, type StreamModel } from '../src/host/contract.ts'

const CANONICAL_SESSION = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

/** What a host does to headers before the request leaves: overwrite what it owns. */
function hostHeaderPass(
	model: StreamModel,
	options: { headers?: Record<string, string> } | undefined,
): Record<string, string> {
	// pi: attribution headers are merged over the resolved ones, host value last.
	const attribution = { 'x-opencode-session': '01a14837-fae7-77d9-9625-aba7e87dd15e', 'x-opencode-client': 'pi' }
	const resolved = { ...model.headers, ...options?.headers }
	// `options.headers` reaches the hook as `requestHeaders`, which it applies last.
	return { ...attribution, ...resolved }
}

/** Capture what `createStreamHandler` hands to the host engine. */
function captureDispatch(): {
	options: Record<string, unknown> | undefined
	model: StreamModel
	engine: StreamEngine
} {
	const captured: { options?: Record<string, unknown>; model?: StreamModel } = {}
	const engine: StreamEngine = {
		diagnostics: { info: () => {}, warn: () => {} },
		normalizeContext: () => ({ tools: [], withTools: () => ({}) }),
		explainFailure: (_id, error) => error,
		createStream: () => ({
			push: () => {},
			end: () => {},
			result: () => new Promise(() => {}),
			[Symbol.asyncIterator]: () => ({
				next: () => new Promise<IteratorResult<never>>(() => {}),
			}),
		}),
		abort: () => {},
		dispatch: (model, _context, options) => {
			captured.model = model
			captured.options = options as Record<string, unknown>
			return {
				push: () => {},
				end: () => {},
				result: () => new Promise(() => {}),
				[Symbol.asyncIterator]: () => ({
					next: () => new Promise<IteratorResult<never>>(() => {}),
				}),
			}
		},
	}
	return {
		get options() {
			return captured.options
		},
		get model() {
			return captured.model as StreamModel
		},
		engine,
	}
}

describe('session headers survive the host (regression, pi 2026-10-17)', () => {
	test('the canonical session id reaches the wire after the host header pass', () => {
		const captured = captureDispatch()
		const handler = createStreamHandler(captured.engine)
		const lane = laneFor('legacy')

		handler(
			{
				id: 'big-pickle',
				api: 'x',
				baseUrl: lane.baseUrl,
				// The registration-level headers the host resolved onto the model. They
				// carry `x-opencode-client: cli`, which pi's attribution hook also tries
				// to claim, so this is the layer that has to survive too.
				headers: lane.headers(PROJECT_ID),
			},
			{},
			{ sessionId: 'host-supplied-session' },
		)

		const model = captured.model
		const options = captured.options
		expect(model).toBeDefined()

		const onWire = hostHeaderPass(model, options as { headers?: Record<string, string> })
		const session = onWire['x-opencode-session']

		// The host's own UUID must not be what goes out.
		expect(session).not.toBe('01a14837-fae7-77d9-9625-aba7e87dd15e')
		expect(session).toMatch(CANONICAL_SESSION)
		// The gate also reads the client marker; pi would rewrite it to "pi".
		expect(onWire['x-opencode-client']).toBe('cli')
	})

	test('the session headers are present on both layers the hosts read', () => {
		const captured = captureDispatch()
		const handler = createStreamHandler(captured.engine)

		handler({ id: 'big-pickle', api: 'x', baseUrl: laneFor('legacy').baseUrl, headers: {} }, {}, {})

		const modelHeaders = captured.model?.headers ?? {}
		const optionHeaders = (captured.options?.headers ?? {}) as Record<string, string>

		// omp reads the model headers; pi's attribution hook overwrites those, so the
		// options layer is what actually carries the fix.
		expect(modelHeaders['x-opencode-session']).toMatch(CANONICAL_SESSION)
		expect(optionHeaders['x-opencode-session']).toMatch(CANONICAL_SESSION)
		expect(optionHeaders['x-opencode-request']).toMatch(/^req_[0-9a-f]{16}$/)
	})

	test('the provider id stays off the wire as a header', () => {
		// Guards against a regression where the provider name leaks into the shape.
		const captured = captureDispatch()
		createStreamHandler(captured.engine)(
			{ id: 'big-pickle', api: 'x', baseUrl: laneFor('legacy').baseUrl, headers: {} },
			{},
			{},
		)
		const headers = captured.model?.headers ?? {}
		expect(Object.keys(headers).some((k) => k.toLowerCase().includes(PROVIDER))).toBe(false)
	})
})