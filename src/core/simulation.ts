import { addInto, total, type Color, type Multiset } from "./multiset";
import { arcCount, type Arc, type Net } from "./net";

/**
 * A token travelling along an arc.
 * - `input` tokens were consumed by a firing and travel from their place into the transition.
 * - `output` tokens were produced by a firing and travel from the transition to their place.
 *   They join the place's marking on arrival and cannot be consumed before that.
 */
export interface InFlightToken {
  id: number;
  color: Color;
  arcId: string;
  kind: "input" | "output";
  /** 0 at the arc's source node, 1 at its target node. */
  progress: number;
  /** The firing this token belongs to. */
  firingId: number;
  /** Index of this token among the tokens moved along its arc by one firing, and their count. */
  slot: number;
  batch: number;
  /** Source supply before this emission, when it was finite. */
  sourceSupplyBefore?: number;
  /** The matching sink goal's absolute delivery ordinal, assigned by the game. */
  goalOrdinal?: number;
}

/** The concrete tokens one firing moves along each of its arcs. */
interface Binding {
  inputs: { arc: Arc; colors: Color[] }[];
  outputs: { arc: Arc; colors: Color[] }[];
  /** Indices into each input place's marking that the firing removes. */
  taken: Map<string, Set<number>>;
}

/**
 * A firing in progress. Its inputs are already consumed and its outputs already committed
 * to their target places, but the outputs only start to travel once all inputs have arrived
 * at the transition.
 */
interface Firing {
  id: number;
  transitionId: string;
  pendingInputs: number;
  outputs: Binding["outputs"];
  consumed: Multiset;
  produced: Multiset;
  sourceSupplyBefore?: number;
}

export interface FireEvent {
  firingId: number;
  transitionId: string;
  consumed: Multiset;
  produced: Multiset;
  time: number;
}

export interface SimulationOptions {
  /** Speed of tokens in flight, in world units per second. */
  tokenSpeed?: number;
  /** Random source used to order competing automatic transitions. */
  random?: () => number;
}

export class Simulation {
  time = 0;
  readonly inFlight: InFlightToken[] = [];
  readonly tokenSpeed: number;
  private readonly random: () => number;
  private nextId = 1;
  private readonly firings = new Map<number, Firing>();
  /** Seconds accumulated towards the next auto-fire, per transition. */
  private readonly autoTimers = new Map<string, number>();
  private readonly fireListeners: ((e: FireEvent) => void)[] = [];
  private readonly completeListeners: ((e: FireEvent) => void)[] = [];
  private readonly arriveListeners: ((t: InFlightToken, placeId: string, time: number) => void)[] = [];
  private readonly inputArriveListeners: ((t: InFlightToken, transitionId: string, time: number) => void)[] = [];
  private readonly beforeAutoListeners: (() => boolean | void)[] = [];

  constructor(
    readonly net: Net,
    opts: SimulationOptions = {},
  ) {
    this.tokenSpeed = opts.tokenSpeed ?? 230;
    this.random = opts.random ?? Math.random;
  }

  /** Called when a transition fires (inputs consumed, outputs committed). */
  onFire(fn: (e: FireEvent) => void): void {
    this.fireListeners.push(fn);
  }

  /** Called when all inputs of a firing have reached the transition and its outputs start to travel. */
  onComplete(fn: (e: FireEvent) => void): void {
    this.completeListeners.push(fn);
  }

  onArrive(fn: (t: InFlightToken, placeId: string, time: number) => void): void {
    this.arriveListeners.push(fn);
  }

  /** Called when an input token reaches its transition. */
  onInputArrive(fn: (t: InFlightToken, transitionId: string, time: number) => void): void {
    this.inputArriveListeners.push(fn);
  }

  /** Called after arrivals, before automatic firing; returning false freezes the rest of this step. */
  onBeforeAutoFire(fn: () => boolean | void): void {
    this.beforeAutoListeners.push(fn);
  }

  /**
   * Enabled iff the settled markings of the input places can supply every input arc (in-flight tokens
   * never count), and no output place would exceed its capacity, counting tokens already committed to it.
   */
  isEnabled(tid: string): boolean {
    return this.bind(tid) !== undefined;
  }

  /** Fires `tid` if enabled. Inputs are consumed and outputs committed immediately; tokens then animate. */
  fire(tid: string): boolean {
    const b = this.bind(tid);
    if (!b) return false;
    const t = this.net.transitions.get(tid)!;
    for (const [pid, idx] of b.taken) {
      const place = this.net.places.get(pid)!;
      place.marking = place.marking.filter((_, i) => !idx.has(i));
    }
    const firing: Firing = {
      id: this.nextId++,
      transitionId: tid,
      pendingInputs: 0,
      outputs: b.outputs,
      consumed: toMultiset(b.inputs.flatMap((x) => x.colors)),
      produced: toMultiset(b.outputs.flatMap((x) => x.colors)),
      sourceSupplyBefore: t.kind === "source" ? t.supply : undefined,
    };
    for (const { arc, colors } of b.inputs) firing.pendingInputs += this.launch(arc, colors, "input", firing.id);
    this.firings.set(firing.id, firing);
    this.autoTimers.set(tid, 0);
    if (t.supply !== undefined) t.supply--;
    const e: FireEvent = { firingId: firing.id, transitionId: tid, consumed: firing.consumed, produced: firing.produced, time: this.time };
    for (const fn of this.fireListeners) fn(e);
    if (firing.pendingInputs === 0) this.complete(firing, 0);
    return true;
  }

  /** Progress of the auto-fire timer of `tid` in [0, 1], or undefined if it is not auto-firing. */
  autoProgress(tid: string): number | undefined {
    const t = this.net.transitions.get(tid);
    if (!t?.autoInterval) return undefined;
    return Math.min(1, (this.autoTimers.get(tid) ?? 0) / t.autoInterval);
  }

  /** Tokens committed to place `pid` but not yet arrived: in flight towards it or waiting in a firing. */
  incoming(pid: string): Multiset {
    const m: Multiset = {};
    for (const tok of this.inFlight) {
      if (tok.kind === "output" && this.net.arcs.get(tok.arcId)!.to === pid) addInto(m, { [tok.color]: 1 });
    }
    for (const f of this.firings.values()) {
      for (const { arc, colors } of f.outputs) if (arc.to === pid) addInto(m, toMultiset(colors));
    }
    return m;
  }

  /** Settled and travelling tokens, including inputs waiting for the rest of their firing. */
  liveTokens(): Multiset {
    const live: Multiset = {};
    for (const place of this.net.places.values()) addInto(live, toMultiset(place.marking));
    for (const token of this.inFlight) if (token.kind === "output") addInto(live, { [token.color]: 1 });
    for (const firing of this.firings.values()) addInto(live, firing.consumed);
    return live;
  }

  /** Settled plus incoming tokens of place `pid`; this is what its capacity limits. */
  occupancy(pid: string): number {
    return this.net.places.get(pid)!.marking.length + total(this.incoming(pid));
  }

  /**
   * Removes transition `tid` and its arcs. Tokens travelling on those arcs and firings in progress
   * of `tid` are dropped.
   */
  removeTransition(tid: string): void {
    const arcIds = new Set(this.net.removeTransition(tid).map((a) => a.id));
    const kept = this.inFlight.filter((tok) => !arcIds.has(tok.arcId));
    this.inFlight.length = 0;
    this.inFlight.push(...kept);
    for (const [id, f] of this.firings) if (f.transitionId === tid) this.firings.delete(id);
    this.autoTimers.delete(tid);
  }

  /** True while `tid` has a firing whose outputs have not started to travel yet. */
  isBusy(tid: string): boolean {
    for (const f of this.firings.values()) if (f.transitionId === tid) return true;
    return false;
  }

  step(dt: number): void {
    this.time += dt;
    this.advanceTokens(dt);
    for (const fn of this.beforeAutoListeners) if (fn() === false) return;
    this.runAutoFire(dt);
    this.collectGhosts();
  }

  /** Deletes ghosts that have nothing left to do: arcs without tokens, then nodes without arcs. */
  private collectGhosts(): void {
    const net = this.net;
    const busyArcs = new Set(this.inFlight.map((tok) => tok.arcId));
    for (const f of this.firings.values()) for (const { arc } of f.outputs) busyArcs.add(arc.id);
    for (const a of [...net.arcs.values()]) if (a.ghost && !busyArcs.has(a.id)) net.deleteArc(a.id);
    for (const t of [...net.transitions.values()]) {
      if (t.ghost && !this.isBusy(t.id) && net.arcsOf(t.id).length === 0) {
        net.deleteNode(t.id);
        this.autoTimers.delete(t.id);
      }
    }
    for (const p of [...net.places.values()]) if (p.ghost && net.arcsOf(p.id).length === 0) net.deleteNode(p.id);
  }

  /** Chooses the tokens a firing of `tid` would move, or undefined if `tid` is not enabled. */
  private bind(tid: string): Binding | undefined {
    const t = this.net.transitions.get(tid);
    if (!t || t.disabled || t.ghost || (t.open?.length ?? 0) > 0 || t.supply === 0) return undefined;
    const inputArcs = this.net.inputs(tid);
    const taken = new Map<string, Set<number>>();
    const chosen = new Map<Arc, Color[]>();
    // Colored arcs first, so "any" arcs cannot steal tokens a colored arc needs; oldest tokens first.
    const ordered = [...inputArcs.filter((a) => a.color), ...inputArcs.filter((a) => !a.color)];
    for (const arc of ordered) {
      const marking = this.net.places.get(arc.from)!.marking;
      const used = taken.get(arc.from) ?? new Set<number>();
      taken.set(arc.from, used);
      const colors: Color[] = [];
      for (let i = 0; i < marking.length && colors.length < arcCount(arc); i++) {
        if (used.has(i) || (arc.color && marking[i] !== arc.color)) continue;
        used.add(i);
        colors.push(marking[i]);
      }
      if (colors.length < arcCount(arc)) return undefined;
      chosen.set(arc, colors);
    }
    const inputs = inputArcs.map((arc) => ({ arc, colors: chosen.get(arc)! }));

    const pool = inputs.filter((x) => !x.arc.color).flatMap((x) => x.colors);
    if (t.copyInputColor) pool.push(pool[0]);
    const outputs = this.net.outputs(tid).map((arc) => ({
      arc,
      colors: arc.color ? Array<Color>(arcCount(arc)).fill(arc.color) : pool.splice(0, arcCount(arc)),
    }));

    const delta = new Map<string, number>();
    for (const { arc, colors } of inputs) delta.set(arc.from, (delta.get(arc.from) ?? 0) - colors.length);
    for (const { arc, colors } of outputs) delta.set(arc.to, (delta.get(arc.to) ?? 0) + colors.length);
    for (const [pid, d] of delta) {
      const cap = this.net.places.get(pid)!.capacity;
      if (cap !== undefined && d > 0 && this.occupancy(pid) + d > cap) return undefined;
    }
    return { inputs, outputs, taken };
  }

  /** Starts the outputs of `f`; `elapsed` is how long ago its last input arrived. */
  private complete(f: Firing, elapsed: number): void {
    this.firings.delete(f.id);
    for (const { arc, colors } of f.outputs) this.launch(arc, colors, "output", f.id, elapsed, f.sourceSupplyBefore);
    const e: FireEvent = { firingId: f.id, transitionId: f.transitionId, consumed: f.consumed, produced: f.produced, time: this.time - elapsed };
    for (const fn of this.completeListeners) fn(e);
  }

  /** Puts `colors` in flight along `a`, `elapsed` seconds along; returns how many were launched. */
  private launch(a: Arc, colors: Color[], kind: InFlightToken["kind"], firingId: number, elapsed = 0, sourceSupplyBefore?: number): number {
    const progress = (elapsed * this.tokenSpeed) / this.length(a);
    colors.forEach((color, slot) => {
      this.inFlight.push({ id: this.nextId++, color, arcId: a.id, kind, progress, firingId, slot, batch: colors.length,
        ...(sourceSupplyBefore !== undefined ? { sourceSupplyBefore } : {}) });
    });
    return colors.length;
  }

  private length(a: Arc): number {
    return Math.max(1, this.net.arcLength(a));
  }

  private advanceTokens(dt: number): void {
    for (const tok of this.inFlight) tok.progress += (this.tokenSpeed * dt) / this.length(this.net.arcs.get(tok.arcId)!);
    // Arrivals can launch outputs that arrive within the same step, so repeat until nothing arrives.
    for (;;) {
      const arrived: { tok: InFlightToken; overshoot: number }[] = [];
      let w = 0;
      for (const tok of this.inFlight) {
        if (tok.progress >= 1) {
          const len = this.length(this.net.arcs.get(tok.arcId)!);
          arrived.push({ tok, overshoot: ((tok.progress - 1) * len) / this.tokenSpeed });
        } else this.inFlight[w++] = tok;
      }
      this.inFlight.length = w;
      if (arrived.length === 0) return;
      // Earliest arrival first, i.e. largest overshoot first.
      arrived.sort((x, y) => y.overshoot - x.overshoot);
      for (const { tok, overshoot } of arrived) this.arrive(tok, overshoot);
    }
  }

  private arrive(tok: InFlightToken, overshoot: number): void {
    const arc = this.net.arcs.get(tok.arcId)!;
    if (tok.kind === "output") {
      const place = this.net.places.get(arc.to)!;
      // Removed places swallow their arrivals.
      if (!place.ghost) place.marking.push(tok.color);
      for (const fn of this.arriveListeners) fn(tok, arc.to, this.time - overshoot);
      return;
    }
    const f = this.firings.get(tok.firingId)!;
    for (const fn of this.inputArriveListeners) fn(tok, f.transitionId, this.time - overshoot);
    if (--f.pendingInputs === 0) this.complete(f, overshoot);
  }

  private runAutoFire(dt: number): void {
    const ready: string[] = [];
    for (const t of this.net.transitions.values()) {
      if (!t.autoInterval || t.ghost) continue;
      const acc = (this.autoTimers.get(t.id) ?? 0) + dt;
      // The timer saturates while the transition is disabled, so it fires as soon as it becomes enabled.
      this.autoTimers.set(t.id, Math.min(acc, t.autoInterval));
      if (acc >= t.autoInterval) ready.push(t.id);
    }
    for (let i = ready.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [ready[i], ready[j]] = [ready[j], ready[i]];
    }
    for (const tid of ready) this.fire(tid);
  }
}

function toMultiset(colors: Color[]): Multiset {
  const m: Multiset = {};
  for (const c of colors) m[c] = (m[c] ?? 0) + 1;
  return m;
}
