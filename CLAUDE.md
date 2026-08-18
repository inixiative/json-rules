<!-- gloss:begin -->
## Gloss — commentary lives in the margin, not in the code

Source files carry exactly three comment forms. Everything else belongs in the gloss.

1. `// why:` — a load-bearing constraint the code can't show. Must-read-now, stays inline.
   Filing rule: **if deleting a gloss entry could change what correct behavior looks like, it was
   misfiled — it belongs in `// why:`.**
2. Daggers — content-free existence markers, exact strings, trailing content is a lint error.
   `// gloss` on its own line above a declaration = that symbol has a gloss section.
   `// gloss:file` at the top of a file = a file-level preamble exists.
3. Machine directives — `eslint-disable*`, `biome-ignore`, `@ts-expect-error`/`@ts-ignore`/
   `@ts-nocheck`, `prettier-ignore`, `/// <reference`, shebangs, license headers, `#__PURE__`,
   bundler magic comments, istanbul/c8, `@vitest-environment`, `sourceMappingURL`.

**Writing.** Comment as you normally would — the harvester sweeps non-`why:` comments out of the
source into the gloss and plants the dagger. Or write the section yourself: `src/foo.ts` glosses to
`.gloss/src/foo.ts.md`, with an `# src/foo.ts` h1, an optional preamble, and one `## <symbol>`
section per symbol (`Class.method` for members, `default` for `export default`).

**Reading.** A `// gloss` dagger means margin commentary exists for that symbol. Reading it is a
second action, like `git log`: do it when a dagger is present and the code doesn't self-explain.
`gloss read <file> [symbol]`.

**Epistemics.** The gloss is advisory past-session commentary. It may be stale or wrong. Trust the
code and `// why:` lines over it.

**NEVER delete a gloss section or a dagger to green a failing check.** Run `gloss fix`.
<!-- gloss:end -->
