export const COLORS = ["red", "blue", "green", "yellow"] as const;
export type Color = (typeof COLORS)[number];

/** A multiset of colored tokens, e.g. `{ red: 2, blue: 1 }`. Missing keys count as 0. */
export type Multiset = Partial<Record<Color, number>>;

export function count(m: Multiset, c: Color): number {
  return m[c] ?? 0;
}

export function total(m: Multiset): number {
  let n = 0;
  for (const c of COLORS) n += count(m, c);
  return n;
}

export function isEmpty(m: Multiset): boolean {
  return total(m) === 0;
}

/** True if `m` contains at least the tokens in `sub`. */
export function contains(m: Multiset, sub: Multiset): boolean {
  return COLORS.every((c) => count(m, c) >= count(sub, c));
}

/** Adds `other` into `m` in place. */
export function addInto(m: Multiset, other: Multiset): void {
  for (const c of COLORS) {
    const n = count(other, c);
    if (n > 0) m[c] = count(m, c) + n;
  }
}

/** Removes `other` from `m` in place. Throws if `m` does not contain `other`. */
export function subtractFrom(m: Multiset, other: Multiset): void {
  if (!contains(m, other)) throw new Error("Multiset underflow");
  for (const c of COLORS) {
    const n = count(other, c);
    if (n === 0) continue;
    const left = count(m, c) - n;
    if (left === 0) delete m[c];
    else m[c] = left;
  }
}

/** Expands a multiset into a flat list of colors in canonical order. */
export function expand(m: Multiset): Color[] {
  const out: Color[] = [];
  for (const c of COLORS) for (let i = 0; i < count(m, c); i++) out.push(c);
  return out;
}
