import type { Color } from "./multiset";

/** Capacity of places that do not specify one. */
export const DEFAULT_CAPACITY = 7;

export type TransitionKind = "normal" | "source" | "sink";

export interface Place {
  id: string;
  x: number;
  y: number;
  /** Maximum number of tokens (settled plus committed incoming); defaults to `DEFAULT_CAPACITY`. */
  capacity?: number;
  /** Settled tokens in arrival order, oldest first. */
  marking: Color[];
}

export interface Transition {
  id: string;
  x: number;
  y: number;
  kind: TransitionKind;
  label?: string;
  /** If set, the transition fires automatically every `autoInterval` seconds when enabled. */
  autoInterval?: number;
  /** A disabled transition can never fire. */
  disabled?: boolean;
}

/**
 * A directed arc between a place and a transition (either direction) moving `count` tokens per firing.
 * A colored arc only moves tokens of `color`. An arc without `color` ("any") moves tokens of any color:
 * as input it takes the oldest tokens of its place; as output it passes on tokens taken by the
 * transition's "any" inputs, in input-arc order.
 */
export interface Arc {
  id: string;
  from: string;
  to: string;
  color?: Color;
  count?: number;
}

export interface NetSpec {
  places: Place[];
  transitions: Transition[];
  arcs: Arc[];
}

export function arcCount(a: Arc): number {
  return a.count ?? 1;
}

export class Net {
  readonly places = new Map<string, Place>();
  readonly transitions = new Map<string, Transition>();
  readonly arcs = new Map<string, Arc>();
  private readonly inArcs = new Map<string, Arc[]>();
  private readonly outArcs = new Map<string, Arc[]>();
  /** Incremented whenever the structure of the net changes, so views can rebuild. */
  version = 0;

  constructor(spec: NetSpec) {
    for (const p of spec.places) this.addPlace(p);
    for (const t of spec.transitions) this.addTransition(t);
    for (const a of spec.arcs) this.addArc(a);
    for (const t of this.transitions.values()) this.validateTransition(t.id);
  }

  addPlace(p: Place): void {
    this.assertFreeId(p.id);
    this.places.set(p.id, { ...p, capacity: p.capacity ?? DEFAULT_CAPACITY, marking: [...p.marking] });
  }

  addTransition(t: Transition): void {
    this.assertFreeId(t.id);
    this.transitions.set(t.id, { ...t });
    this.inArcs.set(t.id, []);
    this.outArcs.set(t.id, []);
  }

  addArc(spec: Arc): void {
    if (this.arcs.has(spec.id)) throw new Error(`Duplicate arc id ${spec.id}`);
    const a: Arc = { ...spec, count: arcCount(spec) };
    if (!Number.isInteger(a.count) || a.count! < 1) throw new Error(`Arc ${a.id} needs a positive integer count`);
    if (this.places.has(a.from) && this.transitions.has(a.to)) {
      this.inArcs.get(a.to)!.push(a);
    } else if (this.transitions.has(a.from) && this.places.has(a.to)) {
      this.outArcs.get(a.from)!.push(a);
    } else {
      throw new Error(`Arc ${a.id} must connect a place and a transition`);
    }
    this.arcs.set(a.id, a);
  }

  /** Removes transition `tid` together with all its arcs; returns the removed arcs. */
  removeTransition(tid: string): Arc[] {
    const arcs = [...this.inputs(tid), ...this.outputs(tid)];
    for (const a of arcs) this.arcs.delete(a.id);
    this.transitions.delete(tid);
    this.inArcs.delete(tid);
    this.outArcs.delete(tid);
    this.version++;
    return arcs;
  }

  /** Arcs from places into transition `tid`. */
  inputs(tid: string): readonly Arc[] {
    return this.inArcs.get(tid) ?? [];
  }

  /** Arcs from transition `tid` into places. */
  outputs(tid: string): readonly Arc[] {
    return this.outArcs.get(tid) ?? [];
  }

  /** Center position of a node (place or transition). */
  pos(id: string): { x: number; y: number } {
    const n = this.places.get(id) ?? this.transitions.get(id);
    if (!n) throw new Error(`Unknown node ${id}`);
    return { x: n.x, y: n.y };
  }

  /** Length of the arc's octilinear route (straight and 45° legs), center to center. */
  arcLength(a: Arc): number {
    const p = this.pos(a.from);
    const q = this.pos(a.to);
    const dx = Math.abs(q.x - p.x);
    const dy = Math.abs(q.y - p.y);
    return Math.max(dx, dy) - Math.min(dx, dy) + Math.min(dx, dy) * Math.SQRT2;
  }

  /** "Any" outputs can only pass on tokens taken by "any" inputs. */
  private validateTransition(tid: string): void {
    const anyIn = this.inputs(tid).filter((a) => !a.color).reduce((n, a) => n + arcCount(a), 0);
    const anyOut = this.outputs(tid).filter((a) => !a.color).reduce((n, a) => n + arcCount(a), 0);
    if (anyOut > anyIn) throw new Error(`Transition ${tid} has more "any" output tokens than "any" input tokens`);
  }

  private assertFreeId(id: string): void {
    if (this.places.has(id) || this.transitions.has(id)) throw new Error(`Duplicate node id ${id}`);
  }
}
