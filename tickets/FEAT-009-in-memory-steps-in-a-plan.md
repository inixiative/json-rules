# FEAT-009: in-memory steps in a plan; a lens order across a bridge

**Status:** follow-up, not built. Each part needs a spec and Aron's yes before code (a semantic
change gets a spec first).

## Intent

Aron, 2026-11-21, reviewing #59 (`pick` and a lens `orderBy`):

- "memory can do as many things as it can. That's kind of how the system works, right? If you
  really need to do things, you have to do them in memory, right? Just preload and do that."
- "long term, we might want to start thinking about how to make plan system plans that can support
  in-memory actions right during the plan, insofar as that's possible."
- On a lens order key across a bridge: "That obviously doesn't work in SQL… You can do a pick
  thing, a pick plan or something, but on just a purely in-memory check, I think you could do an
  order by, like that."
- "make a ticket somewhere to track the enabling of it and the two types of plan as follow-ups."

So memory doing more than a compiler is the design, never a rail divergence to refuse. 4.5.0
already ships that way for `pick`: `check()` runs it and both compilers refuse it. Today the
caller who needs a check-only feature in a fetch preloads rows and checks by hand. This ticket is
the three follow-ups that close that gap. "The two types of plan" is read here as the pick plan
and the order plan (this session's reading).

## Where 4.5.0 stands

- `pick` is check-only: `toSql` refuses with `unsupported_sql_aggregate_mode`, `toPrisma` with
  `unsupported_prisma_aggregate_mode`.
- A lens `orderBy` key crosses to-one relations of one map only. A bridge on the path is refused
  as `wrong_kind` on every posture, `projectRows` included (`orderKeyIssue`, `src/lens/policy.ts`).
- A Prisma plan (`toPrisma` → `executePrismaPlan`) has query steps only: `countStep`, `groupStep`,
  and `{ __field }` column refs resolved between steps. No step evaluates rows in memory.
- 4.4.0 added `indexBridges` / `recordWithBridgeData`: a record with its bridges filled, in memory.

## 1. A lens order key across a bridge, in memory

Allow `{ field: 'billing:Account.balance', dir }`-shaped keys (a to-one bridge, then a number or
date column the lens shows) where the rows carry the bridged record.

- `projectRows` orders by it: `inVisitOrder` already reads values off the row, and
  `recordWithBridgeData` is what fills the bridge. Use those; no new reader.
- `toLensSelect` cannot put it in one query's `orderBy`. Open: leave the key out of the query order
  and say so in the result, or refuse as the compilers refuse `pick`. Either way a paginated fetch
  cuts pages in the database's order until part 3 exists; the spec must say which.
- Same lens rules as any key: the bridge and the column are shown by the parent, to-one only,
  nullable terminal or required hop, no clamped relation on the way in a later layer.

Test cases for the spec: a bridged key orders `projectRows` output with nulls last; a row whose
bridge is not filled sorts as null; a to-many bridge is still `wrong_kind`; a later layer naming a
bridge its parent hides is `not_visible`; mixed keys (own column, then bridged) apply in turn.

## 2. A pick plan

`toPrisma` plans a `pick` as steps instead of refusing: a query step that fetches the window's
rows (the window's `filter`, `orderBy`, `take`, `skip` already compile for other array rules),
then an in-memory step that reads the picked value(s) with `pickValues` and feeds the comparison,
as `{ __field }` refs feed later steps today. `toSql` has no plan and keeps refusing.

Open for the spec: a pick per parent row needs one windowed read per parent or a lateral join;
which, and where the cost limit is.

## 3. An order plan

A lens fetch whose order needs memory (part 1's bridged key) as a plan: fetch the page's candidate
rows, fill bridges (`indexBridges` + `recordWithBridgeData`), order in memory (`inVisitOrder`),
then cut. This is what makes a bridged order correct under pagination.

Open for the spec: ordering before the cut means reading every candidate row; the plan needs a
stated bound or a refusal past it.

## The general shape

Parts 2 and 3 are the same new thing: a plan step that runs in memory between query steps, using
the evaluator that already exists (`check` / `evaluateValue` / `projectRows`), never a second
implementation. Design that step once, in `executePrismaPlan`, and both plans are its first users.
