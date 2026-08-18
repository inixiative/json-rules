# src/lens/exposedSurface.ts

## OFF_PATH

> `const OFF_PATH: readonly string[] = ['__offpath__'];`

A relPath matching no declared root.relations path → resolveVisit applies mapDefaults only.

## unionFieldInto

> `if (entry.groupBy !== undefined && next.groupBy === undefined) {`

A later visit may carry the partition axes an earlier (e.g. off-path) visit
lacked; divergence was already rejected before this merge.

## exposedSurface

> `export const exposedSurface = (`

Leak-safe total exposed surface of a narrowed lens, as a Lens. See docs/LENS.md.

> `const fetchedByModelField = new Map<string, Map<string, SourceOption>>();`

Per-model union of fetched options (the flattened surface collapses paths):
dedup by (group, value) across paths — the same key the materializers use —
so a grouped field's partition survives the union; a later occurrence wins.

> `const axes = effect.sourceGroupBys.get(fieldName);`

Stamp the partition axes so consumers know WHICH sibling path pins this
field's options. The surface flattens per model, so two paths declaring
DIFFERENT axes for one field would union two incompatible partition
namespaces — fail loud instead of merging them.

> `fieldRecord[name] =`

A sourced field already carries fetched `options`; otherwise a value-gated
field surfaces its (unioned) allowed-set as options, so every selectable
field exposes `options` uniformly. `values` stays as the validation input.

> `const bridges: Bridge[] | undefined = lens.bridges?.filter((b) => {`

Keep a bridge only if one of its injected bridge-fields survived (else it
touches unexposed surface and its `on` keys would leak).
