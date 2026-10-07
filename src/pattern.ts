/**
 * Why a regular expression is refused, or null when it is safe to run. A repeated group whose
 * body can itself match in more than one way — a quantifier or an alternation inside (`(a+)+`,
 * `(a|aa)*`) — backtracks exponentially on a near-miss, so a rule from an untrusted author could
 * stall the process (or the database). Such patterns are refused on every rail.
 */
export const unsafePattern = (pattern: string): string | null => {
  // For each open group: whether its body repeats or branches.
  const groups: boolean[] = [];
  let ambiguous = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '[') {
      // A character class is one atom: skip to its close.
      for (i++; i < pattern.length && pattern[i] !== ']'; i++) if (pattern[i] === '\\') i++;
      continue;
    }
    if (c === '(') {
      groups.push(ambiguous);
      ambiguous = false;
      continue;
    }
    const quantifier = c === '+' || c === '*' || c === '{';
    if (c === '|' || quantifier) ambiguous = true;
    if (c === ')') {
      const body = ambiguous;
      ambiguous = groups.pop() ?? false;
      const next = pattern[i + 1];
      const repeated = next === '+' || next === '*' || next === '{';
      if (repeated && body) return `the repeated group ending at ${i} can backtrack exponentially`;
      // The group repeats or branches inside the enclosing one.
      if (body) ambiguous = true;
    }
  }
  return null;
};

/** A rule's pattern as a RegExp; throws on a pattern `unsafePattern` refuses. */
export const readPattern = (value: string | RegExp): RegExp => {
  const source = value instanceof RegExp ? value.source : value;
  const unsafe = unsafePattern(source);
  if (unsafe) throw new Error(`Refused pattern /${source}/: ${unsafe}`);
  return value instanceof RegExp ? value : new RegExp(value);
};
