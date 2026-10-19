/**
 * The tunnel prefilter is the only stage that speaks the proxy protocol itself,
 * so its two edges — "a 200 means the tunnel opened" and "anything else is a
 * refusal, not a throw" — are pinned here against a local socket instead of a
 * public free proxy. No network access and no TLS on the test side.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server, type Socket } from 'node:net'

import { prefilterExit } from '../src/prefilter.ts'

const servers: Server[] = []

afterEach(async () => {
	const closing = servers.splice(0).map((server) => {
		const { promise, resolve } = Promise.withResolvers<void>()
		server.close(() => resolve())
		return promise
	})
	await Promise.all(closing)
})

interface Captured {
	readonly url: string
	readonly received: string[]
}

/** A proxy that answers every connection with `reply`, after recording the request. */
async function fakeProxy(reply: string): Promise<Captured> {
	const received: string[] = []
	const server = createServer((socket: Socket) => {
		socket.on('data', (chunk) => {
			const text = chunk.toString('latin1')
			received.push(text)
			if (text.includes('\r\n\r\n')) socket.write(reply)
		})
		socket.on('error', () => {})
	})
	servers.push(server)
	const { promise, resolve } = Promise.withResolvers<void>()
	server.listen(0, '127.0.0.1', resolve)
	await promise
	const address = server.address()
	if (address === null || typeof address === 'string') throw new Error('no listening address')
	return { url: `http://127.0.0.1:${address.port}`, received }
}

describe('prefilterExit', () => {
	test('a 200 response to CONNECT is the pass', async () => {
		const proxy = await fakeProxy('HTTP/1.1 200 Connection Established\r\n\r\n')
		const result = await prefilterExit(proxy.url)
		expect(result.ok).toBe(true)
		expect(result.error).toBeUndefined()
		// It asks for the same host the full screen will talk to.
		expect(proxy.received.join('')).toContain('CONNECT cloudflare.com:443 HTTP/1.1')
	})

	test('a 407 is a refusal with the status line, not an exception', async () => {
		const proxy = await fakeProxy('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
		const result = await prefilterExit(proxy.url)
		expect(result.ok).toBe(false)
		expect(result.error).toContain('407')
	})

	test('a silent listener costs the timeout and no more', async () => {
		const proxy = await fakeProxy('')
		const startedAt = Date.now()
		const result = await prefilterExit(proxy.url, 100)
		expect(result.ok).toBe(false)
		expect(result.error).toContain('预筛超时')
		expect(Date.now() - startedAt).toBeLessThan(2000)
	})

	test('an https proxy addressed by IP is answered, not thrown', async () => {
		// Node rejects `servername` set to an IP synchronously, before the socket
		// even tries to connect. The free lists contain https proxies by IP, so a
		// throw here aborted an entire discovery run.
		const result = await prefilterExit('https://127.0.0.1:9', 200)
		expect(result.ok).toBe(false)
	})

	test('URL credentials become a Basic Proxy-Authorization header', async () => {
		const proxy = await fakeProxy('HTTP/1.1 200 OK\r\n\r\n')
		const url = proxy.url.replace('http://', 'http://user:p%40ss@')
		const result = await prefilterExit(url)
		expect(result.ok).toBe(true)
		// Percent-decoded, as undici and Bun's fetch do it.
		expect(proxy.received.join('')).toContain(`Proxy-Authorization: Basic ${Buffer.from('user:p@ss').toString('base64')}`)
	})
})
