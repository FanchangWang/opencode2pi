/**
 * Type bridge for `@earendil-works/pi-ai`.
 *
 * Both hosts resolve this specifier at runtime to their OWN built-in pi-ai
 * copy, which is exactly what makes one source tree able to serve both:
 *
 *   pi 1.3.0   `core/extensions/loader.ts` aliases the bare root to
 *              `ai/dist/compat.js`
 *   omp 18.11.3  `extensibility/plugins/legacy-pi-compat.ts` rewrites the scope
 *              to `@oh-my-pi/*` and serves `extensibility/legacy-pi-ai-shim.ts`
 *              for the bare root, which re-exports `@oh-my-pi/pi-ai` and adds the
 *              transcript-replay helpers on top
 *
 * Importing anything else would register into a second, unrelated module
 * instance — or fail to resolve at all.
 *
 * ## Why the types point at omp
 *
 * Only one of the two hosts' type packages can be a dependency here, and it is
 * omp's: `@oh-my-pi/pi-coding-agent` is published and installable, whereas the
 * npm build of `@earendil-works/pi-ai` is an OLDER build that predates
 * `registerCustomApi` (FINDINGS §3.3), so installing it would shadow this
 * declaration and type the extension against an API surface neither host has.
 *
 * The consequence is that pi-only type names are not in scope, so the pi adapter
 * imports the handful it needs structurally and casts at the boundary rather
 * than pretending omp's declarations cover it. Both are visible at build time
 * here: `api/opencode2pi.test.ts` pins the runtime behaviour against the real
 * packages, and `npm run typecheck` covers the shared layer, which references no
 * host type at all.
 *
 * What IS declared here is only what this extension needs, and every name below
 * is a runtime export that BOTH hosts genuinely have from this specifier:
 * `streamSimple` and `createAssistantMessageEventStream` from each host's own
 * pi-ai, plus the transcript-replay family — pi exports it from
 * `ai/dist/index.ts` (`utils/transcript.ts`), and omp's legacy shim ports it
 * verbatim in `legacy-pi-transcript.ts` precisely so a legacy extension can
 * import these by name. That is what lets the pi adapter's transcript handling
 * type-check against the same declarations the omp adapter uses.
 *
 * pi's `TranscriptContext` is a branded type whose brand is not in scope here,
 * so the pi adapter treats it structurally (`{ messages }`) and casts at the
 * dispatch boundary. That is honest rather than convenient: the brand exists so
 * no raw `Context` can reach provider code by accident, and this code path
 * always constructs the transcript deliberately.
 */
declare module '@earendil-works/pi-ai' {
	export * from '@oh-my-pi/pi-ai'

	/** Any transcript: the branded `messages` array both hosts pass around. */
	export interface TranscriptContext {
		messages: TranscriptEntry[]
	}

	/** One transcript entry, as far as the replay helpers are concerned. */
	export interface TranscriptEntry {
		readonly role: string
		readonly [key: string]: unknown
	}

	/**
	 * Replay every system message into one leading message carrying the current
	 * prompt and the resolved tools. Present on both hosts.
	 */
	export function collapseSystemMessages(context: TranscriptContext): TranscriptContext

	/** The tool set in effect after every `toolsAdded` / `toolsRemoved` delta. */
	export function getCurrentTools(messages: readonly { role: string }[]): HostToolShape[]

	/** A host tool declaration, narrowed to what the replay helpers read. */
	export interface HostToolShape {
		name: string
		description: string
		parameters: unknown
	}
}
