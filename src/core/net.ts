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
  /** A removed place: it holds no tokens and swallows arrivals until its last arc is gone. */
  ghost?: boolean;
}

/**
 * An unconnected arc end of a transition, waiting to be connected to a place.
 * `in` ports become arcs from the place into the transition, `out` ports arcs into the place.
 */
export interface Port {
  dir: "in" | "out";
  color?: Color;
  count?: number;
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
  /** Unconnected ports; a transition with open ports cannot fire. */
  open?: Port[];
  /** Remaining firings; undefined means unlimited. */
  supply?: number;
  /** A removed transition: it never fires again but finishes its firings in progress. */
  ghost?: boolean;
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
  /** A removed arc: tokens on it finish their journey, then it disappears. */
  ghost?: boolean;
}

export interface NetSpec {
  places: Place[];
  transitions: Transition[];
  arcs: Arc[];
}

export function arcCount(a: Arc | Port): number {
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
    this.version++;
  }

  addTransition(t: Transition): void {
    this.assertFreeId(t.id);
    this.transitions.set(t.id, { ...t, open: (t.open ?? []).map((port) => ({ ...port, count: arcCount(port) })) });
    this.inArcs.set(t.id, []);
    this.outArcs.set(t.id, []);
    this.version++;
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
    this.version++;
  }

  /** A node or arc id of the form `prefix<n>` that is not in use. */
  freshId(prefix: string): string {
    for (let n = 1; ; n++) {
      const id = `${prefix}${n}`;
      if (!this.places.has(id) && !this.transitions.has(id) && !this.arcs.has(id)) return id;
    }
  }

  /** Turns open port `index` of transition `tid` into an arc to or from place `pid`. */
  connect(tid: string, index: number, pid: string): Arc {
    const t = this.transitions.get(tid);
    const p = this.places.get(pid);
    const port = t?.open?.[index];
    if (!t || t.ghost || !p || p.ghost || !port) throw new Error(`Cannot connect ${tid}[${index}] to ${pid}`);
    const arc: Arc = {
      id: this.freshId("c"),
      from: port.dir === "in" ? pid : tid,
      to: port.dir === "in" ? tid : pid,
      color: port.color,
      count: arcCount(port),
    };
    t.open!.splice(index, 1);
    this.addArc(arc);
    return this.arcs.get(arc.id)!;
  }

  /** Removes arc `aid` as a ghost; its transition gets the arc back as an open port. */
  ghostArc(aid: string): void {
    const a = this.arcs.get(aid);
    if (!a || a.ghost) return;
    a.ghost = true;
    const input = this.transitions.has(a.to);
    const t = this.transitions.get(input ? a.to : a.from)!;
    if (!t.ghost) (t.open ??= []).push({ dir: input ? "in" : "out", color: a.color, count: arcCount(a) });
    this.version++;
  }

  /** Removes transition `tid` and its arcs as ghosts. */
  ghostTransition(tid: string): void {
    const t = this.transitions.get(tid);
    if (!t || t.ghost) return;
    t.ghost = true;
    t.open = [];
    for (const a of this.arcsOf(tid)) this.ghostArc(a.id);
    this.version++;
  }

  /** Removes place `pid` as a ghost, dropping its tokens; transitions get its arcs back as open ports. */
  ghostPlace(pid: string): void {
    const p = this.places.get(pid);
    if (!p || p.ghost) return;
    p.ghost = true;
    p.marking = [];
    for (const a of this.arcsOf(pid)) this.ghostArc(a.id);
    this.version++;
  }

  deleteArc(aid: string): void {
    const a = this.arcs.get(aid);
    if (!a) return;
    this.arcs.delete(aid);
    for (const lists of [this.inArcs, this.outArcs]) {
      for (const [tid, list] of lists) lists.set(tid, list.filter((x) => x !== a));
    }
    this.version++;
  }

  deleteNode(id: string): void {
    for (const a of this.arcsOf(id)) this.deleteArc(a.id);
    this.places.delete(id);
    this.transitions.delete(id);
    this.inArcs.delete(id);
    this.outArcs.delete(id);
    this.version++;
  }

  /** Removes transition `tid` together with all its arcs at once; returns the removed arcs. */
  removeTransition(tid: string): Arc[] {
    const arcs = this.arcsOf(tid);
    this.deleteNode(tid);
    return arcs;
  }

  /** All arcs touching node `id`, ghosts included. */
  arcsOf(id: string): Arc[] {
    return [...this.arcs.values()].filter((a) => a.from === id || a.to === id);
  }

  /** Live arcs from places into transition `tid`. */
  inputs(tid: string): readonly Arc[] {
    return (this.inArcs.get(tid) ?? []).filter((a) => !a.ghost);
  }

  /** Live arcs from transition `tid` into places. */
  outputs(tid: string): readonly Arc[] {
    return (this.outArcs.get(tid) ?? []).filter((a) => !a.ghost);
  }

  /** Live (not removed) places and transitions. */
  liveNodes(): (Place | Transition)[] {
    return [...this.places.values(), ...this.transitions.values()].filter((n) => !n.ghost);
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

  /** "Any" outputs can only pass on tokens taken by "any" inputs; open ports count as their future arcs. */
  validateTransition(tid: string): void {
    const open = this.transitions.get(tid)!.open ?? [];
    const anyCount = (dir: Port["dir"], arcs: readonly Arc[]) =>
      [...arcs, ...open.filter((port) => port.dir === dir)].filter((x) => !x.color).reduce((n, x) => n + arcCount(x), 0);
    const anyIn = anyCount("in", this.inputs(tid));
    const anyOut = anyCount("out", this.outputs(tid));
    if (anyOut > anyIn) throw new Error(`Transition ${tid} has more "any" output tokens than "any" input tokens`);
  }

  private assertFreeId(id: string): void {
    if (this.places.has(id) || this.transitions.has(id) || this.arcs.has(id)) throw new Error(`Duplicate node id ${id}`);
  }
}
