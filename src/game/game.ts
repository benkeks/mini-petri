import { expand, type Color } from "../core/multiset";
import { Net } from "../core/net";
import { Simulation } from "../core/simulation";
import type { Goal, Kit, Level } from "./level";
import { PLACE_CAPACITIES, placeRadius } from "./placeSize";

/** New nodes must be within this distance of a live node. */
export const BUILD_RANGE = 220;
/** Maximum center-to-center distance for a new arc. */
export const CONNECTION_RANGE = BUILD_RANGE + 80;
export function withinConnectionRange(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= CONNECTION_RANGE;
}
/** Radii nodes claim for themselves; footprints plus `CLEARANCE` must not overlap. */
export const PLACE_FOOTPRINT = placeRadius(PLACE_CAPACITIES[PLACE_CAPACITIES.length - 1]) + 8;
export const TRANSITION_FOOTPRINT = 36;
export const CLEARANCE = 24;
/** Interval of a transition upgraded to fire automatically. */
export const AUTO_INTERVAL = 4;
export const FASTER_FACTOR = 0.6;
export const MIN_INTERVAL = 0.6;

export type NodeKind = "place" | "transition";
/** Why a placement is not allowed. */
export type PlacementIssue = "far" | "crowded";

export interface GoalStatus extends Goal {
  /** Matching tokens that have reached the sink, capped at `count`. */
  delivered: number;
  done: boolean;
}

/** Seconds a resolved goal or exhausted source stays visible before it is removed from the map. */
export const RESOLVED_LINGER = 1.2;

/** Game rules on top of the net simulation: goals at sinks and source difficulty ramp. */
export class Game {
  readonly sim: Simulation;
  /** True when node coordinates are transposed so the net flows top to bottom. */
  portrait = false;
  complete = false;
  completedAt?: number;
  /** Goal sinks whose goals are all met, with the time they were met. */
  readonly resolved = new Map<string, number>();
  /** Exhausted sources and the time their supply ran out. */
  readonly exhausted = new Map<string, number>();
  /** Matching tokens that reached each goal sink, per `sink:color`. */
  private readonly delivered = new Map<string, number>();
  /** Matching tokens consumed by each goal sink, including those still travelling into it. */
  private readonly reserved = new Map<string, number>();
  private nextRampAt: number;

  constructor(readonly level: Level) {
    for (const p of level.net.places) placeRadius(p.capacity);
    this.sim = new Simulation(new Net(level.net));
    this.nextRampAt = level.ramp.every;
    for (const t of this.sim.net.transitions.values()) {
      if (t.kind === "source" && t.supply === 0) this.exhausted.set(t.id, this.sim.time);
    }
    this.sim.onFire((e) => {
      const transition = this.sim.net.transitions.get(e.transitionId)!;
      if (transition.kind === "source" && transition.supply === 0) this.exhausted.set(transition.id, e.time);
      const goals = this.goalsOf(e.transitionId);
      if (goals.length === 0) return;
      for (const c of expand(e.consumed)) bump(this.reserved, deliveryKey(e.transitionId, c));
      // Stop consuming once enough matching tokens are on their way.
      if (goals.every((g) => (this.reserved.get(deliveryKey(g.sinkId, g.color)) ?? 0) >= g.count)) {
        this.sim.net.transitions.get(e.transitionId)!.disabled = true;
      }
    });
    // Goals progress once the consumed tokens have visibly reached the sink.
    this.sim.onComplete((e) => {
      const t = this.sim.net.transitions.get(e.transitionId)!;
      if (t.kind !== "sink") return;
      for (const c of expand(e.consumed)) bump(this.delivered, deliveryKey(t.id, c));
      const goals = this.goalsFor(t.id);
      if (goals.length > 0 && goals.every((g) => g.done) && !this.resolved.has(t.id)) {
        this.resolved.set(t.id, e.time);
      }
    });
  }

  /** Player interaction: only non-automatic transitions can be fired by hand. */
  playerFire(tid: string): boolean {
    const t = this.sim.net.transitions.get(tid);
    if (!t || t.kind !== "normal" || this.complete) return false;
    return this.sim.fire(tid);
  }

  /** Whether a node of `kind` may be built at (x, y) in current coordinates. */
  placementIssue(kind: NodeKind, x: number, y: number): PlacementIssue | undefined {
    const net = this.sim.net;
    const r = footprint(kind);
    const nodes = [...net.places.values(), ...net.transitions.values()];
    for (const n of nodes) {
      const other = net.places.has(n.id) ? PLACE_FOOTPRINT : TRANSITION_FOOTPRINT;
      if (Math.hypot(n.x - x, n.y - y) < r + other + CLEARANCE) return "crowded";
    }
    if (!net.liveNodes().some((n) => Math.hypot(n.x - x, n.y - y) <= BUILD_RANGE)) return "far";
    return undefined;
  }

  buildPlace(x: number, y: number, capacity?: (typeof PLACE_CAPACITIES)[number]): string | undefined {
    if (this.complete || !this.level.tools?.place || this.placementIssue("place", x, y)) return undefined;
    const net = this.sim.net;
    const id = net.freshId("p");
    net.addPlace({ id, x, y, capacity, marking: [] });
    return id;
  }

  /** Builds a one-token place and connects it to a live open port. */
  buildConnectedPlace(tid: string, index: number, x: number, y: number): string | undefined {
    const net = this.sim.net;
    if (!this.canConnectAt(tid, index, x, y)) return undefined;
    const id = this.buildPlace(x, y, 1);
    if (id === undefined) return undefined;
    net.connect(tid, index, id);
    return id;
  }

  /** Whether an open port can reach a point in the current world coordinates. */
  canConnectAt(tid: string, index: number, x: number, y: number): boolean {
    const t = this.sim.net.transitions.get(tid);
    return !!t && !this.complete && !t.ghost && !!t.open?.[index]
      && withinConnectionRange(t, { x, y });
  }

  /** Builds a transition from `kit` with all ports open; it is enabled once they are connected. */
  buildTransition(kit: Kit, x: number, y: number): string | undefined {
    if (this.complete || !this.level.tools?.kits?.includes(kit) || this.placementIssue("transition", x, y)) return undefined;
    const net = this.sim.net;
    const id = net.freshId("t");
    net.addTransition({ id, x, y, kind: "normal", open: kit.ports });
    net.validateTransition(id);
    return id;
  }

  /** Connects open port `index` of transition `tid` to place `pid`; only checks if `apply` is false. */
  connect(tid: string, index: number, pid: string, apply = true): boolean {
    const net = this.sim.net;
    const p = net.places.get(pid);
    if (!p || p.ghost || !this.canConnectAt(tid, index, p.x, p.y)) return false;
    if (apply) net.connect(tid, index, pid);
    return true;
  }

  /**
   * Removes an arc, place or transition; it stays as a ghost until its tokens in flight are done.
   * Like the other player actions, it only checks whether the action is possible if `apply` is false.
   */
  remove(id: string, apply = true): boolean {
    const net = this.sim.net;
    if (this.complete || !this.level.tools?.remove) return false;
    const a = net.arcs.get(id);
    if (a && !a.ghost) {
      if (apply) net.ghostArc(id);
      return true;
    }
    const t = net.transitions.get(id);
    if (t && !t.ghost && t.kind === "normal" && this.goalsOf(id).length === 0) {
      if (apply) net.ghostTransition(id);
      return true;
    }
    const p = net.places.get(id);
    if (p && !p.ghost) {
      if (apply) net.ghostPlace(id);
      return true;
    }
    return false;
  }

  /** Automates a manual transition, or speeds up one that is already automatic. */
  upgradeAuto(tid: string, apply = true): boolean {
    const t = this.sim.net.transitions.get(tid);
    if (this.complete || !this.level.tools?.auto || !t || t.ghost || t.kind !== "normal") return false;
    if (t.autoInterval && t.autoInterval <= MIN_INTERVAL) return false;
    if (apply) t.autoInterval = t.autoInterval ? Math.max(MIN_INTERVAL, t.autoInterval * FASTER_FACTOR) : AUTO_INTERVAL;
    return true;
  }

  upgradeCapacity(pid: string, apply = true): boolean {
    const p = this.sim.net.places.get(pid);
    if (this.complete || !this.level.tools?.capacity || !p || p.ghost) return false;
    const next = PLACE_CAPACITIES.find((capacity) => capacity > p.capacity!);
    if (next === undefined) return false;
    const radius = placeRadius(next) + 8;
    for (const n of [...this.sim.net.places.values(), ...this.sim.net.transitions.values()]) {
      if (n.id === pid) continue;
      const other = this.sim.net.places.has(n.id) ? placeRadius(this.sim.net.places.get(n.id)!.capacity) + 8 : TRANSITION_FOOTPRINT;
      if (Math.hypot(n.x - p.x, n.y - p.y) < radius + other + CLEARANCE) return false;
    }
    if (!apply) return true;
    p.capacity = next;
    this.sim.net.version++;
    return true;
  }

  /** Advances the game; frozen once the level is won. */
  step(dt: number): void {
    if (this.complete) return;
    this.sim.step(dt);
    this.rampSources();
    for (const [tid, at] of this.resolved) {
      if (this.sim.time - at >= RESOLVED_LINGER && this.sim.net.transitions.has(tid)) this.sim.removeTransition(tid);
    }
    for (const [tid, at] of this.exhausted) {
      const t = this.sim.net.transitions.get(tid);
      if (!t) this.exhausted.delete(tid);
      else if (!t.ghost && this.sim.time - at >= RESOLVED_LINGER) this.sim.net.ghostTransition(tid);
    }
    if (!this.complete && this.resolved.size === new Set(this.level.goals.map((g) => g.sinkId)).size) {
      this.complete = true;
      this.completedAt = this.sim.time;
    }
  }

  /** Initial framing size, matching the current orientation. */
  get size(): { width: number; height: number } {
    const { width, height } = this.level;
    return this.portrait ? { width: height, height: width } : { width, height };
  }

  /** Transposes node positions (x <-> y). Arc lengths and thus the simulation are unaffected. */
  setPortrait(portrait: boolean): void {
    if (portrait === this.portrait) return;
    this.portrait = portrait;
    const net = this.sim.net;
    for (const n of [...net.places.values(), ...net.transitions.values()]) [n.x, n.y] = [n.y, n.x];
  }

  goals(): GoalStatus[] {
    return this.level.goals.map((g) => {
      const delivered = Math.min(g.count, this.delivered.get(deliveryKey(g.sinkId, g.color)) ?? 0);
      return { ...g, delivered, done: delivered >= g.count };
    });
  }

  goalsFor(sinkId: string): GoalStatus[] {
    return this.goals().filter((g) => g.sinkId === sinkId);
  }

  private goalsOf(sinkId: string): Goal[] {
    return this.level.goals.filter((g) => g.sinkId === sinkId);
  }

  private rampSources(): void {
    const { every, factor, min } = this.level.ramp;
    while (this.sim.time >= this.nextRampAt) {
      this.nextRampAt += every;
      for (const t of this.sim.net.transitions.values()) {
        if (t.kind === "source" && t.autoInterval) t.autoInterval = Math.max(min, t.autoInterval * factor);
      }
    }
  }
}

export function footprint(kind: NodeKind): number {
  return kind === "place" ? PLACE_FOOTPRINT : TRANSITION_FOOTPRINT;
}

function bump(m: Map<string, number>, key: string): void {
  m.set(key, (m.get(key) ?? 0) + 1);
}

function deliveryKey(sinkId: string, c: Color): string {
  return `${sinkId}:${c}`;
}
