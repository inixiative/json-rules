import { expect, test } from 'bun:test';
import {
  type Condition,
  check,
  createLens,
  type FieldMap,
  joinNarrowings,
  type Lens,
  type LensNarrowing,
  LensRefusal,
  type ModelNarrowing,
  narrowRule,
  projectRows,
  validateNarrowing,
  validateRuleInLens,
} from '../index';
import { mulberry32 } from './fuzz/mulberry32';

// joinNarrowings either refuses a chain or returns one narrowing that answers every posture as the
// chain does: over random lenses (scalar-only, and with to-one and to-many relations), random chains
// of two and three layers, random rows and random rules, the gate, narrowRule + check() and
// projectRows agree between the chain and the joined narrowing.

type Layer = Omit<LensNarrowing, 'parent'>;
type Rel = { name: string; model: string; isList: boolean };
type Schema = Record<string, Rel[]>;
type Row = Record<string, unknown>;

const COLS = ['id', 'x', 'y', 'n', 'e'];
const ENUM = ['a', 'b', 'c'];

const run = (seed: number) => {
  const rnd = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)] as T;
  const some = <T>(items: readonly T[], p: number): T[] => items.filter(() => rnd() < p);

  const scalarOnly = rnd() < 0.3;
  const names = Array.from({ length: 2 + Math.floor(rnd() * 3) }, (_, i) => `M${i}`);
  const schema: Schema = {};
  for (const m of names)
    schema[m] = scalarOnly
      ? []
      : Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, i) => ({
          name: `r${i}`,
          model: pick(names),
          isList: rnd() < 0.5,
        }));
  const map: FieldMap = { models: {}, enums: { E: ENUM } };
  for (const m of names) {
    const fields: FieldMap['models'][string]['fields'] = {
      id: { kind: 'scalar', type: 'String' },
      x: { kind: 'scalar', type: 'String' },
      y: { kind: 'scalar', type: 'String' },
      n: { kind: 'scalar', type: 'Int' },
      e: { kind: 'enum', type: 'E' },
    };
    for (const r of schema[m] as Rel[])
      fields[r.name] = { kind: 'object', type: r.model, isList: r.isList };
    map.models[m] = { fields };
  }
  const lens: Lens = createLens({ maps: { app: map }, mapName: 'app', model: 'M0' });

  const leaf = (): Condition => {
    const k = rnd();
    if (k < 0.2) return { field: pick(COLS), operator: rnd() < 0.5 ? 'exists' : 'notExists' };
    if (k < 0.4) return { field: pick(['x', 'y']), operator: 'equals', value: pick(['p', 'q']) };
    if (k < 0.5) return { field: 'id', operator: 'in', value: some(['i0', 'i1', 'i2'], 0.5) };
    if (k < 0.6)
      return { field: pick(['x', 'id']), operator: 'notEquals', value: pick(['p', 'i0']) };
    if (k < 0.75) return { field: 'n', operator: pick(['greaterThan', 'lessThan']), value: 0 };
    if (k < 0.9) return { field: 'e', operator: 'equals', value: pick(ENUM) };
    return { field: 'e', operator: 'notIn', value: [pick(ENUM)] };
  };

  // A condition on `model`'s row, crossing up to `depth` relations.
  const cond = (model: string, depth: number): Condition => {
    const rels = schema[model] as Rel[];
    const k = rnd();
    if (depth > 0 && rels.length && k < 0.35) {
      const r = pick(rels);
      if (r.isList)
        return {
          field: r.name,
          arrayOperator: pick(['any', 'all', 'none']),
          condition: cond(r.model, depth - 1),
        } as Condition;
      const inner = cond(r.model, 0) as { field?: string };
      return typeof inner.field === 'string'
        ? ({ ...inner, field: `${r.name}.${inner.field}` } as Condition)
        : leaf();
    }
    if (k < 0.5) return { all: [cond(model, depth), leaf()] };
    if (k < 0.6) return { any: [leaf(), leaf()] };
    return leaf();
  };

  const turnOns = (model: string, depth: number): Record<string, ModelNarrowing> | undefined => {
    if (depth <= 0) return undefined;
    const rels = some(schema[model] as Rel[], 0.6);
    if (!rels.length) return undefined;
    return Object.fromEntries(rels.map((r) => [r.name, firstNode(r.model, depth - 1, false)]));
  };

  const selection = (node: ModelNarrowing, model: string) => {
    const columns = rnd();
    if (columns < 0.3) node.picks = some(COLS, 0.6);
    else if (columns < 0.5) node.omits = some(COLS.slice(1), 0.4);
    if (rnd() < 0.2) {
      const rels = (schema[model] as Rel[]).map((r) => r.name);
      if (rels.length) node.omits = [...(node.omits ?? []), pick(rels)];
    }
    const enums = rnd();
    if (enums < 0.2) node.enumPicks = { e: some(ENUM, 0.6) };
    else if (enums < 0.35) node.enumOmits = { e: [pick(ENUM)] };
  };

  const firstNode = (model: string, depth: number, onPath: boolean): ModelNarrowing => {
    const node: ModelNarrowing = {};
    selection(node, model);
    if (rnd() < 0.5) node.where = cond(model, 2);
    const relations = turnOns(model, onPath ? depth : Math.min(depth, 1));
    if (relations) node.relations = relations;
    return node;
  };

  const firstLayer = (): Layer => {
    const layer: Layer = {};
    if (rnd() < 0.8) layer.root = firstNode('M0', 2, true);
    if (rnd() < 0.6) {
      const models: Record<string, ModelNarrowing> = {};
      for (const m of some(names, 0.5)) models[m] = firstNode(m, 1, false);
      const enums = rnd() < 0.2 ? { E: { omits: [pick(ENUM)] } } : undefined;
      layer.mapDefaults = { app: { models, ...(enums ? { enums } : {}) } };
    }
    return layer;
  };

  // A later layer over `parent`: random narrowings, each kept only if valid there.
  const laterNode = (model: string, depth: number): ModelNarrowing => {
    const node: ModelNarrowing = {};
    selection(node, model);
    if (rnd() < 0.5) node.where = cond(model, 2);
    if (depth > 0) {
      const rels = some(schema[model] as Rel[], 0.4);
      if (rels.length)
        node.relations = Object.fromEntries(
          rels.map((r) => [r.name, laterNode(r.model, depth - 1)]),
        );
    }
    return node;
  };
  const laterLayer = (parent: Lens | LensNarrowing): Layer => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const layer: Layer = {};
      if (rnd() < 0.7) layer.root = laterNode('M0', 2);
      if (rnd() < 0.5) {
        const models: Record<string, ModelNarrowing> = {};
        for (const m of some(names, 0.5)) models[m] = laterNode(m, 1);
        layer.mapDefaults = { app: { models } };
      }
      if (validateNarrowing({ parent, ...layer }).ok) return layer;
    }
    return {};
  };

  const row = (model: string, depth: number): Row => {
    const out: Row = {};
    for (const c of COLS) {
      if (rnd() < 0.15) continue;
      out[c] =
        rnd() < 0.15
          ? null
          : c === 'id'
            ? pick(['i0', 'i1', 'i2', 'i3'])
            : c === 'n'
              ? Math.floor(rnd() * 4) - 1
              : c === 'e'
                ? pick(ENUM)
                : pick(['p', 'q']);
    }
    if (depth > 0)
      for (const r of schema[model] as Rel[]) {
        if (rnd() < 0.2) continue;
        out[r.name] = r.isList
          ? Array.from({ length: Math.floor(rnd() * 3) }, () => row(r.model, depth - 1))
          : rnd() < 0.2
            ? null
            : row(r.model, depth - 1);
      }
    return out;
  };

  const layer1 = firstLayer();
  let chain: LensNarrowing = { parent: lens, ...layer1 };
  if (!validateNarrowing(chain).ok) return null;
  const layers: Layer[] = [layer1];
  const depth = rnd() < 0.5 ? 2 : 3;
  for (let i = 1; i < depth; i++) {
    const next = laterLayer(chain);
    layers.push(next);
    chain = { parent: chain, ...next };
  }
  const rows = Array.from({ length: 6 }, () => row('M0', 3));
  const rules = Array.from({ length: 8 }, () => cond('M0', 2));
  return { lens, layers, chain, rows, rules };
};

const outcome = (fn: () => unknown): unknown => {
  try {
    return { value: fn() };
  } catch (error) {
    return { threw: error instanceof LensRefusal ? 'LensRefusal' : 'Error' };
  }
};

const CASES = 3000;

test(`joinNarrowings refuses or matches the chain on every posture (${CASES} seeded cases)`, () => {
  const tally = {
    later: 0,
    joined: 0,
    refused: {} as Record<string, number>,
    skipped: 0,
    rules: 0,
  };
  for (let seed = 1; seed <= CASES; seed++) {
    const c = run(seed);
    if (!c) {
      tally.skipped++;
      continue;
    }
    if (c.layers.slice(1).some((layer) => Object.keys(layer).length)) tally.later++;
    let body: Layer;
    try {
      body = joinNarrowings(c.lens, c.layers);
    } catch (error) {
      if (!(error instanceof LensRefusal)) throw error;
      tally.refused[error.code] = (tally.refused[error.code] ?? 0) + 1;
      continue;
    }
    tally.joined++;
    const joined: LensNarrowing = { parent: c.lens, ...body };
    const at = `seed ${seed}`;
    expect([at, validateNarrowing(joined).errors]).toEqual([at, []]);
    // Deterministic, idempotent, and associative over the left fold.
    expect(JSON.stringify(joinNarrowings(c.lens, c.layers))).toBe(JSON.stringify(body));
    expect(JSON.stringify(joinNarrowings(c.lens, [body]))).toBe(JSON.stringify(body));
    if (c.layers.length === 3) {
      const ab = joinNarrowings(c.lens, c.layers.slice(0, 2));
      expect([at, JSON.stringify(joinNarrowings(c.lens, [ab, c.layers[2] as Layer]))]).toEqual([
        at,
        JSON.stringify(body),
      ]);
    }
    for (const keepClampColumns of [false, true])
      expect([
        at,
        keepClampColumns,
        outcome(() => projectRows(c.chain, c.rows, { keepClampColumns })),
      ]).toEqual([
        at,
        keepClampColumns,
        outcome(() => projectRows(joined, c.rows, { keepClampColumns })),
      ]);
    for (const rule of c.rules) {
      const gate = validateRuleInLens(rule, c.chain).ok;
      expect([at, rule, gate]).toEqual([at, rule, validateRuleInLens(rule, joined).ok]);
      if (!gate) continue;
      tally.rules++;
      const viaChain = outcome(() => narrowRule(rule, c.chain));
      const viaJoined = outcome(() => narrowRule(rule, joined));
      expect([at, rule, 'threw' in (viaChain as object)]).toEqual([
        at,
        rule,
        'threw' in (viaJoined as object),
      ]);
      if ('threw' in (viaChain as object)) continue;
      const a = (viaChain as { value: Condition }).value;
      const b = (viaJoined as { value: Condition }).value;
      for (const r of c.rows)
        expect([at, rule, r, outcome(() => check(a, r) === true)]).toEqual([
          at,
          rule,
          r,
          outcome(() => check(b, r) === true),
        ]);
    }
  }
  console.log(JSON.stringify(tally));
  expect(tally.joined).toBeGreaterThan(CASES / 3);
});
