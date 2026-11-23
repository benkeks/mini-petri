import type { Color } from "../core/multiset";
import type { NetSpec, Port } from "../core/net";

/** A goal sink wants to consume `count` tokens of `color`; once all its goals are met it leaves the map. */
export interface Goal {
  sinkId: string;
  color: Color;
  count: number;
}

export interface Level {
  name: string;
  /** Endless games spawn new sources and goals and never complete. */
  mode?: "endless";
  /** Initial framing size; the buildable plane extends beyond this rectangle. */
  width: number;
  height: number;
  net: NetSpec;
  goals: Goal[];
  /** Source intervals are multiplied by `factor` every `every` seconds, down to `min`. */
  ramp: { every: number; factor: number; min: number };
  /** Building and upgrade tools available to the player; none if omitted. */
  tools?: Tools;
}

/** A transition the player can build: it starts with all its ports open. */
export interface Kit {
  id: string;
  ports: Port[];
  /** Add a copy of the first any-color input to the any-color outputs. */
  copyInputColor?: boolean;
}

export interface Tools {
  /** Build new places. */
  place?: boolean;
  /** Build new transitions. */
  kits?: Kit[];
  /** Remove arcs, places and normal transitions. */
  remove?: boolean;
  /** Automate a transition or make an automatic transition faster. */
  auto?: boolean;
  /** Raise the capacity of a place. */
  capacity?: boolean;
}
