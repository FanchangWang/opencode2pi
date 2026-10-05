/**
 * omp resolves `@earendil-works/*` at runtime to its own built-in pi-ai copy
 * through a legacy-compat shim (docs/FINDINGS.md §3.4), so the extension must
 * import through that specifier or it would register its custom API into a
 * second, unrelated registry instance.
 *
 * The npm package of the same name is an older build that predates
 * `registerCustomApi` (docs/FINDINGS.md §3.3), so it is deliberately NOT a
 * dependency: installing it would shadow this declaration and type the
 * extension against an API surface the host does not have. Instead, point the
 * specifier at the host's own type package, which ships with omp itself.
 */
declare module '@earendil-works/pi-ai' {
	export * from '@oh-my-pi/pi-ai'
}
