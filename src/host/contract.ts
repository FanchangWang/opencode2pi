/**
 * The host boundary: everything this extension needs from the agent runtime,
 * expressed in terms neither pi nor omp uses.
 *
 * The two hosts genuinely differ, not cosmetically:
 *
 *   · omp hands a custom API handler an omp `Context` — `systemPrompt`,
 *     `messages` and `tools` as separate fields — while pi hands its
 *     `ProviderConfig.streamSimple` a *transcript*: the prompt and the tool
 *     declarations live in the leading system message, so they have to be
 *     replayed out with `getCurrentTools` / `getCurrentSystemPrompt` before the
 *     gated set can be substituted.
 *   · omp lets an extension register a streaming function process-wide through
 *     `registerCustomApi` before the extension factory runs. pi has no such
 *     registry at all; its only seam is `streamSimple` inside a
 *     `pi.registerProvider` call. Registering through `pi.registerProvider` works
 *     on BOTH hosts (omp's own registry calls `registerCustomApi` internally),
 *     so that is the only seam this extension uses — one code path, two hosts.
 *   · omp gives extensions `pi.logger`; pi 1.3.0 gives them nothing, so
 *     diagnostics have to reach the user some other way.
 *   · `ctx.ui.select` takes `{label, description}[]` on omp and `string[]` on
 *     pi — same feature, different argument shape, and a call written for one
 *     silently renders wrong on the other.
 *   · omp's `AssistantMessage` carries a numeric `errorStatus`; pi folds the
 *     status into the message text instead (`"403: {json}"`), so classification
 *     has to work from text alone where the field is missing.
 *
 * So the rule is: nothing below `src/host/` names a host package. The shared
 * layer (`lanes`, `gate`, `pool`, …) talks to these interfaces, and each
 * adapter is the only place that knows how one host spells them.
 *
 * `ProviderModelConfig` is deliberately NOT re-declared here as a loose
 * structural type. Both hosts publish their own and both *validate* it — omp
 * throws when a custom model set omits `baseUrl`/`apiKey`, pi throws when
 * `api` is missing alongside `streamSimple`. Re-declaring it would put a third,
 * subtly different contract in the middle, so the adapters keep the host's type
 * and the shared layer stays free of it. What the shared layer does carry is
 * {@link ModelSpec}, which is *our* shape and not a host's: both hosts accept a
 * projection of it, and each adapter owns that projection.
 */

/** Provider name this extension registers. Same string on both hosts. */
export const PROVIDER = 'opencode-zen-free'

/**
 * Custom API id, distinct from every built-in.
 *
 * Both hosts reserve their built-in api names and reject a registration that
 * shadows one, so this has to stay a name neither of them ships.
 */
export const API_ID = 'openai-completions-zen-free'

/** The anonymous credential. Upstream only checks that the header is present. */
export const ANONYMOUS_KEY = 'public'

/** Registration source id, so a host that tracks registrations can scope ours. */
export const SOURCE_ID = 'opencode2pi'

/** Project signal rendered into each lane's header shape (FINDINGS §2.5). */
export const PROJECT_ID = 'omp:default-project'

/** The built-in engine both hosts delegate actual streaming to. */
export const BUILTIN_API = 'openai-completions'

/**
 * A tool as this extension sees it.
 *
 * Structurally minimal on purpose: `lanes.gateTools` rewrites descriptions and
 * parameter schemas and passes everything else through, so a wider type would
 * only be a promise the shared layer cannot keep.
 */
export interface HostTool {
	readonly name: string
	readonly description: string
	readonly parameters?: unknown
}

/**
 * A failed assistant turn, narrowed to the fields this extension reads.
 *
 * Neither host's `AssistantMessage` is assignable to this without a cast on one
 * side or the other, and they disagree on more than types: omp carries a numeric
 * `errorStatus`, while pi folds the status into the message text
 * (`utils/error-body.ts`). Reading a status here therefore has to be
 * best-effort, and `errors.ts` classifies from text when it is absent — which is
 * exactly what its marker checks already do.
 */
export interface FailedMessage {
	readonly errorMessage?: string
	/** omp only; pi leaves it undefined and embeds the status in the text. */
	readonly errorStatus?: number
	/** omp only; preserved verbatim so host recovery logic still sees it. */
	readonly errorClassificationMessage?: string
}

/** One event off the host's assistant-message stream. */
export interface StreamEvent {
	readonly type: string
	readonly error?: FailedMessage
}

/**
 * The host stream surface: iterate events, then await the final message.
 *
 * Both hosts ship the same `AssistantMessageEventStream` shape, so this is a
 * structural mirror rather than a re-declaration. It exists because the shared
 * layer forwards a stream it did not create and must not care who did — and
 * because `fail` exists on omp's stream but NOT on pi's, which has no way to
 * reject `result()` other than through a terminal event. The shared layer
 * therefore never calls `fail`; it is absent here for the same reason.
 */
export interface MessageStream {
	[Symbol.asyncIterator](): AsyncIterator<StreamEvent>
	result(): Promise<unknown>
	push(event: StreamEvent): void
	end(message: unknown): void
}

/**
 * The host's fetch implementation, as the exit pool needs it.
 *
 * Declared structurally rather than imported: both hosts accept a
 * `fetch`-compatible function here (pi threads `options.fetch` into
 * `new OpenAI({ fetch })`, omp into its transport), and this is the one function
 * type the pool genuinely has to name.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** Per-request options, narrowed to what the shared layer reads or rewrites. */
export interface StreamOptions {
	readonly toolChoice?: string
	readonly sessionId?: string
	readonly metadata?: Record<string, unknown>
	readonly fetch?: FetchLike
	readonly [key: string]: unknown
}

/**
 * The model a request is for, as the handler receives it.
 *
 * Deliberately not the host's `Model`: the handler rebuilds it per request (to
 * attach the session headers) and the rebuilt object is handed straight back to
 * the host engine, so widening this type buys nothing.
 */
export interface StreamModel {
	readonly id: string
	readonly api: string
	readonly baseUrl?: string
	readonly headers?: Record<string, string>
	readonly [key: string]: unknown
}

/**
 * The request context, normalized across both hosts.
 *
 * `tools` is the host-declared tool set at request time; the handler gates it
 * and hands the result to `withTools`, which rebuilds whatever the host's engine
 * expects — a spread context on omp, a rewritten transcript on pi. The shared
 * layer stays ignorant of which.
 */
export interface NormalizedContext {
	readonly tools: readonly HostTool[]
	/** Rebuild the context for the host engine with these tools substituted. */
	readonly withTools: (tools: readonly HostTool[]) => unknown
}

/** Diagnostics sink. Absent on pi, which is why every call site tolerates it. */
export interface HostLogger {
	info(message: string): void
	warn(message: string): void
}

/** One selectable row: a label plus an optional second line. */
export interface SelectItem {
	readonly label: string
	readonly description?: string
}

/**
 * The subset of `ctx.ui` the commands use.
 *
 * `select` is normalized to omp's richer shape on purpose: pi takes bare
 * strings, so its adapter folds the description into the label rather than
 * dropping it. Losing the second line would make the pool menu — whose rows are
 * mostly evidence, not names — unreadable on pi.
 */
export interface CommandUi {
	readonly hasUI: boolean
	notify(message: string, level?: 'info' | 'warning' | 'error'): void
	setWorkingMessage(message?: string): void
	confirm(title: string, message: string): Promise<boolean>
	input(title: string, placeholder?: string): Promise<string | undefined>
	select(title: string, items: readonly SelectItem[]): Promise<string | undefined>
}

/**
 * The four host-specific pieces the shared request path is built from.
 *
 * This is the whole streaming half of the adapter contract. Everything else
 * about a request — gating the tool set, pinning the session id, wrapping
 * `fetch` for the exit pool, relaying and re-classifying failures, re-probing
 * the lanes — is identical on both hosts and lives in `request.ts`. Splitting it
 * here rather than duplicating it is the point: a fix to the request path cannot
 * land on one host only.
 */
export interface StreamEngine {
	/** Where notes about this path go. Never throws. */
	readonly diagnostics: HostLogger
	/** Read the host's declared tools out of its context, and write a set back. */
	normalizeContext(raw: unknown): NormalizedContext
	/** Rewrite a failed turn so the user reads the failure mode, not raw text. */
	explainFailure(modelId: string, error: FailedMessage): FailedMessage
	/** A fresh relay stream of the host's own class. */
	createStream(): MessageStream
	/**
	 * Terminate a relayed stream after something threw.
	 *
	 * omp's stream has a real `fail`, which rejects `result()`. pi's does not:
	 * its only terminal states are a `done` / `error` event or `end()`, so pi
	 * ends the stream instead. That asymmetry is why this is a hook rather than a
	 * method on {@link MessageStream}.
	 */
	abort(stream: MessageStream, error: unknown): void
	/** Hand the shaped request to this host's built-in engine. */
	dispatch(model: StreamModel, context: unknown, options: StreamOptions): MessageStream
}

/**
 * What an adapter must supply for the shared layer to run.
 *
 * Two capabilities, not one, because they are the two that actually differ:
 * `stream` is the request path, `diagnostics` is how a failure reaches the user
 * when the host has no logger.
 */
export interface HostAdapter {
	readonly name: 'pi' | 'omp'
	/** Build the request-path handler for the current registration. */
	readonly stream: StreamHandler
	/**
	 * The full `registerProvider` config for this host.
	 *
	 * The adapter owns this rather than the entry point because both halves are
	 * host-specific: the model projection (`thinking` vs `thinkingLevelMap`) and
	 * the model-config type the host validates. Returning `Record<string, unknown>`
	 * is deliberate — `pi.registerProvider` takes a different declared type on each
	 * host, and the value is written straight into it.
	 */
	readonly providerConfig: (models: readonly ModelSpec[], baseUrl: string, headers: Record<string, string>) => Record<string, unknown>
	/** Where startup and discovery notes go. Never throws. */
	readonly diagnostics: HostLogger
	/** Wrap a host command context into the shared UI port. */
	readonly ui: (ctx: unknown) => CommandUi
}

/**
 * The custom-api handler both hosts ultimately call.
 *
 * Returning a stream (rather than a promise of one) matches both hosts: pi's
 * `ProviderConfig.streamSimple` and omp's registered custom API both call this
 * synchronously and expect an assistant-message stream back.
 */
export type StreamHandler = (
	model: StreamModel,
	context: unknown,
	options?: StreamOptions,
) => MessageStream

/** Minimal shape of the extension API object both hosts pass to the factory. */
export interface ExtensionApiLike {
	registerProvider(name: string, config: Record<string, unknown>): void
	registerCommand(
		name: string,
		options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> },
	): void
	/** omp only. */
	readonly logger?: HostLogger
}

/**
 * One model as *this extension* describes it, before either host sees it.
 *
 * The shared layer produces these and never a host config; each adapter
 * projects them into `ProviderModelConfig`. The fields are the intersection both
 * hosts accept verbatim (`id`, `name`, `reasoning`, `input`, `cost`,
 * `contextWindow`, `maxTokens`) plus `efforts`, which is the one place the two
 * genuinely disagree about spelling:
 *
 *   omp  `thinking: { mode: 'effort', efforts: Effort[] }`
 *   pi   `thinkingLevelMap: { low: 'low', high: 'high', … }`, `null` = unsupported
 *
 * `efforts` is absent (not empty) when the model has no effort axis: an empty
 * list would violate omp's contract, and pi derives its defaults from
 * `reasoning: true` alone.
 */
export interface ModelSpec {
	readonly id: string
	readonly name: string
	readonly reasoning: boolean
	readonly input: readonly ('text' | 'image')[]
	readonly cost: {
		readonly input: number
		readonly output: number
		readonly cacheRead: number
		readonly cacheWrite: number
	}
	readonly contextWindow: number
	readonly maxTokens: number
	/** Ascending effort levels the model actually supports, if it has an axis. */
	readonly efforts?: readonly string[]
}

/**
 * Project a {@link ModelSpec} into whatever the host validates.
 *
 * Returns `unknown` on purpose: the result is written straight into
 * `pi.registerProvider`, whose config type each host declares for itself, and
 * asserting a cross-host structural type here would reintroduce exactly the
 * third contract this file refuses to hold.
 */
export type ModelProjector = (spec: ModelSpec) => unknown

/** Effort levels both hosts agree on, in ascending order. */
export const EFFORT_LEVELS: readonly string[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
