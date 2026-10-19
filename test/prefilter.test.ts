/**
 * The tunnel prefilter is the only stage that speaks the proxy protocol itself,
 * so its two edges — "a 200 means the tunnel opened" and "anything else is a
 * refusal, not a throw" — are pinned here against local sockets instead of
 * public free proxies. No network access. The TLS half uses a self-signed
 * certificate generated for this test, which is exactly the shape the published
 * `https://host:port` exits present.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server, type Socket } from 'node:net'
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls'

import { prefilterExit } from '../src/prefilter.ts'

/**
 * Self-signed, CN=127.0.0.1, valid until 2126. Regenerating it is only needed
 * if the key is ever compromised; it authenticates nothing.
 */
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQCf8o8VuH/uHOrs
TTRrbOn6SADYvVGKqmrGPG0fVEDZtIWoxBlM0uajSfMxDR5kly/i+jhCtKqUQrRS
mBmzGU0hphyZ5J/WdRiEYCFqvstHkYmU+YeGViTu2E3M3W3Sl3RIJsl50IPuglXY
Ski7HGQB8XChrPE2ySZCZeF69cIVNu2pSTOWGGWcbHLaP0CPPMtTR+hgJJbDvuBw
1S4pOMFopf+uoM2ytciuIuTTYcBG13eSxrY8FyeDgrmyWmtxJdNGox1ai+lldhuK
0pYr4UFdMRo+wTexQGiynD+GGnTbJmCLxKPsp6ukutKilBBrUmm52JIpavEy/8mr
uKc83G5lAgMBAAECggEAIdkl+JXD1PMfsAQinL0+wq1sKHHgCLVJxUvSV/fvhWLT
ikR9iilzj4i9w1qgXO81vhXvxAYRtzBqkrQHdERdc0qA8PxV6v96wcDKMZnQ0QN2
lyU7Te17AWSbCkitzgwpGn/C0VmUIexJGG2X+KjobRTYHg7IOSzWQOTok6ngebaB
VdAl1roTFCpdRuZvbfvwhjYpOBYxSdue6XiTy87mBvAipX8BLwAmDIIqIv1j03ME
EMOQbokZYRpAnGiKb4lGcydi9XxWfYRFLOwVvBr+sUTTqC2SrHcMaCmoTkU4Rw1K
whtgb2aLBN8GtAKjpsPnQlMxYRIuN5Bj75QuHwg9QQKBgQDUCNErjFilxXSsDJDI
E3PvKVtNV69TH14u3dhSCt8JtUDhrpAIJAkAUjB5rV0vnP5zk0xJd5QQ61vI+9MP
ESiIQvreTCh7INlW0aaHX8ZJ1nyW3T4qo/f1nXlzmrtIvf2fBxG0H/WLPOdu2/4E
Brrlx8H021WaXWGuu7IG7VSR1QKBgQDBHN6qrXoXQSHyKEydzHpiQvD0LsUp8nCq
GMisRGYf64rkDC5Bd/u/NcoX6qVSrtpVypVL9xQP9suYRDZ/ULrJnN1/LuNikWwe
IeaDRDgnRfY6AjA2V7siV2tBdswMam8kNU6IAw5pN2iPaSljzfqxLt0Vwob7gb/u
KHN/5MwiUQKBgQDPls5K534G1lnS8/5vk/QGa6QTBc0GAYjxM4tNT41r8MPT8Fbd
UYJqiQ0io6O/MOJB/y1KJEOXiQX0sO/DKZZYSdNY/pEHc3K1uE5k7VSyB8c04Oiz
UJM8Ke+1SgEgR7peDsq7YirBJmCjPcjk4j3rJ3ZyJqcZmWFAdEzo0UTh/QKBgQDA
uIsPUmlR49J41PcBVBufDKdjSXnCzwzY9DrwkKJKoMrPo8hV1eQLgybYj3fF+HI0
xCQS19XRyL6OiyTIEk0W/9GdJ7INoIuB1tsxjVds+kkswxpSYWOEdjG391LT4TRh
skFZQ5OSNZXH6W9BB0N0qAxDtwr23RoqF3yM2k1OwQKBgQCclnVHcXwqLAOUr4tE
9SbmwswIjGtGKRQDhgCh37SocwSICgrxhlE9Y+TyZh7jz2AT5dYAoy6sVgL1Dbas
JzlpnVI443rTuvq7H4rRfqDE7DMyRW5GGYjvYIPPVSeLtJubwK5xZHiXrl3/CZde
/E/UOdbyYRJEH3pVR9l7j6/8hA==
-----END PRIVATE KEY-----`

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDHDCCAgSgAwIBAgIUM9J6IWvlv8u2FqBd94uvGuYIwdIwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MTAxOTEyMDg0OFoYDzIxMjYw
OTI1MTIwODQ4WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCf8o8VuH/uHOrsTTRrbOn6SADYvVGKqmrGPG0fVEDZ
tIWoxBlM0uajSfMxDR5kly/i+jhCtKqUQrRSmBmzGU0hphyZ5J/WdRiEYCFqvstH
kYmU+YeGViTu2E3M3W3Sl3RIJsl50IPuglXYSki7HGQB8XChrPE2ySZCZeF69cIV
Nu2pSTOWGGWcbHLaP0CPPMtTR+hgJJbDvuBw1S4pOMFopf+uoM2ytciuIuTTYcBG
13eSxrY8FyeDgrmyWmtxJdNGox1ai+lldhuK0pYr4UFdMRo+wTexQGiynD+GGnTb
JmCLxKPsp6ukutKilBBrUmm52JIpavEy/8mruKc83G5lAgMBAAGjZDBiMB0GA1Ud
DgQWBBQW3K23VMdOuSyewrFv1qAFdPN3lDAfBgNVHSMEGDAWgBQW3K23VMdOuSye
wrFv1qAFdPN3lDAPBgNVHRMBAf8EBTADAQH/MA8GA1UdEQQIMAaHBH8AAAEwDQYJ
KoZIhvcNAQELBQADggEBAAL1FWesZiOhrEdby6hY0VNsLStfGcmC6CqtnFIVBI1W
jBePv/QZubuHgA3GwM51v+fnMl1txrOD/TxrMsjjPuUkJvvQTH/LIQASrx7ujGhA
ZeCeN/A0c4HwXhH/e9uwszXMfsMLv7q99BBhlUPGX7mHZx+QdS/ltvoPCYkrJbUo
FtXgSBZ45t2Uy+Us0t3ximvUknXUpXF3Rc5I19RCk083eMPoDcWX9fd544opA4J0
rjPzUuiGMq4q4B0/KDBifiBYcmF+o1TTJyc0ywiLzRdH5HNInk2dYA+eFFFnfIBb
xIi1jQY6vvdpM/Vy2grxonZoHFPKY6ZQt3UQ134pDPc=
-----END CERTIFICATE-----`

const servers: (Server | TlsServer)[] = []

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

/** The same proxy, behind TLS with a certificate no client can verify. */
async function fakeTlsProxy(reply: string): Promise<Captured> {
	const received: string[] = []
	const server = createTlsServer({ key: TEST_KEY, cert: TEST_CERT }, (socket) => {
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
	return { url: `https://127.0.0.1:${address.port}`, received }
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

	test('an https proxy with a self-signed certificate is a pass', async () => {
		// Published free-list https exits routinely present certificates no trust
		// store can verify. Verifying the proxy hop judged a working tunnel dead;
		// the request path disables the same check for the same address.
		const proxy = await fakeTlsProxy('HTTP/1.1 200 Connection Established\r\n\r\n')
		const result = await prefilterExit(proxy.url)
		expect(result.ok).toBe(true)
		expect(proxy.received.join('')).toContain('CONNECT cloudflare.com:443 HTTP/1.1')
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
