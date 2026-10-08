import { expect, test } from 'bun:test';
import {
  bindLens,
  type Condition,
  createLens,
  type FieldMap,
  type LensNarrowing,
  lensVisit,
  materializeSources,
  narrowRule,
  projectLens,
  projectRows,
  readLensValue,
  toLensSelect,
  toPrisma,
  toSourceQueries,
  validateNarrowing,
  validateRuleInLens,
} from '../index';

// Round 8: validateNarrowing runs the postures the runtime runs, so `ok` holds exactly when no
// bound posture refuses — over random lenses with binds, relative dates, windows, aggregates,
// nested array conditions, dotted labels and axes, pointers (`from: 'mapDefaults'`) and bridges.

let seed = 8;
const rnd = (): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)];
const COLS = ['id', 'x', 'y'];
const NOW = new Date('2026-10-08T00:00:00Z');

type Rel = { name: string; map: string; model: string; isList: boolean; bridge: boolean };
type Schema = Record<string, Record<string, Rel[]>>;
type Node = {
  picks?: string[];
  omits?: string[];
  where?: Condition;
  sources?: Record<string, unknown>;
  relations?: Record<string, Node>;
};
type Row = { [key: string]: unknown };

const genSchema = (): { schema: Schema; maps: Record<string, FieldMap> } => {
  const names = Array.from({ length: 4 + Math.floor(rnd() * 4) }, (_, i) => `M${i}`);
  const schema: Schema = { app: {}, crm: {} };
  const bridged = rnd() < 0.4;
  for (const m of names) {
    const rels: Rel[] = [];
    for (let i = 0; i < 2 + Math.floor(rnd() * 3); i++)
      rels.push({
        name: `r${i}`,
        map: 'app',
        model: pick(names),
        isList: rnd() < 0.4,
        bridge: false,
      });
    if (bridged && rnd() < 0.4)
      rels.push({ name: 'br', map: 'crm', model: 'K0', isList: false, bridge: true });
    schema.app[m] = rels;
  }
  if (bridged) {
    schema.crm.K0 = [{ name: 'k', map: 'crm', model: 'K1', isList: false, bridge: false }];
    schema.crm.K1 = [{ name: 'back', map: 'crm', model: 'K0', isList: true, bridge: false }];
  }
  const maps: Record<string, FieldMap> = {};
  for (const [mapName, models] of Object.entries(schema)) {
    if (!Object.keys(models).length) continue;
    const map: FieldMap = { models: {} };
    for (const [m, rels] of Object.entries(models)) {
      const order = [...COLS, 'd', 'n', ...rels.map((r) => r.name)];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      const fields: FieldMap['models'][string]['fields'] = {};
      for (const name of order) {
        const r = rels.find((x) => x.name === name);
        fields[name] = !r
          ? { kind: 'scalar', type: name === 'd' ? 'DateTime' : name === 'n' ? 'Int' : 'String' }
          : r.bridge
            ? {
                kind: 'bridge',
                type: `crm:${r.model}`,
                relationName: `${m}_${name}`,
                fromFields: [],
                toFields: [],
              }
            : { kind: 'object', type: r.model, isList: r.isList, relationName: `${m}_${name}` };
      }
      map.models[m] = { fields };
    }
    maps[mapName] = map;
  }
  return { schema, maps };
};

const randNode = (s: Schema, map: string, model: string, depth: number): Node => {
  const rels = s[map][model];
  const n: Node = {};
  if (rnd() < 0.25) n.picks = [...new Set([pick(COLS), ...(rnd() < 0.5 ? [pick(COLS)] : [])])];
  if (rnd() < 0.25) n.omits = [pick(rels).name];
  if (!n.picks && rnd() < 0.15) n.omits = [...(n.omits ?? []), pick(['x', 'y'])];
  if (depth > 0 && rnd() < 0.8) {
    n.relations = {};
    for (const r of rels)
      if (rnd() < 0.65) n.relations[r.name] = randNode(s, r.map, r.model, depth - 1);
  }
  return n;
};

// A rule reaching `segs` as the gate admits one: an array condition across each to-many relation.
const nestedRule = (
  s: Schema,
  segs: string[],
  leaf: Record<string, unknown>,
  op = 'any',
): Condition => {
  let map = 'app';
  let model = 'M0';
  const groups: { field: string[] }[] = [{ field: [] }];
  for (const seg of segs) {
    const r = s[map][model].find((x) => x.name === seg) as Rel;
    groups[groups.length - 1].field.push(seg);
    if (r.isList) groups.push({ field: [] });
    map = r.map;
    model = r.model;
  }
  const tail = [
    ...(groups.pop()?.field ?? []),
    ...(typeof leaf.field === 'string' ? [leaf.field] : []),
  ];
  let rule: Condition = (tail.length ? { ...leaf, field: tail.join('.') } : true) as Condition;
  for (const group of groups.reverse())
    rule = { field: group.field.join('.'), arrayOperator: op, condition: rule } as Condition;
  return rule;
};

const toOnePath = (s: Schema, model: string, len: number, lists = false): string[] => {
  const segs: string[] = [];
  let m = model;
  for (let i = 0; i < len; i++) {
    const rs = s.app[m]?.filter((r) => !r.bridge && (lists || !r.isList)) ?? [];
    if (!rs.length) break;
    const r = pick(rs);
    segs.push(r.name);
    m = r.model;
  }
  return segs;
};

const leaf = (): Record<string, unknown> => {
  const k = rnd();
  if (k < 0.3) return { field: pick(COLS), operator: rnd() < 0.5 ? 'exists' : 'notExists' };
  if (k < 0.5) return { field: pick(COLS), operator: 'equals', bind: 'viewer' };
  if (k < 0.7) return { field: 'd', dateOperator: 'after', value: { ago: { days: 30 } } };
  if (k < 0.8) return { field: 'd', dateOperator: 'before', value: { ago: { days: 1 } } };
  if (k < 0.9) return { field: 'n', operator: 'greaterThan', value: 0 };
  return { field: 'x', operator: 'equals', path: '$.y' };
};

const clampFor = (s: Schema, model: string): Condition => {
  const k = rnd();
  const lists = s.app[model].filter((r) => r.isList && !r.bridge);
  if (k < 0.35) {
    const segs = toOnePath(s, model, Math.floor(rnd() * 3), true);
    let m = model;
    const groups: string[][] = [[]];
    for (const seg of segs) {
      const r = s.app[m].find((x) => x.name === seg) as Rel;
      groups[groups.length - 1].push(seg);
      if (r.isList) groups.push([]);
      m = r.model;
    }
    const tail = groups.pop() ?? [];
    const l = leaf();
    let rule = { ...l, field: [...tail, l.field].join('.') } as Condition;
    for (const g of groups.reverse())
      rule = {
        field: g.join('.'),
        arrayOperator: pick(['any', 'all', 'none']),
        condition: rule,
      } as Condition;
    return rule;
  }
  if (k < 0.55 && lists.length) {
    const n: Record<string, unknown> = {
      field: pick(lists).name,
      arrayOperator: pick(['any', 'all', 'atLeast']),
      condition: leaf(),
    };
    if (n.arrayOperator === 'atLeast') n.count = 1;
    if (rnd() < 0.6) n.orderBy = [{ field: pick(['d', 'x', 'n']), dir: pick(['asc', 'desc']) }];
    if (rnd() < 0.5) n.take = 2;
    if (rnd() < 0.4) n.filter = leaf();
    return n as Condition;
  }
  if (k < 0.7 && lists.length)
    return {
      field: pick(lists).name,
      aggregate: { mode: pick(['sum', 'avg']), field: 'n' },
      operator: 'greaterThan',
      value: 0,
      ...(rnd() < 0.4 ? { condition: leaf() } : {}),
    } as Condition;
  if (k < 0.8) {
    const segs = toOnePath(s, model, 1 + Math.floor(rnd() * 2));
    return { ...leaf(), field: [...segs, pick(COLS)].join('.') } as Condition;
  }
  if (k < 0.9) return { all: [clampFor(s, model), leaf()] } as Condition;
  return leaf() as Condition;
};

const sourceFor = (s: Schema, model: string, onPath: boolean): unknown => {
  const k = rnd();
  if (onPath && k < 0.2)
    return { from: 'mapDefaults', ...(rnd() < 0.5 ? { where: clampFor(s, model) } : {}) };
  // An array condition over a list: the list's clamps (windowed ones too) are carried into it.
  const lists = s.app[model].filter((r) => r.isList && !r.bridge);
  if (k < 0.3 && lists.length)
    return {
      field: pick(lists).name,
      arrayOperator: pick(['any', 'all']),
      condition: leaf(),
      ...(rnd() < 0.5 ? { orderBy: [{ field: 'd', dir: 'desc' }], take: 1 } : {}),
    };
  if (k < 0.5) return clampFor(s, model);
  const dotted = [...toOnePath(s, model, 1 + Math.floor(rnd() * 2)), pick(COLS)].join('.');
  const where = rnd() < 0.5 ? { where: clampFor(s, model) } : {};
  if (k < 0.7) return { label: rnd() < 0.5 ? pick(COLS) : dotted, ...where };
  return { groupBy: rnd() < 0.5 ? dotted : [dotted], ...where };
};

const addClamps = (
  s: Schema,
  node: Node,
  map: string,
  model: string,
  p: number,
  onPath: boolean,
) => {
  if (map !== 'app') return;
  if (rnd() < p) node.where = clampFor(s, model);
  if (rnd() < p / 1.5) node.sources = { [pick(['x', 'y'])]: sourceFor(s, model, onPath) };
  for (const [rel, sub] of Object.entries(node.relations ?? {})) {
    const r = s[map][model].find((q) => q.name === rel);
    if (r) addClamps(s, sub, r.map, r.model, p, onPath);
  }
};

// A later layer over what its parent shows: a spelled path narrowed, model defaults narrowed —
// each maybe clamped or sourced.
const laterLayer = (s: Schema, parent: LensNarrowing): LensNarrowing => {
  const shown = Object.entries(projectLens(parent));
  const layer: LensNarrowing = { parent };
  if (rnd() < 0.7) {
    const [path, visit] = pick(shown);
    const root: Node = {};
    let at = root;
    for (const seg of path.split('.').slice(1)) {
      at.relations = { [seg]: {} };
      at = at.relations[seg];
    }
    const rels = Object.keys(visit.fields).filter((f) => visit.fields[f].kind === 'object');
    const cols = Object.keys(visit.fields).filter(
      (f) => !rels.includes(f) && visit.fields[f].kind !== 'bridge',
    );
    const narrowed = rnd();
    if (narrowed < 0.5) at.omits = [pick(['x', 'y', ...rels])];
    else if (narrowed < 0.75) at.picks = cols.filter(() => rnd() < 0.6);
    layer.root = root as never;
    addClamps(s, root, 'app', 'M0', 0.5, true);
  }
  if (rnd() < 0.6) {
    const models: Record<string, Node> = {};
    for (let i = 0; i < 1 + Math.floor(rnd() * 2); i++) {
      const [, visit] = pick(shown);
      if (visit.mapName !== 'app') continue;
      const node = models[visit.model] ?? {};
      const rels = Object.keys(visit.fields).filter((f) => visit.fields[f].kind === 'object');
      if (rnd() < 0.5) node.omits = [pick(['x', 'y', ...s.app[visit.model].map((r) => r.name)])];
      if (rels.length && rnd() < 0.5)
        node.relations = { [pick(rels)]: rnd() < 0.5 ? { omits: [pick(['x', 'y'])] } : {} };
      addClamps(s, node, 'app', visit.model, 0.6, false);
      models[visit.model] = node;
    }
    layer.mapDefaults = { app: { models: models as never } };
  }
  return layer;
};

const synthRow = (s: Schema, map: string, model: string, depth: number): Row => {
  const row: Row = { id: `${model}-${depth}`, x: 'X', y: 'Y', d: '2026-10-05T00:00:00Z', n: 1 };
  if (depth === 0) return row;
  for (const r of s[map][model]) {
    const child = synthRow(s, r.map, r.model, depth - 1);
    row[r.name] = r.isList ? [child] : child;
  }
  return row;
};

const REFUSAL = /later layer's clamp|climbs out|root row|re-root|to-many relation clamp/;
const REFUSED_ISSUE = new RegExp(
  `${REFUSAL.source}|does not resolve|is a relation the lens does not turn on|Windowing|counting step`,
);

// The first refusal a bound posture makes, or null: projection both ways, the fetch, the source
// plans and options, rows, and — at every shown visit — the visit, a presence rule reaching it and
// a rule and a read of each column there. Any other throw is a compile's or a read's own limit.
// A throw from the lens's own queries or projections that is not a refusal.
const leaks: string[] = [];

const refusedBy = (s: Schema, lens: LensNarrowing, row: Row, valid: boolean): string | null => {
  const bound = bindLens(lens, { viewer: 'X' });
  const attempts: [string, () => unknown][] = [
    ['projectLens', () => projectLens(bound)],
    ['projectLens by model', () => projectLens(bound, { by: 'model' })],
    ['toLensSelect', () => toLensSelect(bound, { now: NOW })],
    ['toSourceQueries', () => toSourceQueries(bound, { now: NOW })],
    ['materializeSources', () => materializeSources(bound, [row], { now: NOW })],
    ['projectRows', () => projectRows(bound, [row], { keepClampColumns: true, now: NOW })],
  ];
  const gate = (rule: Condition) => () => {
    const result = validateRuleInLens(rule, bound);
    const refusal = result.errors.find((e) => REFUSAL.test(e.message));
    if (refusal) throw Object.assign(new Error(refusal.message), { refusal: true });
    if (!result.ok) return;
    narrowRule(rule, bound);
    toPrisma(rule, { lens: bound, now: NOW });
  };
  const walk = (segs: string[], map: string, model: string): void => {
    let visit: unknown;
    try {
      visit = lensVisit(bound, segs.join('.'));
    } catch {
      visit = null;
    }
    if (!visit) return;
    attempts.push([`lensVisit ${segs.join('.')}`, () => lensVisit(bound, segs.join('.'))]);
    if (segs.length)
      attempts.push([
        `presence ${segs.join('.')}`,
        gate(nestedRule(s, segs, { operator: 'exists' })),
      ]);
    if (map === 'app')
      for (const col of [...COLS, 'd']) {
        const path = [...segs, col].join('.');
        attempts.push([
          `rule ${path}`,
          gate(nestedRule(s, segs, { field: col, operator: 'exists' })),
        ]);
        attempts.push([
          `read ${path}`,
          () => {
            const read = readLensValue(bound, row, path, { now: NOW });
            if (!read.ok && REFUSAL.test(JSON.stringify(read)))
              throw new Error(JSON.stringify(read));
          },
        ]);
      }
    for (const r of s[map][model]) walk([...segs, r.name], r.map, r.model);
  };
  walk([], 'app', 'M0');
  for (const [name, attempt] of attempts) {
    try {
      attempt();
    } catch (error) {
      // A rail that can't hold the lens's clamps on a rule is the caller's pick of rail, not a
      // refusal of the lens (check() runs it).
      const refused =
        ((error as Error).constructor.name === 'LensRefusal' &&
          (error as { code?: string }).code !== 'unsupported_target') ||
        (error as { refusal?: boolean }).refusal;
      if (refused) return `${name}: ${(error as Error).message}`;
      // The lens's own queries and projections refuse what they can't run; they never throw.
      if (valid && /^(toSourceQueries|toLensSelect|projectLens|lensVisit)/.test(name))
        leaks.push(`${name}: ${(error as Error).message}`);
    }
  }
  return null;
};

// Over many seeds, each to ≥ 100 later layers: ≥ 2000 in all.
const SEEDS = [8, ...Array.from({ length: 20 }, (_, i) => 901 + i)];

test.each(
  SEEDS,
)('seed %i: validateNarrowing.ok holds exactly when no bound posture refuses', (start) => {
  seed = start;
  leaks.length = 0;
  let later = 0;
  let first = 0;
  const mismatches: string[] = [];
  const agree = (s: Schema, lens: LensNarrowing, row: Row, tag: string): boolean => {
    // A validator never throws: anything but a result is a bug.
    const { ok, errors } = validateNarrowing(lens);
    const refused = refusedBy(s, lens, row, ok);
    if (ok && refused !== null) mismatches.push(`${tag} valid, refused by ${refused}`);
    // A narrowing can be invalid for what it names (a hidden field, a relation it may not turn
    // on); one invalid only for what a posture refuses must be refused by one.
    if (!ok && refused === null && errors.every((e) => REFUSED_ISSUE.test(e.message)))
      mismatches.push(`${tag} refused by validation alone: ${errors[0].message}`);
    return ok;
  };
  const distinct = new Set<string>();
  while (later < 100) {
    const { schema, maps } = genSchema();
    const base = createLens({ maps, mapName: 'app', model: 'M0' });
    const defaults: Record<string, Node> = {};
    for (const m of Object.keys(schema.app))
      if (rnd() < 0.75) {
        defaults[m] = randNode(schema, 'app', m, 2);
        addClamps(schema, defaults[m], 'app', m, 0.3, false);
      }
    const l1: LensNarrowing = { parent: base, mapDefaults: { app: { models: defaults as never } } };
    if (rnd() < 0.7) {
      const root = randNode(schema, 'app', 'M0', 3);
      addClamps(schema, root, 'app', 'M0', 0.35, true);
      l1.root = root as never;
    }
    const row = synthRow(schema, 'app', 'M0', 4);
    first++;
    distinct.add(JSON.stringify([maps, l1.root, l1.mapDefaults]));
    if (!agree(schema, l1, row, `L1#${first}`)) continue;
    for (let k = 0; k < 6; k++) {
      const l2 = laterLayer(schema, l1);
      later++;
      if (agree(schema, l2, row, `L2#${later}`) && rnd() < 0.5) {
        later++;
        agree(schema, laterLayer(schema, l2), row, `L3#${later}`);
      }
    }
  }
  expect(mismatches).toEqual([]);
  expect(leaks).toEqual([]);
  expect(later).toBeGreaterThanOrEqual(100);
  // Every seed walks its own stream: the first narrowings are all different.
  expect(distinct.size).toBeGreaterThan(0.95 * first);
}, 120_000);
