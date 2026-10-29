// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Omni names a column ${view.dimension}, as plain text.
import { describe, expect, it } from 'bun:test';
import type { Condition, FieldMapSet, Lens, LensNarrowing } from '../index';
import {
  DateOperator,
  engineGlobals,
  Operator,
  SqlDialect,
  toLensWhereSql,
  toWhereSql,
} from '../index';

const maps: FieldMapSet['maps'] = {
  app: {
    models: {
      BrandReferenceRequest: {
        fields: {
          id: { kind: 'scalar', type: 'Int' },
          status: { kind: 'scalar', type: 'String' },
          score: { kind: 'scalar', type: 'Int' },
          num: { kind: 'scalar', type: 'Float' },
          active: { kind: 'scalar', type: 'Boolean' },
          createdAt: { kind: 'scalar', type: 'DateTime' },
          deletedAt: { kind: 'scalar', type: 'DateTime' },
          meta: { kind: 'scalar', type: 'Json' },
          tags: { kind: 'scalar', type: 'String', isList: true },
          toString: { kind: 'scalar' as const, type: 'String' },
          brandReferenceRequestFanUsers: {
            kind: 'object',
            type: 'BrandReferenceRequestFanUser',
            isList: true,
            relationName: 'RequestFanUsers',
            fromFields: [],
            toFields: [],
          },
        },
      },
      BrandReferenceRequestFanUser: {
        fields: {
          id: { kind: 'scalar', type: 'Int' },
          affiliation: { kind: 'enum', type: 'Affiliation' },
          requestId: { kind: 'scalar', type: 'Int' },
          request: {
            kind: 'object',
            type: 'BrandReferenceRequest',
            relationName: 'RequestFanUsers',
            fromFields: ['requestId'],
            toFields: ['id'],
          },
        },
      },
    },
    enums: { Affiliation: ['advocate', 'prospect', 'consultant'] },
  },
};

const lens: Lens = { maps, mapName: 'app', model: 'BrandReferenceRequest' };
const set = { map: { maps }, mapName: 'app' };
const request = { ...set, model: 'BrandReferenceRequest' };
const participant = { ...set, model: 'BrandReferenceRequestFanUser' };
const affiliation = '${brand_reference_request_fan_user.affiliation}';

const onMysql = <T>(fn: () => T): T =>
  engineGlobals.with({ sql: { dialect: SqlDialect.mysql } }, fn);

/** A rule on the request's `status`, read as column `c`, under the MySQL dialect. */
const mysql = (condition: Condition, columns: Record<string, string> = { status: 'c' }) =>
  onMysql(() => toWhereSql(condition, { columns, ...request }));

describe('SqlDialect', () => {
  it('names the SQL dialects, shared by every SQL-writing function', () => {
    expect(SqlDialect).toEqual({ postgres: 'postgres', mysql: 'mysql' });
  });

  it('is an engine global that defaults to postgres', () => {
    expect(engineGlobals.get('sql.dialect')).toBe(SqlDialect.postgres);
  });

  it('refuses a dialect the engine does not know', () => {
    expect(() =>
      engineGlobals.with({ sql: { dialect: 'oracle' as never } }, () =>
        toWhereSql(true, { columns: {}, ...request }),
      ),
    ).toThrow("sql.dialect 'oracle'");
  });
});

describe('toWhereSql — MySQL forms', () => {
  it('writes equals against the caller column, value inline, no joins', () => {
    expect(
      onMysql(() =>
        toWhereSql(
          { field: 'affiliation', operator: Operator.equals, value: 'advocate' },
          { columns: { affiliation }, ...participant },
        ),
      ),
    ).toBe(`${affiliation} = 'advocate'`);
  });

  it('writes in as IN (…) and keeps NULL rows on negations', () => {
    expect(mysql({ field: 'status', operator: Operator.in, value: ['a', 'b'] })).toBe(
      "c IN ('a', 'b')",
    );
    expect(mysql({ field: 'status', operator: Operator.notIn, value: ['a', 'b'] })).toBe(
      "(c NOT IN ('a', 'b') OR c IS NULL)",
    );
    expect(mysql({ field: 'status', operator: Operator.notEquals, value: 'a' })).toBe(
      "(c <> 'a' OR c IS NULL)",
    );
  });

  it('reads a null member and an empty list as check() does', () => {
    expect(mysql({ field: 'status', operator: Operator.in, value: ['a', null] })).toBe(
      "(c IN ('a') OR c IS NULL)",
    );
    expect(mysql({ field: 'status', operator: Operator.notIn, value: ['a', null] })).toBe(
      "(c NOT IN ('a') AND c IS NOT NULL)",
    );
    expect(mysql({ field: 'status', operator: Operator.in, value: [] })).toBe('FALSE');
    expect(mysql({ field: 'status', operator: Operator.notIn, value: [] })).toBe('TRUE');
    expect(mysql({ field: 'status', operator: Operator.equals, value: null })).toBe('c IS NULL');
    expect(mysql({ field: 'status', operator: Operator.notEquals, value: null })).toBe(
      'c IS NOT NULL',
    );
  });

  it('writes numbers and booleans as literals', () => {
    const columns = { num: 'c', active: 'c' };
    expect(mysql({ field: 'num', operator: Operator.in, value: [1, 2.5] }, columns)).toBe(
      'c IN (1, 2.5)',
    );
    expect(mysql({ field: 'active', operator: Operator.equals, value: true }, columns)).toBe(
      'c = TRUE',
    );
  });

  it('writes no ::text cast on an enum', () => {
    const sql = onMysql(() =>
      toWhereSql(
        { field: 'affiliation', operator: Operator.in, value: ['advocate', 'consultant'] },
        { columns: { affiliation }, ...participant },
      ),
    );
    expect(sql).toBe(`${affiliation} IN ('advocate', 'consultant')`);
  });

  it('escapes backslash and single quote', () => {
    expect(mysql({ field: 'status', operator: Operator.equals, value: "O'Brien \\ x\\'" })).toBe(
      "c = 'O''Brien \\\\ x\\\\'''",
    );
  });

  it('composes all / any and the boolean conditions', () => {
    expect(
      mysql({
        any: [
          { field: 'status', operator: Operator.exists },
          { all: [{ field: 'status', operator: Operator.notExists }, true] },
        ],
      }),
    ).toBe('(c IS NOT NULL OR (c IS NULL AND TRUE))');
    expect(mysql({ all: [] })).toBe('TRUE');
    expect(mysql({ any: [] })).toBe('FALSE');
  });

  it('reads a to-one relation’s existence from columns[<rel>.<key>]', () => {
    const options = { columns: { 'request.id': '${brand_reference_request.id}' }, ...participant };
    expect(
      onMysql(() => toWhereSql({ field: 'request', operator: Operator.exists }, options)),
    ).toBe('${brand_reference_request.id} IS NOT NULL');
    expect(
      onMysql(() => toWhereSql({ field: 'request', operator: Operator.notExists }, options)),
    ).toBe('${brand_reference_request.id} IS NULL');
    expect(() =>
      onMysql(() =>
        toWhereSql({ field: 'request', operator: Operator.equals, value: 'x' }, options),
      ),
    ).toThrow("'request' is a relation");
  });

  it('reads a path through a to-one relation from columns as written', () => {
    expect(
      onMysql(() =>
        toWhereSql(
          { field: 'request.status', operator: Operator.equals, value: 'open' },
          { columns: { 'request.status': 'r.status' }, ...participant },
        ),
      ),
    ).toBe("r.status = 'open'");
  });
});

describe('toWhereSql — the Postgres default', () => {
  it('writes the same predicate, escaping only the quote', () => {
    expect(
      toWhereSql(
        { field: 'status', operator: Operator.equals, value: "O'Brien \\ x" },
        { columns: { status: 'c' }, ...request },
      ),
    ).toBe("c = 'O''Brien \\ x'");
    expect(
      toWhereSql(
        { field: 'status', operator: Operator.notIn, value: ['a', 'b'] },
        { columns: { status: 'c' }, ...request },
      ),
    ).toBe("(c NOT IN ('a', 'b') OR c IS NULL)");
  });
});

describe('toWhereSql — existence on every column', () => {
  const columns = {
    deletedAt: '${brand_reference_request.deleted_at}',
    meta: 'm',
    tags: 't',
    'brandReferenceRequestFanUsers.id': 'x',
  };

  it('writes a DateTime’s existence: the lens soft-delete where', () => {
    expect(mysql({ field: 'deletedAt', operator: Operator.notExists }, columns)).toBe(
      '${brand_reference_request.deleted_at} IS NULL',
    );
    expect(mysql({ field: 'deletedAt', operator: Operator.exists }, columns)).toBe(
      '${brand_reference_request.deleted_at} IS NOT NULL',
    );
    expect(mysql({ field: 'deletedAt', operator: Operator.equals, value: null }, columns)).toBe(
      '${brand_reference_request.deleted_at} IS NULL',
    );
  });

  it('writes a list’s existence, and refuses a Json column’s: a JSON null is not a SQL NULL', () => {
    expect(mysql({ field: 'tags', operator: Operator.notExists }, columns)).toBe('t IS NULL');
    expect(() => mysql({ field: 'meta', operator: Operator.exists }, columns)).toThrow(
      "the Json value 'meta'",
    );
    expect(() => mysql({ field: 'meta', operator: Operator.notExists }, columns)).toThrow(
      "the Json value 'meta'",
    );
  });

  it('throws for a rule with no value, as check() does, instead of a NULL test', () => {
    for (const operator of [Operator.equals, Operator.notEquals, Operator.in, Operator.notIn])
      expect(() => mysql({ field: 'status', operator } as Condition)).toThrow(
        'No value, path or bind specified',
      );
  });

  it('still refuses a value compare on a date, Json or list, and any to-many hop', () => {
    expect(() =>
      mysql({ field: 'deletedAt', operator: Operator.equals, value: '2026-01-01' }, columns),
    ).toThrow("the date 'deletedAt'");
    expect(() => mysql({ field: 'meta', operator: Operator.equals, value: 'x' }, columns)).toThrow(
      "the Json value 'meta'",
    );
    expect(() => mysql({ field: 'tags', operator: Operator.in, value: ['x'] }, columns)).toThrow(
      "the list 'tags'",
    );
    expect(() =>
      mysql({ field: 'brandReferenceRequestFanUsers', operator: Operator.exists }, columns),
    ).toThrow(
      "'brandReferenceRequestFanUsers' is a to-many relation — its rows take an arrayOperator rule: { field: 'brandReferenceRequestFanUsers', arrayOperator: 'notEmpty' } for a row",
    );
    expect(() =>
      mysql(
        { field: 'brandReferenceRequestFanUsers.id', operator: Operator.equals, value: 1 },
        columns,
      ),
    ).toThrow('to-many');
    expect(() => mysql({ field: 'meta.a', operator: Operator.exists }, { 'meta.a': 'x' })).toThrow(
      "the Json value 'meta.a'",
    );
  });
});

describe('toWhereSql — a value of another type is refused, not cast', () => {
  const columns = { score: 'c', active: 'c', status: 'c', affiliation: 'c' };

  it('refuses a boolean on an Int and a number on a Boolean', () => {
    expect(() =>
      mysql({ field: 'score', operator: Operator.equals, value: true }, columns),
    ).toThrow("value true does not fit Int field 'score'");
    expect(() =>
      mysql({ field: 'score', operator: Operator.in, value: [1, true] }, columns),
    ).toThrow("value true does not fit Int field 'score'");
    expect(() => mysql({ field: 'active', operator: Operator.in, value: [1] }, columns)).toThrow(
      "value 1 does not fit Boolean field 'active'",
    );
  });

  it('refuses a number on an enum and on a String', () => {
    expect(() =>
      onMysql(() =>
        toWhereSql(
          { field: 'affiliation', operator: Operator.equals, value: 1 },
          { columns, ...participant },
        ),
      ),
    ).toThrow("value 1 does not fit Enum field 'affiliation'");
    expect(() => mysql({ field: 'status', operator: Operator.equals, value: 0 }, columns)).toThrow(
      "value 0 does not fit String field 'status'",
    );
  });
});

describe('toWhereSql — refusals', () => {
  it('requires the map and the model, and a model the map declares', () => {
    expect(() => toWhereSql(true, { columns: {} } as never)).toThrow(
      'toWhereSql: `map` and `model` are required',
    );
    expect(() => toWhereSql(true, { columns: {}, ...set } as never)).toThrow(
      'toWhereSql: `map` and `model` are required',
    );
    expect(() => toWhereSql(true, { columns: {}, ...set, model: 'Nope' })).toThrow(
      "toWhereSql: the map has no model 'Nope'",
    );
  });

  it('names itself in the map errors', () => {
    expect(() => toWhereSql(true, { columns: {}, map: { maps }, model: 'X' })).toThrow(
      "toWhereSql: 'map' is a FieldMapSet",
    );
  });

  it('throws for a path missing from columns, naming it', () => {
    expect(() => mysql({ field: 'score', operator: Operator.equals, value: 1 })).toThrow(
      "no column for 'score'",
    );
    // An inherited key is not a column.
    expect(() => mysql({ field: 'toString', operator: Operator.exists })).toThrow(
      "no column for 'toString'",
    );
  });

  it('refuses a path the map does not declare', () => {
    expect(() => mysql({ field: 'other', operator: Operator.equals, value: 'a' })).toThrow(
      "'other' is not a field the map declares on BrandReferenceRequest",
    );
  });

  it('throws for each operator outside the set, naming it', () => {
    for (const operator of [
      Operator.contains,
      Operator.notContains,
      Operator.startsWith,
      Operator.endsWith,
      Operator.matches,
      Operator.notMatches,
      Operator.lessThan,
      Operator.greaterThan,
      Operator.between,
      Operator.isEmpty,
    ])
      expect(() => mysql({ field: 'status', operator, value: 'a' } as Condition)).toThrow(
        `operator '${operator}'`,
      );
    expect(() =>
      mysql({ field: 'createdAt', dateOperator: DateOperator.before, value: '2026-01-01' }),
    ).toThrow("dateOperator 'before'");
    expect(() =>
      mysql({ field: 'status', arrayOperator: 'any', condition: true } as Condition),
    ).toThrow("arrayOperator 'any'");
    expect(() =>
      mysql({ if: true, then: { field: 'status', operator: Operator.exists } } as Condition),
    ).toThrow('if / then / else');
  });

  it('refuses binds, column paths, case-insensitivity and offsets', () => {
    expect(() => mysql({ field: 'status', operator: Operator.equals, bind: 'x' })).toThrow(
      "bind 'x'",
    );
    expect(() => mysql({ field: 'status', operator: Operator.equals, path: 'other' })).toThrow(
      "the column 'other'",
    );
    expect(() =>
      mysql({ field: 'status', operator: Operator.equals, value: 'a', caseInsensitive: true }),
    ).toThrow('case-insensitive');
  });
});

/** Orders whose lines carry notes: a composite key, and a to-many relation below a to-many one. */
const orders: FieldMapSet['maps'] = {
  app: {
    models: {
      Order: {
        fields: {
          tenantId: { kind: 'scalar', type: 'Int' },
          id: { kind: 'scalar', type: 'Int' },
          lines: { kind: 'object', type: 'Line', isList: true, relationName: 'OrderLines' },
        },
      },
      Line: {
        fields: {
          tenantId: { kind: 'scalar', type: 'Int' },
          id: { kind: 'scalar', type: 'Int' },
          orderId: { kind: 'scalar', type: 'Int' },
          sku: { kind: 'scalar', type: 'String' },
          order: {
            kind: 'object',
            type: 'Order',
            relationName: 'OrderLines',
            fromFields: ['tenantId', 'orderId'],
            toFields: ['tenantId', 'id'],
          },
          notes: { kind: 'object', type: 'Note', isList: true, relationName: 'LineNotes' },
        },
      },
      Note: {
        fields: {
          lineId: { kind: 'scalar', type: 'Int' },
          text: { kind: 'scalar', type: 'String' },
          line: {
            kind: 'object',
            type: 'Line',
            relationName: 'LineNotes',
            fromFields: ['lineId'],
            toFields: ['id'],
          },
        },
      },
    },
  },
};

describe('toWhereSql — an array rule on a to-many relation', () => {
  const columns = {
    id: 'r.id',
    status: 'r.status',
    'brandReferenceRequestFanUsers.id': 'p.id',
    'brandReferenceRequestFanUsers.requestId': 'p.request_id',
    'brandReferenceRequestFanUsers.affiliation': 'p.affiliation',
  };
  const tables = { brandReferenceRequestFanUsers: 'brand_reference_request_fan_user AS p' };
  const over = (arrayOperator: string, condition?: Condition, extra = {}): Condition =>
    ({ field: 'brandReferenceRequestFanUsers', arrayOperator, condition, ...extra }) as Condition;
  const advocate: Condition = {
    field: 'affiliation',
    operator: Operator.equals,
    value: 'advocate',
  };
  const write = (condition: Condition, given: Partial<typeof request> = {}) =>
    onMysql(() => toWhereSql(condition, { columns, tables, ...request, ...given }));
  const rows = 'SELECT 1 FROM brand_reference_request_fan_user AS p WHERE p.request_id = r.id';

  it('writes any, none, all, empty and notEmpty as one subquery each, keyed to the row', () => {
    expect(write(over('any', advocate))).toBe(`EXISTS (${rows} AND (p.affiliation = 'advocate'))`);
    expect(write(over('none', advocate))).toBe(
      `NOT EXISTS (${rows} AND (p.affiliation = 'advocate'))`,
    );
    // A NULL result fails `all`, as in check().
    expect(write(over('all', advocate))).toBe(
      `NOT EXISTS (${rows} AND (p.affiliation = 'advocate') IS NOT TRUE)`,
    );
    expect(write(over('empty'))).toBe(`NOT EXISTS (${rows})`);
    expect(write(over('notEmpty'))).toBe(`EXISTS (${rows})`);
  });

  it('compiles the condition with the same operators and NULL rules, beside the row', () => {
    expect(
      write({
        all: [
          { field: 'status', operator: Operator.notEquals, value: 'draft' },
          over('any', {
            any: [
              { field: 'affiliation', operator: Operator.notIn, value: ['prospect'] },
              { field: 'id', operator: Operator.notExists },
            ],
          }),
        ],
      }),
    ).toBe(
      `((r.status <> 'draft' OR r.status IS NULL) AND EXISTS (${rows} AND (((p.affiliation NOT IN ('prospect') OR p.affiliation IS NULL) OR p.id IS NULL))))`,
    );
  });

  it('ANDs every pair of a composite key, and nests a relation of the related rows', () => {
    const sql = onMysql(() =>
      toWhereSql(
        {
          field: 'lines',
          arrayOperator: 'any',
          condition: {
            all: [
              { field: 'sku', operator: Operator.equals, value: 'x' },
              {
                field: 'notes',
                arrayOperator: 'none',
                condition: { field: 'text', operator: Operator.exists },
              },
            ],
          },
        } as Condition,
        {
          columns: {
            tenantId: 'o.tenant_id',
            id: 'o.id',
            'lines.tenantId': 'l.tenant_id',
            'lines.id': 'l.id',
            'lines.orderId': 'l.order_id',
            'lines.sku': 'l.sku',
            'lines.notes.lineId': 'n.line_id',
            'lines.notes.text': 'n.text',
          },
          tables: { lines: 'line AS l', 'lines.notes': 'note AS n' },
          map: { maps: orders },
          mapName: 'app',
          model: 'Order',
        },
      ),
    );
    expect(sql).toBe(
      "EXISTS (SELECT 1 FROM line AS l WHERE l.tenant_id = o.tenant_id AND l.order_id = o.id AND ((l.sku = 'x' AND NOT EXISTS (SELECT 1 FROM note AS n WHERE n.line_id = l.id AND (n.text IS NOT NULL)))))",
    );
  });

  it('refuses the array rules it has no form for, naming each', () => {
    for (const operator of ['atLeast', 'atMost', 'exactly'])
      expect(() => write(over(operator, advocate, { count: 1 }))).toThrow(
        `arrayOperator '${operator}'`,
      );
    expect(() => write(over('any', advocate, { take: 1 }))).toThrow('a window');
    expect(() => write(over('all', advocate, { filter: advocate }))).toThrow('a window');
    expect(() => write({ arrayOperator: 'any', condition: advocate } as Condition)).toThrow(
      "the fieldless arrayOperator 'any'",
    );
    expect(() => write(over('any'))).toThrow('any requires a condition');
    // An inner condition is refused as the outer one would be.
    expect(() =>
      write(over('any', { field: 'affiliation', operator: Operator.contains, value: 'a' })),
    ).toThrow("operator 'contains'");
  });

  it('refuses an array rule on anything but a to-many relation directly on the model', () => {
    expect(() =>
      write({ ...(over('any', advocate) as object), field: 'tags' } as Condition),
    ).toThrow("arrayOperator 'any' on 'tags', which is not a to-many relation");
    expect(() =>
      write({ ...(over('any', advocate) as object), field: 'nope' } as Condition),
    ).toThrow("'nope' is not a field the map declares on BrandReferenceRequest");
    const fromParticipant = (field: string) =>
      onMysql(() =>
        toWhereSql({ field, arrayOperator: 'any', condition: advocate } as Condition, {
          columns: {},
          tables: {},
          ...participant,
        }),
      );
    expect(() => fromParticipant('request')).toThrow(
      "arrayOperator 'any' on 'request', which is not a to-many relation",
    );
    expect(() => fromParticipant('request.brandReferenceRequestFanUsers')).toThrow(
      "arrayOperator 'any' on 'request.brandReferenceRequestFanUsers', behind the relation 'request'",
    );
  });

  it('throws for a relation missing from tables, naming it', () => {
    expect(() => write(over('any', advocate), { tables: {} } as never)).toThrow(
      "no table for 'brandReferenceRequestFanUsers' in `tables`",
    );
  });
});

describe('toLensWhereSql — an array rule on a to-many relation', () => {
  const advocate: Condition = {
    field: 'affiliation',
    operator: Operator.equals,
    value: 'advocate',
  };
  const columns = {
    id: 'r.id',
    'brandReferenceRequestFanUsers.id': 'p.id',
    'brandReferenceRequestFanUsers.requestId': 'p.request_id',
    'brandReferenceRequestFanUsers.affiliation': 'p.affiliation',
    'brandReferenceRequestFanUsers.request.id': 'pr.id',
    'BrandReferenceRequestFanUser.id': 'p.id',
  };
  const tables = { brandReferenceRequestFanUsers: 'brand_reference_request_fan_user AS p' };

  it("carries the relation's clamps from the layer above inside its subquery, and still reports them", () => {
    const clamped: LensNarrowing = {
      parent: lens,
      root: {
        relations: {
          brandReferenceRequestFanUsers: {
            where: { field: 'affiliation', operator: Operator.exists },
          },
        },
      },
      mapDefaults: {
        app: {
          models: {
            BrandReferenceRequestFanUser: { where: { field: 'id', operator: Operator.exists } },
          },
        },
      },
    };
    const narrowing: LensNarrowing = {
      parent: clamped,
      root: {
        where: {
          field: 'brandReferenceRequestFanUsers',
          arrayOperator: 'none',
          condition: advocate,
        } as Condition,
      },
    };
    expect(onMysql(() => toLensWhereSql(narrowing, { columns, tables }))).toEqual({
      root: "NOT EXISTS (SELECT 1 FROM brand_reference_request_fan_user AS p WHERE p.request_id = r.id AND (p.affiliation IS NOT NULL) AND (p.id IS NOT NULL) AND (p.affiliation = 'advocate'))",
      relations: { brandReferenceRequestFanUsers: 'p.affiliation IS NOT NULL' },
      mapDefaults: { app: { models: { BrandReferenceRequestFanUser: 'p.id IS NOT NULL' } } },
    });
  });

  it("reads a clamp's own relations through the layers above the clamp's", () => {
    // The Line default (layer 0) reads its notes; the Note default comes a layer later, so it
    // narrows the where of layer 2 only where that where reads notes itself.
    const lineDefault: LensNarrowing = {
      parent: { maps: orders, mapName: 'app', model: 'Order' },
      root: { relations: { lines: { relations: { notes: {} } } } },
      mapDefaults: {
        app: {
          models: { Line: { where: { field: 'notes', arrayOperator: 'notEmpty' } as Condition } },
        },
      },
    };
    const noteDefault: LensNarrowing = {
      parent: lineDefault,
      mapDefaults: {
        app: { models: { Note: { where: { field: 'text', operator: Operator.exists } } } },
      },
    };
    const narrowing: LensNarrowing = {
      parent: noteDefault,
      root: {
        where: {
          field: 'lines',
          arrayOperator: 'any',
          condition: { field: 'sku', operator: Operator.equals, value: 'x' },
        } as Condition,
      },
    };
    expect(
      onMysql(() =>
        toLensWhereSql(narrowing, {
          columns: {
            tenantId: 'o.tenant_id',
            id: 'o.id',
            'lines.tenantId': 'l.tenant_id',
            'lines.orderId': 'l.order_id',
            'lines.id': 'l.id',
            'lines.sku': 'l.sku',
            'lines.notes.lineId': 'n.line_id',
            'Line.id': 'l.id',
            'Line.notes.lineId': 'n.line_id',
            'Note.text': 'n.text',
          },
          tables: { lines: 'line AS l', 'lines.notes': 'note AS n', 'Line.notes': 'note AS n' },
        }),
      ).root,
    ).toBe(
      "EXISTS (SELECT 1 FROM line AS l WHERE l.tenant_id = o.tenant_id AND l.order_id = o.id AND (EXISTS (SELECT 1 FROM note AS n WHERE n.line_id = l.id)) AND (l.sku = 'x'))",
    );
  });

  it('refuses an array rule on a relation the lens hides', () => {
    const hidden: LensNarrowing = {
      parent: lens,
      root: {
        where: {
          field: 'brandReferenceRequestFanUsers',
          arrayOperator: 'any',
          condition: advocate,
        } as Condition,
      },
    };
    expect(() => toLensWhereSql(hidden, { columns, tables })).toThrow(
      "'brandReferenceRequestFanUsers' at the root crosses 'brandReferenceRequestFanUsers', a relation the lens hides",
    );
  });

  it("checks an array rule's condition from the relation's rows", () => {
    const readsRequest = (relations: LensNarrowing['root']): LensNarrowing => ({
      parent: lens,
      root: {
        ...relations,
        where: {
          field: 'brandReferenceRequestFanUsers',
          arrayOperator: 'any',
          condition: { field: 'request', operator: Operator.exists },
        } as Condition,
      },
    });
    // `request` is a relation of the participant, not of the request: it is shown or hidden there.
    expect(() =>
      toLensWhereSql(readsRequest({ relations: { brandReferenceRequestFanUsers: {} } }), {
        columns,
        tables,
      }),
    ).toThrow("'request' at 'brandReferenceRequestFanUsers' crosses 'request'");
    expect(
      toLensWhereSql(
        readsRequest({
          relations: { brandReferenceRequestFanUsers: { relations: { request: {} } } },
        }),
        { columns, tables },
      ).root,
    ).toBe(
      'EXISTS (SELECT 1 FROM brand_reference_request_fan_user AS p WHERE p.request_id = r.id AND (pr.id IS NOT NULL))',
    );
  });

  it('reads a relation path where by its path, and refuses a model default whose clamps differ by path', () => {
    // Anchored at the participant, the request is reached twice: at `request`, and again below
    // the participants of that request, where a parent layer clamps the participants.
    const participantLens: Lens = { maps, mapName: 'app', model: 'BrandReferenceRequestFanUser' };
    const twoPaths: LensNarrowing = {
      parent: participantLens,
      root: {
        relations: {
          request: {
            relations: {
              brandReferenceRequestFanUsers: {
                where: advocate,
                relations: { request: { relations: { brandReferenceRequestFanUsers: {} } } },
              },
            },
          },
        },
      },
    };
    const anyParticipant = {
      field: 'brandReferenceRequestFanUsers',
      arrayOperator: 'notEmpty',
    } as Condition;
    const asPath: LensNarrowing = {
      parent: twoPaths,
      root: { relations: { request: { where: anyParticipant } } },
    };
    const sqlOf = toLensWhereSql(asPath, {
      columns: {
        'request.id': 'r.id',
        'request.brandReferenceRequestFanUsers.requestId': 'p.request_id',
        'request.brandReferenceRequestFanUsers.affiliation': 'p.affiliation',
      },
      tables: { 'request.brandReferenceRequestFanUsers': 'brand_reference_request_fan_user AS p' },
    });
    expect(sqlOf.relations.request).toBe(
      "EXISTS (SELECT 1 FROM brand_reference_request_fan_user AS p WHERE p.request_id = r.id AND (p.affiliation = 'advocate'))",
    );
    const asDefault: LensNarrowing = {
      parent: twoPaths,
      mapDefaults: { app: { models: { BrandReferenceRequest: { where: anyParticipant } } } },
    };
    expect(() =>
      toLensWhereSql(asDefault, {
        columns: {
          'BrandReferenceRequest.id': 'r.id',
          'BrandReferenceRequest.brandReferenceRequestFanUsers.requestId': 'p.request_id',
          'BrandReferenceRequest.brandReferenceRequestFanUsers.affiliation': 'p.affiliation',
          'request.brandReferenceRequestFanUsers.affiliation': 'p.affiliation',
        },
        tables: {
          'BrandReferenceRequest.brandReferenceRequestFanUsers':
            'brand_reference_request_fan_user AS p',
        },
      }),
    ).toThrow(
      'the default where of BrandReferenceRequest reads a to-many relation whose clamps differ between the paths',
    );
  });
});

describe("toLensWhereSql — toMany: 'join' reads the row the caller's join brings", () => {
  const participants = 'brandReferenceRequestFanUsers';
  const advocate: Condition = {
    field: 'affiliation',
    operator: Operator.equals,
    value: 'advocate',
  };
  const over = (arrayOperator: string, condition?: Condition, extra = {}): Condition =>
    ({ field: participants, arrayOperator, condition, ...extra }) as Condition;
  const columns = {
    id: 'r.id',
    status: 'r.status',
    deletedAt: 'r.deleted_at',
    'brandReferenceRequestFanUsers.id': 'p.id',
    'brandReferenceRequestFanUsers.requestId': 'p.request_id',
    'brandReferenceRequestFanUsers.affiliation': 'p.affiliation',
    'BrandReferenceRequestFanUser.id': 'p.id',
  };
  const tables = { brandReferenceRequestFanUsers: 'brand_reference_request_fan_user AS p' };
  const idExists: Condition = { field: 'id', operator: Operator.exists };
  /** Layer 1: the participants turned on, clamped along the path and by their model's default. */
  const clamped: LensNarrowing = {
    parent: lens,
    root: { relations: { brandReferenceRequestFanUsers: { where: advocate } } },
    mapDefaults: { app: { models: { BrandReferenceRequestFanUser: { where: idExists } } } },
  };
  /** Layer 2 under `parent`: a root where. */
  const reads = (where: Condition, parent: LensNarrowing = clamped): LensNarrowing => ({
    parent,
    root: { where },
  });
  const join = (narrowing: LensNarrowing, given: Record<string, string> = columns) =>
    onMysql(() => toLensWhereSql(narrowing, { columns: given, toMany: 'join' }));

  it('writes notEmpty as the joined key IS NOT NULL, the clamps a layer above in the ON', () => {
    // The Omni shape: the topic LEFT JOINs the participants ON their keys AND `relations[path]`
    // AND the participant's default. No `tables`: join mode reads none.
    const omni = {
      deletedAt: '${brand_reference_request.deleted_at}',
      'brandReferenceRequestFanUsers.requestId': '${brand_reference_request_fan_user.request_id}',
      'brandReferenceRequestFanUsers.affiliation': affiliation,
      'BrandReferenceRequestFanUser.id': '${brand_reference_request_fan_user.id}',
    };
    const narrowing = reads({
      all: [{ field: 'deletedAt', operator: Operator.notExists }, over('notEmpty')],
    });
    expect(join(narrowing, omni)).toEqual({
      root: '(${brand_reference_request.deleted_at} IS NULL AND ${brand_reference_request_fan_user.request_id} IS NOT NULL)',
      relations: { brandReferenceRequestFanUsers: `${affiliation} = 'advocate'` },
      mapDefaults: {
        app: {
          models: {
            BrandReferenceRequestFanUser: '${brand_reference_request_fan_user.id} IS NOT NULL',
          },
        },
      },
    });
  });

  it('writes any as the key IS NOT NULL and its condition on the joined columns, a negation too', () => {
    expect(join(reads(over('any', { all: [advocate, idExists] }))).root).toBe(
      "(p.request_id IS NOT NULL AND (p.affiliation = 'advocate' AND p.id IS NOT NULL))",
    );
    // The guard has dropped the all-NULL row of a parent with no participant, so the condition
    // inside may hold on a missing value.
    expect(
      join(
        reads(over('any', { field: 'affiliation', operator: Operator.notIn, value: ['prospect'] })),
      ).root,
    ).toBe(
      "(p.request_id IS NOT NULL AND (p.affiliation NOT IN ('prospect') OR p.affiliation IS NULL))",
    );
    expect(join(reads({ all: [over('notEmpty'), over('any', advocate)] })).root).toBe(
      "(p.request_id IS NOT NULL AND (p.request_id IS NOT NULL AND p.affiliation = 'advocate'))",
    );
  });

  it('keeps the subquery by default, and refuses a mode it does not know', () => {
    const narrowing = reads(over('notEmpty'));
    const subquery =
      "EXISTS (SELECT 1 FROM brand_reference_request_fan_user AS p WHERE p.request_id = r.id AND (p.affiliation = 'advocate') AND (p.id IS NOT NULL))";
    expect(onMysql(() => toLensWhereSql(narrowing, { columns, tables })).root).toBe(subquery);
    expect(
      onMysql(() => toLensWhereSql(narrowing, { columns, tables, toMany: 'subquery' })).root,
    ).toBe(subquery);
    expect(() => toLensWhereSql(narrowing, { columns, toMany: 'joins' as 'join' })).toThrow(
      "toMany 'joins' is neither 'subquery' nor 'join'",
    );
  });

  it('refuses empty, none and all, which hold with no rows, and the counts', () => {
    for (const operator of ['empty', 'none', 'all'])
      expect(() =>
        join(reads(over(operator, operator === 'empty' ? undefined : advocate))),
      ).toThrow(
        `arrayOperator '${operator}' on 'brandReferenceRequestFanUsers', a relation the caller joins, holds when it has no rows — that takes an anti-join, not the topic's join`,
      );
    for (const operator of ['atLeast', 'atMost', 'exactly'])
      expect(() => join(reads(over(operator, advocate, { count: 1 })))).toThrow(
        `arrayOperator '${operator}' has no SQL form here`,
      );
  });

  it('refuses exists / notExists on the joined list and a field read through it: to-many relations keep the arrayOperator spelling', () => {
    // In the first narrowing, which may read the whole schema: a later layer's clamp is refused by
    // the lens before it compiles.
    const first = (where: Condition): LensNarrowing => ({
      parent: lens,
      root: { where, relations: { brandReferenceRequestFanUsers: {} } },
    });
    for (const operator of [Operator.exists, Operator.notExists])
      expect(() => join(first({ field: participants, operator }))).toThrow(
        "'brandReferenceRequestFanUsers' is a to-many relation — its rows take an arrayOperator rule: { field: 'brandReferenceRequestFanUsers', arrayOperator: 'notEmpty' } for a row",
      );
    expect(() =>
      join(
        first({
          field: 'brandReferenceRequestFanUsers.affiliation',
          operator: Operator.equals,
          value: 'advocate',
        }),
      ),
    ).toThrow(
      "reads through the to-many relation 'brandReferenceRequestFanUsers'; compare its rows with an arrayOperator rule",
    );
  });

  it('reads a to-many relation from the root where only: not a model default, not a relation where', () => {
    const asDefault: LensNarrowing = {
      parent: clamped,
      mapDefaults: { app: { models: { BrandReferenceRequest: { where: over('notEmpty') } } } },
    };
    expect(() =>
      join(asDefault, {
        ...columns,
        'BrandReferenceRequest.brandReferenceRequestFanUsers.requestId': 'p.request_id',
      }),
    ).toThrow(
      "the default where of BrandReferenceRequest reads the to-many relation 'brandReferenceRequestFanUsers' — with toMany: 'join' it compiles once for every path that reaches BrandReferenceRequest",
    );
    // A relation's where sits in that relation's ON, which the joins below it come after.
    const participantLens: Lens = { maps, mapName: 'app', model: 'BrandReferenceRequestFanUser' };
    const asRelationWhere: LensNarrowing = {
      parent: participantLens,
      root: {
        relations: {
          request: { where: over('notEmpty'), relations: { brandReferenceRequestFanUsers: {} } },
        },
      },
    };
    expect(() =>
      join(asRelationWhere, {
        'request.brandReferenceRequestFanUsers.requestId': 'p.request_id',
      }),
    ).toThrow(
      "the where at 'request' reads the to-many relation 'brandReferenceRequestFanUsers' — with toMany: 'join' it sits in that relation's join ON, ahead of the joins below it",
    );
  });

  it("refuses a relation read inside a joined any: the joined row's relations have no join here", () => {
    const orderLens: LensNarrowing = {
      parent: { maps: orders, mapName: 'app', model: 'Order' },
      root: { relations: { lines: { relations: { notes: {} } } } },
    };
    expect(() =>
      join(
        reads(
          {
            field: 'lines',
            arrayOperator: 'any',
            condition: { field: 'notes', arrayOperator: 'notEmpty' },
          } as Condition,
          orderLens,
        ),
        { 'lines.tenantId': 'l.tenant_id', 'lines.notes.lineId': 'n.line_id' },
      ),
    ).toThrow("arrayOperator 'notEmpty' on 'notes' inside an any over the joined 'lines'");
    const showsRequest: LensNarrowing = {
      parent: lens,
      root: { relations: { brandReferenceRequestFanUsers: { relations: { request: {} } } } },
    };
    expect(() =>
      join(reads(over('any', { field: 'request', operator: Operator.exists }), showsRequest), {
        ...columns,
        'brandReferenceRequestFanUsers.request.id': 'pr.id',
      }),
    ).toThrow(
      "'request' inside an any over the joined 'brandReferenceRequestFanUsers' reads the relation 'request'",
    );
  });

  it('throws when a clamp in the ON sits in the where’s own layer or a later one, and passes one layer up', () => {
    // check() reads a layer's where through the layers above it only: a same-layer or later clamp
    // in the ON would hide rows the where still counts.
    const sameLayer: LensNarrowing = {
      parent: lens,
      root: {
        where: over('notEmpty'),
        relations: { brandReferenceRequestFanUsers: { where: advocate } },
      },
    };
    expect(() => join(sameLayer)).toThrow(
      "the root where of layer 1 reads 'brandReferenceRequestFanUsers' on the caller's join, whose ON carries a clamp of layer 1 (its where) — check() reads a where through the clamps of the layers above its own only. Move that clamp into a narrowing above layer 1",
    );
    const unclamped: LensNarrowing = {
      parent: lens,
      root: { where: over('notEmpty'), relations: { brandReferenceRequestFanUsers: {} } },
    };
    const laterPath: LensNarrowing = {
      parent: unclamped,
      root: { relations: { brandReferenceRequestFanUsers: { where: advocate } } },
    };
    expect(() => join(laterPath)).toThrow('whose ON carries a clamp of layer 2 (its where)');
    const laterDefault: LensNarrowing = {
      parent: unclamped,
      mapDefaults: { app: { models: { BrandReferenceRequestFanUser: { where: idExists } } } },
    };
    expect(() => join(laterDefault)).toThrow(
      "whose ON carries a clamp of layer 2 (BrandReferenceRequestFanUser's default where)",
    );
    expect(join(reads(over('notEmpty'))).root).toBe('p.request_id IS NOT NULL');
  });

  it('refuses two any rules on one joined relation: one joined row would have to meet both', () => {
    // A request with an advocate and a prospect participant holds `any advocate AND any prospect`
    // in check(); on the join, no one row is both.
    const prospect: Condition = { ...advocate, value: 'prospect' } as Condition;
    const twoAnys = "the root reads 'brandReferenceRequestFanUsers' with two any rules";
    expect(() => join(reads({ all: [over('any', advocate), over('any', prospect)] }))).toThrow(
      twoAnys,
    );
    expect(() => join(reads(over('any', prospect), reads(over('any', advocate))))).toThrow(twoAnys);
    // One any whose condition says which row reads the same thing exactly.
    expect(join(reads(over('any', { any: [advocate, prospect] }))).root).toBe(
      "(p.request_id IS NOT NULL AND (p.affiliation = 'advocate' OR p.affiliation = 'prospect'))",
    );
  });
});

describe('toLensWhereSql — mirrors the lens', () => {
  const participantWhere = { field: 'affiliation', operator: Operator.equals, value: 'advocate' };
  const narrowing: LensNarrowing = {
    parent: lens,
    root: {
      where: {
        all: [
          { field: 'status', operator: Operator.notEquals, value: 'draft' },
          { field: 'deletedAt', operator: Operator.notExists },
        ],
      },
      relations: {
        brandReferenceRequestFanUsers: {
          where: { field: 'id', operator: Operator.exists },
          relations: { request: {} },
        },
      },
    },
    mapDefaults: {
      app: {
        models: {
          BrandReferenceRequest: { where: { field: 'id', operator: Operator.exists } },
          BrandReferenceRequestFanUser: { where: participantWhere },
        },
      },
    },
  };
  const columns = {
    status: '${brand_reference_request.status}',
    deletedAt: '${brand_reference_request.deleted_at}',
    'brandReferenceRequestFanUsers.id': '${brand_reference_request_fan_user.id}',
    'BrandReferenceRequest.id': '${brand_reference_request.id}',
    'BrandReferenceRequestFanUser.affiliation': affiliation,
  };

  it('reports root, relation and mapDefaults wheres each where the lens wrote them', () => {
    expect(onMysql(() => toLensWhereSql(narrowing, { columns }))).toEqual({
      root: "((${brand_reference_request.status} <> 'draft' OR ${brand_reference_request.status} IS NULL) AND ${brand_reference_request.deleted_at} IS NULL)",
      relations: {
        brandReferenceRequestFanUsers: '${brand_reference_request_fan_user.id} IS NOT NULL',
      },
      mapDefaults: {
        app: {
          models: {
            BrandReferenceRequest: '${brand_reference_request.id} IS NOT NULL',
            BrandReferenceRequestFanUser: `${affiliation} = 'advocate'`,
          },
        },
      },
    });
  });

  it('compiles a model default once, however many paths reach the model', () => {
    const twice: LensNarrowing = {
      parent: { maps, mapName: 'app', model: 'BrandReferenceRequestFanUser' },
      root: {
        relations: { request: { relations: { brandReferenceRequestFanUsers: {} } } },
      },
      mapDefaults: {
        app: { models: { BrandReferenceRequestFanUser: { where: participantWhere } } },
      },
    };
    expect(toLensWhereSql(twice, { columns })).toEqual({
      root: null,
      relations: {},
      mapDefaults: {
        app: { models: { BrandReferenceRequestFanUser: `${affiliation} = 'advocate'` } },
      },
    });
  });

  it('reports each layer’s where as written: a parent’s path clamp never rides inside a model default', () => {
    // Layer 1 clamps `request` differently on two paths; layer 2 adds a model default on the
    // participant. Narrowed under layer 1, that default would carry the clamp of whichever path
    // compiled it first — the mirror reports the clamp under its own path instead.
    const participant: Lens = { maps, mapName: 'app', model: 'BrandReferenceRequestFanUser' };
    const layer1: LensNarrowing = {
      parent: participant,
      root: {
        relations: {
          request: {
            where: { field: 'status', operator: Operator.equals, value: 'open' },
            relations: {
              brandReferenceRequestFanUsers: {
                relations: {
                  request: {
                    where: { field: 'status', operator: Operator.equals, value: 'closed' },
                  },
                },
              },
            },
          },
        },
      },
    };
    const layer2: LensNarrowing = {
      parent: layer1,
      mapDefaults: {
        app: {
          models: {
            BrandReferenceRequestFanUser: {
              where: { field: 'request', operator: Operator.exists },
            },
          },
        },
      },
    };
    expect(
      toLensWhereSql(layer2, {
        columns: {
          'request.status': 'r1.status',
          'request.brandReferenceRequestFanUsers.request.status': 'r2.status',
          'BrandReferenceRequestFanUser.request.id': 'p.request_id',
        },
      }),
    ).toEqual({
      root: null,
      relations: {
        request: "r1.status = 'open'",
        'request.brandReferenceRequestFanUsers.request': "r2.status = 'closed'",
      },
      mapDefaults: {
        app: { models: { BrandReferenceRequestFanUser: 'p.request_id IS NOT NULL' } },
      },
    });
  });

  it('refuses a where that crosses a relation the lens hides: its clamps have no path to report at', () => {
    // Layer 1 shows `request` and clamps its model; layer 2 hides `request` yet reads through it.
    // check() still carries the hidden hop's clamp (narrowed in); SQL could only drop it.
    const participant: Lens = { maps, mapName: 'app', model: 'BrandReferenceRequestFanUser' };
    const layer1: LensNarrowing = {
      parent: participant,
      root: { relations: { request: {} } },
      mapDefaults: {
        app: {
          models: {
            BrandReferenceRequest: {
              where: { field: 'status', operator: Operator.equals, value: 'open' },
            },
          },
        },
      },
    };
    const columns = { 'BrandReferenceRequestFanUser.request.id': 'r.id', 'request.id': 'r.id' };
    const throughHidden = { field: 'request', operator: Operator.exists };
    const asDefault: LensNarrowing = {
      parent: layer1,
      root: { omits: ['request'] },
      mapDefaults: { app: { models: { BrandReferenceRequestFanUser: { where: throughHidden } } } },
    };
    const asPath: LensNarrowing = {
      parent: layer1,
      root: { omits: ['request'], where: throughHidden },
    };
    for (const narrowing of [asDefault, asPath])
      expect(() => toLensWhereSql(narrowing, { columns })).toThrow(
        "crosses 'request', a relation the lens hides",
      );
  });

  it('reports a lens with no wheres as nothing', () => {
    expect(toLensWhereSql(lens, { columns: {} })).toEqual({
      root: null,
      relations: {},
      mapDefaults: {},
    });
  });

  it('names a missing column by relation path, or by model for a model default', () => {
    expect(() =>
      onMysql(() =>
        toLensWhereSql(narrowing, {
          columns: { ...columns, 'brandReferenceRequestFanUsers.id': '' },
        }),
      ),
    ).toThrow("no column for 'brandReferenceRequestFanUsers.id'");
    expect(() =>
      onMysql(() =>
        toLensWhereSql(narrowing, {
          columns: { ...columns, 'BrandReferenceRequestFanUser.affiliation': '' },
        }),
      ),
    ).toThrow("no column for 'BrandReferenceRequestFanUser.affiliation'");
  });
});
