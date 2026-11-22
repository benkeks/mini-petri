import { expand, type Color } from "../core/multiset";
import { Net } from "../core/net";
import { Simulation } from "../core/simulation";
import type { Goal, Level } from "./level";

export interface GoalStatus extends Goal {
  /** Matching tokens that have reached the sink, capped at `count`. */
  delivered: number;
  done: boolean;
}

/** Seconds a resolved goal sink stays visible (check-marked) before it is removed from the map. */
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
  /** Matching tokens that reached each goal sink, per `sink:color`. */
  private readonly delivered = new Map<string, number>();
  /** Matching tokens consumed by each goal sink, including those still travelling into it. */
  private readonly reserved = new Map<string, number>();
  private nextRampAt: number;

  constructor(readonly level: Level) {
    this.sim = new Simulation(new Net(level.net));
    this.nextRampAt = level.ramp.every;
    this.sim.onFire((e) => {
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

  /** Advances the game; frozen once the level is won. */
  step(dt: number): void {
    if (this.complete) return;
    this.sim.step(dt);
    this.rampSources();
    for (const [tid, at] of this.resolved) {
      if (this.sim.time - at >= RESOLVED_LINGER && this.sim.net.transitions.has(tid)) this.sim.removeTransition(tid);
    }
    if (!this.complete && this.resolved.size === new Set(this.level.goals.map((g) => g.sinkId)).size) {
      this.complete = true;
      this.completedAt = this.sim.time;
    }
  }

  /** World size, matching the current orientation. */
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

function bump(m: Map<string, number>, key: string): void {
  m.set(key, (m.get(key) ?? 0) + 1);
}

function deliveryKey(sinkId: string, c: Color): string {
  return `${sinkId}:${c}`;
}
