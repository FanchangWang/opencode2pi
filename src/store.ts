/**
 * The extension's data directory, in one place.
 *
 * Four files live here: the probe cache (`health.json`), the filter choice
 * (`filters.json`), the exit pool (`pool.json` + the user's `exits.txt`) and the
 * models.dev discovery cache (`models-dev-*.json`). Each of them used to spell
 * out `join(tmpdir(), 'opencode2pi', …)` for itself, and a second copy of a path
 * is how two files end up in two directories that drift apart.
 *
 * `os.tmpdir()` is deliberate. None of this is authoritative state: verdicts
 * expire, filters are re-selectable, discovery re-runs, and an exit list can be
 * pasted back. Losing the whole directory costs a re-probe, never a wrong
 * answer — which is also why every writer here swallows its own failure instead
 * of making the caller invent a recovery story for a cache miss.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `OPENCODE2PI_DATA_DIR` overrides the location, which is what lets the test
 * suite exercise the writers without touching the user's real pool or probe
 * cache; unset means the platform temp directory.
 */
export function dataDir(): string {
	return process.env.OPENCODE2PI_DATA_DIR ?? join(tmpdir(), 'opencode2pi')
}

export function dataFile(name: string): string {
	return join(dataDir(), name)
}

/** Parsed JSON, or `undefined` when the file is missing, unreadable or malformed. */
export async function readJson(name: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(dataFile(name), 'utf8')) as unknown
	} catch {
		return undefined
	}
}

/** Text, or `undefined` when the file is missing or unreadable. */
export async function readText(name: string): Promise<string | undefined> {
	try {
		return await readFile(dataFile(name), 'utf8')
	} catch {
		return undefined
	}
}

/** Write JSON, or give up quietly: see the module comment. */
export async function writeJson(name: string, value: unknown): Promise<void> {
	await writeText(name, JSON.stringify(value))
}

export async function writeText(name: string, text: string): Promise<void> {
	try {
		await mkdir(dataDir(), { recursive: true })
		await writeFile(dataFile(name), text, 'utf8')
	} catch {
		// A store we cannot write is a cache miss on the next run, never a
		// failure now: every caller's data is either derived or re-selectable.
	}
}
