import { RE2JS } from 're2js';

// A rule's pattern runs on RE2, in time linear in its input, so an untrusted rule can't stall
// check() — Postgres's own engine doesn't backtrack either. A pattern RE2 can't run (a
// backreference, a lookaround) is refused on every rail; of a RegExp's flags only `i` reads,
// which SQL writes as `~*`.

export type Pattern = { source: string; caseInsensitive: boolean; re: RE2JS };

export const readPattern = (value: string | RegExp): Pattern => {
  const source = value instanceof RegExp ? value.source : value;
  const flags = value instanceof RegExp ? value.flags : '';
  if (/[^i]/.test(flags))
    throw new Error(`Refused pattern /${source}/${flags}: only the 'i' flag is supported`);
  const caseInsensitive = flags === 'i';
  try {
    return {
      source,
      caseInsensitive,
      re: RE2JS.compile(source, caseInsensitive ? RE2JS.CASE_INSENSITIVE : 0),
    };
  } catch (error) {
    throw new Error(`Refused pattern /${source}/: ${(error as Error).message}`);
  }
};

// RE2's classes are ASCII; Postgres's follow the database locale.
const CLASSES: Record<string, string> = {
  d: '0-9',
  w: '0-9A-Za-z_',
  s: '\\t\\n\\f\\r ',
};
const POSIX: Record<string, string> = {
  alnum: '0-9A-Za-z',
  alpha: 'A-Za-z',
  ascii: '\\u0000-\\u007f',
  blank: '\\t ',
  cntrl: '\\u0000-\\u001f\\u007f',
  digit: '0-9',
  graph: '!-~',
  lower: 'a-z',
  print: ' -~',
  punct: '!-/:-@\\[-`{-~',
  space: '\\t\\n\\v\\f\\r ',
  upper: 'A-Z',
  word: '0-9A-Za-z_',
  xdigit: '0-9A-Fa-f',
};
const PG_SPECIAL = /[\\^$.|?*+()[\]{}]/;
const MAX_REPEAT = 255;

const codePoint = (code: number): string =>
  code <= 0xffff
    ? `\\u${code.toString(16).padStart(4, '0')}`
    : `\\U${code.toString(16).padStart(8, '0')}`;

const literal = (char: string): string => (PG_SPECIAL.test(char) ? `\\${char}` : char);

/**
 * The pattern in Postgres's dialect, matching what RE2 matches: `.` stops at a newline, `\b` is a
 * word boundary, and classes are ASCII. A construct Postgres can't express — a Unicode class, a
 * flag group, a repeat past 255 — is refused. `source` is one RE2 already compiled.
 */
export const postgresSource = (source: string): string => {
  const refuse = (what: string): never => {
    throw new Error(`Refused pattern /${source}/: ${what} has no Postgres form`);
  };
  let out = '';
  let i = 0;
  // One escape at `i` (the backslash), inside a class or not; returns the translation.
  const translateEscape = (inClass: boolean): string => {
    const c = source[i + 1];
    i += 2;
    if (Object.hasOwn(CLASSES, c)) return inClass ? CLASSES[c] : `[${CLASSES[c]}]`;
    const upper = c.toLowerCase();
    if (c !== upper && Object.hasOwn(CLASSES, upper)) {
      if (inClass) refuse(`a negated class \\${c} inside brackets`);
      return `[^${CLASSES[upper]}]`;
    }
    if (c === 'p' || c === 'P') return refuse('a Unicode class');
    if (c === 'C') return refuse('\\C');
    if (c === 'x') {
      const braced = source[i] === '{';
      const end = braced ? source.indexOf('}', i) : i + 2;
      const hex = source.slice(braced ? i + 1 : i, end);
      i = braced ? end + 1 : end;
      return codePoint(Number.parseInt(hex, 16));
    }
    if (c >= '0' && c <= '7') {
      let oct = c;
      while (oct.length < 3 && source[i] >= '0' && source[i] <= '7') oct += source[i++];
      return codePoint(Number.parseInt(oct, 8));
    }
    if (!inClass && (c === 'b' || c === 'B')) return c === 'b' ? '\\y' : '\\Y';
    if (!inClass && c === 'z') return '\\Z';
    if (!inClass && c === 'A') return '\\A';
    if (c === 'Q') {
      const end = source.indexOf('\\E', i);
      const quoted = source.slice(i, end === -1 ? undefined : end);
      i = end === -1 ? source.length : end + 2;
      return [...quoted]
        .map(inClass ? (ch) => (/[\\\]^-]/.test(ch) ? `\\${ch}` : ch) : literal)
        .join('');
    }
    return `\\${c}`;
  };
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') {
      out += translateEscape(false);
    } else if (c === '.') {
      out += '[^\\n]';
      i++;
    } else if (c === '(' && source[i + 1] === '?') {
      const named = /^\(\?P?<[^>]+>/.exec(source.slice(i));
      if (named) {
        out += '(';
        i += named[0].length;
      } else if (source[i + 2] === ':') {
        out += '(?:';
        i += 3;
      } else refuse('a flag group');
    } else if (c === '{') {
      // A count with a leading zero is literal text to RE2.
      const repeat = /^\{(0|[1-9]\d*)(?:,(0|[1-9]\d*)?)?\}/.exec(source.slice(i));
      if (!repeat) {
        out += '\\{';
        i++;
        continue;
      }
      if (Number(repeat[1]) > MAX_REPEAT || Number(repeat[2] ?? 0) > MAX_REPEAT)
        refuse(`a repeat count past ${MAX_REPEAT}`);
      out += repeat[0];
      i += repeat[0].length;
    } else if (c === '[') {
      out += '[';
      i++;
      if (source[i] === '^') {
        out += '^';
        i++;
      }
      // A leading ] is a member, as in RE2.
      if (source[i] === ']') {
        out += '\\]';
        i++;
      }
      // A class expands to ranges, so a - after one is a literal, as RE2 reads it; after a
      // range's -, the next character ends the range, even a [.
      let afterClass = false;
      let rangeEnd = false;
      let members = 0;
      while (i < source.length && source[i] !== ']') {
        const posix: RegExpExecArray | null = rangeEnd
          ? null
          : /^\[:(\^?)([a-z]+):\]/.exec(source.slice(i));
        const expands: boolean = !!posix || /^\\[dswDSW]/.test(source.slice(i));
        const dash: boolean =
          source[i] === '-' && members > 0 && source[i + 1] !== ']' && !rangeEnd;
        if (posix) {
          if (posix[1]) refuse(`a negated class [:^${posix[2]}:]`);
          if (!Object.hasOwn(POSIX, posix[2])) refuse(`the class [:${posix[2]}:]`);
          out += POSIX[posix[2]];
          i += posix[0].length;
        } else if (source[i] === '\\') {
          out += translateEscape(true);
        } else if (dash && afterClass) {
          out += '\\-';
          i++;
        } else {
          out += source[i] === '[' ? '\\[' : source[i];
          i++;
        }
        rangeEnd = dash && !afterClass;
        afterClass = expands;
        members++;
      }
      out += ']';
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
};

/** Why a pattern is refused (on `target`, when given), or null. */
export const patternProblem = (value: string | RegExp, target?: string): string | null => {
  try {
    const { source } = readPattern(value);
    if (target === 'toSql') postgresSource(source);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
};
