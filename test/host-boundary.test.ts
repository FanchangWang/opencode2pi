/**
 * The layering rule, asserted rather than asserted-to.
 *
 * This extension supports two agent runtimes whose APIs genuinely disagree, and
 * the whole design rests on one invariant: **only `src/host/` may name a host
 * package.** If a shared module imports `@oh-my-pi/pi-ai` or
 * `@earendil-works/pi-ai`, then one of the two hosts is being typed against the
 * other's declarations, and the failure mode is not a compile error — it is a
 * call that type-checks on the host you tested and silently does the wrong thing
 * on the other. That is precisely how pi 1.3.0 came to crash with
 * `(0, _piAi.registerCustomApi) is not a function` while omp was fine.
 *
 * A comment cannot hold that rule, so it is checked here: read every source file,
 * and assert the boundary holds.
 */

import { describe, expect, test } from 'bun:test'

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const SRC = join(import.meta.dir, '..', 'src')

/** Package specifiers that mean "one specific host". */
const HOST_PACKAGES = ['@oh-my-pi/', '@earendil-works/', '@mariozechner/']

async function sourceFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true })
	const files: string[] = []
	for (const entry of entries) {
		const full = join(dir, entry.name)
		if (entry.isDirectory()) files.push(...(await sourceFiles(full)))
		else if (entry.name.endsWith('.ts')) files.push(full)
	}
	return files
}

/**
 * Match the specifier only where it is *imported*, so prose in a file header
 * explaining the rule does not count as a violation of it.
 */
function importedSpecifiers(source: string): string[] {
	const specifiers: string[] = []
	for (const match of source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) {
		if (match[1] !== undefined) specifiers.push(match[1])
	}
	return specifiers
}

describe('host boundary (the rule the two-host support rests on)', () => {
	test('only src/host/ names a host package', async () => {
		const violations: string[] = []
		for (const file of await sourceFiles(SRC)) {
			const relative = file.slice(SRC.length + 1).replaceAll('\\', '/')
			// The adapters are where a host package name is *supposed* to appear, and
			// so is the type bridge that keeps TypeScript resolving them.
			if (relative.startsWith('host/') || relative === 'host.d.ts') continue
			const source = await readFile(file, 'utf8')
			for (const specifier of importedSpecifiers(source)) {
				if (HOST_PACKAGES.some((pkg) => specifier.startsWith(pkg))) {
					violations.push(`${relative} imports ${specifier}`)
				}
			}
		}
		expect(violations).toEqual([])
	})

	test('both adapters exist and each imports its own host surface', async () => {
		// Guards the rule above from being satisfied vacuously: if someone deleted an
		// adapter, "no shared file names a host" would still pass.
		const omp = await readFile(join(SRC, 'host', 'omp.ts'), 'utf8')
		const pi = await readFile(join(SRC, 'host', 'pi.ts'), 'utf8')
		expect(importedSpecifiers(omp).some((s) => s.startsWith('@oh-my-pi/'))).toBe(true)
		expect(importedSpecifiers(pi).some((s) => s.startsWith('@earendil-works/'))).toBe(true)
	})

	test('the request path is shared, so a fix cannot land on one host only', async () => {
		// The handler both hosts register is built from a StreamEngine, not written
		// twice. If this ever inlines per-host logic, the invariant above stops being
		// enough on its own.
		const request = await readFile(join(SRC, 'request.ts'), 'utf8')
		expect(request).toContain('createStreamHandler')
		// And it must not reach for a host package to do it.
		expect(importedSpecifiers(request).some((s) => HOST_PACKAGES.some((pkg) => s.startsWith(pkg)))).toBe(false)
	})
})
