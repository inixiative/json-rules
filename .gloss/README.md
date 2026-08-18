# .gloss

Margin commentary for this repo's source: `src/foo.ts` glosses to `.gloss/src/foo.ts.md`, an
`# src/foo.ts` h1 plus one `## <symbol>` section per symbol, and a `// gloss` dagger in the source
means a section exists here. It is advisory past-session commentary — it may be stale or wrong, so
trust the code and its `// why:` lines over it — and `gloss read <file> [symbol]` prints a section
with the staleness git derives for it.
