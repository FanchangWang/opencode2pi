/**
 * Free exit-IP source list — the `http://` subset of `opencode2dsh`'s
 * `packages/plugin/src/pool/sources.ts`, ported verbatim on 2026-10-17 (URLs
 * and their fast→slow order unchanged).
 *
 * Only `protocol: 'http'` entries were carried over. The reference also lists
 * 29 `protocol: 'socks5'` entries, but they are deliberately dropped: the
 * runtime is Bun 1.4.3, whose `fetch(url, { proxy })` rejects every socks
 * variant with `TypeError: UnsupportedProxyProtocol` — measured, not assumed —
 * so a socks source could never yield a single usable exit IP here.
 * "别把跑不通的东西放进池子里" is cheaper than discovering it at refill time.
 *
 * The list is data, not transport: no network code lives here, and nothing in
 * this module runs on import.
 *
 * Note carried over from the reference: dead lists are common in this space —
 * candidates found dead (ShiftyTR, clarketm, mmpx12, proxy-list.download…)
 * were already dropped upstream, and the survivors still rot over time.
 */

export interface FreeSource {
	readonly url: string
	readonly tier: 'fast' | 'slow'
}

export const FREE_SOURCES: readonly FreeSource[] = [
	// fast tier (GoProxy fastUpdateSources)
	{ url: 'https://raw.githubusercontent.com/ProxyScraper/ProxyScraper/main/http.txt', tier: 'fast' },
	{ url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt', tier: 'fast' },
	{ url: 'https://raw.githubusercontent.com/prxchk/proxy-list/main/http.txt', tier: 'fast' },
	{ url: 'https://cdn.jsdelivr.net/gh/sunny9577/proxy-scraper/generated/http_proxies.txt', tier: 'fast' },
	// fast tier additions (2026-09-09, live-verified upstream)
	{ url: 'https://raw.githubusercontent.com/proxio-io/proxy-list/main/http.txt', tier: 'fast' },
	{
		url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt',
		tier: 'fast',
	},
	{ url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt', tier: 'fast' },
	{ url: 'https://proxyspace.pro/http.txt', tier: 'fast' },
	// slow tier (GoProxy slowUpdateSources)
	{ url: 'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt', tier: 'slow' },
	{ url: 'https://cdn.jsdelivr.net/gh/databay-labs/free-proxy-list/http.txt', tier: 'slow' },
	{
		url: 'https://cdn.jsdelivr.net/gh/Anonym0usWork1221/Free-Proxies/proxy_files/http_proxies.txt',
		tier: 'slow',
	},
	{ url: 'https://cdn.jsdelivr.net/gh/ALIILAPRO/Proxy/http.txt', tier: 'slow' },
	{ url: 'https://cdn.jsdelivr.net/gh/vakhov/fresh-proxy-list/http.txt', tier: 'slow' },
	{ url: 'https://cdn.jsdelivr.net/gh/Zaeem20/FREE_PROXIES_LIST/http.txt', tier: 'slow' },
	{ url: 'https://cdn.jsdelivr.net/gh/proxy4parsing/proxy-list/http.txt', tier: 'slow' },
	// slow tier additions (2026-09-09, live-verified upstream)
	{ url: 'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt', tier: 'slow' },
	{ url: 'https://raw.githubusercontent.com/Tianndev/free-proxy/main/proxy/http.txt', tier: 'slow' },
	{ url: 'https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/http.txt', tier: 'slow' },
	{ url: 'https://raw.githubusercontent.com/proxmint/free-proxy-list/main/proxies/http.txt', tier: 'slow' },
	{ url: 'https://raw.githubusercontent.com/Ian-Lusule/Proxies/main/proxies/http.txt', tier: 'slow' },
	{ url: 'http://openproxylist.xyz/http.txt', tier: 'slow' },
	{
		url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all',
		tier: 'slow',
	},
]

/** `host:port` or `scheme://host:port` -> canonical `http://host:port`; null when unusable. */
export function parseProxyLine(line: string): string | null {
	let text = line
	// BOM first: it survives trim() and would otherwise poison the scheme match.
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
	text = text.trim()
	// Lists quote lines inconsistently; unwrap repeatedly so `"'h:p'"` also lands.
	while (text.length >= 2) {
		const quote = text[0]
		if ((quote !== '"' && quote !== "'") || text[text.length - 1] !== quote) break
		text = text.slice(1, -1).trim()
	}
	if (text === '') return null
	if (text.startsWith('#') || text.startsWith(';') || text.startsWith('//')) return null

	let scheme = 'http'
	const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text)
	if (schemeMatch?.[1]) {
		const found = schemeMatch[1].toLowerCase()
		// Every socks flavour is unusable under Bun's fetch proxy — reject on the
		// scheme alone, before any host/port parsing can rescue it.
		if (found.startsWith('socks')) return null
		if (found !== 'http' && found !== 'https') return null
		scheme = found
		text = text.slice(schemeMatch[0].length)
	}

	let credentials = ''
	const at = text.lastIndexOf('@')
	if (at >= 0) {
		credentials = text.slice(0, at)
		text = text.slice(at + 1)
		if (credentials === '' || /[\s/]/.test(credentials)) return null
	}

	// A single trailing slash is cosmetic (`host:port/`); anything else is a path.
	if (text.endsWith('/')) text = text.slice(0, -1)
	if (text === '' || /[\s/]/.test(text)) return null

	const bracketed = /^(\[[^\]]+\]):(\d{1,5})$/.exec(text)
	const plain = bracketed ? null : /^([^:]+):(\d{1,5})$/.exec(text)
	const host = bracketed?.[1] ?? plain?.[1]
	const portText = bracketed?.[2] ?? plain?.[2]
	if (!host || !portText || /\s/.test(host)) return null

	const port = Number(portText)
	if (!Number.isInteger(port) || port < 1 || port > 65535) return null
	return `${scheme}://${credentials === '' ? '' : `${credentials}@`}${host}:${port}`
}

/** First-seen order, exact-string dedupe (mirrors the reference `dedupeAddresses`). */
export function dedupeAddresses(addresses: readonly string[]): string[] {
	const seen = new Set<string>()
	const out: string[] = []
	for (const address of addresses) {
		if (seen.has(address)) continue
		seen.add(address)
		out.push(address)
	}
	return out
}
