/**
 * Free exit-IP source list — the `http://` subset of `opencode2dsh`'s
 * `packages/plugin/src/pool/sources.ts`, ported on 2026-10-17.
 *
 * Twenty-two `raw.githubusercontent.com`-and-friends URLs, in **one flat list with
 * no tiers**. They used to carry a `'fast' | 'slow'` label, ported along with the
 * order from the reference's `fastUpdateSources` / `slowUpdateSources`. That label
 * was never measured here — it was a hand-ordered guess from another codebase —
 * and all it actually did was split each round's screen budget in two and keep
 * fourteen sources permanently second. The tier was removed on 2026-10-17: every
 * source is fetched together and the addresses are shuffled as one pool, so a
 * round samples all twenty-two rather than exhausting eight before touching the
 * rest. `discoverExit` in pool-probe.ts is the only consumer.
 *
 * Of these twenty-two, twenty are `raw.githubusercontent.com`. They were jsdelivr
 * (`cdn.jsdelivr.net/gh/…`) until 2026-10-17, when measuring which hosts this
 * machine can actually reach showed 20 of the 22 sources failing on direct
 * access and only two responding — so the CDN was not an asset here, and a
 * source list that mostly returns `fetch failed` is worse than a short one.
 *
 * **The branch in each URL is verified, not assumed.** Six of these repositories
 * do not use `main`:
 *
 *   · databay-labs/free-proxy-list → `master`
 *   · sunny9577/proxy-scraper→ `master`
 *   · TheSpeedX/PROXY-List          → `master`
 *   · TheSpeedX/SOCKS-List          → `master`
 *   · vakhov/fresh-proxy-list       → `master`
 *   · Zaeem20/FREE_PROXIES_LIST     → `master`
 *
 * Confirmed against the GitHub API's `default_branch` on 2026-10-17, and the
 * one path that had been written as `main` for a `master` repo
 * (`sunny9577/proxy-scraper/generated/http_proxies.txt`) was measured to fail on
 * that branch. A wrong branch is a 404 that looks exactly like a dead proxy list,
 * which is why this is written down rather than left to whoever edits it next.
 *
 * `http://` entries only. The reference also lists 29 `socks5` entries,
 * deliberately dropped: the runtimes this runs on reject every socks variant
 * (`UnsupportedProxyProtocol` on Bun, and an HTTP-only exit list is what an HTTP
 * pool can use), measured rather than assumed. "别把跑不通的东西放进池子里" is
 * cheaper than discovering it at refill time.
 *
 * The list is data, not transport: no network code lives here, and nothing in
 * this module runs on import. {@link GITHUB_MIRRORS} is the one exception and it
 * is still only data — pool-probe.ts reads it.
 *
 * Note carried over from the reference: dead lists are common in this space —
 * candidates found dead (ShiftyTR, clarketm, mmpx12, proxy-list.download…)
 * were already dropped upstream, and the survivors still rot over time.
 */

/**
 * Prefixed onto a source URL when `raw.githubusercontent.com` cannot be reached,
 * tried in this order.
 *
 * Prefixed directly onto the raw URL, so a GitHub-hosted source becomes
 * `https://ghproxy.net/https://raw.githubusercontent.com/…`. All three were
 * verified to serve real content on 2026-10-17 (2710 lines, HTTP 200): ghproxy
 * in 1105 ms, github.allproxy.dpdns.org in 1004 ms, wget.la in 4481 ms.
 *
 * Order is fastest-measured first, with wget.la last rather than first because it
 * was three times slower than the other two and a fourth position costs nothing.
 */
export const GITHUB_MIRRORS: readonly string[] = [
	'https://ghproxy.net',
	'https://github.allproxy.dpdns.org',
	'https://wget.la',
]

/**
 * Every free list worth pulling, all treated alike.
 *
 * Order carries no meaning: the addresses these produce are shuffled together
 * before screening, so nothing here is reached "first" except by chance.
 */
export const FREE_SOURCES: readonly string[] = [
	'https://raw.githubusercontent.com/ProxyScraper/ProxyScraper/main/http.txt',
	'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
	'https://raw.githubusercontent.com/prxchk/proxy-list/main/http.txt',
	// `master`, not `main` — measured: the main branch of this repo 404s here.
	'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/generated/http_proxies.txt',
	'https://raw.githubusercontent.com/proxio-io/proxy-list/main/http.txt',
	'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt',
	'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
	'https://proxyspace.pro/http.txt',
	'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
	'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/http.txt',
	'https://raw.githubusercontent.com/Anonym0usWork1221/Free-Proxies/main/proxy_files/http_proxies.txt',
	'https://raw.githubusercontent.com/ALIILAPRO/Proxy/main/http.txt',
	'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt',
	'https://raw.githubusercontent.com/Zaeem20/FREE_PROXIES_LIST/master/http.txt',
	'https://raw.githubusercontent.com/proxy4parsing/proxy-list/main/http.txt',
	// live-verified upstream 2026-09-09
	'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt',
	'https://raw.githubusercontent.com/Tianndev/free-proxy/main/proxy/http.txt',
	'https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/http.txt',
	'https://raw.githubusercontent.com/proxymint/free-proxy-list/main/proxies/http.txt',
	'https://raw.githubusercontent.com/Ian-Lusule/Proxies/main/proxies/http.txt',
	'http://openproxylist.xyz/http.txt',
	// Replaces api.proxyscrape.com, which was unreachable here while this GitHub
	// path answered 1201 proxy lines on the same measurement. Same `http://ip:port`
	// per line, so `parseProxyLine` reads it unchanged.
	'https://raw.githubusercontent.com/ProxyScrape/free-proxy-list/main/proxies/protocols/http/data.txt',
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
