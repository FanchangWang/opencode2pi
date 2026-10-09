/**
 * Invariants for the parts where a wrong answer is silent.
 *
 * These cover the three orderings that are easy to get backwards and produce no
 * visible failure when they are: the free-lane judgment (docs/PLAN.md §T2), the
 * capability mapping's fallbacks (§T1), and upstream error precedence (§T4).
 * The classification order matters most — opencode2dsh shipped a version that
 * reported a geo block as an API-key problem until 0.3.5.
 */

import { describe, expect, test } from 'bun:test'

import { healthFor, mergeHealth, pruneHealth, summarizeHealth, type HealthRecord, type HealthStore, type ProbeResult } from '../src/health.ts'
import { classifyUpstreamFailure } from '../src/errors.ts'
import {
	DEFAULT_FILTERS,
	hidden,
	hiddenFromStore,
	onHiddenChange,
	publishFilters,
	publishHealth,
	type ProbeFilters,
} from '../src/filters.ts'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, isFreeModel, normalizeEntry, type ModelsDevEntry } from '../src/metadata.ts'
import { canonicalSessionID, PROCESS_SESSION, sessionForRequest } from '../src/session.ts'
import { SEED_MODELS, UNAVAILABLE, VERIFIED_FREE } from '../src/seed.ts'

const CANONICAL = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

describe('capability mapping (T1)', () => {
	test('adopts flat fields verbatim', () => {
		const { config } = normalizeEntry({
			id: 'probe-alpha',
			limit: { context: 999_999, output: 12_345 },
			cost: { input: 0, output: 0 },
			modalities: { input: ['text', 'image'] },
			reasoning: true,
		})
		expect(config.contextWindow).toBe(999_999)
		expect(config.maxTokens).toBe(12_345)
		expect(config.input).toEqual(['text', 'image'])
		expect(config.reasoning).toBe(true)
	})

	test('clamps maxTokens to contextWindow', () => {
		const { config } = normalizeEntry({ id: 'c', limit: { context: 1_000, output: 5_000 } })
		expect(config.maxTokens).toBe(1_000)
	})

	test('explicitly defaults a missing limit instead of leaving it to the host', () => {
		const { config, notes } = normalizeEntry({ id: 'sparse' })
		expect(config.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW)
		expect(config.maxTokens).toBe(DEFAULT_MAX_TOKENS)
		// The silent 128000/16384 host fallback is the documented failure mode,
		// so a defaulted value must always carry its reason.
		expect(notes.join(' ')).toContain('limit.context')
	})

	test('rejects non-integer and negative limits', () => {
		const { config } = normalizeEntry({ id: 'bad', limit: { context: -5, output: 12.5 } })
		expect(config.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW)
		expect(config.maxTokens).toBe(DEFAULT_MAX_TOKENS)
	})

	test('drops input modalities the host cannot model, and says so', () => {
		const { config, notes } = normalizeEntry({ id: 'm', modalities: { input: ['text', 'image', 'audio'] } })
		expect(config.input).toEqual(['text', 'image'])
		expect(notes.join(' ')).toContain('audio')
	})

	test('keeps only known effort levels', () => {
		const { config } = normalizeEntry({
			id: 'e',
			reasoning: true,
			reasoning_options: [{ type: 'effort', values: ['low', 'high', 'bogus'] }],
		})
		// `Effort` is a host const enum, so the levels are compared as plain
		// strings rather than importing an enum the host may not emit.
		expect(config.thinking?.efforts?.join(',')).toBe('low,high')
	})

	test('leaves thinking undefined when there is no effort axis', () => {
		// A toggle model has no effort surface. Emitting an empty list would
		// violate the host contract, and the host derives defaults from
		// `reasoning: true` instead.
		const { config } = normalizeEntry({ id: 't', reasoning: true, reasoning_options: [{ type: 'toggle' }] })
		expect(config.reasoning).toBe(true)
		expect(config.thinking).toBeUndefined()
	})
})

describe('free-lane judgment order (T2)', () => {
	const free: ModelsDevEntry = { id: 'x', cost: { input: 0, output: 0 } }
	const paid: ModelsDevEntry = { id: 'y', cost: { input: 3, output: 15 } }

	test('metadata decides, not the model name', () => {
		expect(isFreeModel('deepseek-v4-flash-free', paid, VERIFIED_FREE)).toBe(false)
		expect(isFreeModel('mystery', free, VERIFIED_FREE)).toBe(true)
	})

	test('deprecated vetoes even a -free name', () => {
		const retired: ModelsDevEntry = { id: 'ghost-free', deprecated: 'retired', cost: { input: 0, output: 0 } }
		expect(isFreeModel('ghost-free', retired, VERIFIED_FREE)).toBe(false)
	})

	test('every denylisted id never ships despite being free', () => {
		expect(Object.keys(UNAVAILABLE).length).toBeGreaterThan(0)
		for (const id of Object.keys(UNAVAILABLE)) {
			expect(isFreeModel(id, free, VERIFIED_FREE)).toBe(false)
		}
	})

	test('a retired id that models.dev still prices at zero stays denylisted', () => {
		// mimo-v2.5-free was pulled from Zen while models.dev kept publishing it
		// at cost 0, so free-by-pricealone would re-advertise a dead model.
		expect(isFreeModel('mimo-v2.5-free', free, VERIFIED_FREE)).toBe(false)
		expect(SEED_MODELS.map((model) => model.id)).not.toContain('mimo-v2.5-free')
	})

	test('a verified id passes although its name carries no signal', () => {
		expect(isFreeModel('big-pickle', free, VERIFIED_FREE)).toBe(true)
	})

	test('falls back to the name only when metadata is absent or incomplete', () => {
		expect(isFreeModel('jev-1.13-free', undefined, VERIFIED_FREE)).toBe(true)
		expect(isFreeModel('mystery', undefined, VERIFIED_FREE)).toBe(false)
		expect(isFreeModel('mystery-free', { id: 'mystery-free', cost: {} }, VERIFIED_FREE)).toBe(true)
	})
})

describe('seed integrity', () => {
	test('no seed entry sits on the silent host fallback', () => {
		const suspicious = SEED_MODELS.filter(
			(model) => model.contextWindow === DEFAULT_CONTEXT_WINDOW && model.maxTokens === DEFAULT_MAX_TOKENS,
		)
		expect(suspicious).toEqual([])
	})

	test('no seed entry claims more output than context', () => {
		expect(SEED_MODELS.filter((model) => model.maxTokens > model.contextWindow)).toEqual([])
	})

	test('every verified-free id is actually in the seed', () => {
		const seedIds = SEED_MODELS.map((model) => model.id)
		expect(Object.keys(VERIFIED_FREE).sort()).toEqual([...seedIds].sort())
	})
})

describe('session identity (T3)', () => {
	const hostSession = { sessionId: '01a10bfe-9111-744a-8200-d1d09389c7f7' } as never
	const otherSession = { sessionId: 'ffffffff-2222-3333-4444-555555555555' } as never

	test('derives a canonical id from the host session id', () => {
		const result = sessionForRequest(hostSession)
		expect(result.derived).toBe(true)
		expect(result.id).toMatch(CANONICAL)
	})

	test('two conversations in one process differ', () => {
		expect(sessionForRequest(hostSession).id).not.toBe(sessionForRequest(otherSession).id)
	})

	test('is stable across turns of one conversation', () => {
		expect(sessionForRequest(hostSession).id).toBe(sessionForRequest(hostSession).id)
	})

	test('agrees with the session id mirrored into metadata', () => {
		const viaMetadata = sessionForRequest({
			metadata: { user_id: '{"session_id":"01a10bfe-9111-744a-8200-d1d09389c7f7"}' },
		} as never)
		expect(viaMetadata.id).toBe(sessionForRequest(hostSession).id)
	})

	test('falls back to a process-level id when the host gives no identity', () => {
		const result = sessionForRequest(undefined)
		expect(result.derived).toBe(false)
		expect(result.id).toBe(PROCESS_SESSION)
	})

	test('canonicalSessionID is idempotent', () => {
		const once = canonicalSessionID('anything')
		expect(canonicalSessionID(once)).toBe(once)
	})
})

describe('error classification precedence (T4)', () => {
	test('region block outranks every auth-shaped verdict', () => {
		expect(classifyUpstreamFailure(403, 'RegionError: not available in your country').kind).toBe('REGION_BLOCKED')
		expect(classifyUpstreamFailure(403, 'This model is not available in your country').kind).toBe('REGION_BLOCKED')
	})

	test('shape gate is distinguished from auth', () => {
		expect(classifyUpstreamFailure(403, '{"error":{"message":"FreeTierError"}}').kind).toBe('SHAPE_REJECTED')
		expect(classifyUpstreamFailure(403, 'forbidden').kind).toBe('SHAPE_REJECTED')
		expect(classifyUpstreamFailure(401, 'unauthorized').kind).toBe('AUTH')
	})

	test('a 400 is a rejected request, never an outage to retry', () => {
		// Measured: a text-only model handed a PNG answers 400 with this exact
		// phrase, which a genuine outage also uses. Status has to decide.
		const message = '400 Error from provider (Console): Upstream request failed: Endpoint is unavailable.'
		expect(classifyUpstreamFailure(400, message).kind).toBe('REQUEST_REJECTED')
		expect(classifyUpstreamFailure(503, 'Endpoint is unavailable.').kind).toBe('UPSTREAM')
	})

	test('retired models are separated from other 401s', () => {
		expect(classifyUpstreamFailure(401, 'ModelError: not supported').kind).toBe('MODEL_GONE')
		expect(classifyUpstreamFailure(401, 'unauthorized').kind).toBe('AUTH')
	})

	test('rate limiting is its own verdict', () => {
		expect(classifyUpstreamFailure(429, 'slow down').kind).toBe('RATE_LIMIT')
	})

	test('unclassified errors keep the upstream text', () => {
		expect(classifyUpstreamFailure(undefined, 'something novel').summary).toContain('something novel')
	})

	test('every verdict carries real advice text', () => {
		// A missing entry in the advice table renders as the literal string
		// "undefined" in the user's terminal, which is worse than no message.
		const verdicts = [
			classifyUpstreamFailure(403, 'FreeTierError'),
			classifyUpstreamFailure(403, 'RegionError: not available in your country'),
			classifyUpstreamFailure(401, 'ModelError: not supported'),
			classifyUpstreamFailure(429, 'slow down'),
			classifyUpstreamFailure(400, 'bad input'),
			classifyUpstreamFailure(503, 'boom'),
			classifyUpstreamFailure(401, 'unauthorized'),
			classifyUpstreamFailure(undefined, 'novel'),
		]
		for (const verdict of verdicts) {
			expect(verdict.summary.length).toBeGreaterThan(10)
			expect(verdict.summary).not.toContain('undefined')
		}
	})
})

describe('health verdicts (T5)', () => {
	const probe = (modelId: string, kind: ProbeResult['kind'], health: ProbeResult['health']): ProbeResult => ({
		modelId,
		kind,
		health,
		detail: '',
		checkedAt: 1_000,
		terminalFailures: 0,
		transientFailures: 0,
		latencyMs: 1,
	})

	test('one ModelError is not enough to condemn a model', () => {
		// Measured: nemotron-3.ultra-free answered 401 ModelError and then 200
		// a minute apart. Promoting on the first terminal verdict would mark a
		// working model dead.
		const first = mergeHealth({}, [probe('m', 'MODEL_GONE', 'flaky')])
		expect(first['m']?.health).toBe('flaky')
		expect(first['m']?.terminalFailures).toBe(1)

		const second = mergeHealth(first, [probe('m', 'MODEL_GONE', 'flaky')])
		expect(second['m']?.health).toBe('dead')
	})

	test('a success clears both counters and revives a dead model', () => {
		const dead = mergeHealth({}, [probe('m', 'MODEL_GONE', 'flaky'), probe('m', 'MODEL_GONE', 'flaky')])
		expect(dead['m']?.health).toBe('dead')

		const revived = mergeHealth(dead, [probe('m', 'OK', 'ok')])
		expect(revived['m']?.health).toBe('ok')
		expect(revived['m']?.terminalFailures).toBe(0)
		expect(revived['m']?.transientFailures).toBe(0)
	})

	test('a dead model keeps its verdict across a transient re-probe', () => {
		const dead = mergeHealth({}, [probe('m', 'MODEL_GONE', 'flaky'), probe('m', 'MODEL_GONE', 'flaky')])
		const wobble = mergeHealth(dead, [probe('m', 'UPSTREAM', 'flaky')])
		expect(wobble['m']?.health).toBe('dead')
	})

	test('a geo block condemns on the first hit', () => {
		// A region block is deterministic for a given egress, unlike ModelError.
		const once = mergeHealth({}, [probe('m', 'REGION_BLOCKED', 'dead')])
		expect(once['m']?.health).toBe('dead')
	})

	test('transient outages never become dead', () => {
		let state: HealthStore = {}
		for (let i = 0; i < 5; i++) state = mergeHealth(state, [probe('m', 'UPSTREAM', 'flaky')])
		expect(state['m']?.health).toBe('flaky')
		expect(state['m']?.transientFailures).toBe(5)
	})

	test('lane-wide failures are never blamed on a model', () => {
		// A broken shape gate or auth change fails every id at once; painting ❌
		// across the roster there would be noise, not diagnosis.
		expect(mergeHealth({}, [probe('m', 'SHAPE_REJECTED', 'unknown')])['m']?.health).toBe('unknown')
		expect(mergeHealth({}, [probe('m', 'AUTH', 'unknown')])['m']?.health).toBe('unknown')
	})

	test('intermittent models keep a non-fatal mark', () => {
		// ling-3.0-flash-fin-free answers 400 on this lane; it must never be ❌,
		// and a 400 is evidence about the round rather than a state of its own.
		expect(healthFor('REQUEST_REJECTED')).toBe('flaky')
		expect(mergeHealth({}, [probe('ling-3.0-flash-fin-free', 'REQUEST_REJECTED', 'flaky')])['ling-3.0-flash-fin-free']?.health).toBe('flaky')
	})

	test('an unrecognised failure is a transient, not a verdict of its own', () => {
		// The classifier simply did not recognise the text; that carries no more
		// evidence against a model than a 5xx does.
		expect(healthFor('UNKNOWN')).toBe('flaky')
	})

	test('the summary counts the displayed verdict, not the raw probe result', () => {
		// `m` is promoted to ❌ by its second consecutive ModelError. The raw
		// result is still flaky, so counting results renders ⚠️ above a ❌ line.
		const store = mergeHealth(
			mergeHealth({}, [probe('m', 'MODEL_GONE', 'flaky')]),
			[probe('m', 'MODEL_GONE', 'flaky'), probe('fine', 'OK', 'ok')],
		)
		expect(summarizeHealth([{ id: 'm' }, { id: 'fine' }], store)).toBe('✅ 1  ❌ 1')
	})

	test('a model the store says nothing about is not counted as a verdict', () => {
		// `status` prints 未探测 for it and probes it on the spot, so it is a
		// statement about our coverage rather than a state of the model.
		const store = mergeHealth({}, [probe('a', 'OK', 'ok')])
		expect(summarizeHealth([{ id: 'a' }, { id: 'unprobed' }], store)).toBe('✅ 1')
	})

	test('the store keeps only the models the current roster contains', () => {
		// Upstream adds and withdraws models, so a merge-only store would keep
		// every id the lane ever served, real or not.
		const store = mergeHealth({}, [
			probe('kept', 'OK', 'ok'),
			probe('retired-upstream-model', 'MODEL_GONE', 'flaky'),
			probe('never-existed', 'MODEL_GONE', 'flaky'),
		])

		const pruned = pruneHealth(store, new Set(['kept']))
		expect(Object.keys(pruned)).toEqual(['kept'])
		expect(pruned['kept']?.health).toBe('ok')
	})

	test('pruning keeps the surviving counters intact', () => {
		// `m` must reach ❌ across two runs; pruning must not reset the history
	// it is judged by.
		const once = mergeHealth({}, [probe('m', 'MODEL_GONE', 'flaky'), probe('gone', 'OK', 'ok')])
		const twice = pruneHealth(mergeHealth(once, [probe('m', 'MODEL_GONE', 'flaky')]), new Set(['m']))
		expect(twice['m']?.health).toBe('dead')
		expect(twice['m']?.terminalFailures).toBe(2)
	})

	test('a rate limit is not a verdict on the model', () => {
		// Measured 2026-10-06: 429 is metered per model, not per IP, so it must
		// not read as an unstable model. A transport timeout says the same thing:
		// the request may never have reached the model.
		expect(healthFor('RATE_LIMIT')).toBe('limited')
		expect(healthFor('UPSTREAM')).toBe('flaky')
		expect(summarizeHealth([{ id: 'm' }], mergeHealth({}, [probe('m', 'RATE_LIMIT', 'limited')]))).toBe('🚧 1')
	})

	test('a quota pause neither revives nor condemns a dead model', () => {
		const dead = mergeHealth({}, [probe('m', 'MODEL_GONE', 'flaky'), probe('m', 'MODEL_GONE', 'flaky')])
		const paused = mergeHealth(dead, [probe('m', 'RATE_LIMIT', 'limited')])
		expect(paused['m']?.health).toBe('dead')
	})
})


describe('roster filters', () => {
	const record = (kind: HealthRecord['kind'], health: HealthRecord['health']): HealthRecord => ({
		kind,
		health,
		detail: '',
		checkedAt: 1_000,
		terminalFailures: 0,
		transientFailures: 0,
	})

	// One model per verdict the roster can display, so a rule that hides by
	// anything other than "attributable to this model" has nowhere to hide.
	const store: HealthStore = {
		'fine': record('OK', 'ok'),
		'out-of-quota': record('RATE_LIMIT', 'limited'),
		'lane-timeout': record('UPSTREAM', 'limited'),
		'retired': record('MODEL_GONE', 'dead'),
		'geo-blocked': record('REGION_BLOCKED', 'dead'),
		'refuses-images': record('REQUEST_REJECTED', 'flaky'),
		'outage': record('UPSTREAM', 'flaky'),
		'gate-is-broken': record('SHAPE_REJECTED', 'unknown'),
	}

	const withFilters = (patch: Partial<ProbeFilters>): ProbeFilters => ({ ...DEFAULT_FILTERS, ...patch })

	test('nothing is hidden until the user says so', () => {
		expect([...hiddenFromStore(store, DEFAULT_FILTERS)]).toEqual([])
	})

	test('a quota pause and a dead lane never empty the roster', () => {
		// Both are facts about the channel: hiding on them empties the list at
		// exactly the moment it is worth having.
		const hidden = hiddenFromStore(store, withFilters({ hideRegionBlocked: true, hideFailed: true }))
		expect([...hidden].sort()).toEqual(['geo-blocked', 'outage', 'refuses-images', 'retired'])
		expect(hidden.has('out-of-quota')).toBe(false)
		expect(hidden.has('lane-timeout')).toBe(false)
	})

	test('the narrow switch hides exactly the geo blocks', () => {
		// A model retired upstream is still worth seeing: the free pool rotates
		// and an id that comes back should already be in the list.
		expect([...hiddenFromStore(store, withFilters({ hideRegionBlocked: true }))]).toEqual(['geo-blocked'])
	})

	test('the hidden set follows both the choice and the latest verdicts', () => {
		publishFilters(DEFAULT_FILTERS)
		publishHealth(store)
		expect(hidden().size).toBe(0)

		publishFilters(withFilters({ hideRegionBlocked: true }))
		expect([...hidden()]).toEqual(['geo-blocked'])

		// A re-probe that clears the geo block puts the model back, with no new
		// question asked.
		publishHealth({ 'geo-blocked': record('OK', 'ok') })
		expect(hidden().size).toBe(0)
	})

	test('the provider is rewritten only when the roster actually moves', () => {
		publishFilters(DEFAULT_FILTERS)
		publishHealth(store)
		let rewrites = 0
		const off = onHiddenChange(() => {
			rewrites++
		})

		publishFilters(withFilters({ hideRegionBlocked: true }))
		publishHealth(store)
		expect(rewrites).toBe(1)

		off()
		publishFilters(DEFAULT_FILTERS)
		expect(rewrites).toBe(1)
	})
})