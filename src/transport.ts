/**
 * Per-request proxying, for whichever runtime is actually hosting us.
 *
 * The exit pool's switching mechanism is a single function around `fetch`, and
 * for a long time that function was written as `fetch(url, { proxy })`. Measured
 * 2026-10-17, that only ever worked on one host:
 *
 *   · **Bun** (omp) implements `proxy` as a `RequestInit` extension. Verified:
 *     through `http://192.168.31.50:7890` the egress IP changes 120.225.64.15 →
 *     195.154.200.13.
 *   · **Node** (pi, all three install methods — see below) does not. undici
 *     ignores unknown `RequestInit` properties *silently*: no warning, no
 *     error, the request just goes out directly. Measured: direct, a US public
 *     proxy and a LAN proxy all returned 120.225.64.15.
 *
 * A silent no-op is the worst possible failure mode for this feature, because
 * the pool reports a selected exit, the menu shows that exit's evidence, and
 * every request quietly leaves from the machine's own address — which is the
 * one address whose quota is already spent. So the runtime is detected and the
 * two mechanisms are kept apart rather than assumed interchangeable.
 *
 * On Node the mechanism is undici's `ProxyAgent`, and it carries a trap worth
 * writing down: **a dispatcher only works with the `fetch` from the copy that
 * built it.** Handing a `ProxyAgent` from an external undici to Node's built-in
 * global `fetch` fails with `TypeError: fetch failed` (measured), because the
 * global belongs to Node's *internal* undici. So the wrapper switches the whole
 * `fetch`, not just the dispatcher.
 *
 * Which undici to use is resolved at startup rather than assumed, and
 * `undici` is deliberately not a hard dependency. pi ships its own (8.10.2, a
 * direct dependency of `@earendil-works/pi-coding-agent`) and it is reachable
 * through `createRequire` anchored on the running entry script; an extension
 * installed on its own would rather have its own copy. Both are tried, in that
 * order, and a third possibility — a future host that is neither Bun nor
 * carries undici — resolves to `'none'`, which callers must treat as "the pool
 * cannot work here" rather than "carry on direct".
 *
 * Note on install methods, since it decides whether this file needs a Bun branch
 * at all: pi runs on Node however it was installed. Its `dist/bundle/cli.js`
 * carries `#!/usr/bin/env node` (read from the installed file), its package
 * declares `engines.node >= 22.19.0`, and `bun add --global` produces a `.bunx`
 * shim that *honours the shebang* — measured with a purpose-built package:
 * `#!/usr/bin/env node` shims to node, `#!/usr/bin/env bun` tries to exec bun
 * and fails. So "which runtime" is answered by asking the runtime, not by
 * asking which host or which installer.
 */

import { createRequire } from 'node:module'

import type { FetchLike } from './host/contract.ts'

/** `RequestInit` plus the option Bun's fetch uses for a per-request proxy. */
type ProxiedInit = RequestInit & { proxy?: string; dispatcher?: unknown }

/**
 * How a per-request proxy can be expressed here.
 *
 * `'none'` is a real answer, not a placeholder: it means this runtime offers no
 * mechanism, and the pool must say so rather than pretend. `'unresolved'` is the
 * state *before* {@link initProxyBackend} has run, and it is kept distinct on
 * purpose — a caller that reached for a proxy before resolution finished would
 * otherwise be told "this runtime cannot", which is a different claim, and would
 * quietly go direct. `index.ts` resolves before the provider is registered, so
 * in a live session this state is only ever seen by a call site that skipped
 * startup, which is exactly what should be loud rather than silent.
 */
export type ProxyBackend = 'unresolved' | 'bun' | 'undici' | 'none'

/** The slice of undici this file uses. Structural so it needs no dependency. */
export interface UndiciLike {
	readonly fetch: FetchLike
	readonly ProxyAgent: new (options: string | ProxyAgentOptions) => DispatcherLike
}

/**
 * ProxyAgent options, narrowed to the two fields this file sets.
 *
 * `proxyTls` is undici's separate TLS configuration for the *proxy hop*. It has
 * to be disabled in practice: the published free lists carry `https://host:port`
 * entries with self-signed certificates, and Node rejects those before CONNECT —
 * so the address is judged dead even though the tunnel would work. Only the hop
 * to the proxy is unverified; the tunnelled `CONNECT` still speaks TLS to the
 * target through the proxy and verifies *that* certificate normally.
 */
export interface ProxyAgentOptions {
	readonly uri: string
	readonly proxyTls?: { readonly rejectUnauthorized?: boolean }
}

interface DispatcherLike {
	close?(): Promise<void>
	destroy?(): Promise<void>
}

const UNDICI_SPECIFIER = 'undici'
/** Proxies are per-exit and there are only ever a handful in the pool. */
const AGENT_CACHE_LIMIT = 4

let backend: ProxyBackend = 'unresolved'
let undici: UndiciLike | undefined
let initialised = false

/**
 * Anchors to try when resolving undici, most specific first.
 *
 * `import.meta.url` is this file: right when the extension ships its own undici.
 * `process.argv[1]` is the *host's* entry script, which walks up to the host's
 * `node_modules` — how pi's own copy is found without hard-coding an install
 * path that a version bump would invalidate. `process.execPath` covers a global
 * install next to the interpreter.
 */
function resolutionAnchors(): readonly string[] {
	const anchors: string[] = [import.meta.url]
	if (process.argv[1] !== undefined) anchors.push(process.argv[1])
	if (process.execPath !== undefined) anchors.push(process.execPath)
	return anchors
}

function usableUndici(candidate: unknown): UndiciLike | undefined {
	if (typeof candidate !== 'object' || candidate === null) return undefined
	const record = candidate as { fetch?: unknown; ProxyAgent?: unknown; default?: unknown }
	// A CJS `require` under a transpiling ESM loader can arrive wrapped.
	const inner = (record.default ?? candidate) as { fetch?: unknown; ProxyAgent?: unknown }
	if (typeof inner.fetch !== 'function' || typeof inner.ProxyAgent !== 'function') return undefined
	return { fetch: inner.fetch as FetchLike, ProxyAgent: inner.ProxyAgent as UndiciLike['ProxyAgent'] }
}

async function loadUndici(): Promise<UndiciLike | undefined> {
	try {
		const direct = usableUndici(await import(UNDICI_SPECIFIER))
		if (direct) return direct
	} catch {
		/* Not installed here; fall through to the host's copy. */
	}
	for (const anchor of resolutionAnchors()) {
		try {
			const resolved = usableUndici(createRequire(anchor)(UNDICI_SPECIFIER))
			if (resolved) return resolved
		} catch {
			/* This anchor has no undici; try the next. */
		}
	}
	return undefined
}

/**
 * Decide once, at startup, how (or whether) this process can proxy a request.
 *
 * Bun is checked first and returns immediately: its mechanism needs no
 * dependency at all, so there is nothing to resolve. Everything else has to
 * find an undici or admit it cannot.
 *
 * `override` takes an undici-shaped object instead of resolving one. It exists
 * for the two cases the search cannot cover — a host that keeps its HTTP stack
 * somewhere unusual, and the test that has to exercise the Node branch without
 * spawning a Node process. It is a documented seam rather than a test hook,
 * because "the host knows where its own undici is" is a real answer.
 *
 * Idempotent, because it runs on a path that may be entered more than once and
 * re-running `import` would be pure cost.
 */
export async function initProxyBackend(override?: unknown): Promise<ProxyBackend> {
	if (initialised) return backend
	initialised = true
	if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' && override === undefined) {
		backend = 'bun'
		return backend
	}
	undici = usableUndici(override) ?? (await loadUndici())
	backend = undici === undefined ? 'none' : 'undici'
	return backend
}

/** The backend in force. `'unresolved'` before {@link initProxyBackend} has run. */
export function proxyBackend(): ProxyBackend {
	return backend
}

/** Human-readable reason a backend is unusable, for the one warning we emit. */
export function proxyBackendNote(): string {
	switch (backend) {
		case 'bun':
			return 'fetch proxy'
		case 'undici':
			return 'undici ProxyAgent'
		case 'none':
			return 'no mechanism'
		default:
			return 'not resolved yet'
	}
}

const agents = new Map<string, DispatcherLike>()

/**
 * One agent per proxy URL, reused across requests.
 *
 * A fresh `ProxyAgent` per request would leave a socket pool per request, and
 * the extension makes one request per model turn. The cache is small and bounded
 * because the pool holds a handful of exits; the eviction closes the agent so
 * its sockets do not outlive it.
 */
function agentFor(copy: UndiciLike, url: string): DispatcherLike {
	const existing = agents.get(url)
	if (existing) return existing
	// An `https:` proxy needs its own TLS verification turned off. Free-list
	// entries commonly present self-signed certificates, and undici refuses the
	// hop before it ever sends CONNECT; the same addresses are then screened out
	// (prefilter.ts makes the identical choice). Plain `http:` proxies keep the
	// string form, so no unnecessary options object reaches undici.
	const created = url.startsWith('https:')
		? new copy.ProxyAgent({ uri: url, proxyTls: { rejectUnauthorized: false } })
		: new copy.ProxyAgent(url)
	agents.set(url, created)
	// `Map.delete` answers whether the key was there, not what it held, so the
	// evicted agent has to be read before it goes.
	while (agents.size > AGENT_CACHE_LIMIT) {
		const oldest = agents.keys().next()
		if (oldest.done === true) break
		const evicted = agents.get(oldest.value)
		agents.delete(oldest.value)
		void evicted?.close?.().catch(() => {})
	}
	return created
}

/** Close every cached agent. Called when the pool is switched or turned off. */
export async function disposeProxyAgents(): Promise<void> {
	const held = [...agents.values()]
	agents.clear()
	await Promise.all(
		held.map(async (agent) => {
			try {
				await agent.close?.()
			} catch {
				/* A socket that is already gone is not a failure worth raising. */
			}
		}),
	)
}

/**
 * The proxy mechanism, resolved and held.
 *
 * Split from {@link makeProxiedFetch} on purpose: resolution touches the module
 * system and runs once, while the wrapper is pure and has to be exercisable for
 * *both* mechanisms. A suite that can only reach the branch its own runtime
 * happens to take is how the other branch shipped broken.
 */
export interface ProxyEngine {
	readonly kind: 'bun' | 'undici'
	/** Required for `undici`; absent for `bun`, which uses the global fetch. */
	readonly undici?: UndiciLike
}

/**
 * Build a fetch that routes through `proxyUrl`, or `undefined` when this runtime
 * cannot.
 *
 * `undefined` is load-bearing and callers must not paper over it: with an engine
 * this always returns a function, and without one it returns nothing so the pool
 * can report that it is inert here. That is the difference between "the pool is
 * off" and "the pool cannot work", and the bug this replaces collapsed the two.
 *
 * `base` is honoured only on the Bun path. On the Node path the request has to
 * go through the *same* undici copy that built the agent — handing a foreign
 * `ProxyAgent` to Node's built-in global `fetch` fails with `TypeError: fetch
 * failed` (measured), because the global belongs to Node's *internal* undici —
 * and `base`, the host's own fetch, belongs to that internal one. Bypassed hosts
 * (see `pool.ts`) still use `base`, because those never take the proxied path.
 */
export function makeProxiedFetch(
	engine: ProxyEngine | undefined,
	proxyUrl: string,
	base?: FetchLike,
): FetchLike | undefined {
	if (engine === undefined) return undefined
	if (engine.kind === 'bun') {
		const inner = base ?? globalThis.fetch
		return (input, init) => {
			const proxied: ProxiedInit = { ...(init ?? {}), proxy: proxyUrl }
			return inner(input, proxied)
		}
	}
	const copy = engine.undici
	if (copy === undefined) return undefined
	return (input, init) => {
		// `dispatcher` is typed as undici's own `Dispatcher` in the ambient
		// RequestInit, and this agent is structurally one only as far as this file
		// uses it. The cast is where that gap is acknowledged — a foreign-runtime
		// object handed back to the runtime that produced it, not a shape the
		// extension has to maintain.
		const proxied = { ...(init ?? {}), dispatcher: agentFor(copy, proxyUrl) } as RequestInit
		return copy.fetch(input, proxied)
	}
}

/** The engine this process resolved, or `undefined` when it has none. */
export function proxyEngine(): ProxyEngine | undefined {
	if (backend !== 'bun' && backend !== 'undici') return undefined
	return { kind: backend, ...(undici === undefined ? {} : { undici }) }
}

/** The resolved mechanism, using this process's own. */
export function proxiedFetch(proxyUrl: string, base?: FetchLike): FetchLike | undefined {
	return makeProxiedFetch(proxyEngine(), proxyUrl, base)
}