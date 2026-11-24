import { COLORS, expand, total, type Color } from "../core/multiset";
import { Net, type Transition } from "../core/net";
import { Simulation } from "../core/simulation";
import type { Goal, Kit, Level } from "./level";
import { PLACE_CAPACITIES, placeRadius } from "./placeSize";
import { POWERUPS, type Powerup } from "./powerups";

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
export const CLEARANCE = 16;
/** Interval of a transition upgraded to fire automatically. */
export const AUTO_INTERVAL = 4;
export const FASTER_FACTOR = 0.6;
export const MIN_INTERVAL = 0.6;
export const UPGRADE_COST = 5;
export const STARTING_COINS = 40;
export const EXHAUSTED_SOURCE_REWARD = 5;
export const MAX_LIVES = 10;
export const LIFE_COST = 50;
export const LIFE_PRICE_INCREASE = 10;
export const LIFE_OFFER_CHANCE = 0.02;

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
/** Unconnected one-token places expire after this many seconds without use. */
export const UNUSED_PLACE_LIFETIME = 120;
export const POWERUP_LIFETIME = 120;
export const ENDLESS_EPOCH_PROGRESS = 60;
export const EMISSION_PROGRESS = 10;
export const ENDLESS_RULES = {
  blueOnlyEpochs: 5,
  redChance: 0.5,
  distantRedAfter: 10,
  variedRedAfter: 20,
  redFiveRoll: 0.75,
  redTenRoll: 0.9,
  blueDoubleFrom: 25,
  blueTripleAfter: 50,
  blueDoubleRoll: 0.75,
  blueTripleRoll: 0.9,
  greenFrom: 40,
  greenChance: 0.1,
  redSoloFrom: 75,
  yellowFrom: 100,
  yellowChance: 0.1,
} as const;
const SINK_GRACE = 180;
const SOURCE_IDLE = 240;
const COUNTDOWN = 60;
const DELIVERY_EXTENSION = 10;
const ENDLESS_STEP = 1 / 60;
const TIME_EPSILON = 1e-8;

interface Countdown {
  startsAt: number;
  deadline: number;
  duration: number;
}

export interface CoinEvent {
  amount: number;
  x: number;
  y: number;
}

export interface SinkNotice {
  sinkId: string;
  color: Color;
  x: number;
  y: number;
}

export interface PowerupOffer {
  id: string;
  x: number;
  y: number;
  expiresAt: number;
  choices: [Powerup, Powerup];
}

/** Game rules on top of the net simulation: goals at sinks and source difficulty ramp. */
export class Game {
  readonly sim: Simulation;
  /** True when node coordinates are transposed so the net flows top to bottom. */
  portrait = false;
  complete = false;
  paused = false;
  completedAt?: number;
  /** Goal tokens delivered during this endless run. */
  score = 0;
  private survivalActive: boolean;
  private survivalBaseline?: { score: number; epoch: number };
  private lifeBalance = MAX_LIVES;
  private purchasedLives = 0;
  survivalFailed = false;
  private coinBalance = STARTING_COINS;
  private paidUpgrades = 0;
  private readonly coinListeners: ((event: CoinEvent) => void)[] = [];
  private readonly lifeLostListeners: ((position: { x: number; y: number }) => void)[] = [];
  private readonly sinkDeathListeners: ((sink: SinkNotice) => void)[] = [];
  private readonly upgradeSpending = new Map<string, number>();
  private readonly autoUpgradeLevels = new Map<string, number>();
  private readonly inventory = new Map<string, number>();
  readonly offers = new Map<string, PowerupOffer>();
  offerVersion = 0;
  private nextOfferId = 1;
  /** Goal sinks whose goals are all met, with the time they were met. */
  readonly resolved = new Map<string, number>();
  /** Exhausted sources and the time their supply ran out. */
  readonly exhausted = new Map<string, number>();
  /** Transitions that timed out and the time their countdown expired. */
  readonly failed = new Map<string, number>();
  /** Creation times of spawned endless transitions, for their entrance animation. */
  readonly spawnedAt = new Map<string, number>();
  /** Matching tokens that reached each goal sink, per `sink:color`. */
  private readonly delivered = new Map<string, number>();
  /** Matching tokens consumed by each goal sink, including those still travelling into it. */
  private readonly reserved = new Map<string, number>();
  private goalDefinitions: Goal[];
  private nextRampAt: number;
  private readonly countdowns = new Map<string, Countdown>();
  private readonly unusedPlaces = new Map<string, number>();
  private unusedPlacesVersion = -1;
  private readonly endlessCenter?: Transition;
  private endlessProgress = 0;
  private endlessEpoch = 0;
  private redSurplus = 0;
  private pendingColor?: Color;
  private nextRedHasSource = true;
  private nextSpawnRetryAt = 0;
  private nextEndlessId = 1;

  constructor(readonly level: Level, private readonly random: () => number = Math.random, options: { survival?: boolean } = {}) {
    this.survivalActive = level.mode === "endless" && !!options.survival;
    for (const p of level.net.places) placeRadius(p.capacity);
    this.sim = new Simulation(new Net(level.net));
    this.goalDefinitions = level.goals.map((goal) => ({ ...goal }));
    this.nextRampAt = level.ramp.every;
    if (level.mode === "endless") {
      this.endlessCenter = [...this.sim.net.transitions.values()].find((t) => t.kind === "source" && t.supply === undefined);
      for (const goal of this.goalDefinitions) {
        const factor = goal.color === "yellow" ? 2 : 1;
        this.startCountdown(goal.sinkId, SINK_GRACE * factor, this.sim.time, COUNTDOWN * factor);
      }
    }
    this.syncUnusedPlaces();
    this.sim.onBeforeAutoFire(() => {
      if (this.level.mode === "endless") this.expireCountdowns();
      this.expireUnusedPlaces();
      return !this.survivalFailed;
    });
    this.sim.onArrive((_token, placeId, time) => this.touchPlace(placeId, time));
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
          this.changeCoins(EXHAUSTED_SOURCE_REWARD, transition);
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
      if (this.survivalFailed) return;
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

  /** Number of completed endless spawn epochs. */
  get epoch(): number {
    return this.endlessEpoch;
  }

  get coins(): number {
    return this.coinBalance;
  }

  get survival(): boolean {
    return this.survivalActive;
  }

  get survivalResult(): Readonly<{ score: number; epoch: number }> | undefined {
    return this.survivalBaseline;
  }

  get lives(): number {
    return this.lifeBalance;
  }

  get lifePrice(): number {
    return LIFE_COST + this.purchasedLives * LIFE_PRICE_INCREASE;
  }

  buyLife(position: { x: number; y: number }, apply = true): boolean {
    if (!this.survival || this.complete || this.paused || this.lives >= MAX_LIVES || this.coins < this.lifePrice) return false;
    if (apply) {
      const price = this.lifePrice;
      this.purchasedLives++;
      this.lifeBalance++;
      this.changeCoins(-price, position);
    }
    return true;
  }

  continueEndless(): void {
    if (!this.survival) return;
    this.survivalBaseline = { score: this.score, epoch: this.epoch };
    this.survivalActive = false;
    this.survivalFailed = false;
    this.complete = false;
    this.completedAt = undefined;
    this.paused = false;
  }

  /** Price of the next paid upgrade, shared by both upgrade tools. */
  get upgradePrice(): number {
    return UPGRADE_COST + this.paidUpgrades;
  }

  autoUpgradeLevel(tid: string): number {
    return this.autoUpgradeLevels.get(tid) ?? 0;
  }

  onCoins(fn: (event: CoinEvent) => void): void {
    this.coinListeners.push(fn);
  }

  onLifeLost(fn: (position: { x: number; y: number }) => void): void {
    this.lifeLostListeners.push(fn);
  }

  onSinkDeath(fn: (sink: SinkNotice) => void): void {
    this.sinkDeathListeners.push(fn);
  }

  endangeredSinks(): (SinkNotice & { remaining: number })[] {
    const sinks: (SinkNotice & { remaining: number })[] = [];
    for (const [tid, countdown] of this.countdowns) {
      const t = this.sim.net.transitions.get(tid);
      if (t?.kind === "sink" && !t.ghost && this.sim.time + TIME_EPSILON >= countdown.startsAt
        && this.sim.time + TIME_EPSILON < countdown.deadline) {
        sinks.push({ ...this.sinkNotice(t), remaining: countdown.deadline - this.sim.time });
      }
    }
    return sinks;
  }

  private sinkNotice(t: Transition): SinkNotice {
    const goal = this.goalsOf(t.id)[0];
    if (!goal) throw new Error(`Countdown sink ${t.id} has no goal`);
    return { sinkId: t.id, color: goal.color, x: t.x, y: t.y };
  }

  powerupStock(id: string): number {
    return this.inventory.get(id) ?? 0;
  }

  availableKits(): Kit[] {
    if (!this.level.tools) return [];
    const kits = [...(this.level.tools?.kits ?? [])];
    for (const powerup of POWERUPS) {
      if (powerup.kind === "kit" && this.powerupStock(powerup.id) > 0) kits.push(powerup.kit);
    }
    return kits;
  }

  kitPowerup(kit: Kit): Extract<Powerup, { kind: "kit" }> | undefined {
    return POWERUPS.find((powerup): powerup is Extract<Powerup, { kind: "kit" }> =>
      powerup.kind === "kit" && powerup.kit === kit);
  }

  collectOffer(id: string, index: number): boolean {
    const offer = this.offers.get(id);
    if (this.complete || !offer || this.sim.time >= offer.expiresAt || (index !== 0 && index !== 1)) return false;
    const choice = offer.choices[index];
    if (choice.kind === "life" && this.survival && this.lives >= MAX_LIVES) return false;
    this.offers.delete(id);
    this.offerVersion++;
    if (choice.kind === "coins") this.changeCoins(choice.amount, offer);
    else if (choice.kind === "life") {
      if (this.survival) this.lifeBalance++;
      else this.changeCoins(5, offer);
    } else this.inventory.set(choice.id, this.powerupStock(choice.id) + 1);
    return true;
  }

  private spawnOffer(position: { x: number; y: number }, at: number): void {
    const expiresAt = at + POWERUP_LIFETIME;
    if (this.sim.time >= expiresAt) return;
    const eligible = POWERUPS.filter((powerup) => powerup.kind !== "life" && this.endlessEpoch >= powerup.afterEpoch);
    const first = eligible.splice(Math.floor(this.random() * eligible.length), 1)[0];
    let second = eligible[Math.floor(this.random() * eligible.length)];
    const life = POWERUPS.find((powerup) => powerup.kind === "life")!;
    if (this.survival && this.lives < MAX_LIVES && this.epoch >= life.afterEpoch
      && this.random() < LIFE_OFFER_CHANCE * (this.lives <= 3 ? 2 : 1)) second = life;
    const id = `offer${this.nextOfferId++}`;
    this.offers.set(id, { id, x: position.x, y: position.y, expiresAt, choices: [first, second] });
    this.offerVersion++;
  }

  private expireOffers(): void {
    for (const offer of this.offers.values()) {
      if (this.sim.time < offer.expiresAt) continue;
      this.offers.delete(offer.id);
      this.offerVersion++;
    }
  }

  private changeCoins(amount: number, position: { x: number; y: number }): void {
    if (amount === 0) return;
    this.coinBalance += amount;
    for (const fn of this.coinListeners) fn({ amount, x: position.x, y: position.y });
  }

  private buyUpgrade(node: { id: string; x: number; y: number }): void {
    const price = this.upgradePrice;
    this.upgradeSpending.set(node.id, (this.upgradeSpending.get(node.id) ?? 0) + price);
    this.paidUpgrades++;
    this.changeCoins(-price, node);
  }

  private useUpgrade(kind: "auto" | "capacity", node: { id: string; x: number; y: number }): void {
    const stock = this.powerupStock(kind);
    if (stock > 0) this.inventory.set(kind, stock - 1);
    else this.buyUpgrade(node);
  }

  private refundUpgrade(node: { id: string; x: number; y: number }): void {
    const spent = this.upgradeSpending.get(node.id) ?? 0;
    this.upgradeSpending.delete(node.id);
    this.changeCoins(Math.round(spent / 2), node);
  }

  /** Player interaction: only non-automatic transitions can be fired by hand. */
  playerFire(tid: string): boolean {
    const t = this.sim.net.transitions.get(tid);
    if (!t || t.kind !== "normal" || this.complete || this.paused) return false;
    return this.sim.fire(tid);
  }

  /** Whether a node of `kind` may be built at (x, y) in current coordinates. */
  placementIssue(kind: NodeKind, x: number, y: number): PlacementIssue | undefined {
    const net = this.sim.net;
    const nodes = [...net.places.values(), ...net.transitions.values()];
    for (const n of nodes) {
      const otherKind = net.places.has(n.id) ? "place" : "transition";
      if (Math.hypot(n.x - x, n.y - y) < placementClearance(kind, otherKind)) return "crowded";
    }
    if (!net.liveNodes().some((n) => Math.hypot(n.x - x, n.y - y) <= BUILD_RANGE)) return "far";
    return undefined;
  }

  buildPlace(x: number, y: number, capacity?: (typeof PLACE_CAPACITIES)[number]): string | undefined {
    if (this.complete || !this.level.tools?.place || this.placementIssue("place", x, y)) return undefined;
    const net = this.sim.net;
    const id = net.freshId("p");
    net.addPlace({ id, x, y, capacity, marking: [] });
    this.syncUnusedPlaces();
    return id;
  }

  /** Builds a one-token place and connects it to a live open port. */
  buildConnectedPlace(tid: string, index: number, x: number, y: number): string | undefined {
    const net = this.sim.net;
    if (!this.canConnectAt(tid, index, x, y)) return undefined;
    const id = this.buildPlace(x, y, 1);
    if (id === undefined) return undefined;
    net.connect(tid, index, id);
    this.syncUnusedPlaces();
    return id;
  }

  /** Available color-preserving one-to-one kit, if building it is enabled. */
  relayKit(): Kit | undefined {
    return this.level.tools?.kits?.find((kit) => kit.ports.length === 2
      && kit.ports.every((port) => !port.color && (port.count ?? 1) === 1)
      && kit.ports.some((port) => port.dir === "in")
      && kit.ports.some((port) => port.dir === "out"));
  }

  /** Whether a new relay can be built and connected from a place at this point. */
  canBuildConnectedTransition(pid: string, x: number, y: number): boolean {
    const place = this.sim.net.places.get(pid);
    return !!place && !place.ghost && !this.complete && !!this.relayKit()
      && withinConnectionRange(place, { x, y }) && !this.placementIssue("transition", x, y);
  }

  /** Builds a relay with its input connected to the selected place. */
  buildConnectedTransition(pid: string, x: number, y: number): string | undefined {
    const kit = this.relayKit();
    if (!kit || !this.canBuildConnectedTransition(pid, x, y)) return undefined;
    const id = this.buildTransition(kit, x, y);
    if (id === undefined) throw new Error("Could not build a validated connected transition");
    const input = kit.ports.findIndex((port) => port.dir === "in");
    if (!this.connect(id, input, pid)) throw new Error("Could not connect a validated transition");
    return id;
  }

  /** Whether an open port can reach a point in the current world coordinates. */
  canConnectAt(tid: string, index: number, x: number, y: number): boolean {
    const t = this.sim.net.transitions.get(tid);
    return !!t && !this.complete && !t.ghost && !!t.open?.[index]
      && withinConnectionRange(t, { x, y });
  }

  /** Builds a transition from `kit` with all ports open; it is enabled once they are connected. */
  canBuildTransition(kit: Kit, x: number, y: number): boolean {
    if (this.complete || this.placementIssue("transition", x, y)) return false;
    if (this.level.tools?.kits?.includes(kit)) return true;
    const powerup = this.kitPowerup(kit);
    return !!this.level.tools && !!powerup && this.powerupStock(powerup.id) > 0 && this.coins >= powerup.price;
  }

  buildTransition(kit: Kit, x: number, y: number): string | undefined {
    if (!this.canBuildTransition(kit, x, y)) return undefined;
    const net = this.sim.net;
    const id = net.freshId("t");
    net.addTransition({ id, x, y, kind: "normal", open: kit.ports, copyInputColor: kit.copyInputColor });
    net.validateTransition(id);
    const powerup = this.kitPowerup(kit);
    if (powerup && !this.level.tools?.kits?.includes(kit)) {
      this.inventory.set(powerup.id, this.powerupStock(powerup.id) - 1);
      this.changeCoins(-powerup.price, { x, y });
    }
    return id;
  }

  /** Connects open port `index` of transition `tid` to place `pid`; only checks if `apply` is false. */
  connect(tid: string, index: number, pid: string, apply = true): boolean {
    const net = this.sim.net;
    const p = net.places.get(pid);
    if (!p || p.ghost || !this.canConnectAt(tid, index, p.x, p.y)) return false;
    if (apply) {
      this.syncUnusedPlaces();
      net.connect(tid, index, pid);
      this.syncUnusedPlaces();
    }
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
      if (apply) {
        this.syncUnusedPlaces();
        net.ghostArc(id);
        this.syncUnusedPlaces();
      }
      return true;
    }
    const t = net.transitions.get(id);
    if (t && !t.ghost && t.kind === "normal" && this.goalsOf(id).length === 0) {
      if (apply) {
        this.syncUnusedPlaces();
        this.refundUpgrade(t);
        this.autoUpgradeLevels.delete(t.id);
        net.ghostTransition(id);
        this.syncUnusedPlaces();
      }
      return true;
    }
    const p = net.places.get(id);
    if (p && !p.ghost) {
      if (apply) {
        this.changeCoins(p.marking.length, p);
        this.refundUpgrade(p);
        net.ghostPlace(id);
        this.syncUnusedPlaces();
      }
      return true;
    }
    return false;
  }

  /** Automates a manual transition, or speeds up one that is already automatic. */
  upgradeAuto(tid: string, apply = true): boolean {
    const t = this.sim.net.transitions.get(tid);
    if (this.complete || !this.level.tools?.auto || !t || t.ghost || t.kind !== "normal"
      || (this.powerupStock("auto") === 0 && this.coins < this.upgradePrice)) return false;
    if (t.autoInterval && t.autoInterval <= MIN_INTERVAL) return false;
    if (apply) {
      t.autoInterval = t.autoInterval ? Math.max(MIN_INTERVAL, t.autoInterval * FASTER_FACTOR) : AUTO_INTERVAL;
      this.useUpgrade("auto", t);
      this.autoUpgradeLevels.set(tid, this.autoUpgradeLevel(tid) + 1);
    }
    return true;
  }

  upgradeCapacity(pid: string, apply = true): boolean {
    const p = this.sim.net.places.get(pid);
    if (this.complete || !this.level.tools?.capacity || !p || p.ghost
      || (this.powerupStock("capacity") === 0 && this.coins < this.upgradePrice)) return false;
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
    this.useUpgrade("capacity", p);
    this.sim.net.version++;
    this.syncUnusedPlaces();
    return true;
  }

  /** Advances the game; frozen while paused or once the level is won. */
  step(dt: number): void {
    if (this.complete || this.paused) return;
    if (this.level.mode !== "endless") {
      this.advance(dt);
      return;
    }
    if (dt === 0) this.spawnEndless();
    for (let remaining = dt; remaining > 1e-9;) {
      const step = Math.min(remaining, ENDLESS_STEP);
      this.advance(step);
      if (this.complete) break;
      remaining -= step;
    }
  }

  private advance(dt: number): void {
    if (this.level.mode === "endless") this.endlessProgress += dt;
    this.sim.step(dt);
    if (this.survivalFailed) return;
    this.expireOffers();
    this.rampSources();
    for (const [tid, at] of this.resolved) {
      if (this.sim.time - at < RESOLVED_LINGER) continue;
      const sink = this.sim.net.transitions.get(tid);
      if (sink) {
        this.spawnOffer(sink, at + RESOLVED_LINGER);
        this.sim.removeTransition(tid);
        this.spawnedAt.delete(tid);
      }
      if (this.level.mode === "endless") {
        this.forgetGoal(tid);
        this.resolved.delete(tid);
      }
    }
    for (const [tid, at] of this.exhausted) {
      const t = this.sim.net.transitions.get(tid);
      if (!t) {
        this.exhausted.delete(tid);
        this.spawnedAt.delete(tid);
      }
      else if (!t.ghost && this.sim.time - at >= RESOLVED_LINGER) this.sim.net.ghostTransition(tid);
    }
    for (const [tid, at] of this.failed) {
      const t = this.sim.net.transitions.get(tid);
      if (!t) {
        this.failed.delete(tid);
        this.spawnedAt.delete(tid);
      }
      else if (this.sim.time - at >= RESOLVED_LINGER) {
        if (t.kind === "sink") {
          this.sim.removeTransition(tid);
          this.spawnedAt.delete(tid);
          this.forgetGoal(tid);
          this.failed.delete(tid);
        } else if (!t.ghost) this.sim.net.ghostTransition(tid);
      }
    }
    this.expireUnusedPlaces();
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
    for (const offer of this.offers.values()) [offer.x, offer.y] = [offer.y, offer.x];
    this.offerVersion++;
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

  /** Records interaction or a token arrival at an unconnected small place. */
  touchPlace(pid: string, time = this.sim.time): void {
    this.syncUnusedPlaces();
    const since = this.unusedPlaces.get(pid);
    if (since !== undefined && time >= since && time - since < UNUSED_PLACE_LIFETIME - TIME_EPSILON) {
      this.unusedPlaces.set(pid, time);
    }
  }

  private syncUnusedPlaces(): void {
    const net = this.sim.net;
    if (this.unusedPlacesVersion === net.version) return;
    const connected = new Set<string>();
    for (const arc of net.arcs.values()) {
      if (!arc.ghost) {
        connected.add(arc.from);
        connected.add(arc.to);
      }
    }
    for (const p of net.places.values()) {
      if (p.ghost || p.capacity !== 1 || connected.has(p.id)) this.unusedPlaces.delete(p.id);
      else if (!this.unusedPlaces.has(p.id)) this.unusedPlaces.set(p.id, this.sim.time);
    }
    for (const id of this.unusedPlaces.keys()) if (!net.places.has(id)) this.unusedPlaces.delete(id);
    this.unusedPlacesVersion = net.version;
  }

  private expireUnusedPlaces(): void {
    this.syncUnusedPlaces();
    for (const [id, since] of this.unusedPlaces) {
      if (this.sim.time - since + TIME_EPSILON < UNUSED_PLACE_LIFETIME) continue;
      this.sim.net.ghostPlace(id);
      this.unusedPlaces.delete(id);
    }
  }

  /** Fraction of the final countdown remaining, or undefined before it starts. */
  countdownProgress(tid: string): number | undefined {
    const countdown = this.countdowns.get(tid);
    if (!countdown || this.sim.time + TIME_EPSILON < countdown.startsAt) return undefined;
    return Math.max(0, Math.min(1, (countdown.deadline - this.sim.time) / countdown.duration));
  }

  private startCountdown(tid: string, grace: number, at = this.sim.time, duration = COUNTDOWN): void {
    const startsAt = at + grace;
    this.countdowns.set(tid, { startsAt, deadline: startsAt + duration, duration });
  }

  private expireCountdowns(): void {
    for (const [tid, countdown] of this.countdowns) {
      if (this.sim.time + TIME_EPSILON >= countdown.deadline) this.failTransition(tid, countdown.deadline);
    }
  }

  private failTransition(tid: string, at: number): void {
    if (this.failed.has(tid)) return;
    const t = this.sim.net.transitions.get(tid);
    if (!t) throw new Error(`Countdown transition ${tid} is missing`);
    t.disabled = true;
    if (t.open?.length) {
      t.open = [];
      this.sim.net.version++;
    }
    this.countdowns.delete(tid);
    this.failed.set(tid, at);
    if (t.kind === "sink") {
      const sink = this.sinkNotice(t);
      for (const fn of this.sinkDeathListeners) fn(sink);
    }
    if (t.kind === "sink" && this.survival && this.lives > 0) {
      this.lifeBalance--;
      for (const fn of this.lifeLostListeners) fn({ x: t.x, y: t.y });
      if (this.lives === 0) {
        this.survivalFailed = true;
        this.complete = true;
        this.completedAt = at;
      }
    }
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
      this.pendingColor ??= this.endlessColor();
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

  private endlessColor(): Color {
    if (this.endlessEpoch < ENDLESS_RULES.blueOnlyEpochs) return "blue";
    if (this.endlessEpoch === ENDLESS_RULES.blueOnlyEpochs) return "red";
    const epoch = this.endlessEpoch + 1;
    const green = epoch >= ENDLESS_RULES.greenFrom ? ENDLESS_RULES.greenChance : 0;
    const yellow = epoch >= ENDLESS_RULES.yellowFrom ? ENDLESS_RULES.yellowChance : 0;
    const roll = this.random();
    if (roll < yellow) return "yellow";
    if (roll < yellow + green) return "green";
    return roll < yellow + green + (1 - yellow - green) * ENDLESS_RULES.redChance ? "red" : "blue";
  }

  private spawnEndlessGoal(color: Color): boolean {
    const net = this.sim.net;
    const alternating = color === "red" && this.endlessEpoch + 1 >= ENDLESS_RULES.redSoloFrom;
    const withSource = color === "red" && (!alternating || this.nextRedHasSource);
    const positions = this.endlessPositions(withSource, color === "red");
    if (!positions) return false;

    const inputCount = color === "blue" ? this.blueSinkInputCount() : 1;
    const sinkId = net.freshId(`endless${this.nextEndlessId++}_`);
    net.addTransition({ id: sinkId, ...positions.sink, kind: "sink", autoInterval: 0.6, open: [{ dir: "in", color, count: inputCount }] });
    this.spawnedAt.set(sinkId, this.sim.time);
    let goalCount = color === "red" && this.endlessEpoch >= ENDLESS_RULES.variedRedAfter ? this.redCount()
      : color === "yellow" ? 10 * (1 + Math.floor(this.random() * 3)) : inputCount > 1 ? 6 : 5;
    // Keep five in reserve for the next unpaired sink without exceeding a source's 15-token maximum.
    if (alternating) goalCount = Math.min(goalCount, withSource ? 10 + this.redSurplus : this.redSurplus);
    this.goalDefinitions.push({ sinkId, color, count: goalCount });
    const factor = color === "yellow" ? 2 : 1;
    this.startCountdown(sinkId, SINK_GRACE * factor, this.sim.time, COUNTDOWN * factor);
    if (positions.source) {
      const proposedSupply = this.endlessEpoch >= ENDLESS_RULES.variedRedAfter ? this.redCount() : 5;
      const supply = Math.max(proposedSupply, goalCount - this.redSurplus + (alternating ? 5 : 0));
      this.redSurplus += supply - goalCount;
      const sourceId = net.freshId(`endless${this.nextEndlessId++}_`);
      net.addTransition({
        id: sourceId, ...positions.source, kind: "source", autoInterval: 3, supply, open: [{ dir: "out", color: "red" }],
      });
      this.spawnedAt.set(sourceId, this.sim.time);
      this.startCountdown(sourceId, SOURCE_IDLE);
    } else if (color === "red") {
      this.redSurplus -= goalCount;
    }
    if (alternating) this.nextRedHasSource = !this.nextRedHasSource;
    return true;
  }

  private blueSinkInputCount(): number {
    if (this.endlessEpoch + 1 < ENDLESS_RULES.blueDoubleFrom) return 1;
    const roll = this.random();
    if (this.endlessEpoch >= ENDLESS_RULES.blueTripleAfter && roll >= ENDLESS_RULES.blueTripleRoll) return 3;
    return roll >= ENDLESS_RULES.blueDoubleRoll ? 2 : 1;
  }

  private redCount(): number {
    const roll = this.random();
    return roll < ENDLESS_RULES.redFiveRoll ? 5 : roll < ENDLESS_RULES.redTenRoll ? 10 : 15;
  }

  private endlessPositions(withSource: boolean, red: boolean): { sink: { x: number; y: number }; source?: { x: number; y: number } } | undefined {
    const net = this.sim.net;
    const nodes = net.liveNodes();
    if (nodes.length === 0) throw new Error("Endless mode needs a live node to spawn near");
    const center = this.endlessCenter;
    if (!center || center.ghost || !net.transitions.has(center.id)) throw new Error("Endless mode needs its permanent starting source");
    const candidateAt = (anchor: { x: number; y: number }, angle: number) => {
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      const distant = red && this.endlessEpoch >= ENDLESS_RULES.distantRedAfter;
      const distance = distant ? BUILD_RANGE * 1.5 : BUILD_RANGE - 1;
      const sink = { x: anchor.x + dx * distance, y: anchor.y + dy * distance };
      const sinkIssue = this.placementIssue("transition", sink.x, sink.y);
      if (sinkIssue === "crowded" || (!distant && sinkIssue)) return undefined;
      if (distant) {
        const middle = { x: (anchor.x + sink.x) / 2, y: (anchor.y + sink.y) / 2 };
        if (this.placementIssue("place", middle.x, middle.y) === "crowded"
          || nodes.some((node) => Math.hypot(node.x - sink.x, node.y - sink.y) < BUILD_RANGE + 30)) return undefined;
      }
      if (!withSource) return { sink };
      const separation = distant ? BUILD_RANGE * 1.5 : BUILD_RANGE - 1;
      const source = { x: sink.x + dx * separation, y: sink.y + dy * separation };
      const middle = { x: (sink.x + source.x) / 2, y: (sink.y + source.y) / 2 };
      // The sink will be added first, making both the source and middle place reachable.
      if (this.placementIssue("transition", source.x, source.y) !== "crowded"
        && this.placementIssue("place", middle.x, middle.y) !== "crowded"
        && (!distant || nodes.every((node) => Math.hypot(node.x - source.x, node.y - source.y) >= BUILD_RANGE + 30))) return { sink, source };
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

export function placementClearance(kind: NodeKind, otherKind: NodeKind): number {
  return footprint(kind) + footprint(otherKind) + CLEARANCE;
}

function bump(m: Map<string, number>, key: string): void {
  m.set(key, (m.get(key) ?? 0) + 1);
}

function deliveryKey(sinkId: string, c: Color): string {
  return `${sinkId}:${c}`;
}
