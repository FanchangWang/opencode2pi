/**
 * The cheap first stage of exit screening: can this proxy open a tunnel at all?
 *
 * The full screen ({@link import('./pool-probe.ts').traceEgress}) talks TLS to
 * Cloudflare and then measures a second request on the same tunnel. That is the
 * right measurement for "is this exit good", and the wrong one for "is this
 * address dead": most published free proxies are dead sockets that hang until
 * the 2 s budget. Measured on 2026-10-19: 1280 screened addresses produced 20
 * trace passes (1.6%) and 1260 quarantines — almost all of the time was spent
 * learning that a socket never answered. At the old shared width of 128 the
 * 4096-address round took ~65 s; at this stage's 512 it takes ~16 s.
 *
 * This stage asks only the one question a dead socket cannot fake: complete an
 * HTTP `CONNECT` to the host the real trace uses. It sends no TLS and no HTTP
 * request through the tunnel, so a dead proxy costs one TCP round-trip or a 2 s
 * timeout instead of a TLS handshake plus an HTTPS request. Survivors then go
 * through the existing screen unchanged, which is what keeps the verdict — and
 * the exit IP, latency and handshake figures — identical to before.
 *
 * No fetch/undici is used on purpose. This is a statement about the proxy
 * itself, not about the host runtime's proxy plumbing, and it has to cost less
 * than the thing it is rejecting. The real request path still uses
 * `proxiedFetch`; nothing here becomes a second transport.
 */

import { connect as netConnect, isIP, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

/** Same host as {@link import('./pool-probe.ts').TRACE_URL}, so a whitelist cannot differ. */
const CONNECT_TARGET = 'cloudflare.com:443'

/**
 * Per-address budget for the tunnel check.
 *
 * Free-list addresses are mostly either gone or silently dropping packets. 2 s
 * is several times the TCP RTT of any exit worth keeping and still bounds 4096
 * addresses at roughly a minute with the concurrency the sweep uses. Anything
 * slower than this cannot carry a conversation that already spends seconds on
 * the tunnel.
 */
export const PREFILTER_TIMEOUT_MS = 2000

export interface PrefilterResult {
	readonly ok: boolean
	readonly latencyMs: number
	/** Why the tunnel was refused. Never contains the proxy's credentials. */
	readonly error?: string
}

/**
 * Ask one proxy for a `CONNECT cloudflare.com:443` tunnel, then close it.
 *
 * Resolves rather than throws: a refusal is the answer this function exists to
 * produce. `https` proxies authenticate the client with TLS first (`tlsConnect`)
 * and `http` proxies are plain sockets; both then speak the same CONNECT line.
 * Basic credentials in the URL become `Proxy-Authorization`, decoded exactly as
 * `undici` and Bun's fetch do, so a proxy that works here works there.
 */
export function prefilterExit(proxyUrl: string, timeoutMs = PREFILTER_TIMEOUT_MS): Promise<PrefilterResult> {
	const startedAt = Date.now()
	const { promise, resolve } = Promise.withResolvers<PrefilterResult>()
	let settled = false
	let socket: Socket | undefined
	let cancelTimer: () => void = () => {}
	const finish = (result: Omit<PrefilterResult, 'latencyMs'>): void => {
		if (settled) return
		settled = true
		cancelTimer()
		socket?.destroy()
		resolve({ latencyMs: Date.now() - startedAt, ...result })
	}
	// A hard total budget, not `socket.setTimeout`: that one only starts once the
	// socket connects, so a hostname whose DNS lookup hangs would outlive it. A
	// prefilter that is slower than the thing it rejects is worthless.
	const timer = setTimeout(() => finish({ ok: false, error: `预筛超时 ${timeoutMs}ms` }), timeoutMs)
	cancelTimer = () => clearTimeout(timer)

	let url: URL
	try {
		url = new URL(proxyUrl)
	} catch {
		finish({ ok: false, error: '代理地址无法解析' })
		return promise
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		finish({ ok: false, error: `不支持的代理协议 ${url.protocol}` })
		return promise
	}

	// Node reports IPv6 hostnames in URLs as `[::1]`; net.connect wants the
	// address without brackets. Credentials are percent-encoded in URLs.
	const host = url.hostname.replace(/^\[|\]$/g, '')
	const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
	const auth =
		url.username === '' && url.password === ''
			? ''
			: `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}\r\n`

	// TLS creation can throw synchronously — `servername` set to an IP is rejected
	// before any I/O — and a prefilter that throws instead of answering is a crash
	// in the middle of a run. Both constructors are covered, not just TLS.
	let opening: Socket
	try {
		opening =
			url.protocol === 'https:'
				? tlsConnect({ host, port, ...(isIP(host) === 0 ? { servername: host } : {}) })
				: netConnect({ host, port })
	} catch (error) {
		finish({ ok: false, error: String(error) })
		return promise
	}
	socket = opening
	socket.setTimeout(timeoutMs, () => finish({ ok: false, error: `预筛超时 ${timeoutMs}ms` }))
	socket.once('error', (error) => finish({ ok: false, error: String(error) }))
	socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
		socket?.write(
			`CONNECT ${CONNECT_TARGET} HTTP/1.1\r\n` +
				`Host: ${CONNECT_TARGET}\r\n` +
				'Proxy-Connection: keep-alive\r\n' +
				auth +
				'\r\n',
		)
	})

	let received = ''
	socket.on('data', (chunk) => {
		received += chunk.toString('latin1')
		const end = received.indexOf('\r\n')
		if (end < 0) {
			// A proxy that does not answer with a status line is not a proxy.
			if (received.length > 1024) finish({ ok: false, error: 'CONNECT 响应不是 HTTP 状态行' })
			return
		}
		const statusLine = received.slice(0, end)
		const status = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine)
		if (status === null) {
			finish({ ok: false, error: `CONNECT 响应无法解析：${statusLine.slice(0, 80)}` })
			return
		}
		const code = Number(status[1])
		finish(
			code >= 200 && code < 300
				? { ok: true }
				: { ok: false, error: `代理拒绝 CONNECT：${statusLine.slice(0, 80)}` },
		)
	})
	return promise
}
