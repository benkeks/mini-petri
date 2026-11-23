import { DEFAULT_CAPACITY } from "../core/net";

export const PLACE_CAPACITIES = [1, 7, 19] as const;
export const TOKEN_SPACING = 14;

/** Place radii grow by one token ring for each capacity level. */
export function placeRadius(capacity = DEFAULT_CAPACITY): number {
  const level = PLACE_CAPACITIES.findIndex((value) => value === capacity);
  if (level < 0) throw new Error(`Unsupported place capacity ${capacity}; expected 1, 7 or 19`);
  return 12 + level * TOKEN_SPACING;
}
