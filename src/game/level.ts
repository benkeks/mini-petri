import type { Color } from "../core/multiset";
import type { NetSpec } from "../core/net";

/** A goal sink wants to consume `count` tokens of `color`; once all its goals are met it leaves the map. */
export interface Goal {
  sinkId: string;
  color: Color;
  count: number;
}

export interface Level {
  name: string;
  /** World size; the view scales this rectangle to fit the screen. */
  width: number;
  height: number;
  net: NetSpec;
  goals: Goal[];
  /** Source intervals are multiplied by `factor` every `every` seconds, down to `min`. */
  ramp: { every: number; factor: number; min: number };
}
