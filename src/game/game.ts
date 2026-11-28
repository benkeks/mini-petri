import { COLORS, expand, total, type Color, type Multiset } from "../core/multiset";
import { arcCount, Net, type Arc, type Place, type Transition } from "../core/net";
import { Simulation } from "../core/simulation";
import type { Goal, Kit, Level } from "./level";
import { PLACE_CAPACITIES, placeLevel, placeRadius } from "./placeSize";
import { POWERUPS, type Powerup } from "./powerups";
import { Statistics } from "./statistics";
import { distanceToPolyline, outsidePlace, transitionLayout, type Pt } from "../render/geometry";

/** Base build distance for transitions and the smallest places. */
export const BUILD_RANGE = 220;
export function buildRange(node: Place | Transition): number {
  return "kind" in node ? BUILD_RANGE : BUILD_RANGE + (BUILD_RANGE / 5) * placeLevel(node.capacity);
}
/** Base center-to-center arc reach for a one-token place. */
export const CONNECTION_RANGE = BUILD_RANGE + 80;
export function connectionRange(node: { x: number; y: number; capacity?: number }): number {
  return node.capacity === undefined ? CONNECTION_RANGE : CONNECTION_RANGE + (CONNECTION_RANGE / 5) * placeLevel(node.capacity);
}

export function withinConnectionRange(a: { x: number; y: number; capacity?: number }, b: { x: number; y: number; capacity?: number }): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= Math.max(connectionRange(a), connectionRange(b));
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
export const UNUSED_PLACE_LIFETIME = 30;
export const STARTER_SOURCE_LIMIT_EPOCH = 2000;
export const STARTER_SOURCE_SUPPLY = 50;
export const POWERUP_LIFETIME = 120;
export const ENDLESS_EPOCH_PROGRESS = 60;
export const EMISSION_PROGRESS = 6;
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
  doubledDemandFrom: 125,
  blueRedFrom: 175,
  variedBlueRedFrom: 450,
  yellowGreenFrom: 250,
  quadrupleFrom: 350,
  variedQuadrupleFrom: 550,
  pairChance: 0.1,
  quadrupleChance: 0.05,
  redSourcesUntil: 625,
} as const;
const SINK_GRACE = 180;
const SOURCE_IDLE = 240;
const COUNTDOWN = 60;
const DELIVERY_EXTENSION = 10;
const INFINITE_SINK_IDLE = 150;
const ENDLESS_STEP = 1 / 60;
const TIME_EPSILON = 1e-8;
const SPAWN_ARC_CLEARANCE = 45;

interface Countdown {
  startsAt: number;
  deadline: number;
  duration: number;
}

interface EndlessDemand {
  colors: readonly Color[];
  /** Permanent sinks are restricted to this central fraction of the current map extent. */
  centralFraction?: number;
  milestone?: number;
}

interface EndlessPositions {
  sink: { x: number; y: number };
  source?: { x: number; y: number };
}

interface SpawnRoute {
  points: Pt[];
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const PERMANENT_SINKS: readonly EndlessDemand[] = [
  { milestone: 300, colors: ["blue"], centralFraction: 0.3 },
  { milestone: 400, colors: ["red"], centralFraction: 0.5 },
  { milestone: 500, colors: ["green"], centralFraction: 0.65 },
  { milestone: 600, colors: ["yellow"], centralFraction: 0.75 },
  { milestone: 725, colors: ["red", "blue"], centralFraction: 1 },
  { milestone: 850, colors: ["yellow", "green"], centralFraction: 1 },
  { milestone: 1000, colors: ["blue", "red", "green", "yellow"], centralFraction: 1 },
];

export interface CoinEvent {
  amount: number;
  x: number;
  y: number;
}

export interface SinkNotice {
  sinkId: string;
  color: Color;
  colors: Color[];
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
  readonly statistics: Statistics;
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
  private lostLife = false;
  private purchasedLives = 0;
  survivalFailed = false;
  private coinBalance = STARTING_COINS;
  private paidUpgrades = 0;
  private readonly coinListeners: ((event: CoinEvent) => void)[] = [];
  private readonly lifeListeners: ((amount: number) => void)[] = [];
  private readonly deliveryListeners: ((colors: Multiset) => void)[] = [];
  private readonly insufficientCoinsListeners: (() => void)[] = [];
  private readonly lifeLostListeners: ((position: { x: number; y: number }) => void)[] = [];
  private readonly sinkDeathListeners: ((sink: SinkNotice) => void)[] = [];
  private readonly upgradeSpending = new Map<string, number>();
  private readonly autoUpgradeLevels = new Map<string, number>();
  private readonly builtTransitions = new Set<string>();
  private readonly inventory = new Map<string, number>();
  readonly offers = new Map<string, PowerupOffer>();
  offerVersion = 0;
  private nextOfferId = 1;
  /** Goal sinks whose goals are all met, with the time they were met. */
  readonly resolved = new Map<string, number>();
  /** Exhausted sources and the time their supply ran out. */
  readonly exhausted = new Map<string, number>();
  private readonly rewardedSources = new Set<string>();
  /** Transitions that timed out and the time their countdown expired. */
  readonly failed = new Map<string, number>();
  /** Creation times of spawned endless transitions, for their entrance animation. */
  readonly spawnedAt = new Map<string, number>();
  /** Matching tokens that reached each goal sink, per `sink:color`. */
  private readonly delivered = new Map<string, number>();
  /** Matching tokens consumed by each goal sink, including those still travelling into it. */
  private readonly reserved = new Map<string, number>();
  private readonly completedGoalOrdinals = new Map<string, Set<number>>();
  private readonly firingGoalOrdinals = new Map<number, { sinkId: string; key: string; ordinal: number }[]>();
  private goalDefinitions: Goal[];
  private nextRampAt: number;
  private readonly countdowns = new Map<string, Countdown>();
  private readonly unusedPlaces = new Map<string, number>();
  private unusedPlacesVersion = -1;
  private connectorSpaceVersion = -1;
  private readonly connectorSpace = new Map<string, boolean>();
  private readonly endlessCenter?: Transition;
  private endlessProgress = 0;
  private endlessEpoch = 0;
  private redSurplus = 0;
  private pendingEpoch?: { remaining: number; demand?: EndlessDemand };
  private permanentBluePosition?: { x: number; y: number };
  private nextRedHasSource = true;
  private nextSpawnRetryAt = 0;
  private nextEndlessId = 1;

  constructor(readonly level: Level, private readonly random: () => number = Math.random, options: { survival?: boolean; snapshot?: GameSnapshot } = {}) {
    this.survivalActive = level.mode === "endless" && !!options.survival;
    for (const p of level.net.places) placeRadius(p.capacity);
    if (options.snapshot) validateSavedNet(options.snapshot);
    this.sim = new Simulation(new Net(options.snapshot?.net ?? level.net, !options.snapshot));
    this.statistics = new Statistics(this.sim.liveTokens());
    for (const transition of this.sim.net.transitions.values()) {
      if (transition.kind !== "sink") continue;
      const goals = level.goals.filter((goal) => goal.sinkId === transition.id);
      const inputs = this.sim.net.inputs(transition.id);
      const colors = goals.length ? [...new Set(goals.map((goal) => goal.color))] : COLORS.filter((color) =>
        inputs.some((arc) => arc.color === color)
        || transition.open?.some((port) => port.dir === "in" && port.color === color));
      this.statistics.recordSinkCreation(this.sim.time, colors);
    }
    this.goalDefinitions = level.goals.map((goal) => ({ ...goal }));
    this.nextRampAt = level.ramp.every;
    if (level.mode === "endless") {
      const savedCenter = options.snapshot?.endlessCenter;
      this.endlessCenter = savedCenter
        ? this.sim.net.transitions.get(savedCenter.id) ?? { ...savedCenter }
        : [...this.sim.net.transitions.values()].find((t) => t.kind === "source" && t.supply === undefined);
      for (const sinkId of new Set(this.goalDefinitions.map((goal) => goal.sinkId))) {
        const factor = this.goalsOf(sinkId).some((goal) => goal.color === "yellow") ? 2 : 1;
        this.startCountdown(sinkId, SINK_GRACE * factor, this.sim.time, COUNTDOWN * factor);
      }
    }
    this.syncUnusedPlaces();
    this.sim.onBeforeAutoFire(() => {
      if (this.level.mode === "endless") this.expireCountdowns();
      this.expireUnusedPlaces();
      return !this.survivalFailed;
    });
    this.sim.onArrive((_token, placeId, time) => this.touchPlace(placeId, time));
    this.sim.onInputArrive((_token, tid, time) => {
      if (this.survivalFailed) return;
      const countdown = this.countdowns.get(tid);
      const goals = this.goalsOf(tid);
      if (!countdown || !goals.length || !goals.every((goal) => !Number.isFinite(goal.count))) return;
      if (time + TIME_EPSILON >= countdown.deadline) {
        this.failTransition(tid, countdown.deadline);
        return;
      }
      this.startCountdown(tid, INFINITE_SINK_IDLE - countdown.duration, time, countdown.duration);
    });
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
          if (!this.rewardedSources.has(transition.id)) {
            this.rewardedSources.add(transition.id);
            this.changeCoins(EXHAUSTED_SOURCE_REWARD, transition);
          }
        }
      }
      const goals = this.goalsOf(e.transitionId);
      if (goals.length === 0) return;
      const allocated: Multiset = {};
      const ordinals: { sinkId: string; key: string; ordinal: number }[] = [];
      const flights = this.sim.inFlight;
      let first = flights.length;
      while (first > 0 && flights[first - 1].firingId === e.firingId) first--;
      for (let i = first; i < flights.length; i++) {
        const token = flights[i];
        if (token.kind !== "input") continue;
        const goal = goals.find((g) => g.color === token.color);
        if (!goal) continue;
        const key = deliveryKey(e.transitionId, token.color);
        const ordinal = (this.reserved.get(key) ?? 0) + (allocated[token.color] ?? 0);
        if (ordinal < goal.count) {
          token.goalOrdinal = ordinal;
          if (Number.isFinite(goal.count)) ordinals.push({ sinkId: e.transitionId, key, ordinal });
        }
        allocated[token.color] = (allocated[token.color] ?? 0) + 1;
      }
      if (ordinals.length) this.firingGoalOrdinals.set(e.firingId, ordinals);
      for (const c of expand(e.consumed)) bump(this.reserved, deliveryKey(e.transitionId, c));
      // Stop consuming once enough matching tokens are on their way.
      if (goals.every((g) => (this.reserved.get(deliveryKey(g.sinkId, g.color)) ?? 0) >= g.count)) {
        this.sim.net.transitions.get(e.transitionId)!.disabled = true;
      }
    });
    // Goals progress once the consumed tokens have visibly reached the sink.
    this.sim.onComplete((e) => {
      const transition = this.sim.net.transitions.get(e.transitionId)!;
      if (transition.kind === "source") this.statistics.record("sources", e.time, e.produced);
      else if (this.builtTransitions.has(e.transitionId)) this.statistics.record("built", e.time, e.produced);
      const ordinals = this.firingGoalOrdinals.get(e.firingId) ?? [];
      this.firingGoalOrdinals.delete(e.firingId);
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
      for (const { key, ordinal } of ordinals) {
        const completed = this.completedGoalOrdinals.get(key) ?? new Set<number>();
        completed.add(ordinal);
        this.completedGoalOrdinals.set(key, completed);
      }
      const before = this.goalsFor(t.id);
      for (const c of expand(e.consumed)) bump(this.delivered, deliveryKey(t.id, c));
      const goals = this.goalsFor(t.id);
      if (this.level.mode === "endless") {
        const scored: Multiset = {};
        goals.forEach((goal, index) => {
          const count = goal.delivered - before[index].delivered;
          if (count > 0) scored[goal.color] = (scored[goal.color] ?? 0) + count;
        });
        const count = total(scored);
        if (count > 0) {
          this.endlessProgress += 1;
          this.score += count;
          this.statistics.record("deliveries", e.time, scored);
          for (const listener of this.deliveryListeners) listener(scored);
        }
      }
      if (goals.length > 0 && goals.every((g) => g.done) && !this.resolved.has(t.id)) {
        this.resolved.set(t.id, e.time);
        this.countdowns.delete(t.id);
      }
    });
    if (options.snapshot) this.restoreSnapshot(options.snapshot);
  }

  snapshot() {
    const net = this.sim.net;
    return {
      net: { places: [...net.places.values()], transitions: [...net.transitions.values()], arcs: [...net.arcs.values()] },
      simulation: this.sim.snapshot(),
      statistics: this.statistics.snapshot(),
      portrait: this.portrait, complete: this.complete, completedAt: this.completedAt, score: this.score,
      survivalActive: this.survivalActive, survivalBaseline: this.survivalBaseline, survivalFailed: this.survivalFailed,
      lifeBalance: this.lifeBalance, lostLife: this.lostLife, purchasedLives: this.purchasedLives,
      coinBalance: this.coinBalance, paidUpgrades: this.paidUpgrades,
      upgradeSpending: [...this.upgradeSpending], autoUpgradeLevels: [...this.autoUpgradeLevels],
      builtTransitions: [...this.builtTransitions], inventory: [...this.inventory],
      offers: [...this.offers.values()].map((offer) => ({ ...offer, choices: offer.choices.map((choice) => choice.id) })),
      nextOfferId: this.nextOfferId,
      resolved: [...this.resolved], exhausted: [...this.exhausted], rewardedSources: [...this.rewardedSources],
      failed: [...this.failed], delivered: [...this.delivered], reserved: [...this.reserved],
      completedGoalOrdinals: [...this.completedGoalOrdinals].map(([key, value]) => [key, [...value]] as [string, number[]]),
      firingGoalOrdinals: [...this.firingGoalOrdinals],
      goalDefinitions: this.goalDefinitions.map((goal) => ({ ...goal, count: Number.isFinite(goal.count) ? goal.count : null })),
      nextRampAt: Number.isFinite(this.nextRampAt) ? this.nextRampAt : null,
      countdowns: [...this.countdowns], unusedPlaces: [...this.unusedPlaces],
      endlessCenter: this.endlessCenter, endlessProgress: this.endlessProgress, endlessEpoch: this.endlessEpoch,
      redSurplus: this.redSurplus, pendingEpoch: this.pendingEpoch, permanentBluePosition: this.permanentBluePosition,
      nextRedHasSource: this.nextRedHasSource, nextSpawnRetryAt: this.nextSpawnRetryAt, nextEndlessId: this.nextEndlessId,
    };
  }

  private restoreSnapshot(state: GameSnapshot): void {
    const arrays = [state.upgradeSpending, state.autoUpgradeLevels, state.builtTransitions, state.inventory, state.offers,
      state.resolved, state.exhausted, state.rewardedSources, state.failed, state.delivered, state.reserved,
      state.completedGoalOrdinals, state.firingGoalOrdinals, state.goalDefinitions, state.countdowns, state.unusedPlaces];
    if (arrays.some((value) => !Array.isArray(value))
      || ![state.score, state.lifeBalance, state.coinBalance, state.paidUpgrades, state.purchasedLives,
        state.nextOfferId, state.endlessProgress, state.endlessEpoch, state.redSurplus,
        state.nextSpawnRetryAt, state.nextEndlessId].every(Number.isFinite)
      || typeof state.portrait !== "boolean" || typeof state.complete !== "boolean"
      || typeof state.survivalActive !== "boolean" || typeof state.survivalFailed !== "boolean"
      || typeof state.lostLife !== "boolean" || typeof state.nextRedHasSource !== "boolean"
      || (this.level.mode === "endless" && !this.endlessCenter)) throw new Error("Invalid game state");
    const numberMaps = [state.upgradeSpending, state.autoUpgradeLevels, state.inventory, state.resolved, state.exhausted,
      state.failed, state.delivered, state.reserved, state.unusedPlaces];
    if (numberMaps.some((entries) => entries.some((entry) => !Array.isArray(entry) || typeof entry[0] !== "string"
      || !Number.isFinite(entry[1]) || entry[1] < 0))
      || state.lifeBalance < 0 || state.lifeBalance > MAX_LIVES || state.coinBalance < 0 || state.score < 0
      || state.endlessEpoch < 0 || state.endlessProgress < 0
      || (state.nextRampAt !== null && !Number.isFinite(state.nextRampAt))) throw new Error("Invalid game counters");
    for (const [id, countdown] of state.countdowns) {
      if (typeof id !== "string" || !this.sim.net.transitions.has(id) || !countdown
        || !Number.isFinite(countdown.startsAt) || !Number.isFinite(countdown.deadline)
        || !Number.isFinite(countdown.duration) || countdown.duration <= 0) throw new Error("Invalid countdown");
    }
    this.sim.restore(state.simulation);
    this.statistics.restore(state.statistics);
    this.portrait = state.portrait;
    this.complete = state.complete;
    this.completedAt = state.completedAt;
    this.score = state.score;
    this.survivalActive = state.survivalActive;
    this.survivalBaseline = state.survivalBaseline;
    this.survivalFailed = state.survivalFailed;
    this.lifeBalance = state.lifeBalance;
    this.lostLife = state.lostLife;
    this.purchasedLives = state.purchasedLives;
    this.coinBalance = state.coinBalance;
    this.paidUpgrades = state.paidUpgrades;
    const replace = <K, V>(target: Map<K, V>, entries: [K, V][]) => {
      target.clear();
      for (const [key, value] of entries) target.set(key, value);
    };
    replace(this.upgradeSpending, state.upgradeSpending);
    replace(this.autoUpgradeLevels, state.autoUpgradeLevels);
    replace(this.inventory, state.inventory);
    this.builtTransitions.clear();
    for (const id of state.builtTransitions) this.builtTransitions.add(id);
    this.offers.clear();
    for (const offer of state.offers) {
      const choices = offer.choices.map((id) => POWERUPS.find((item) => item.id === id));
      if (choices.length !== 2 || !choices[0] || !choices[1]) throw new Error("Unknown saved reward");
      this.offers.set(offer.id, { ...offer, choices: [choices[0], choices[1]] });
    }
    this.offerVersion++;
    this.nextOfferId = state.nextOfferId;
    replace(this.resolved, state.resolved);
    replace(this.exhausted, state.exhausted);
    this.rewardedSources.clear();
    for (const id of state.rewardedSources) this.rewardedSources.add(id);
    replace(this.failed, state.failed);
    replace(this.delivered, state.delivered);
    replace(this.reserved, state.reserved);
    this.completedGoalOrdinals.clear();
    for (const [key, values] of state.completedGoalOrdinals) this.completedGoalOrdinals.set(key, new Set(values));
    replace(this.firingGoalOrdinals, state.firingGoalOrdinals);
    this.goalDefinitions = state.goalDefinitions.map((goal) => {
      if (!COLORS.includes(goal.color) || (goal.count !== null && (!Number.isFinite(goal.count) || goal.count < 0))) {
        throw new Error("Invalid saved goal");
      }
      return { ...goal, count: goal.count ?? Infinity };
    });
    this.nextRampAt = state.nextRampAt ?? Infinity;
    replace(this.countdowns, state.countdowns);
    replace(this.unusedPlaces, state.unusedPlaces);
    this.unusedPlacesVersion = -1;
    this.endlessProgress = state.endlessProgress;
    this.endlessEpoch = state.endlessEpoch;
    this.redSurplus = state.redSurplus;
    this.pendingEpoch = state.pendingEpoch;
    this.permanentBluePosition = state.permanentBluePosition;
    this.nextRedHasSource = state.nextRedHasSource;
    this.nextSpawnRetryAt = state.nextSpawnRetryAt;
    this.nextEndlessId = state.nextEndlessId;
  }

  /** Number of completed endless spawn epochs. */
  get epoch(): number {
    return this.endlessEpoch;
  }

  get starterSource(): Transition | undefined {
    return this.endlessCenter;
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

  get hasLostLife(): boolean {
    return this.lostLife;
  }

  get lifePrice(): number {
    return LIFE_COST + this.purchasedLives * LIFE_PRICE_INCREASE;
  }

  buyLife(position: { x: number; y: number }, apply = true): boolean {
    if (!this.survival || this.complete || this.paused || this.lives >= MAX_LIVES) return false;
    if (!this.canAfford(this.lifePrice, apply)) return false;
    if (apply) {
      const price = this.lifePrice;
      this.purchasedLives++;
      this.changeLives(1);
      this.changeCoins(-price, position);
    }
    return true;
  }

  continueEndless(): void {
    if (!this.survival) return;
    this.survivalBaseline = { score: this.score, epoch: this.epoch };
    this.statistics.endlessAt = this.sim.time;
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

  onLives(fn: (amount: number) => void): void {
    this.lifeListeners.push(fn);
  }

  onDeliveries(fn: (colors: Multiset) => void): void {
    this.deliveryListeners.push(fn);
  }

  onInsufficientCoins(fn: () => void): void {
    this.insufficientCoinsListeners.push(fn);
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
    const colors = [...new Set(this.goalsOf(t.id).map((goal) => goal.color))];
    if (!colors.length) throw new Error(`Countdown sink ${t.id} has no goal`);
    return { sinkId: t.id, color: colors[0], colors, x: t.x, y: t.y };
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
      if (this.survival) this.changeLives(1);
      else this.changeCoins(5, offer);
    } else this.inventory.set(choice.id, this.powerupStock(choice.id) + 1);
    return true;
  }

  private spawnOffer(position: { x: number; y: number }, at: number): void {
    const expiresAt = at + POWERUP_LIFETIME;
    if (this.sim.time >= expiresAt) {
      this.changeCoins(1, position);
      return;
    }
    const eligible = POWERUPS.filter((powerup) => powerup.kind !== "life" && this.endlessEpoch >= powerup.afterEpoch
      && (powerup.untilEpoch === undefined || this.endlessEpoch < powerup.untilEpoch));
    const draw = (): Powerup => {
      const weights = eligible.map((powerup) => {
        if (powerup.kind === "coins") return this.coins < 50 ? 3 : 1;
        if (powerup.kind !== "kit") return 1;
        const stock = this.powerupStock(powerup.id);
        return 0.66 ** ((stock > 7 ? 1 : 0) + (stock > 15 ? 1 : 0) + (stock > 25 ? 1 : 0));
      });
      let roll = this.random() * weights.reduce((sum, weight) => sum + weight, 0);
      let index = 0;
      while (index < eligible.length - 1 && roll >= weights[index]) roll -= weights[index++];
      return eligible.splice(index, 1)[0];
    };
    const first = draw();
    let second = draw();
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
      this.changeCoins(1, offer);
    }
  }

  private changeCoins(amount: number, position: { x: number; y: number }): void {
    if (amount === 0) return;
    this.coinBalance += amount;
    for (const fn of this.coinListeners) fn({ amount, x: position.x, y: position.y });
  }

  private changeLives(amount: number): void {
    this.lifeBalance += amount;
    for (const fn of this.lifeListeners) fn(amount);
  }

  private canAfford(price: number, notify: boolean): boolean {
    if (this.coins >= price) return true;
    if (notify) for (const fn of this.insufficientCoinsListeners) fn();
    return false;
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
    if (!net.liveNodes().some((n) => Math.hypot(n.x - x, n.y - y) <= buildRange(n))) return "far";
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

  /** Connects open ports through a new nearby place, or checks placement without mutation. */
  connectPorts(from: { tid: string; index: number }, to: { tid: string; index: number }, apply = true, near?: { x: number; y: number }): boolean {
    if (this.complete || this.paused || !this.level.tools?.place) return false;
    const net = this.sim.net;
    if (this.connectorSpaceVersion !== net.version) {
      this.connectorSpace.clear();
      this.connectorSpaceVersion = net.version;
    }
    const key = JSON.stringify([from.tid, from.index, to.tid, to.index]);
    if (!apply && this.connectorSpace.has(key)) return this.connectorSpace.get(key) === true;
    const position = this.connectorPlacePosition(from, to, near);
    this.connectorSpace.set(key, !!position);
    if (!position) return false;
    if (!apply) return true;
    const id = this.buildPlace(position.x, position.y, 1);
    if (id === undefined) throw new Error("Could not build a validated connector place");
    const ports = from.tid === to.tid && from.index === to.index ? [from] : [from, to];
    for (const port of ports.sort((a, b) => b.index - a.index)) net.connect(port.tid, port.index, id);
    this.syncUnusedPlaces();
    return true;
  }

  /** Shared exact placement for connector previews and committed bridges. */
  connectorPlacePosition(from: { tid: string; index: number }, to: { tid: string; index: number }, near?: { x: number; y: number }): { x: number; y: number } | undefined {
    const net = this.sim.net;
    const source = net.transitions.get(from.tid);
    const target = net.transitions.get(to.tid);
    if (this.complete || this.paused || !this.level.tools?.place || !source || !target
      || source.ghost || target.ghost || !source.open?.[from.index] || !target.open?.[to.index]
      || Math.hypot(source.x - target.x, source.y - target.y) > CONNECTION_RANGE * 2) return undefined;
    const pointer = near ?? target;
    const valid = (p: { x: number; y: number }) => this.canConnectAt(from.tid, from.index, p.x, p.y)
      && this.canConnectAt(to.tid, to.index, p.x, p.y) && !this.placementIssue("place", p.x, p.y);
    const direction = pointer.x === target.x && pointer.y === target.y ? source : pointer;
    const angle = Math.atan2(direction.y - target.y, direction.x - target.x);
    const distance = placementClearance("place", "transition") + 4;
    let position = { x: target.x + Math.cos(angle) * distance, y: target.y + Math.sin(angle) * distance };
    if (!valid(position)) {
      // A free region is bounded by reach, build or clearance circles. Check their boundary arcs,
      // split at intersections, so narrow gaps are not missed by a fixed angular sampling grid.
      const circles = (source === target ? [target] : [target, source]).map((t) => ({ x: t.x, y: t.y, r: CONNECTION_RANGE, angles: [angle] }));
      for (const node of [...net.places.values(), ...net.transitions.values()]) {
        const clearance = placementClearance("place", "kind" in node ? "transition" : "place");
        if (Math.hypot(node.x - target.x, node.y - target.y) > CONNECTION_RANGE + Math.max(clearance, buildRange(node))) continue;
        circles.push({ x: node.x, y: node.y, r: clearance, angles: [Math.atan2(pointer.y - node.y, pointer.x - node.x)] });
        if (!node.ghost) circles.push({ x: node.x, y: node.y, r: buildRange(node), angles: [angle] });
      }
      for (let i = 0; i < circles.length; i++) for (let j = i + 1; j < circles.length; j++) {
        const a = circles[i], b = circles[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d === 0 || d > a.r + b.r || d < Math.abs(a.r - b.r)) continue;
        const along = (a.r * a.r - b.r * b.r + d * d) / (2 * d);
        const across = Math.sqrt(Math.max(0, a.r * a.r - along * along));
        for (const sign of [-1, 1]) {
          const x = a.x + (dx * along - dy * across * sign) / d;
          const y = a.y + (dy * along + dx * across * sign) / d;
          a.angles.push(Math.atan2(y - a.y, x - a.x));
          b.angles.push(Math.atan2(y - b.y, x - b.x));
        }
      }
      const candidates = circles.flatMap((circle) => {
        const angles = circle.angles.map((a) => (a + Math.PI * 2) % (Math.PI * 2)).sort((a, b) => a - b);
        // Tiny radial offsets avoid rejecting valid boundaries due to floating-point roundoff.
        return angles.flatMap((a, i) => [a, (a + (angles[i + 1] ?? angles[0] + Math.PI * 2)) / 2])
          .flatMap((a) => [circle.r, circle.r + 1e-6, circle.r - 1e-6].map((r) =>
            ({ x: circle.x + Math.cos(a) * r, y: circle.y + Math.sin(a) * r })));
      });
      const found = candidates.sort((a, b) => Math.hypot(a.x - pointer.x, a.y - pointer.y) - Math.hypot(b.x - pointer.x, b.y - pointer.y)).find(valid);
      if (!found) return undefined;
      position = found;
    }
    return position;
  }

  /** Available color-preserving one-to-one kit, if building it is enabled. */
  relayKit(): Kit | undefined {
    return this.level.tools?.kits?.find((kit) => kit.ports.length === 2
      && kit.ports.every((port) => !port.color && (port.count ?? 1) === 1)
      && kit.ports.some((port) => port.dir === "in")
      && kit.ports.some((port) => port.dir === "out"));
  }

  /** Whether a transition can be built and connected from a place at this point. */
  canBuildConnectedTransition(pid: string, x: number, y: number, kit = this.relayKit()): boolean {
    const place = this.sim.net.places.get(pid);
    return !!place && !place.ghost && !!kit && kit.ports.some((port) => port.dir === "in")
      && withinConnectionRange(place, { x, y }) && this.canBuildTransition(kit, x, y);
  }

  /** Builds a transition with its input connected to the selected place. */
  buildConnectedTransition(pid: string, x: number, y: number, kit = this.relayKit()): string | undefined {
    if (!kit || !this.canBuildConnectedTransition(pid, x, y, kit)) return undefined;
    const id = this.buildTransition(kit, x, y);
    if (id === undefined) throw new Error("Could not build a validated connected transition");
    const input = kit.ports.findIndex((port) => port.dir === "in");
    if (!this.connect(id, input, pid)) throw new Error("Could not connect a validated transition");
    return id;
  }

  /** Only place selections display their upgraded reach; transition rings retain the base radius. */
  connectionRange(node?: Place | Transition): number {
    if (node && !("kind" in node)) return connectionRange(node);
    return CONNECTION_RANGE;
  }

  /** Whether an open port can reach a place of this capacity in current world coordinates. */
  canConnectAt(tid: string, index: number, x: number, y: number, capacity = 1): boolean {
    const t = this.sim.net.transitions.get(tid);
    return !!t && !this.complete && !t.ghost && !!t.open?.[index]
      && withinConnectionRange(t, { x, y, capacity });
  }

  /** Builds a transition from `kit` with all ports open; it is enabled once they are connected. */
  canBuildTransition(kit: Kit, x: number, y: number): boolean {
    if (this.complete || this.placementIssue("transition", x, y)) return false;
    return this.canUseKit(kit);
  }

  private canUseKit(kit: Kit, notify = false): boolean {
    if (this.level.tools?.kits?.includes(kit)) return true;
    const powerup = this.kitPowerup(kit);
    return !!this.level.tools && !!powerup && this.powerupStock(powerup.id) > 0 && this.canAfford(powerup.price, notify);
  }

  buildTransition(kit: Kit, x: number, y: number): string | undefined {
    if (this.complete || this.placementIssue("transition", x, y) || !this.canUseKit(kit, true)) return undefined;
    const net = this.sim.net;
    const id = net.freshId("t");
    net.addTransition({ id, x, y, kind: "normal", open: kit.ports, copyInputColor: kit.copyInputColor });
    net.validateTransition(id);
    this.builtTransitions.add(id);
    this.useKit(kit, { x, y });
    return id;
  }

  private useKit(kit: Kit, position: { x: number; y: number }): void {
    const powerup = this.kitPowerup(kit);
    if (powerup && !this.level.tools?.kits?.includes(kit)) {
      this.inventory.set(powerup.id, this.powerupStock(powerup.id) - 1);
      this.changeCoins(-powerup.price, position);
    }
  }

  /** Retypes connected arcs in place so committed firings retain their endpoints and concrete tokens. */
  convertTransition(tid: string, kit: Kit, apply = true): boolean {
    const net = this.sim.net;
    const transition = net.transitions.get(tid);
    if (this.complete || this.paused || !transition || transition.ghost || transition.kind !== "normal") return false;
    const portKey = (port: { dir: "in" | "out"; color?: Color; count?: number }) =>
      `${port.dir}:${port.color ?? ""}:${arcCount(port)}`;
    const current = [
      ...net.inputs(tid).map((arc) => portKey({ ...arc, dir: "in" })),
      ...net.outputs(tid).map((arc) => portKey({ ...arc, dir: "out" })),
      ...(transition.open ?? []).map(portKey),
    ].sort();
    const requested = kit.ports.map(portKey).sort();
    if (!!transition.copyInputColor === !!kit.copyInputColor && current.length === requested.length
      && current.every((port, index) => port === requested[index])) return false;
    const ports = kit.ports.map((port) => ({ ...port, count: arcCount(port) }));
    const bindings = [];
    for (const dir of ["in", "out"] as const) {
      const arcs = [...(dir === "in" ? net.inputs(tid) : net.outputs(tid))];
      if (arcs.length > ports.filter((port) => port.dir === dir).length) return false;
      // Assign explicitly colored arcs first, preserving matching colors when the new kit permits.
      arcs.sort((a, b) => Number(!!b.color) - Number(!!a.color));
      for (const arc of arcs) {
        let index = ports.findIndex((port) => port.dir === dir && port.color === arc.color);
        if (index === -1) index = ports.findIndex((port) => port.dir === dir);
        bindings.push({ arc, port: ports.splice(index, 1)[0] });
      }
    }
    if (!this.canUseKit(kit, apply)) return false;
    if (!apply) return true;
    for (const { arc, port } of bindings) {
      arc.color = port.color;
      arc.count = port.count;
    }
    transition.open = ports;
    transition.copyInputColor = kit.copyInputColor;
    net.validateTransition(tid);
    net.version++;
    this.useKit(kit, transition);
    return true;
  }

  /** Connects open port `index` of transition `tid` to place `pid`; only checks if `apply` is false. */
  connect(tid: string, index: number, pid: string, apply = true): boolean {
    const net = this.sim.net;
    const p = net.places.get(pid);
    if (!p || p.ghost || !this.canConnectAt(tid, index, p.x, p.y, p.capacity)) return false;
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
    if (a && !a.ghost && !a.indestructible) {
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
    if (p && !p.ghost && !p.indestructible) {
      if (apply) {
        const returned = this.returnSourceTokens(p);
        this.changeCoins(p.marking.length - returned, p);
        this.refundUpgrade(p);
        net.ghostPlace(id);
        this.syncUnusedPlaces();
      }
      return true;
    }
    return false;
  }

  private returnSourceTokens(place: Place): number {
    const net = this.sim.net;
    const available: Multiset = {};
    for (const color of place.marking) available[color] = (available[color] ?? 0) + 1;
    const sources = new Set(net.arcsOf(place.id).filter((arc) => !arc.ghost && arc.to === place.id).map((arc) => arc.from));
    for (const id of sources) {
      const source = net.transitions.get(id);
      if (!source || source.kind !== "source" || source.ghost || this.failed.has(id)
        || source.supply === undefined || source.initialSupply === undefined) continue;
      const outputs = net.outputs(id);
      // Refund only complete emissions, never duplicating tokens emitted to another place.
      if (outputs.some((arc) => arc.to !== place.id || !arc.color) || source.open?.some((port) => port.dir === "out")) continue;
      const batch: Multiset = {};
      for (const arc of outputs) {
        if (arc.color) batch[arc.color] = (batch[arc.color] ?? 0) + arcCount(arc);
      }
      const colors = COLORS.filter((color) => (batch[color] ?? 0) > 0);
      if (colors.length === 0) continue;
      const returned = Math.min(source.initialSupply - source.supply,
        ...colors.map((color) => Math.floor((available[color] ?? 0) / batch[color]!)));
      if (returned <= 0) continue;
      source.supply += returned;
      for (const color of colors) available[color] = (available[color] ?? 0) - returned * batch[color]!;
      if (this.exhausted.delete(id) && this.level.mode === "endless") this.startCountdown(id, SOURCE_IDLE, this.sim.time);
    }
    return place.marking.length - total(available);
  }

  /** Automates a manual transition, or speeds up one that is already automatic. */
  upgradeAuto(tid: string, apply = true): boolean {
    const t = this.sim.net.transitions.get(tid);
    if (this.complete || !this.level.tools?.auto || !t || t.ghost || t.kind !== "normal") return false;
    if (t.autoInterval && t.autoInterval <= MIN_INTERVAL) return false;
    if (this.powerupStock("auto") === 0 && !this.canAfford(this.upgradePrice, apply)) return false;
    if (apply) {
      t.autoInterval = t.autoInterval ? Math.max(MIN_INTERVAL, t.autoInterval * FASTER_FACTOR) : AUTO_INTERVAL;
      this.useUpgrade("auto", t);
      this.autoUpgradeLevels.set(tid, this.autoUpgradeLevel(tid) + 1);
    }
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
    if (this.powerupStock("capacity") === 0 && !this.canAfford(this.upgradePrice, apply)) return false;
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
      while (this.sim.time + TIME_EPSILON >= this.statistics.nextSampleTime) {
        this.statistics.sample(this.sim.liveTokens());
      }
      const step = Math.min(remaining, ENDLESS_STEP, this.statistics.nextSampleTime - this.sim.time);
      this.advance(step);
      if (this.sim.time + TIME_EPSILON >= this.statistics.nextSampleTime) this.statistics.sample(this.sim.liveTokens());
      if (this.complete) break;
      remaining -= step;
    }
  }

  private advance(dt: number): void {
    if (this.level.mode === "endless") {
      const openDemand = this.goalDefinitions.some((goal) => {
        const sink = this.sim.net.transitions.get(goal.sinkId);
        return sink?.kind === "sink" && !sink.ghost && !this.failed.has(sink.id) && !this.resolved.has(sink.id)
          && (this.reserved.get(deliveryKey(sink.id, goal.color)) ?? 0) < goal.count;
      });
      this.endlessProgress += dt * (openDemand ? 1 : 15);
    }
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
    if (this.endlessCenter && !net.transitions.has(this.endlessCenter.id)) {
      [this.endlessCenter.x, this.endlessCenter.y] = [this.endlessCenter.y, this.endlessCenter.x];
    }
    for (const offer of this.offers.values()) [offer.x, offer.y] = [offer.y, offer.x];
    if (this.permanentBluePosition) {
      [this.permanentBluePosition.x, this.permanentBluePosition.y] = [this.permanentBluePosition.y, this.permanentBluePosition.x];
    }
    this.offerVersion++;
  }

  goals(): GoalStatus[] {
    return this.goalDefinitions.map((goal) => this.goalStatus(goal));
  }

  goalsFor(sinkId: string): GoalStatus[] {
    return this.goalsOf(sinkId).map((goal) => this.goalStatus(goal));
  }

  private goalStatus(goal: Goal): GoalStatus {
    const delivered = Math.min(goal.count, this.delivered.get(deliveryKey(goal.sinkId, goal.color)) ?? 0);
    return { ...goal, delivered, done: delivered >= goal.count };
  }

  remainingGoalOrdinals(goal: GoalStatus): number[] {
    if (!Number.isFinite(goal.count)) return [0];
    const completed = this.completedGoalOrdinals.get(deliveryKey(goal.sinkId, goal.color));
    return Array.from({ length: goal.count }, (_, i) => i).filter((ordinal) => !completed?.has(ordinal));
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
      if (this.survivalFailed) break;
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
      this.statistics.recordSinkDeath(at, sink.colors);
      for (const fn of this.sinkDeathListeners) fn(sink);
    }
    if (t.kind === "sink" && this.survival && this.lives > 0) {
      this.lostLife = true;
      this.changeLives(-1);
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
      this.completedGoalOrdinals.delete(deliveryKey(tid, color));
    }
    for (const [id, ordinals] of this.firingGoalOrdinals) {
      if (ordinals.some((entry) => entry.sinkId === tid)) this.firingGoalOrdinals.delete(id);
    }
    this.goalDefinitions = this.goalDefinitions.filter((goal) => goal.sinkId !== tid);
    this.countdowns.delete(tid);
  }

  private spawnEndless(): void {
    while (this.endlessProgress >= ENDLESS_EPOCH_PROGRESS - 1e-9 && this.sim.time >= this.nextSpawnRetryAt) {
      const epoch = this.endlessEpoch + 1;
      const count = epoch >= 1750 ? 3 : epoch >= 1500 ? 2
        : epoch >= 1250 ? (epoch % 2 === 0 ? 2 : 1)
          : epoch >= 1000 && epoch % 3 === 0 ? 2 : 1;
      this.pendingEpoch ??= { remaining: count };
      while (this.pendingEpoch.remaining > 0) {
        this.pendingEpoch.demand ??= (this.pendingEpoch.remaining === count
          ? PERMANENT_SINKS.find((sink) => sink.milestone === epoch) : undefined) ?? this.endlessDemand();
        if (!this.spawnEndlessGoal(this.pendingEpoch.demand)) {
          console.warn("Could not place an endless goal and its source; retrying in one second");
          this.nextSpawnRetryAt = this.sim.time + 1;
          return;
        }
        this.pendingEpoch.remaining--;
        this.pendingEpoch.demand = undefined;
      }
      this.endlessProgress = Math.max(0, this.endlessProgress - ENDLESS_EPOCH_PROGRESS);
      this.endlessEpoch++;
      if (this.endlessEpoch === STARTER_SOURCE_LIMIT_EPOCH && this.endlessCenter) {
        this.endlessCenter.supply = STARTER_SOURCE_SUPPLY;
        this.endlessCenter.initialSupply = STARTER_SOURCE_SUPPLY;
      }
      this.pendingEpoch = undefined;
    }
  }

  private endlessDemand(): EndlessDemand {
    const epoch = this.endlessEpoch + 1;
    if (epoch >= ENDLESS_RULES.blueRedFrom) {
      let roll = this.random();
      if (epoch >= ENDLESS_RULES.quadrupleFrom) {
        if (roll < ENDLESS_RULES.quadrupleChance) return { colors: ["blue", "red", "green", "yellow"] };
        roll -= ENDLESS_RULES.quadrupleChance;
      }
      if (epoch >= ENDLESS_RULES.yellowGreenFrom) {
        if (roll < ENDLESS_RULES.pairChance) return { colors: ["yellow", "green"] };
        roll -= ENDLESS_RULES.pairChance;
      }
      if (roll < ENDLESS_RULES.pairChance) return { colors: ["blue", "red"] };
    }
    return { colors: [this.endlessColor()] };
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

  private spawnEndlessGoal(demand: EndlessDemand): boolean {
    const net = this.sim.net;
    const epoch = this.endlessEpoch + 1;
    const { colors } = demand;
    const color = colors[0];
    const fraction = demand.centralFraction;
    const permanent = fraction !== undefined;
    const red = colors.length === 1 && color === "red" && !permanent;
    const redSources = epoch < ENDLESS_RULES.redSourcesUntil;
    const alternating = red && redSources && epoch >= ENDLESS_RULES.redSoloFrom;
    const withSource = red && redSources && (!alternating || this.nextRedHasSource);
    const positions = permanent ? this.permanentPosition(fraction, demand.milestone === 400) : this.endlessPositions(withSource, red);
    if (!positions) return false;

    const inputCount = colors.length === 1 && color === "blue" && !permanent ? this.blueSinkInputCount() : 1;
    const sinkId = net.freshId(`endless${this.nextEndlessId++}_`);
    net.addTransition({
      id: sinkId, ...positions.sink, kind: "sink", autoInterval: 0.6,
      open: colors.map((color) => ({ dir: "in", color, count: inputCount })),
    });
    this.statistics.recordSinkCreation(this.sim.time, colors);
    this.spawnedAt.set(sinkId, this.sim.time);
    let goalCount: number;
    if (permanent) goalCount = Infinity;
    else if (colors.length === 4) goalCount = epoch >= ENDLESS_RULES.variedQuadrupleFrom ? (this.random() < 0.5 ? 10 : 15) : 5;
    else if (colors.length === 2) goalCount = color === "blue" && epoch >= ENDLESS_RULES.variedBlueRedFrom ? this.redCount() : 5;
    else if (color === "red" && this.endlessEpoch >= ENDLESS_RULES.variedRedAfter) goalCount = this.redCount();
    else if (color === "yellow") goalCount = 10 * (1 + Math.floor(this.random() * 3));
    else goalCount = inputCount > 1 ? 6 : 5;
    if (!permanent && colors.length === 1 && (color === "blue" || color === "green")
      && epoch >= ENDLESS_RULES.doubledDemandFrom) goalCount *= 2;
    // Keep five in reserve for the next unpaired sink without exceeding a source's 15-token maximum.
    if (alternating) goalCount = Math.min(goalCount, withSource ? 10 + this.redSurplus : this.redSurplus);
    for (const color of colors) this.goalDefinitions.push({ sinkId, color, count: goalCount });
    const factor = colors.includes("yellow") ? 2 : 1;
    this.startCountdown(sinkId, SINK_GRACE * factor, this.sim.time, COUNTDOWN * factor);
    if (demand.milestone === 300) this.permanentBluePosition = { ...positions.sink };
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
    } else if (red && redSources) {
      this.redSurplus -= goalCount;
    }
    if (alternating) this.nextRedHasSource = !this.nextRedHasSource;
    return true;
  }

  private permanentPosition(fraction: number, avoidBlue: boolean): EndlessPositions | undefined {
    const routes = this.spawnArcRoutes();
    const bounds = this.sim.net.liveNodes().reduce((bounds, node) => ({
      left: Math.min(bounds.left, node.x), right: Math.max(bounds.right, node.x),
      top: Math.min(bounds.top, node.y), bottom: Math.max(bounds.bottom, node.y),
    }), { left: 0, right: this.size.width, top: 0, bottom: this.size.height });
    const width = (bounds.right - bounds.left) * fraction;
    const height = (bounds.bottom - bounds.top) * fraction;
    const left = (bounds.left + bounds.right - width) / 2;
    const top = (bounds.top + bounds.bottom - height) / 2;
    const candidateAt = (x: number, y: number) => {
      const sink = { x: left + x * width, y: top + y * height };
      if (this.placementIssue("transition", sink.x, sink.y) === "crowded") return undefined;
      if (avoidBlue && this.permanentBluePosition
        && Math.hypot(sink.x - this.permanentBluePosition.x, sink.y - this.permanentBluePosition.y) < CONNECTION_RANGE) return undefined;
      return { sink };
    };
    let best: EndlessPositions | undefined;
    let bestPenalty = Infinity;
    for (let i = 0; i < 64; i++) {
      const candidate = candidateAt(this.random(), this.random());
      if (!candidate) continue;
      const penalty = this.spawnArcPenalty(candidate.sink, routes);
      if (penalty === 0) return candidate;
      if (penalty < bestPenalty) [best, bestPenalty] = [candidate, penalty];
    }
    if (best) return best;
    for (let y = 0; y <= 32; y++) {
      for (let x = 0; x <= 32; x++) {
        const candidate = candidateAt(x / 32, y / 32);
        if (candidate) return candidate;
      }
    }
    return undefined;
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

  private endlessPositions(withSource: boolean, red: boolean): EndlessPositions | undefined {
    const net = this.sim.net;
    const nodes = net.liveNodes();
    const routes = this.spawnArcRoutes();
    if (nodes.length === 0) throw new Error("Endless mode needs a live node to spawn near");
    const center = this.endlessCenter;
    if (!center || (this.endlessEpoch < STARTER_SOURCE_LIMIT_EPOCH && (center.ghost || !net.transitions.has(center.id)))) {
      throw new Error("Endless mode needs its starting source before epoch 2000");
    }
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
      const penalty = this.spawnArcPenalty(candidate.sink, routes)
        + (candidate.source ? this.spawnArcPenalty(candidate.source, routes) : 0);
      const weight = (candidate.source ? (gravity(candidate.sink) + gravity(candidate.source)) / 2 : gravity(candidate.sink))
        / (1 + 8 * penalty);
      candidateWeight += weight;
      if (this.random() * candidateWeight < weight) selected = candidate;
    }
    if (selected) return selected;

    // An outer-edge fallback keeps spawns possible when the center is crowded.
    const startAngle = this.random() * Math.PI * 2;
    let bestFallback: ReturnType<typeof candidateAt>;
    let bestPenalty = Infinity;
    for (let i = 0; i < 32; i++) {
      const angle = startAngle + i * Math.PI * 2 / 32;
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      const anchor = nodes.reduce((best, node) =>
        node.x * dx + node.y * dy > best.x * dx + best.y * dy ? node : best);
      const candidate = candidateAt(anchor, angle);
      if (!candidate) continue;
      const penalty = this.spawnArcPenalty(candidate.sink, routes)
        + (candidate.source ? this.spawnArcPenalty(candidate.source, routes) : 0);
      if (penalty === 0) return candidate;
      if (penalty < bestPenalty) [bestFallback, bestPenalty] = [candidate, penalty];
    }
    return bestFallback;
  }

  private spawnArcRoutes(): SpawnRoute[] {
    const net = this.sim.net;
    const routes: SpawnRoute[] = [];
    const arcsByTransition = new Map<string, Arc[]>();
    for (const arc of net.arcs.values()) {
      const tid = net.transitions.has(arc.from) ? arc.from : arc.to;
      const arcs = arcsByTransition.get(tid) ?? [];
      arcs.push(arc);
      arcsByTransition.set(tid, arcs);
    }
    for (const [tid, arcs] of arcsByTransition) {
      const transition = net.transitions.get(tid);
      if (!transition || transition.ghost) continue;
      for (const [id, route] of transitionLayout(net, transition, this.portrait, arcs).routes) {
        const place = net.places.get(route.placeId);
        if (!net.arcs.get(id)?.ghost && place && !place.ghost) {
          const points = outsidePlace(route.pts, placeRadius(place.capacity));
          routes.push({
            points,
            left: Math.min(...points.map((point) => point.x)) - SPAWN_ARC_CLEARANCE,
            right: Math.max(...points.map((point) => point.x)) + SPAWN_ARC_CLEARANCE,
            top: Math.min(...points.map((point) => point.y)) - SPAWN_ARC_CLEARANCE,
            bottom: Math.max(...points.map((point) => point.y)) + SPAWN_ARC_CLEARANCE,
          });
        }
      }
    }
    return routes;
  }

  private spawnArcPenalty(point: Pt, routes: SpawnRoute[]): number {
    return routes.reduce((sum, route) => {
      if (point.x < route.left || point.x > route.right || point.y < route.top || point.y > route.bottom) return sum;
      const distance = distanceToPolyline(point, route.points);
      return sum + Math.max(0, 1 - distance / SPAWN_ARC_CLEARANCE) ** 2;
    }, 0);
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

export type GameSnapshot = ReturnType<Game["snapshot"]>;

function validateSavedNet(state: GameSnapshot): void {
  const net = state.net;
  if (!net || !Array.isArray(net.places) || !Array.isArray(net.transitions) || !Array.isArray(net.arcs)) {
    throw new Error("Invalid saved net");
  }
  const position = (node: { id: string; x: number; y: number }) =>
    !!node && typeof node.id === "string" && node.id.length > 0 && Number.isFinite(node.x) && Number.isFinite(node.y);
  const color = (value: Color | undefined) => value === undefined || COLORS.includes(value);
  for (const place of net.places) {
    if (!position(place) || !Array.isArray(place.marking) || place.marking.some((token) => !color(token))) throw new Error("Invalid saved place");
    placeRadius(place.capacity);
  }
  for (const transition of net.transitions) {
    if (!position(transition) || !["normal", "source", "sink"].includes(transition.kind)
      || (transition.autoInterval !== undefined && (!Number.isFinite(transition.autoInterval) || transition.autoInterval <= 0))
      || (transition.supply !== undefined && (!Number.isInteger(transition.supply) || transition.supply < 0))
      || (transition.open !== undefined && (!Array.isArray(transition.open) || transition.open.some((port) =>
        !port || (port.dir !== "in" && port.dir !== "out") || !color(port.color)
        || (port.count !== undefined && (!Number.isInteger(port.count) || port.count < 1)))))) throw new Error("Invalid saved transition");
  }
  for (const arc of net.arcs) {
    if (!arc || typeof arc.id !== "string" || !arc.id || typeof arc.from !== "string" || typeof arc.to !== "string"
      || !color(arc.color) || (arc.count !== undefined && (!Number.isInteger(arc.count) || arc.count < 1))) {
      throw new Error("Invalid saved arc");
    }
  }
  if (state.endlessCenter && (!position(state.endlessCenter) || state.endlessCenter.kind !== "source")) {
    throw new Error("Invalid saved spawn center");
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
