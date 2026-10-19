/**
 * The proxy transport has one job: never fail silently.
 *
 * The bug this file exists for was measured, not hypothesised. `init.proxy` is a
 * Bun extension to `RequestInit`; under Node's undici an unknown init property
 * is ignored without a warning, so the exit pool's wrapper returned a function
 * that fetched *directly*. Nothing threw. The pool menu showed a selected exit,
 * that exit carried screen evidence, and every request still left from the
 * machine's own address — the one address whose quota was already spent. pi
 * looked like a 429 problem and was a 429 problem, for a reason no error could
 * have reported.
 *
 * So two properties are locked here:
 *
 *  · **The mechanism is chosen by capability.** Bun gets `init.proxy`; Node gets
 *    a `dispatcher` and, with it, a *different* `fetch` — because a dispatcher
 *    only works with the undici copy that built it.
 *  · **Inert is a first-class answer.** No engine yields `undefined`, and that
 *    `undefined` is what makes the warning in `request.ts` reachable. It is the
 *    only honest thing a runtime without a mechanism can return.
 *
 * The Node branch is driven through {@link makeProxiedFetch} with an
 * undici-shaped double rather than by spawning a Node process: the part worth
 * pinning is *which key lands in the init object*, and that is fully observable
 * without one. A suite that can only reach the branch its own runtime takes is
 * how the other branch shipped broken.
 */

import { describe, expect, test } from 'bun:test'

import {
	disposeProxyAgents,
	initProxyBackend,
	makeProxiedFetch,
	proxiedFetch,
	proxyBackend,
	proxyBackendNote,
	type ProxyAgentOptions,
	type UndiciLike,
} from '../src/transport.ts'

const EXIT = 'http://192.0.2.10:8080'

/** Records what actually reached the transport, keyed by mechanism. */
function recordingUndici() {
	const calls: { url: string; init: RequestInit }[] = []
	const built: (string | ProxyAgentOptions)[] = []
	const copy: UndiciLike = {
		fetch: (async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), init: init ?? {} })
			return new Response('{}')
		}) as UndiciLike['fetch'],
		ProxyAgent: class {
			constructor(options: string | ProxyAgentOptions) {
				built.push(options)
			}
			async close(): Promise<void> {}
		},
	}
	return { copy, calls, built }
}

describe('this runtime', () => {
	test('resolves to a mechanism rather than to "none"', async () => {
		// The suite runs under Bun, which is the `init.proxy` mechanism.
		expect(await initProxyBackend()).toBe('bun')
		expect(proxyBackend()).toBe('bun')
		expect(proxiedFetch(EXIT)).toBeInstanceOf(Function)
	})

	test('re-resolving is free and agrees with itself', async () => {
		expect(await initProxyBackend()).toBe(await initProxyBackend())
	})
})

describe('the Bun mechanism', () => {
	test('carries the exit in `init.proxy` and keeps the caller’s init', async () => {
		const seen: (RequestInit & { proxy?: string })[] = []
		const base = (async (_input: string | URL | Request, init?: RequestInit) => {
			seen.push(init ?? {})
			return new Response('{}')
		}) as typeof globalThis.fetch

		const wrapped = makeProxiedFetch({ kind: 'bun' }, EXIT, base)
		expect(wrapped).toBeDefined()
		await wrapped?.('https://opencode.ai/zen/v1/chat/completions', { method: 'POST' })

		expect(seen[0]?.proxy).toBe(EXIT)
		expect(seen[0]?.method).toBe('POST')
	})
})

describe('the undici mechanism (the Node half)', () => {
	test('carries the exit in `dispatcher`, and never in `proxy`', async () => {
		const { copy, calls, built } = recordingUndici()
		const wrapped = makeProxiedFetch({ kind: 'undici', undici: copy }, EXIT)
		expect(wrapped).toBeDefined()
		await wrapped?.('https://opencode.ai/zen/v1/chat/completions', { method: 'POST' })

		// The regression, stated as an assertion: `proxy` is the key Node ignores,
		// so its absence here is the whole point of the separate mechanism.
		const init = calls[0]?.init as (RequestInit & { proxy?: string; dispatcher?: unknown }) | undefined
		expect(init?.proxy).toBeUndefined()
		expect(init?.dispatcher).toBeDefined()
		expect(init?.method).toBe('POST')
		expect(built).toEqual([EXIT])
	})

	test('switches the fetch, not only the dispatcher', async () => {
		// Measured: an external undici's ProxyAgent handed to Node's *internal*
		// global fetch throws `TypeError: fetch failed`. The host's `base` is that
		// internal fetch, so honouring `base` on this path would break every
		// proxied request. `base` must be ignored here and only here.
		const { copy, calls } = recordingUndici()
		const baseCalls: unknown[] = []
		const base = (async () => {
			baseCalls.push('called')
			return new Response('{}')
		}) as unknown as typeof globalThis.fetch

		const wrapped = makeProxiedFetch({ kind: 'undici', undici: copy }, EXIT, base)
		await wrapped?.('https://opencode.ai/zen/v1/chat/completions')

		expect(baseCalls).toEqual([])
		expect(calls).toHaveLength(1)
	})

	test('disables TLS verification on an https exit, and only there', async () => {
		// Published free-list `https://host:port` exits routinely present
		// self-signed certificates. undici otherwise refuses the proxy hop before
		// sending CONNECT, and a working tunnel is judged dead. The plain-http
		// path must keep the string form so nothing else changes.
		const https = 'https://192.0.2.88:8443'
		const { copy, built } = recordingUndici()
		const wrapped = makeProxiedFetch({ kind: 'undici', undici: copy }, https)
		await wrapped?.('https://opencode.ai/a')
		expect(built).toEqual([{ uri: https, proxyTls: { rejectUnauthorized: false } }])
		await disposeProxyAgents()

		const { copy: plain, built: plainBuilt } = recordingUndici()
		const http = 'http://192.0.2.89:8080'
		await makeProxiedFetch({ kind: 'undici', undici: plain }, http)?.('https://opencode.ai/a')
		expect(plainBuilt).toEqual([http])
		await disposeProxyAgents()
	})

	test('reuses one agent per exit instead of one per request', async () => {
		// Its own exit URL: the agent cache is module state shared by the whole
		// suite, so reusing `EXIT` here would find the agent an earlier test built.
		const url = 'http://192.0.2.77:8080'
		const { copy, built } = recordingUndici()
		const wrapped = makeProxiedFetch({ kind: 'undici', undici: copy }, url)
		await wrapped?.('https://opencode.ai/a')
		await wrapped?.('https://opencode.ai/b')
		expect(built).toEqual([url])
		await disposeProxyAgents()
	})
})

describe('no mechanism', () => {
	test('yields undefined instead of a fetch that quietly goes direct', () => {
		// This is what makes the pool's one-shot warning reachable. Returning a
		// direct-connecting function here is the bug in its original form.
		expect(makeProxiedFetch(undefined, EXIT)).toBeUndefined()
		expect(makeProxiedFetch({ kind: 'undici' }, EXIT)).toBeUndefined()
	})

	test('an unresolved runtime is a distinct state, never mistaken for "no mechanism"', () => {
		// Only one of the two inert states is fixable, so they must not share a
		// reported cause. This suite resolves to `bun`, so the assertion is that
		// the distinction exists in the vocabulary rather than about this runtime.
		expect(proxyBackendNote()).toBe('fetch proxy')
		expect(proxyBackend()).not.toBe('none')
		expect(proxyBackend()).not.toBe('unresolved')
	})
})