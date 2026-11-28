import { addInto, type Color, type Multiset } from "../core/multiset";

export const STATISTICS_INTERVAL = 10;

export type CreationKind = "sources" | "built";
type EventKind = CreationKind | "deliveries";

interface Counts {
  deliveries: Multiset;
  sources: Multiset;
  built: Multiset;
}

export interface StatisticsSnapshot {
  events: [number, Counts][];
  minutes: [number, Multiset][];
  alive: [number, Multiset][];
  sinkDeaths: SinkDeath[];
  sinkCreations: SinkCreation[];
  endlessAt?: number;
  nextSampleTime: number;
}

export interface StatisticsPoint extends Counts {
  time: number;
  alive: Multiset;
}

export interface DeliveryMinute {
  time: number;
  deliveries: Multiset;
}

export interface SinkDeath {
  time: number;
  colors: readonly Color[];
}

export interface SinkCreation {
  time: number;
  colors: readonly Color[];
}

function emptyCounts(): Counts {
  return { deliveries: {}, sources: {}, built: {} };
}

/** Per-run event totals and snapshots at ten-second simulation-time boundaries. */
export class Statistics {
  private readonly events = new Map<number, Counts>();
  private readonly minutes = new Map<number, Multiset>();
  private readonly alive = new Map<number, Multiset>();
  readonly sinkDeaths: SinkDeath[] = [];
  readonly sinkCreations: SinkCreation[] = [];
  endlessAt?: number;
  nextSampleTime = STATISTICS_INTERVAL;

  constructor(initialAlive: Multiset) {
    this.alive.set(0, { ...initialAlive });
  }

  snapshot(): StatisticsSnapshot {
    return {
      events: [...this.events], minutes: [...this.minutes], alive: [...this.alive],
      sinkDeaths: this.sinkDeaths, sinkCreations: this.sinkCreations,
      endlessAt: this.endlessAt, nextSampleTime: this.nextSampleTime,
    };
  }

  restore(state: StatisticsSnapshot): void {
    if (!Array.isArray(state.events) || !Array.isArray(state.minutes) || !Array.isArray(state.alive)
      || !Array.isArray(state.sinkDeaths) || !Array.isArray(state.sinkCreations)
      || !Number.isFinite(state.nextSampleTime) || state.nextSampleTime <= 0) throw new Error("Invalid statistics");
    this.events.clear();
    this.minutes.clear();
    this.alive.clear();
    for (const [key, value] of state.events) this.events.set(key, value);
    for (const [key, value] of state.minutes) this.minutes.set(key, value);
    for (const [key, value] of state.alive) this.alive.set(key, value);
    this.sinkDeaths.push(...state.sinkDeaths);
    this.sinkCreations.length = 0;
    this.sinkCreations.push(...state.sinkCreations);
    this.endlessAt = state.endlessAt;
    this.nextSampleTime = state.nextSampleTime;
  }

  recordSinkDeath(time: number, colors: readonly Color[]): void {
    this.sinkDeaths.push({ time, colors: [...colors] });
  }

  recordSinkCreation(time: number, colors: readonly Color[]): void {
    this.sinkCreations.push({ time, colors: [...colors] });
  }

  record(kind: EventKind, time: number, colors: Multiset): void {
    const index = Math.max(0, Math.ceil((time - 1e-8) / STATISTICS_INTERVAL));
    const counts = this.events.get(index) ?? emptyCounts();
    addInto(counts[kind], colors);
    this.events.set(index, counts);
    if (kind === "deliveries") {
      const minute = Math.max(0, Math.floor((time + 1e-8) / 60));
      const deliveries = this.minutes.get(minute) ?? {};
      addInto(deliveries, colors);
      this.minutes.set(minute, deliveries);
    }
  }

  sample(alive: Multiset): void {
    this.alive.set(this.nextSampleTime / STATISTICS_INTERVAL, { ...alive });
    this.nextSampleTime += STATISTICS_INTERVAL;
  }

  history(now: number, currentAlive: Multiset): StatisticsPoint[] {
    const points: StatisticsPoint[] = [];
    const totals = emptyCounts();
    const last = Math.floor((now + 1e-8) / STATISTICS_INTERVAL);
    for (let index = 0; index <= last; index++) {
      const events = this.events.get(index);
      if (events) for (const kind of ["deliveries", "sources", "built"] as const) addInto(totals[kind], events[kind]);
      points.push({
        time: index * STATISTICS_INTERVAL,
        deliveries: { ...totals.deliveries }, sources: { ...totals.sources }, built: { ...totals.built },
        alive: { ...(this.alive.get(index) ?? currentAlive) },
      });
    }
    if (now - last * STATISTICS_INTERVAL > 1e-8) {
      const events = this.events.get(last + 1);
      if (events) for (const kind of ["deliveries", "sources", "built"] as const) addInto(totals[kind], events[kind]);
      points.push({
        time: now,
        deliveries: { ...totals.deliveries }, sources: { ...totals.sources }, built: { ...totals.built },
        alive: { ...currentAlive },
      });
    } else {
      points[points.length - 1].alive = { ...currentAlive };
    }
    return points;
  }

  deliveriesPerMinute(now: number): DeliveryMinute[] {
    const count = Math.floor((now + 1e-8) / 60) + 1;
    return Array.from({ length: count }, (_, index) => ({
      time: index * 60, deliveries: { ...this.minutes.get(index) },
    }));
  }
}
