import { COLORS, expand, total, type Color } from "../core/multiset";
import { Net, type Transition } from "../core/net";
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
const ENDLESS_EPOCH_PROGRESS = 60;
const EMISSION_PROGRESS = 10;
const SINK_GRACE = 180;
const SOURCE_IDLE = 240;
const COUNTDOWN = 60;
const DELIVERY_EXTENSION = 10;
const ENDLESS_STEP = 1 / 60;
const TIME_EPSILON = 1e-8;

interface Countdown {
  startsAt: number;
  deadline: number;
}

/** Game rules on top of the net simulation: goals at sinks and source difficulty ramp. */
export class Game {
  readonly sim: Simulation;
  /** True when node coordinates are transposed so the net flows top to bottom. */
  portrait = false;
  complete = false;
  completedAt?: number;
  /** Goal tokens delivered during this endless run. */
  score = 0;
  /** Goal sinks whose goals are all met, with the time they were met. */
  readonly resolved = new Map<string, number>();
  /** Exhausted sources and the time their supply ran out. */
  readonly exhausted = new Map<string, number>();
  /** Transitions that timed out and the time their countdown expired. */
  readonly failed = new Map<string, number>();
  /** Matching tokens that reached each goal sink, per `sink:color`. */
  private readonly delivered = new Map<string, number>();
  /** Matching tokens consumed by each goal sink, including those still travelling into it. */
  private readonly reserved = new Map<string, number>();
  private goalDefinitions: Goal[];
  private nextRampAt: number;
  private readonly countdowns = new Map<string, Countdown>();
  private readonly endlessCenter?: Transition;
  private endlessProgress = 0;
  private endlessEpoch = 0;
  private pendingColor?: "blue" | "red";
  private nextSpawnRetryAt = 0;
  private nextEndlessId = 1;

  constructor(readonly level: Level, private readonly random: () => number = Math.random) {
    for (const p of level.net.places) placeRadius(p.capacity);
    this.sim = new Simulation(new Net(level.net));
    this.goalDefinitions = level.goals.map((goal) => ({ ...goal }));
    this.nextRampAt = level.ramp.every;
    if (level.mode === "endless") {
      this.endlessCenter = [...this.sim.net.transitions.values()].find((t) => t.kind === "source" && t.supply === undefined);
      for (const goal of this.goalDefinitions) this.startCountdown(goal.sinkId, SINK_GRACE);
      this.sim.onBeforeAutoFire(() => this.expireCountdowns());
    }
    for (const t of this.sim.net.transitions.values()) {
      if (t.kind === "source" && t.supply === 0) this.exhausted.set(t.id, this.sim.time);
    }
    this.sim.onFire((e) => {
      const transition = this.sim.net.transitions.get(e.transitionId)!;
      if (transition.kind === "source") {
        if (this.level.mode === "endless") {
          this.endlessProgress += total(e.produced) * EMISSION_PROGRESS;
          if (this.countdowns.has(transition.id)) this.startCountdown(transition.id, SOURCE_IDLE, e.time);
        }
        if (transition.supply === 0) {
          this.countdowns.delete(transition.id);
          this.exhausted.set(transition.id, e.time);
        }
      }
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
      if (this.failed.has(t.id)) return;
      const countdown = this.countdowns.get(t.id);
      if (countdown && e.time + TIME_EPSILON >= countdown.deadline) {
        this.failTransition(t.id, countdown.deadline);
        return;
      }
      if (countdown && e.time + TIME_EPSILON >= countdown.startsAt) countdown.deadline += total(e.consumed) * DELIVERY_EXTENSION;
      const before = this.goalsFor(t.id).reduce((sum, goal) => sum + goal.delivered, 0);
      for (const c of expand(e.consumed)) bump(this.delivered, deliveryKey(t.id, c));
      const goals = this.goalsFor(t.id);
      if (this.level.mode === "endless") {
        this.score += goals.reduce((sum, goal) => sum + goal.delivered, 0) - before;
      }
      if (goals.length > 0 && goals.every((g) => g.done) && !this.resolved.has(t.id)) {
        this.resolved.set(t.id, e.time);
        this.countdowns.delete(t.id);
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
    if (this.level.mode !== "endless") {
      this.advance(dt);
      return;
    }
    if (dt === 0) this.spawnEndless();
    for (let remaining = dt; remaining > 1e-9;) {
      const step = Math.min(remaining, ENDLESS_STEP);
      this.advance(step);
      remaining -= step;
    }
  }

  private advance(dt: number): void {
    if (this.level.mode === "endless") this.endlessProgress += dt;
    this.sim.step(dt);
    this.rampSources();
    for (const [tid, at] of this.resolved) {
      if (this.sim.time - at < RESOLVED_LINGER) continue;
      if (this.sim.net.transitions.has(tid)) this.sim.removeTransition(tid);
      if (this.level.mode === "endless") {
        this.forgetGoal(tid);
        this.resolved.delete(tid);
      }
    }
    for (const [tid, at] of this.exhausted) {
      const t = this.sim.net.transitions.get(tid);
      if (!t) this.exhausted.delete(tid);
      else if (!t.ghost && this.sim.time - at >= RESOLVED_LINGER) this.sim.net.ghostTransition(tid);
    }
    for (const [tid, at] of this.failed) {
      const t = this.sim.net.transitions.get(tid);
      if (!t) this.failed.delete(tid);
      else if (this.sim.time - at >= RESOLVED_LINGER) {
        if (t.kind === "sink") {
          this.sim.removeTransition(tid);
          this.forgetGoal(tid);
          this.failed.delete(tid);
        } else if (!t.ghost) this.sim.net.ghostTransition(tid);
      }
    }
    if (this.level.mode === "endless") {
      this.spawnEndless();
    } else if (this.resolved.size === new Set(this.goalDefinitions.map((g) => g.sinkId)).size) {
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
    return this.goalDefinitions.map((g) => {
      const delivered = Math.min(g.count, this.delivered.get(deliveryKey(g.sinkId, g.color)) ?? 0);
      return { ...g, delivered, done: delivered >= g.count };
    });
  }

  goalsFor(sinkId: string): GoalStatus[] {
    return this.goals().filter((g) => g.sinkId === sinkId);
  }

  private goalsOf(sinkId: string): Goal[] {
    return this.goalDefinitions.filter((g) => g.sinkId === sinkId);
  }

  /** Fraction of the final countdown remaining, or undefined before it starts. */
  countdownProgress(tid: string): number | undefined {
    const countdown = this.countdowns.get(tid);
    if (!countdown || this.sim.time + TIME_EPSILON < countdown.startsAt) return undefined;
    return Math.max(0, Math.min(1, (countdown.deadline - this.sim.time) / COUNTDOWN));
  }

  private startCountdown(tid: string, grace: number, at = this.sim.time): void {
    const startsAt = at + grace;
    this.countdowns.set(tid, { startsAt, deadline: startsAt + COUNTDOWN });
  }

  private expireCountdowns(): void {
    for (const [tid, countdown] of this.countdowns) {
      if (this.sim.time + TIME_EPSILON >= countdown.deadline) this.failTransition(tid, countdown.deadline);
    }
  }

  private failTransition(tid: string, at: number): void {
    const t = this.sim.net.transitions.get(tid);
    if (!t) throw new Error(`Countdown transition ${tid} is missing`);
    t.disabled = true;
    if (t.open?.length) {
      t.open = [];
      this.sim.net.version++;
    }
    this.countdowns.delete(tid);
    this.failed.set(tid, at);
  }

  private forgetGoal(tid: string): void {
    for (const color of COLORS) {
      this.delivered.delete(deliveryKey(tid, color));
      this.reserved.delete(deliveryKey(tid, color));
    }
    this.goalDefinitions = this.goalDefinitions.filter((goal) => goal.sinkId !== tid);
    this.countdowns.delete(tid);
  }

  private spawnEndless(): void {
    while (this.endlessProgress >= ENDLESS_EPOCH_PROGRESS - 1e-9 && this.sim.time >= this.nextSpawnRetryAt) {
      this.pendingColor ??= this.endlessEpoch < 5 ? "blue"
        : this.endlessEpoch === 5 || this.random() < 0.5 ? "red" : "blue";
      if (!this.spawnEndlessGoal(this.pendingColor)) {
        console.warn("Could not place an endless goal and its source; retrying in one second");
        this.nextSpawnRetryAt = this.sim.time + 1;
        break;
      }
      this.endlessProgress = Math.max(0, this.endlessProgress - ENDLESS_EPOCH_PROGRESS);
      this.endlessEpoch++;
      this.pendingColor = undefined;
    }
  }

  private spawnEndlessGoal(color: "blue" | "red"): boolean {
    const net = this.sim.net;
    const positions = this.endlessPositions(color === "red");
    if (!positions) return false;

    const sinkId = net.freshId(`endless${this.nextEndlessId++}_`);
    net.addTransition({ id: sinkId, ...positions.sink, kind: "sink", autoInterval: 0.6, open: [{ dir: "in", color }] });
    this.goalDefinitions.push({ sinkId, color, count: 5 });
    this.startCountdown(sinkId, SINK_GRACE);
    if (positions.source) {
      const sourceId = net.freshId(`endless${this.nextEndlessId++}_`);
      net.addTransition({
        id: sourceId, ...positions.source, kind: "source", autoInterval: 3, supply: 5, open: [{ dir: "out", color: "red" }],
      });
      this.startCountdown(sourceId, SOURCE_IDLE);
    }
    return true;
  }

  private endlessPositions(withSource: boolean): { sink: { x: number; y: number }; source?: { x: number; y: number } } | undefined {
    const net = this.sim.net;
    const nodes = net.liveNodes();
    if (nodes.length === 0) throw new Error("Endless mode needs a live node to spawn near");
    const center = this.endlessCenter;
    if (!center || center.ghost || !net.transitions.has(center.id)) throw new Error("Endless mode needs its permanent starting source");
    const candidateAt = (anchor: { x: number; y: number }, angle: number) => {
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      const sink = { x: anchor.x + dx * (BUILD_RANGE - 1), y: anchor.y + dy * (BUILD_RANGE - 1) };
      if (this.placementIssue("transition", sink.x, sink.y)) return undefined;
      if (!withSource) return { sink };
      const source = { x: sink.x + dx * (BUILD_RANGE - 1), y: sink.y + dy * (BUILD_RANGE - 1) };
      const middle = { x: (sink.x + source.x) / 2, y: (sink.y + source.y) / 2 };
      // The sink will be added first, making both the source and middle place reachable.
      if (this.placementIssue("transition", source.x, source.y) !== "crowded"
        && this.placementIssue("place", middle.x, middle.y) !== "crowded") return { sink, source };
      return undefined;
    };

    const gravity = (point: { x: number; y: number }) => 1 / (1 + Math.hypot(point.x - center.x, point.y - center.y) / (2 * BUILD_RANGE));
    const weights = nodes.map(gravity);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    let selected: ReturnType<typeof candidateAt>;
    let candidateWeight = 0;
    for (let i = 0; i < 32; i++) {
      let choice = this.random() * totalWeight;
      let index = 0;
      while (index < nodes.length - 1 && choice >= weights[index]) choice -= weights[index++];
      const candidate = candidateAt(nodes[index], this.random() * Math.PI * 2);
      if (!candidate) continue;
      const weight = candidate.source ? (gravity(candidate.sink) + gravity(candidate.source)) / 2 : gravity(candidate.sink);
      candidateWeight += weight;
      if (this.random() * candidateWeight < weight) selected = candidate;
    }
    if (selected) return selected;

    // An outer-edge fallback keeps spawns possible when the center is crowded.
    const startAngle = this.random() * Math.PI * 2;
    for (let i = 0; i < 32; i++) {
      const angle = startAngle + i * Math.PI * 2 / 32;
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      const anchor = nodes.reduce((best, node) =>
        node.x * dx + node.y * dy > best.x * dx + best.y * dy ? node : best);
      const candidate = candidateAt(anchor, angle);
      if (candidate) return candidate;
    }
    return undefined;
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
