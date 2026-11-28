import { describe, expect, it, vi } from "vitest";
import type { Color } from "../src/core/multiset";
import design from "../docs/DESIGN.md?raw";
import { BUILD_RANGE, CLEARANCE, EMISSION_PROGRESS, ENDLESS_EPOCH_PROGRESS, ENDLESS_RULES, Game, PLACE_FOOTPRINT, RESOLVED_LINGER, STARTER_SOURCE_LIMIT_EPOCH, STARTER_SOURCE_SUPPLY, TRANSITION_FOOTPRINT, withinConnectionRange } from "../src/game/game";
import { endless } from "../src/game/endless";
import type { Level } from "../src/game/level";

// One place feeding a goal sink through an any-color arc; optionally a second, unreachable goal.
function level(unreachableGoal = false): Level {
  const lvl: Level = {
    name: "test",
    width: 200,
    height: 100,
    goals: [{ sinkId: "sink", color: "red", count: 2 }],
    ramp: { every: 1000, factor: 1, min: 1 },
    net: {
      places: [{ id: "p", x: 0, y: 0, marking: ["red", "blue", "red", "red"] }],
      transitions: [{ id: "sink", x: 100, y: 0, kind: "sink", autoInterval: 0.1 }],
      arcs: [{ id: "a", from: "p", to: "sink" }],
    },
  };
  if (unreachableGoal) {
    lvl.net.transitions.push({ id: "sink2", x: 100, y: 50, kind: "sink" });
    lvl.goals.push({ sinkId: "sink2", color: "green", count: 1 });
  }
  return lvl;
}

function run(game: Game, seconds: number): void {
  for (let t = 0; t < seconds; t += 1 / 60) game.step(1 / 60);
}

describe("endless spawn placement near arcs", () => {
  const definition: Level = {
    ...endless, width: 1000, height: 1000, goals: [], net: {
      places: [{ id: "p", x: 900, y: 500, marking: [] }],
      transitions: [{ id: "source", x: 100, y: 500, kind: "source" }],
      arcs: [{ id: "arc", from: "source", to: "p", color: "blue" }],
    },
  };

  it.each([false, true])("prefers clear ordinary spawn candidates, paired=%s", (paired) => {
    const rolls = [0.99, 0, 0, 0.99, 0.25, 0.75];
    let index = 0;
    const game = new Game(definition, () => rolls[index++] ?? [0.99, 0, 0.99][(index - 7) % 3]);
    const position = game["endlessPositions"](paired, false)!;
    expect(position.sink.x).toBeCloseTo(100);
    expect(position.sink.y).toBeCloseTo(719);
    if (paired) expect(position.source?.y).toBeCloseTo(938);
  });

  it("tries another milestone position before accepting an arc overlap, with a fallback", () => {
    const rolls = [0.5, 0.5, 0.5, 0.7];
    const game = new Game(definition, () => rolls.shift() ?? 0.5);
    expect(game["permanentPosition"](1, false)?.sink).toEqual({ x: 500, y: 700 });
    const crowded = new Game(definition, () => 0.5);
    expect(crowded["permanentPosition"](1, false)?.sink).toEqual({ x: 500, y: 500 });
  });
});

describe("late endless progression", () => {
  function setup() {
    let rolls: number[] = [];
    let fallback = 0.95;
    const game = new Game(endless, () => rolls.shift() ?? fallback);
    game.sim.net.transitions.get("starterSource")!.autoInterval = undefined;
    const advance = (nextRolls: number[] = []) => {
      rolls = [...nextRolls];
      game.sim.net.places.get("starterPlace")!.marking = [];
      for (let i = 0; i < 15; i++) expect(game.sim.fire("starterSource")).toBe(true);
      const before = new Set(game.sim.net.transitions.keys());
      game.step(0);
      const spawned = [...game.sim.net.transitions.values()].filter((transition) => !before.has(transition.id));
      game.sim.step(1);
      game.step(0.001);
      return spawned;
    };
    const reach = (target: number) => {
      while (game.epoch < target) {
        const before = game.epoch;
        advance();
        expect(game.epoch).toBe(before + 1);
      }
    };
    return { game, advance, reach, fallback: (value: number) => { fallback = value; } };
  }

  it.each([
    { color: "blue", roll: 0.95, tail: 0.7, before: 5, after: 10, weight: 1 },
    { color: "blue", roll: 0.95, tail: 0.95, before: 6, after: 12, weight: 3 },
    { color: "green", roll: 0.15, tail: 0.95, before: 5, after: 10, weight: 1 },
  ])("doubles new $color demand at 125, including weight $weight", ({ color, roll, tail, before, after, weight }) => {
    const { game, advance, reach, fallback } = setup();
    reach(123);
    fallback(tail);
    const previous = advance([roll]).find((transition) => transition.kind === "sink")!;
    expect(game.goalsFor(previous.id)).toMatchObject([{ color, count: before }]);
    const next = advance([roll]).find((transition) => transition.kind === "sink")!;
    expect(game.goalsFor(next.id)).toMatchObject([{ color, count: after }]);
    expect(next.open).toMatchObject([{ count: weight }]);
    expect(game.goalsFor(previous.id)[0].count).toBe(before);
  });

  it.each([
    { epoch: 174, colors: ["yellow"], count: 30, tail: 0.95, roll: 0 },
    { epoch: 175, colors: ["blue", "red"], count: 5, tail: 0.95, roll: 0 },
    { epoch: 249, colors: ["blue", "red"], count: 5, tail: 0.95, roll: 0 },
    { epoch: 250, colors: ["yellow", "green"], count: 5, tail: 0.95, roll: 0 },
    { epoch: 349, colors: ["yellow", "green"], count: 5, tail: 0.95, roll: 0 },
    { epoch: 350, colors: ["blue", "red", "green", "yellow"], count: 5, tail: 0.95, roll: 0 },
    { epoch: 449, colors: ["blue", "red"], count: 5, tail: 0.95, roll: 0.2 },
    { epoch: 450, colors: ["blue", "red"], count: 10, tail: 0.8, roll: 0.2 },
    { epoch: 450, colors: ["blue", "red"], count: 15, tail: 0.95, roll: 0.2 },
    { epoch: 549, colors: ["blue", "red", "green", "yellow"], count: 5, tail: 0.95, roll: 0 },
    { epoch: 550, colors: ["blue", "red", "green", "yellow"], count: 10, tail: 0.49, roll: 0 },
    { epoch: 550, colors: ["blue", "red", "green", "yellow"], count: 15, tail: 0.95, roll: 0 },
  ])("introduces $colors with $count firings at epoch $epoch", ({ epoch, colors, count, tail, roll }) => {
    const { game, advance, reach, fallback } = setup();
    reach(epoch - 1);
    fallback(tail);
    const spawned = advance([roll]);
    expect(spawned).toHaveLength(1);
    const sink = spawned[0];
    expect(sink.open?.map((port) => port.color)).toEqual(colors);
    expect(sink.open?.every((port) => port.dir === "in" && port.count === 1)).toBe(true);
    expect(game.goalsFor(sink.id).map((goal) => goal.count)).toEqual(colors.map(() => count));
  });

  it("creates every permanent milestone once in its region, stops red sources, and increases sink cadence without duplicate retries", () => {
    const { game, advance } = setup();
    const milestones = new Map<number, { colors: Color[]; fraction: number }>([
      [300, { colors: ["blue"], fraction: 0.3 }], [400, { colors: ["red"], fraction: 0.5 }],
      [500, { colors: ["green"], fraction: 0.65 }], [600, { colors: ["yellow"], fraction: 0.75 }],
      [725, { colors: ["red", "blue"], fraction: 1 }], [850, { colors: ["yellow", "green"], fraction: 1 }],
      [1000, { colors: ["blue", "red", "green", "yellow"], fraction: 1 }],
    ]);
    let blueId = "";
    const seen: number[] = [];
    for (let epoch = 1; epoch <= 1751; epoch++) {
      if (epoch === 350) game.setPortrait(true);
      const before = new Set(game.sim.net.transitions.keys());
      const nodes = game.sim.net.liveNodes();
      const bounds = {
        left: Math.min(0, ...nodes.map((node) => node.x)), right: Math.max(game.size.width, ...nodes.map((node) => node.x)),
        top: Math.min(0, ...nodes.map((node) => node.y)), bottom: Math.max(game.size.height, ...nodes.map((node) => node.y)),
      };
      const originalPlacement = game.placementIssue.bind(game);
      const blocked = epoch === 1500 ? vi.spyOn(game, "placementIssue").mockImplementation((...args) =>
        [...game.spawnedAt.keys()].some((id) => !before.has(id)) ? "crowded" : originalPlacement(...args)) : undefined;
      const warning = epoch === 1500 ? vi.spyOn(console, "warn").mockImplementation(() => {}) : undefined;
      const spawned = advance(epoch === 624 ? [0.99, 0.4] : epoch === 625 || epoch === 626 ? [0.99, 0.4] : []);
      if (blocked) {
        expect(game.epoch).toBe(1499);
        expect(spawned).toHaveLength(1);
        expect(warning).toHaveBeenCalled();
        blocked.mockRestore();
        warning!.mockRestore();
        game.sim.step(1);
        game.step(0);
      }
      const created = [...game.sim.net.transitions.values()].filter((transition) => !before.has(transition.id));
      expect(game.epoch).toBe(epoch);
      const sinks = created.filter((transition) => transition.kind === "sink");
      const expected = epoch >= 1750 ? 3 : epoch >= 1500 ? 2 : epoch >= 1250 ? (epoch % 2 === 0 ? 2 : 1)
        : epoch >= 1000 && epoch % 3 === 0 ? 2 : 1;
      expect(sinks).toHaveLength(expected);
      if (epoch === 624) expect(created.some((transition) => transition.kind === "source")).toBe(true);
      if (epoch >= 625) expect(created.every((transition) => transition.kind !== "source")).toBe(true);
      if (epoch === 625 || epoch === 626) expect(game.goalsFor(sinks[0].id)).toMatchObject([{ color: "red", count: 15 }]);
      const permanent = sinks.filter((sink) => game.goalsFor(sink.id).every((goal) => goal.count === Infinity));
      const milestone = milestones.get(epoch);
      expect(permanent).toHaveLength(milestone ? 1 : 0);
      if (!milestone) continue;
      seen.push(epoch);
      const sink = permanent[0];
      expect(sink.open?.map((port) => port.color)).toEqual(milestone.colors);
      expect(sink.open?.every((port) => port.count === 1)).toBe(true);
      const x = (sink.x - bounds.left) / (bounds.right - bounds.left);
      const y = (sink.y - bounds.top) / (bounds.bottom - bounds.top);
      for (const fraction of [x, y]) {
        expect(fraction).toBeGreaterThanOrEqual((1 - milestone.fraction) / 2 - 1e-9);
        expect(fraction).toBeLessThanOrEqual((1 + milestone.fraction) / 2 + 1e-9);
      }
      if (epoch === 300) blueId = sink.id;
      if (epoch === 400) {
        const blue = game.sim.net.transitions.get(blueId)!;
        expect(Math.hypot(sink.x - blue.x, sink.y - blue.y)).toBeGreaterThanOrEqual(300);
      }
    }
    expect(seen).toEqual([...milestones.keys()]);
  }, 30000);

  it("limits the initial source at epoch 2000 and keeps spawning after its exhaustion", () => {
    const { game, reach, advance } = setup();
    const source = game.starterSource!;
    reach(1999);
    expect(source.supply).toBeUndefined();
    source.autoInterval = 3;
    advance();
    expect(game.epoch).toBe(2000);
    expect(source).toMatchObject({ supply: 50, initialSupply: 50, autoInterval: 3 });
    source.autoInterval = undefined;
    advance();
    expect(game.epoch).toBe(2001);
    expect(source.supply).toBe(35);

    expect(game.remove("starterOutput")).toBe(false);
    for (let remaining = 35; remaining > 0; remaining--) {
      if (remaining % 10 === 5) {
        game.sim.step(1);
        game.sim.net.places.get("starterPlace")!.marking = [];
      }
      expect(game.sim.fire(source.id)).toBe(true);
    }
    expect(source.supply).toBe(0);
    expect(game.sim.fire(source.id)).toBe(false);
    game.step(2);
    expect(game.sim.net.transitions.has(source.id)).toBe(false);
    const center = { x: source.x, y: source.y };
    game.setPortrait(true);
    expect(source).toMatchObject({ x: center.y, y: center.x });
    const epoch = game.epoch;
    game.sim.net.addTransition({ id: "replacementSource", x: source.x - 100, y: source.y, kind: "source" });
    game.sim.net.addArc({ id: "replacementOutput", from: "replacementSource", to: "starterPlace", color: "blue" });
    game.sim.net.places.get("starterPlace")!.marking = [];
    for (let i = 0; i < 15; i++) expect(game.sim.fire("replacementSource")).toBe(true);
    game.step(0);
    expect(game.epoch).toBeGreaterThan(epoch);
  }, 30000);

  it.each([["blue", "red"], ["yellow", "green"], ["blue", "red", "green", "yellow"]] satisfies Color[][])(
    "consumes complete %j groups atomically from a shared place and resolves after five firings", (...colors) => {
      const definition = structuredClone(endless);
      definition.goals = colors.map((color) => ({ sinkId: "starterSink", color, count: 5 }));
      definition.net.transitions.forEach((transition) => { transition.autoInterval = undefined; });
      definition.net.transitions.find((transition) => transition.id === "starterSink")!.open = colors.map((color) => ({ dir: "in", color }));
      definition.net.arcs = definition.net.arcs.filter((arc) => arc.id !== "starterInput");
      const game = new Game(definition);
      for (let i = 0; i < colors.length; i++) expect(game.connect("starterSink", 0, "starterDestination")).toBe(true);
      const place = game.sim.net.places.get("starterDestination")!;
      place.marking.push(...colors.slice(1));
      const partial = [...place.marking];
      expect(game.sim.fire("starterSink")).toBe(false);
      expect(place.marking).toEqual(partial);
      place.marking = [];
      for (let firing = 1; firing <= 5; firing++) {
        place.marking.push(...colors);
        expect(game.sim.fire("starterSink")).toBe(true);
        expect(place.marking).toEqual([]);
        expect(game.score).toBe((firing - 1) * colors.length);
        game.sim.step(1);
        expect(game.score).toBe(firing * colors.length);
      }
      expect(game.sim.fire("starterSink")).toBe(false);
      expect(game.resolved.has("starterSink")).toBe(true);
    });

  it("resets an infinite sink's starvation deadline on every delivery, even before warnings begin", () => {
    const definition = structuredClone(endless);
    definition.goals[0].count = Infinity;
    definition.net.transitions.forEach((transition) => { transition.autoInterval = undefined; });
    const game = new Game(definition, () => 0.95, { survival: true });
    for (let i = 0; i < 8; i++) {
      game.sim.net.places.get("starterDestination")!.marking.push("blue");
      expect(game.sim.fire("starterSink")).toBe(true);
      game.sim.step(1);
    }
    expect(game.score).toBe(8);
    expect(game.goalsFor("starterSink")).toMatchObject([{ count: Infinity, delivered: 8, done: false }]);
    expect(game.resolved.has("starterSink")).toBe(false);
    expect(game.sim.net.transitions.get("starterSink")!.disabled).toBeFalsy();
    game.sim.step(89);
    expect(game.endangeredSinks()).toEqual([]);
    game.sim.step(1);
    expect(game.endangeredSinks()).toHaveLength(1);
    game.sim.net.places.get("starterDestination")!.marking.push("blue");
    expect(game.sim.fire("starterSink")).toBe(true);
    game.sim.step(1);
    expect(game.score).toBe(9);
    expect(game.endangeredSinks()).toEqual([]);
    const deadline = game["countdowns"].get("starterSink")!.deadline;
    expect(deadline).toBeCloseTo(98 + 200 / 230 + 150);
    game.sim.step(deadline - game.sim.time - 0.01);
    expect(game.failed.has("starterSink")).toBe(false);
    game.sim.step(0.02);
    expect(game.failed.has("starterSink")).toBe(true);
    expect(game.lives).toBe(9);
    expect(game.offers.size).toBe(0);
  });

  it("refreshes infinite multicolor sinks for each input arrival, not just completed firings", () => {
    const definition = structuredClone(endless);
    definition.goals[0].count = Infinity;
    definition.goals.push({ sinkId: "starterSink", color: "red", count: Infinity });
    definition.net.transitions.forEach((transition) => { transition.autoInterval = undefined; });
    definition.net.places.push({ id: "far", x: -3600, y: 400, marking: ["red"] });
    definition.net.arcs.push({ id: "farInput", from: "far", to: "starterSink", color: "red" });
    const game = new Game(definition, () => 0.5, { survival: true });
    game.sim.step(190);
    expect(game.endangeredSinks()).toHaveLength(1);
    game.sim.net.places.get("starterDestination")!.marking.push("blue");
    expect(game.sim.fire("starterSink")).toBe(true);
    game.sim.step(1);
    expect(game.score).toBe(0);
    expect(game.endangeredSinks()).toEqual([]);
    expect(game["countdowns"].get("starterSink")!.deadline).toBeCloseTo(190 + 200 / 230 + 150);
    game.sim.step(20);
    expect(game.score).toBe(2);
    expect(game["countdowns"].get("starterSink")!.deadline).toBeCloseTo(360);
    game.sim.step(149);
    expect(game.failed.get("starterSink")).toBeCloseTo(360);
  });

  it("uses the same 150-second reset for infinite yellow sinks", () => {
    const definition = structuredClone(endless);
    definition.goals[0] = { sinkId: "starterSink", color: "yellow", count: Infinity };
    definition.net.arcs.find((arc) => arc.id === "starterInput")!.color = "yellow";
    definition.net.transitions.forEach((transition) => { transition.autoInterval = undefined; });
    const game = new Game(definition, () => 0.5, { survival: true });
    game.sim.net.places.get("starterDestination")!.marking.push("yellow");
    expect(game.sim.fire("starterSink")).toBe(true);
    game.sim.step(1);
    expect(game["countdowns"].get("starterSink")!.deadline).toBeCloseTo(150 + 200 / 230);
    expect(game.endangeredSinks()).toEqual([]);
    game.sim.step(29.8);
    expect(game.endangeredSinks()).toEqual([]);
    game.sim.step(0.1);
    expect(game.endangeredSinks()).toHaveLength(1);
  });

  it("does not revive an infinite sink when an input arrives after its deadline", () => {
    const definition = structuredClone(endless);
    definition.goals[0].count = Infinity;
    definition.net.transitions.forEach((transition) => { transition.autoInterval = undefined; });
    const game = new Game(definition, () => 0.5, { survival: true });
    game.sim.step(239.9);
    game.sim.net.places.get("starterDestination")!.marking.push("blue");
    expect(game.sim.fire("starterSink")).toBe(true);
    game.sim.step(2);
    expect(game.failed.get("starterSink")).toBe(240);
    expect(game.score).toBe(0);
    expect(game.snapshot().endlessProgress).toBe(0);
    expect(game.statistics.sinkDeaths).toEqual([{ time: 240, colors: ["blue"] }]);
  });
});

describe("survival mode", () => {
  function survivalGame(sinks = 1) {
    const definition = structuredClone(endless);
    definition.net.transitions.find((t) => t.id === "starterSource")!.autoInterval = undefined;
    for (let i = 1; i < sinks; i++) {
      definition.net.transitions.push({ id: `timeout${i}`, x: 1000 + i * 100, y: 0, kind: "sink" });
      definition.goals.push({ sinkId: `timeout${i}`, color: "blue", count: 5 });
    }
    return new Game(definition, () => 0.5, { survival: true });
  }

  it("preserves survival totals while endless scoring and epoch progression continue", () => {
    const game = survivalGame();
    expect(game.survivalResult).toBeUndefined();
    for (let i = 0; i < 15; i++) expect(game.sim.fire("starterSource")).toBe(true);
    game.step(0);
    game.sim.step(1);
    game.sim.net.places.get("starterDestination")!.marking.push(...Array<"blue">(5).fill("blue"));
    for (let i = 0; i < 5; i++) expect(game.sim.fire("starterSink")).toBe(true);
    game.sim.step(1);
    expect(game.score).toBe(5);
    expect(game.epoch).toBe(1);
    game.continueEndless();
    expect(game.survivalResult).toEqual({ score: 5, epoch: 1 });
    expect(game.statistics.endlessAt).toBe(2);
    game.sim.net.places.get("starterPlace")!.marking = [];
    for (let i = 0; i < 15; i++) expect(game.sim.fire("starterSource")).toBe(true);
    game.step(0);
    const goal = game.goals().find((goal) => goal.sinkId !== "starterSink")!;
    game.sim.net.connect(goal.sinkId, 0, "starterDestination");
    game.sim.net.places.get("starterDestination")!.marking.push("blue");
    expect(game.sim.fire(goal.sinkId)).toBe(true);
    game.step(10);
    expect(game.score).toBe(6);
    expect(game.epoch).toBe(2);
    game.continueEndless();
    expect(game.survivalResult).toEqual({ score: 5, epoch: 1 });
    expect(game.statistics.endlessAt).toBe(2);
    expect(survivalGame().survivalResult).toBeUndefined();
  });

  it("lists each endangered sink at countdown start and removes it after resolution or timeout", () => {
    const game = survivalGame(2);
    expect(game.endangeredSinks()).toEqual([]);
    game.sim.step(179.9);
    expect(game.endangeredSinks()).toEqual([]);
    game.sim.step(0.1);
    expect(game.endangeredSinks().map((sink) => sink.sinkId)).toEqual(["starterSink", "timeout1"]);
    expect(game.endangeredSinks().map((sink) => sink.color)).toEqual(["blue", "blue"]);
    game.sim.net.places.get("starterDestination")!.marking.push(...Array<"blue">(5).fill("blue"));
    for (let i = 0; i < 5; i++) game.sim.fire("starterSink");
    game.sim.step(1);
    expect(game.endangeredSinks().map((sink) => sink.sinkId)).toEqual(["timeout1"]);
    const deaths: string[] = [];
    game.onSinkDeath((sink) => deaths.push(`${sink.sinkId}:${sink.color}`));
    game.sim.step(59);
    expect(game.endangeredSinks()).toEqual([]);
    expect(deaths).toEqual(["timeout1:blue"]);
    expect(game.statistics.sinkDeaths).toEqual([{ time: 240, colors: ["blue"] }]);
    game.step(0.1);
    expect(deaths).toHaveLength(1);
    expect(game.statistics.sinkDeaths).toHaveLength(1);
  });

  it.each(["red", "yellow"] as const)("uses the %s sink color and its countdown timing for notices", (color) => {
    const definition = structuredClone(endless);
    definition.goals[0].color = color;
    definition.net.transitions.find((t) => t.id === "starterSource")!.autoInterval = undefined;
    const game = new Game(definition, Math.random, { survival: true });
    const factor = color === "yellow" ? 2 : 1;
    const deaths: string[] = [];
    game.onSinkDeath((sink) => deaths.push(sink.color));
    game.sim.step(180 * factor - 0.1);
    expect(game.endangeredSinks()).toEqual([]);
    game.sim.step(0.1);
    expect(game.endangeredSinks()[0]).toMatchObject({ sinkId: "starterSink", color, remaining: 60 * factor });
    game.sim.step(60 * factor - 15);
    expect(game.endangeredSinks()[0].remaining).toBeCloseTo(15);
    game.sim.step(15);
    expect(game.endangeredSinks()).toEqual([]);
    expect(deaths).toEqual([color]);
  });

  it("moves an urgent sink back out of the final fifteen seconds when a token arrives", () => {
    const game = survivalGame();
    game.sim.step(225);
    expect(game.endangeredSinks()[0].remaining).toBeCloseTo(15);
    game.sim.net.places.get("starterDestination")!.marking.push("blue");
    expect(game.sim.fire("starterSink")).toBe(true);
    game.sim.step(1);
    expect(game.endangeredSinks()[0].remaining).toBeCloseTo(24);
  });

  it("loses one life per sink timeout, not on completion or repeated steps", () => {
    const game = survivalGame(2);
    const losses: { x: number; y: number }[] = [];
    game.onLifeLost((position) => losses.push(position));
    game.sim.net.places.get("starterDestination")!.marking.push(...Array<"blue">(5).fill("blue"));
    for (let i = 0; i < 5; i++) expect(game.sim.fire("starterSink")).toBe(true);
    game.sim.step(1);
    expect(game.score).toBe(5);
    expect(game.lives).toBe(10);
    game.sim.step(239);
    expect(game.lives).toBe(9);
    const sink = game.sim.net.transitions.get("timeout1")!;
    expect(losses).toEqual([{ x: sink.x, y: sink.y }]);
    game.step(0.1);
    expect(game.lives).toBe(9);
    expect(losses).toHaveLength(1);
    expect(game.complete).toBe(false);
  });

  it("freezes on the last timeout, then preserves the run when continuing in endless", () => {
    const game = survivalGame(11);
    const losses: { x: number; y: number }[] = [];
    game.onLifeLost((position) => losses.push(position));
    game.sim.step(239.9);
    expect(game.sim.fire("starterSource")).toBe(true);
    game.sim.net.transitions.get("starterSource")!.autoInterval = 0.1;
    const coins = game.coins;
    game.step(30);
    expect(game.lives).toBe(0);
    expect(game.survivalFailed).toBe(true);
    expect(game.complete).toBe(true);
    expect(losses).toHaveLength(10);
    expect(game.statistics.sinkDeaths).toHaveLength(10);
    const time = game.sim.time;
    const tokens = game.sim.inFlight.map((token) => ({ ...token }));
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens).toHaveLength(1);
    game.step(100);
    expect(game.sim.time).toBe(time);
    expect(game.sim.inFlight).toEqual(tokens);
    expect(game.playerFire("starterRelay")).toBe(false);
    game.continueEndless();
    expect(game.statistics.endlessAt).toBe(time);
    expect(game.survival).toBe(false);
    expect(game.complete).toBe(false);
    expect(game.coins).toBe(coins);
    expect(game.sim.time).toBe(time);
    expect(game.sim.inFlight).toEqual(tokens);
    game.step(1);
    expect(game.sim.time).toBeGreaterThan(time);
    expect(game.sim.net.places.get("starterPlace")!.marking).toContain("blue");
    expect(game.buyLife({ x: 0, y: 0 })).toBe(false);
    expect(losses).toHaveLength(10);
  });

  it("charges only successful life purchases, independently of upgrade prices and up to the cap", () => {
    const game = survivalGame(2);
    game.sim.net.addPlace({ id: "funds", x: -1000, y: 0, capacity: 19, marking: Array(19).fill("blue") });
    expect(game.remove("funds")).toBe(true);
    expect(game.coins).toBe(59);
    expect(game.buyLife({ x: 0, y: 0 })).toBe(false);
    expect(game.lifePrice).toBe(50);
    game.sim.step(240);
    expect(game.lives).toBe(8);
    expect(game.buyLife({ x: 0, y: 0 }, false)).toBe(true);
    expect(game.lifePrice).toBe(50);
    game.paused = true;
    expect(game.buyLife({ x: 0, y: 0 })).toBe(false);
    game.paused = false;
    expect(game.buyLife({ x: 0, y: 0 })).toBe(true);
    expect(game.coins).toBe(9);
    expect(game.lives).toBe(9);
    expect(game.lifePrice).toBe(60);
    expect(game.upgradePrice).toBe(5);
    expect(game.buyLife({ x: 0, y: 0 })).toBe(false);
    for (let i = 0; i < 3; i++) {
      game.sim.net.addPlace({ id: `funds${i}`, x: -2000 - i * 100, y: 0, capacity: 19, marking: Array(19).fill("blue") });
      expect(game.remove(`funds${i}`)).toBe(true);
    }
    expect(game.buyLife({ x: 0, y: 0 })).toBe(true);
    expect(game.lives).toBe(10);
    expect(game.coins).toBe(6);
    expect(game.lifePrice).toBe(70);
    expect(game.buyLife({ x: 0, y: 0 })).toBe(false);
  });

  it("signals insufficient coins only for an attempted life purchase below the cap", () => {
    const game = survivalGame();
    let insufficient = 0;
    game.onInsufficientCoins(() => { insufficient++; });
    expect(game.buyLife({ x: 0, y: 0 })).toBe(false);
    expect(insufficient).toBe(0);
    game.sim.step(240);
    expect(game.buyLife({ x: 0, y: 0 }, false)).toBe(false);
    expect(insufficient).toBe(0);
    expect(game.buyLife({ x: 0, y: 0 })).toBe(false);
    expect(insufficient).toBe(1);
    expect(game.coins).toBe(40);
    expect(game.lives).toBe(9);
    game.paused = true;
    expect(game.buyLife({ x: 0, y: 0 })).toBe(false);
    expect(insufficient).toBe(1);
  });

  it("does not lose lives in ordinary endless mode or from source timeouts", () => {
    const game = new Game(endless, () => 0.5, { survival: true });
    const losses: { x: number; y: number }[] = [];
    game.onLifeLost((position) => losses.push(position));
    game.sim.net.transitions.get("starterSource")!.autoInterval = undefined;
    for (let i = 0; i < 6; i++) {
      game.sim.net.places.get("starterPlace")!.marking = [];
      for (let j = 0; j < 15; j++) game.sim.fire("starterSource");
      game.step(0);
      game.sim.step(1);
    }
    const source = [...game.sim.net.transitions.values()].find((t) => t.kind === "source" && t.id !== "starterSource")!;
    const sinkIds = new Set(game.goals().map((g) => g.sinkId));
    // Finish goals before their timeout, isolating the source's expiry.
    for (const id of sinkIds) {
      const goal = game.goalsFor(id)[0];
      const transition = game.sim.net.transitions.get(id)!;
      transition.open = [];
      const place = game.sim.net.places.get("starterDestination")!;
      place.marking = Array(goal.count).fill(goal.color);
      if (!game.sim.net.inputs(id).length) game.sim.net.addArc({ id: `test-${id}`, from: place.id, to: id, color: goal.color });
      for (let i = 0; i < goal.count; i++) game.sim.fire(id);
      game.sim.step(10);
    }
    game.sim.step(300);
    expect(game.failed.has(source.id)).toBe(true);
    expect(game.statistics.sinkDeaths).toEqual([]);
    expect(game.lives).toBe(10);
    expect(losses).toEqual([]);
    const ordinary = new Game(endless);
    ordinary.sim.step(240);
    expect(ordinary.lives).toBe(10);
    expect(ordinary.complete).toBe(false);
  });
});

describe("epoch overview", () => {
  it("matches the spawn thresholds and probabilities used by the game", () => {
    const r = ENDLESS_RULES;
    const percent = (n: number) => Math.round(n * 100);
    const section = design.split("## Epoch progression")[1]?.split("### Powerup unlocks")[0];
    expect(section).toBeDefined();
    expect(section).toContain(`Private progress gains 1 unit per simulation second, ${EMISSION_PROGRESS} per emitted source token, and 1 per completed sink delivery.`);
    expect(section).toContain(`Every ${ENDLESS_EPOCH_PROGRESS} units creates one new goal epoch`);
    const rows = section!.split("\n").filter((line) => /^\| (?:\d|Exactly \d)/.test(line));
    expect(rows).toEqual([
      `| 1–${r.blueOnlyEpochs} | Blue sink, requiring 5 tokens, one per firing. |`,
      `| ${r.blueOnlyEpochs + 1} | Red sink and paired red source, each with 5 tokens. |`,
      `| ${r.blueOnlyEpochs + 2}–${r.greenFrom - 1} | Each epoch is ${percent(1 - r.redChance)}% blue sink, ${percent(r.redChance)}% red sink with paired source. |`,
      `| ${r.distantRedAfter + 1} onward | Red endpoints are at least ${BUILD_RANGE + 30} units from existing nodes and ${BUILD_RANGE * 1.5} units apart instead of ${BUILD_RANGE - 1}; the sink is ${BUILD_RANGE * 1.5} units from its anchor. Room is reserved for intermediate connections. |`,
      `| ${r.variedRedAfter + 1} onward | Red source and sink counts are sampled from 5 (${percent(r.redFiveRoll)}%), 10 (${percent(r.redTenRoll - r.redFiveRoll)}%), or 15 (${percent(1 - r.redTenRoll)}%), subject to supply balancing. |`,
      `| ${r.blueDoubleFrom}–${r.blueTripleAfter} | Each blue sink has a ${percent(1 - r.blueDoubleRoll)}% chance of consuming 2 tokens per firing; otherwise it consumes 1. |`,
      `| ${r.greenFrom}–${r.yellowFrom - 1} | Each epoch is ${percent((1 - r.greenChance) * (1 - r.redChance))}% blue, ${percent((1 - r.greenChance) * r.redChance)}% red, or ${percent(r.greenChance)}% green. Green sinks require 5 tokens and have no source. |`,
      `| ${r.blueTripleAfter + 1} onward | Each blue sink has a ${percent(1 - r.blueTripleRoll)}% chance of consuming 3 tokens per firing, a ${percent(r.blueTripleRoll - r.blueDoubleRoll)}% chance of consuming 2, and otherwise consumes 1. |`,
      `| ${r.redSoloFrom} onward | Red sinks alternate between paired and source-free, starting with a paired sink. Paired sources reserve at least 5 tokens for the next source-free sink; sink demands and source supplies remain 5, 10, or 15. |`,
      `| ${r.yellowFrom} onward | Each epoch is ${percent((1 - r.greenChance - r.yellowChance) * (1 - r.redChance))}% blue, ${percent((1 - r.greenChance - r.yellowChance) * r.redChance)}% red, ${percent(r.greenChance)}% green, or ${percent(r.yellowChance)}% yellow. Yellow sinks have no source, require 10, 20, or 30 tokens with equal probability, and have twice the normal grace and countdown. |`,
      `| ${r.doubledDemandFrom} onward | New single-color blue and green sinks require twice as many tokens, without changing their input weights or existing sinks. |`,
      `| ${r.blueRedFrom} onward | A ${percent(r.pairChance)}% chance of a blue-red sink requiring 5 pairs, one blue and one red token per firing, without a paired source. |`,
      `| ${r.yellowGreenFrom} onward | A separate ${percent(r.pairChance)}% chance of a yellow-green sink requiring 5 pairs, without a paired source. |`,
      `| ${r.quadrupleFrom} onward | A separate ${percent(r.quadrupleChance)}% chance of a four-color sink requiring 5 blue-red-green-yellow quadruples. |`,
      `| ${r.variedBlueRedFrom} onward | Blue-red demands become 5 (${percent(r.redFiveRoll)}%), 10 (${percent(r.redTenRoll - r.redFiveRoll)}%), or 15 (${percent(1 - r.redTenRoll)}%) pairs. |`,
      `| ${r.variedQuadrupleFrom} onward | Four-color sinks require 10 or 15 quadruples with equal probability, never 5. |`,
      "| Exactly 300 | One infinite blue sink inside the central 30% of the map extent on both axes. |",
      "| Exactly 400 | One infinite red sink inside the central 50%, at least 300 units from where the infinite blue sink appeared. |",
      "| Exactly 500 | One infinite green sink inside the central 65%. |",
      "| Exactly 600 | One infinite yellow sink inside the central 75%. |",
      `| ${r.redSourcesUntil} onward | No new red sources; ordinary red sinks still appear and require 5, 10 or 15 tokens without the earlier supply-balance cap. Existing red sources are unchanged. |`,
      "| Exactly 725 | One infinite red-blue pair sink anywhere within the map extent. |",
      "| Exactly 850 | One infinite yellow-green pair sink anywhere within the map extent. |",
      "| Exactly 1000 | One infinite four-color sink anywhere within the map extent. |",
      "| 1000–1249 | Epochs divisible by 3 create 2 sinks; other epochs create 1. |",
      "| 1250–1499 | Even epochs create 2 sinks; odd epochs create 1, replacing the rule of thirds. |",
      "| 1500–1749 | Every epoch creates 2 sinks. |",
      "| 1750 onward | Every epoch creates 3 sinks. |",
      `| Exactly ${STARTER_SOURCE_LIMIT_EPOCH} | The starting blue source becomes finite with ${STARTER_SOURCE_SUPPLY} remaining firings and shows a warning until exhausted. Its original position remains the spawn anchor after it disappears. |`,
    ]);
  });
});

describe("goal sinks", () => {
  it("count only matching tokens once they arrive", () => {
    const game = new Game(level());
    game.sim.fire("sink");
    expect(game.goalsFor("sink")[0].delivered).toBe(0);
    // 100 units at 230 units/s: the first red arrives after ~0.43s.
    run(game, 0.4);
    expect(game.goalsFor("sink")[0].delivered).toBe(0);
    run(game, 0.1);
    expect(game.goalsFor("sink")[0].delivered).toBe(1);
  });

  describe("endless mode", () => {
    it("scores only matching tokens once they arrive and never wins when all goals resolve", () => {
      const definition = level();
      definition.mode = "endless";
      definition.net.transitions[0].autoInterval = undefined;
      const game = new Game(definition);
      const deliveries = vi.fn();
      game.onDeliveries(deliveries);

      expect(game.sim.fire("sink")).toBe(true);
      expect(game.score).toBe(0);
      expect(deliveries).not.toHaveBeenCalled();
      run(game, 0.5);
      expect(game.score).toBe(1);
      expect(game.snapshot().endlessProgress - game.sim.time).toBeCloseTo(1);
      expect(deliveries).toHaveBeenLastCalledWith({ red: 1 });
      expect(game.sim.fire("sink")).toBe(true);
      run(game, 0.5);
      expect(game.score).toBe(1);
      expect(game.snapshot().endlessProgress - game.sim.time).toBeCloseTo(1);
      expect(deliveries).toHaveBeenCalledTimes(1);
      expect(game.sim.fire("sink")).toBe(true);
      expect(game.score).toBe(1);
      run(game, 0.5);
      expect(game.score).toBe(2);
      expect(game.snapshot().endlessProgress - game.sim.time).toBeCloseTo(2);
      expect(deliveries).toHaveBeenCalledTimes(2);
      expect(game.complete).toBe(false);
      run(game, RESOLVED_LINGER + 0.1);
      expect(game.sim.net.transitions.has("sink")).toBe(false);
      expect(game.goals()).toEqual([]);
      expect(game.score).toBe(2);
      expect(game.complete).toBe(false);
    });

    it("notifies only the scored colors and amounts in simultaneous and excess deliveries", () => {
      const game = new Game({
        ...level(), mode: "endless",
        goals: [{ sinkId: "sink", color: "blue", count: 1 }, { sinkId: "sink", color: "red", count: 3 }],
        net: {
          places: [{ id: "p", x: 0, y: 0, marking: ["blue", "blue", "blue", "blue", "red", "red"] }],
          transitions: [{ id: "sink", x: 100, y: 0, kind: "sink" }],
          arcs: [
            { id: "blue", from: "p", to: "sink", color: "blue", count: 2 },
            { id: "red", from: "p", to: "sink", color: "red" },
          ],
        },
      });
      const deliveries = vi.fn();
      game.onDeliveries(deliveries);
      expect(game.sim.fire("sink")).toBe(true);
      run(game, 0.5);
      expect(game.score).toBe(2);
      expect(deliveries).toHaveBeenLastCalledWith({ blue: 1, red: 1 });
      expect(game.sim.fire("sink")).toBe(true);
      run(game, 0.5);
      expect(game.score).toBe(3);
      expect(deliveries).toHaveBeenLastCalledWith({ red: 1 });
      expect(deliveries).toHaveBeenCalledTimes(2);
    });

    function pausedGame(random = () => 0): Game {
      const game = new Game(endless, random);
      game.sim.net.transitions.get("starterSource")!.autoInterval = undefined;
      return game;
    }

    function advanceEpoch(game: Game) {
      game.sim.net.places.get("starterPlace")!.marking = [];
      for (let i = 0; i < 15; i++) expect(game.sim.fire("starterSource")).toBe(true);
      const before = new Set(game.sim.net.transitions.keys());
      game.step(0);
      const spawned = [...game.sim.net.transitions.values()].filter((transition) => !before.has(transition.id));
      game.sim.step(1);
      return spawned;
    }

    function redPair(game: Game) {
      const source = [...game.sim.net.transitions.values()].find((t) => t.kind === "source" && t.id !== "starterSource")!;
      const goal = game.goals().find((g) => g.color === "red")!;
      return { source, sink: game.sim.net.transitions.get(goal.sinkId)! };
    }

    function connectPair(game: Game, source: { id: string; x: number; y: number }, sink: { id: string; x: number; y: number }): string {
      const point = Array.from({ length: 64 }, (_, i) => {
        const angle = i * Math.PI * 2 / 64;
        return { x: source.x + 140 * Math.cos(angle), y: source.y + 140 * Math.sin(angle) };
      }).find((p) => !game.placementIssue("place", p.x, p.y) && withinConnectionRange(sink, p));
      expect(point).toBeDefined();
      const place = game.buildConnectedPlace(source.id, 0, point!.x, point!.y);
      expect(place).toBeDefined();
      expect(game.connect(sink.id, 0, place!)).toBe(true);
      return place!;
    }

    it("starts with a manual blue relay between a large source place and an upgradable destination", () => {
      const game = new Game(endless);
      expect([...game.sim.net.places.values()].map((p) => p.capacity)).toEqual([19, 7]);
      expect(game.upgradeCapacity("starterDestination", false)).toBe(true);
      expect(game.sim.net.transitions.size).toBe(3);
      expect(game.sim.net.transitions.get("starterSource")?.supply).toBeUndefined();
      expect(game.goals()).toMatchObject([{ color: "blue", count: 5 }]);
      expect(game.level.tools?.kits?.map((kit) => kit.id)).toEqual(["relay"]);
      game.step(4);
      expect(game.score).toBe(0);
      expect(game.playerFire("starterRelay")).toBe(true);
      game.step(3);
      expect(game.score).toBe(1);
      expect(new Game(endless).score).toBe(0);
    });

    it("spawns an epoch for fifteen emitted tokens, sixty seconds, or a proportional mixture", () => {
      const emitted = pausedGame();
      for (let i = 0; i < 14; i++) expect(emitted.sim.fire("starterSource")).toBe(true);
      emitted.step(0);
      expect(emitted.goals()).toHaveLength(1);
      expect(emitted.sim.fire("starterSource")).toBe(true);
      emitted.step(0);
      expect(emitted.goals()).toHaveLength(2);
      expect(emitted.epoch).toBe(1);

      const mixed = pausedGame();
      for (let i = 0; i < 3; i++) expect(mixed.sim.fire("starterSource")).toBe(true);
      mixed.step(47.9);
      expect(mixed.goals()).toHaveLength(1);
      mixed.step(0.2);
      expect(mixed.goals()).toHaveLength(2);

      const timed = pausedGame();
      timed.step(59.9);
      expect(timed.goals()).toHaveLength(1);
      timed.step(0.2);
      expect(timed.goals()).toHaveLength(2);

      const multiple = structuredClone(endless);
      multiple.net.arcs.find((arc) => arc.id === "starterOutput")!.count = 2;
      const multiGame = new Game(multiple);
      multiGame.sim.net.transitions.get("starterSource")!.autoInterval = undefined;
      for (let i = 0; i < 7; i++) expect(multiGame.sim.fire("starterSource")).toBe(true);
      multiGame.step(0);
      expect(multiGame.goals()).toHaveLength(1);
      expect(multiGame.sim.fire("starterSource")).toBe(true);
      multiGame.step(0);
      expect(multiGame.goals()).toHaveLength(2);
    });

    it.each([
      { colors: ["blue"], weight: 1 },
      { colors: ["blue"], weight: 3 },
      { colors: ["blue", "red", "green", "yellow"], weight: 1 },
    ] satisfies { colors: Color[]; weight: number }[])("adds one progress unit per completed delivery with $colors and weight $weight", ({ colors, weight }) => {
      const game = new Game({
        ...endless,
        goals: colors.map((color) => ({ sinkId: "sink", color, count: weight * 2 })),
        net: {
          places: [{ id: "p", x: 0, y: 0, marking: colors.flatMap((color) => Array<Color>(weight * 2).fill(color)) }],
          transitions: [
            { id: "starterSource", x: 200, y: 400, kind: "source", open: [{ dir: "out", color: "blue" }] },
            { id: "sink", x: 100, y: 0, kind: "sink" },
          ],
          arcs: colors.map((color) => ({ id: color, from: "p", to: "sink", color, count: weight })),
        },
      }, () => 0);
      game.step(58.5);
      expect(game.sim.fire("sink")).toBe(true);
      expect(game.snapshot().endlessProgress).toBeCloseTo(58.5);
      game.sim.step(0.5);
      expect(game.snapshot().endlessProgress).toBeCloseTo(59.5);
      game.step(0);
      expect(game.epoch).toBe(0);
      expect(game.score).toBe(colors.length * weight);
      expect(game.sim.fire("sink")).toBe(true);
      game.sim.step(0.5);
      game.step(0);
      expect(game.epoch).toBe(1);
      expect(game.snapshot().endlessProgress).toBeCloseTo(0.5);
    });

    it("freezes game time and manual firing while paused, then resumes", () => {
      const game = pausedGame();
      game.sim.net.places.get("starterPlace")!.marking.push("blue");
      game.paused = true;
      game.step(60);
      expect(game.sim.time).toBe(0);
      expect(game.epoch).toBe(0);
      expect(game.playerFire("starterRelay")).toBe(false);
      expect(game.sim.net.places.get("starterPlace")!.marking).toEqual(["blue"]);
      game.paused = false;
      expect(game.playerFire("starterRelay")).toBe(true);
      game.step(1);
      expect(game.sim.time).toBeCloseTo(1);
    });

    it.each([
      { roll: 0.6, expected: [1, 1, 1, 1] },
      { roll: 0.8, expected: [1, 2, 2, 2] },
      { roll: 0.95, expected: [1, 2, 2, 3] },
    ])("introduces occasional multi-token blue sinks at the epoch boundaries (roll $roll)", ({ roll, expected }) => {
      const game = pausedGame(() => roll);
      const seen: number[] = [];
      let weightedSink = "";
      for (let epoch = 1; epoch <= 51; epoch++) {
        game.sim.net.places.get("starterPlace")!.marking = [];
        for (let i = 0; i < 15; i++) expect(game.sim.fire("starterSource")).toBe(true);
        game.step(0);
        const goal = game.goals().at(-1)!;
        if ([24, 25, 50, 51].includes(epoch)) {
          expect(goal.color).toBe("blue");
          const sink = game.sim.net.transitions.get(goal.sinkId)!;
          const count = sink.open![0].count!;
          seen.push(count);
          expect(goal.count).toBe(count === 1 ? 5 : 6);
          if (epoch === 51 && count > 1) weightedSink = sink.id;
        }
        game.sim.step(1);
      }
      expect(seen).toEqual(expected);
      if (weightedSink) {
        const sink = game.sim.net.transitions.get(weightedSink)!;
        game.sim.net.addPlace({ id: "weightedInput", x: sink.x - 100, y: sink.y, capacity: 7, marking: Array(7).fill("blue") });
        expect(game.connect(sink.id, 0, "weightedInput")).toBe(true);
        game.step(3);
        expect(game.score).toBe(6);
        expect(game.sim.net.places.get("weightedInput")!.marking).toEqual(["blue"]);
      }
    });

    it("creates five blue epochs before red pairs, with nearby, well-spaced nodes", () => {
      const game = pausedGame(() => 0.9);
      for (let epoch = 1; epoch <= 7; epoch++) {
        game.step(epoch * 60 - game.sim.time - 0.1);
        const before = game.sim.net.liveNodes().map((node) => ({ ...node }));
        const beforeIds = new Set(before.map((node) => node.id));
        game.step(0.2);
        const spawned = [...game.sim.net.transitions.values()].filter((t) => !beforeIds.has(t.id));
        expect(spawned).toHaveLength(epoch === 6 ? 2 : 1);
        const sink = spawned.find((t) => t.kind === "sink")!;
        expect(game.goalsFor(sink.id)).toMatchObject([{ color: epoch === 6 ? "red" : "blue", count: 5 }]);
        if (epoch === 6) expect(spawned.find((t) => t.kind === "source")).toMatchObject({ supply: 5, open: [{ color: "red" }] });
        for (const node of spawned) {
          const anchors = node.kind === "source" ? [...before, sink] : before;
          expect(Math.min(...anchors.map((other) => Math.hypot(node.x - other.x, node.y - other.y)))).toBeLessThanOrEqual(BUILD_RANGE);
          for (const other of before) {
            const radius = game.sim.net.places.has(other.id) ? PLACE_FOOTPRINT : TRANSITION_FOOTPRINT;
            expect(Math.hypot(node.x - other.x, node.y - other.y)).toBeGreaterThanOrEqual(TRANSITION_FOOTPRINT + radius + CLEARANCE);
          }
          expect(game.remove(node.id)).toBe(false);
        }
        if (epoch === 3) game.setPortrait(true);
      }
      expect(endless.goals).toHaveLength(1);
      expect(new Game(endless).goals()).toHaveLength(1);
    });

    it("favors the starting source over distant structures while allowing varied placements", () => {
      const definition = structuredClone(endless);
      for (let i = 0; i < 8; i++) {
        definition.net.places.push({ id: `distant${i}`, x: 2400 + i * 200, y: 0, marking: [] });
      }
      const distances: number[] = [];
      for (let i = 0; i < 80; i++) {
        let seed = Math.imul(i + 1, 2654435761) >>> 0;
        const random = () => {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          return seed / 2 ** 32;
        };
        const game = new Game(definition, random);
        for (let token = 0; token < 15; token++) expect(game.sim.fire("starterSource")).toBe(true);
        game.step(0);
        const sink = game.sim.net.transitions.get(game.goals().at(-1)!.sinkId)!;
        const center = game.sim.net.transitions.get("starterSource")!;
        distances.push(Math.hypot(sink.x - center.x, sink.y - center.y));
      }
      expect(distances.filter((distance) => distance < 1500).length).toBeGreaterThan(56);
      expect(distances.some((distance) => distance >= 1500)).toBe(true);
      expect(new Set(distances.map((distance) => Math.round(distance))).size).toBeGreaterThan(20);
    });

    it("keeps a buildable connection between randomly placed red pairs", () => {
      for (let i = 1; i <= 12; i++) {
        let seed = Math.imul(i, 2654435761) >>> 0;
        const game = pausedGame(() => {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          return seed / 2 ** 32;
        });
        game.step(360.1);
        const { source, sink } = redPair(game);
        const middle = { x: (source.x + sink.x) / 2, y: (source.y + sink.y) / 2 };
        expect(game.placementIssue("place", middle.x, middle.y)).toBeUndefined();
        const place = game.buildConnectedPlace(source.id, 0, middle.x, middle.y);
        expect(place).toBeDefined();
        expect(game.connect(sink.id, 0, place!)).toBe(true);
      }
    });

    it("widens red pairs after epoch ten and varies balanced total supplies after epoch twenty", () => {
      let seed = 42;
      const game = pausedGame(() => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 2 ** 32;
      });
      let supplyTotal = 0;
      let demandTotal = 0;
      const pairs: { epoch: number; supply: number; demand: number }[] = [];
      for (let epoch = 1; epoch <= 70; epoch++) {
        game.sim.net.places.get("starterPlace")!.marking = [];
        for (let i = 0; i < 15; i++) expect(game.sim.fire("starterSource")).toBe(true);
        const before = new Set(game.sim.net.transitions.keys());
        const existing = game.sim.net.liveNodes().map((node) => ({ ...node }));
        game.step(0);
        const spawned = [...game.sim.net.transitions.values()].filter((t) => !before.has(t.id));
        const source = spawned.find((t) => t.kind === "source");
        const sink = spawned.find((t) => t.kind === "sink")!;
        if (source) {
          const demand = game.goalsFor(sink.id)[0].count;
          const supply = source.supply!;
          pairs.push({ epoch, supply, demand });
          supplyTotal += supply;
          demandTotal += demand;
          expect(supplyTotal).toBeGreaterThanOrEqual(demandTotal);
          expect(Math.hypot(source.x - sink.x, source.y - sink.y)).toBeCloseTo(epoch <= 10 ? BUILD_RANGE - 1 : BUILD_RANGE * 1.5);
          if (epoch > 10) {
            for (const node of [sink, source]) {
              expect(Math.min(...existing.map((other) => Math.hypot(node.x - other.x, node.y - other.y)))).toBeGreaterThanOrEqual(BUILD_RANGE + 30);
            }
            const bridgeable = existing.some((node) => {
              if (Math.abs(Math.hypot(node.x - sink.x, node.y - sink.y) - BUILD_RANGE * 1.5) > 1e-6) return false;
              return !game.placementIssue("place", (node.x + sink.x) / 2, (node.y + sink.y) / 2);
            });
            expect(bridgeable).toBe(true);
          }
          const middle = { x: (source.x + sink.x) / 2, y: (source.y + sink.y) / 2 };
          expect(game.placementIssue("place", middle.x, middle.y)).toBeUndefined();
          expect(withinConnectionRange(source, middle)).toBe(true);
          expect(withinConnectionRange(sink, middle)).toBe(true);
          if (epoch <= 20) expect([supply, demand]).toEqual([5, 5]);
        }
        game.sim.step(1);
      }
      const later = pairs.filter((pair) => pair.epoch > 20);
      expect(later.some((pair) => pair.supply > 5)).toBe(true);
      expect(later.some((pair) => pair.demand > 5)).toBe(true);
      expect(later.some((pair) => pair.supply > pair.demand)).toBe(true);
      expect(later.some((pair) => pair.supply < pair.demand)).toBe(true);
    });

    it("introduces source-free green and yellow sinks at their epoch boundaries", () => {
      let first = false;
      let afterSelection = 0.5;
      const game = pausedGame(() => {
        if (first) {
          first = false;
          return 0.05;
        }
        return afterSelection;
      });
      for (let epoch = 1; epoch <= 102; epoch++) {
        afterSelection = epoch === 101 ? 0.5 : epoch === 102 ? 0.95 : 0.05;
        first = epoch >= 39;
        const spawned = advanceEpoch(game);
        if (epoch === 39) expect(game.goalsFor(spawned.find((t) => t.kind === "sink")!.id)[0].color).toBe("red");
        if (epoch === 40 || epoch === 99 || epoch >= 100) {
          expect(spawned).toHaveLength(1);
          const goal = game.goalsFor(spawned[0].id)[0];
          expect(goal.color).toBe(epoch < 100 ? "green" : "yellow");
          expect(goal.count).toBe(epoch < 100 ? 5 : (epoch - 99) * 10);
        }
      }
    });

    it("alternates red pairs and source-free sinks from epoch 75 while keeping supply balanced", () => {
      let first = false;
      let firstRoll = 0.3;
      const game = pausedGame(() => {
        if (first) {
          first = false;
          return firstRoll;
        }
        return 0.95;
      });
      let supply = 0;
      let demand = 0;
      let lateRed = 0;
      for (let epoch = 1; epoch <= 90; epoch++) {
        first = true;
        firstRoll = epoch >= 75 && epoch % 3 === 1 ? 0.05 : 0.3;
        const spawned = advanceEpoch(game);
        const sink = spawned.find((transition) => transition.kind === "sink")!;
        const goal = game.goalsFor(sink.id)[0];
        if (goal.color !== "red") continue;
        const source = spawned.find((transition) => transition.kind === "source");
        if (epoch < 75) expect(source).toBeDefined();
        else {
          expect(Boolean(source)).toBe(lateRed % 2 === 0);
          lateRed++;
        }
        expect([5, 10, 15]).toContain(goal.count);
        if (source) {
          expect([5, 10, 15]).toContain(source.supply);
          supply += source.supply!;
        }
        demand += goal.count;
        expect(supply).toBeGreaterThanOrEqual(demand);
        if (epoch >= 75 && source) {
          expect(supply - demand).toBeGreaterThanOrEqual(5);
          expect([source.supply, goal.count]).toEqual([15, 10]);
        } else if (epoch >= 75) expect(goal.count).toBe(5);
      }
      expect(lateRed).toBe(11);
    });

    it("gives yellow sinks double grace and countdown, extending their deadline on delivery", () => {
      let chooseYellow = false;
      const game = pausedGame(() => {
        if (chooseYellow) {
          chooseYellow = false;
          return 0.05;
        }
        return 0.9;
      });
      for (let epoch = 1; epoch < 100; epoch++) advanceEpoch(game);
      chooseYellow = true;
      const sink = advanceEpoch(game)[0];
      expect(game.goalsFor(sink.id)[0].color).toBe("yellow");
      sink.autoInterval = undefined;
      game.sim.net.addPlace({ id: "yellowInput", x: sink.x - 100, y: sink.y, capacity: 7, marking: [] });
      expect(game.connect(sink.id, 0, "yellowInput")).toBe(true);
      game.sim.step(358.9);
      expect(game.countdownProgress(sink.id)).toBeUndefined();
      game.sim.step(0.1);
      expect(game.countdownProgress(sink.id)).toBeCloseTo(1);
      game.sim.step(60);
      expect(game.countdownProgress(sink.id)).toBeCloseTo(0.5);
      game.sim.net.places.get("yellowInput")!.marking.push("yellow");
      expect(game.sim.fire(sink.id)).toBe(true);
      game.sim.step(1);
      expect(game.score).toBe(1);
      expect(game.countdownProgress(sink.id)).toBeCloseTo(69 / 120);
      game.sim.step(68.9);
      expect(game.failed.has(sink.id)).toBe(false);
      game.sim.step(0.1);
      expect(game.failed.has(sink.id)).toBe(true);
    });

    it("allows a red source and sink to deliver exactly five tokens", () => {
      const game = pausedGame();
      game.step(360.1);
      const { source, sink } = redPair(game);
      connectPair(game, source, sink);
      game.step(18.5);
      expect(game.score).toBe(5);
      expect(game.sim.net.transitions.has(source.id)).toBe(false);
      expect(game.sim.net.transitions.has(sink.id)).toBe(false);
      expect(game.complete).toBe(false);
    });

    it("starts a sink countdown after three minutes and crosses it out after one more", () => {
      const game = pausedGame();
      game.step(179.9);
      expect(game.countdownProgress("starterSink")).toBeUndefined();
      game.step(0.2);
      expect(game.countdownProgress("starterSink")).toBeGreaterThan(0.99);
      game.step(59.8);
      expect(game.failed.has("starterSink")).toBe(false);
      game.step(0.2);
      expect(game.failed.has("starterSink")).toBe(true);
      expect(game.sim.net.transitions.get("starterSink")?.disabled).toBe(true);
      game.step(RESOLVED_LINGER + 0.1);
      expect(game.sim.net.transitions.has("starterSink")).toBe(false);
      expect(game.sim.net.transitions.has("starterSource")).toBe(true);
      expect(game.complete).toBe(false);
    });

    it("adds ten seconds for a delivery during the sink countdown", () => {
      const game = pausedGame();
      game.step(180.1);
      game.sim.net.places.get("starterDestination")!.marking.push("blue");
      expect(game.sim.fire("starterSink")).toBe(true);
      game.step(1);
      expect(game.score).toBe(1);
      expect(game.countdownProgress("starterSink")).toBe(1);
      game.step(59);
      expect(game.failed.has("starterSink")).toBe(false);
      game.step(10);
      expect(game.failed.has("starterSink")).toBe(true);
    });

    it("does not extend the sink deadline for an earlier delivery", () => {
      const game = pausedGame();
      game.sim.net.places.get("starterDestination")!.marking.push("blue");
      expect(game.sim.fire("starterSink")).toBe(true);
      game.step(1);
      expect(game.score).toBe(1);
      game.step(239.1);
      expect(game.failed.has("starterSink")).toBe(true);
    });

    it("does not score or extend a sink for a token arriving after expiry", () => {
      const game = pausedGame();
      game.step(239.5);
      game.sim.net.places.get("starterDestination")!.marking.push("blue");
      expect(game.sim.fire("starterSink")).toBe(true);
      game.step(0.6);
      expect(game.failed.has("starterSink")).toBe(true);
      game.step(0.5);
      expect(game.score).toBe(0);
      expect(game.resolved.has("starterSink")).toBe(false);
    });

    it("resets a red source's full inactivity timer on emission", () => {
      const game = pausedGame();
      game.step(360.1);
      const { source, sink } = redPair(game);
      connectPair(game, source, sink);
      source.autoInterval = undefined;
      game.step(239.8);
      expect(game.countdownProgress(source.id)).toBeUndefined();
      game.step(0.2);
      expect(game.countdownProgress(source.id)).toBeGreaterThan(0.99);
      source.autoInterval = 0.01;
      game.step(0.1);
      expect(source.supply).toBe(4);
      expect(game.countdownProgress(source.id)).toBeUndefined();
      source.autoInterval = undefined;
      game.step(239.8);
      expect(game.countdownProgress(source.id)).toBeUndefined();
      game.step(0.3);
      expect(game.countdownProgress(source.id)).toBeGreaterThan(0.99);
      game.step(60);
      expect(game.failed.has(source.id)).toBe(true);
      expect(game.sim.net.transitions.has("starterSource")).toBe(true);
    });

    it("expires an idle source before an automatic emission at its deadline", () => {
      const game = pausedGame();
      game.step(360);
      const { source, sink } = redPair(game);
      connectPair(game, source, sink);
      source.autoInterval = 300;
      game.step(300.05);
      expect(game.failed.has(source.id)).toBe(true);
      expect(source.supply).toBe(5);
    });
  });

  describe("exhausted sources", () => {
    function sourceLevel(supply: number): Level {
      const lvl = level(true);
      lvl.net.transitions[0].autoInterval = undefined;
      lvl.net.places.push({ id: "destination", x: 1000, y: 0, marking: [] });
      lvl.net.transitions.push({ id: "source", x: 0, y: 0, kind: "source", supply });
      lvl.net.arcs.push({ id: "sourceArc", from: "source", to: "destination", color: "red" });
      return lvl;
    }

    it("fades after exhaustion without becoming a goal or dropping its last token", () => {
      const game = new Game(sourceLevel(1));
      expect(game.sim.fire("source")).toBe(true);
      expect(game.exhausted.get("source")).toBe(0);
      game.step(RESOLVED_LINGER - 0.1);
      expect(game.sim.net.transitions.get("source")?.ghost).toBeFalsy();
      expect(game.resolved.size).toBe(0);
      expect(game.complete).toBe(false);

      game.step(0.2);
      expect(game.sim.net.transitions.get("source")?.ghost).toBe(true);
      expect(game.sim.inFlight).toHaveLength(1);
      expect(game.sim.incoming("destination")).toEqual({ red: 1 });
      game.step(4);
      expect(game.sim.net.places.get("destination")?.marking).toEqual(["red"]);
      expect(game.sim.net.transitions.has("source")).toBe(false);
      expect(game.sim.net.arcs.has("sourceArc")).toBe(false);
      expect(game.complete).toBe(false);
    });

    it("removes a source that starts exhausted", () => {
      const game = new Game(sourceLevel(0));
      expect(game.exhausted.get("source")).toBe(0);
      expect(game.sim.fire("source")).toBe(false);
      game.step(RESOLVED_LINGER + 0.1);
      game.step(0.1);
      expect(game.sim.net.transitions.has("source")).toBe(false);
      expect(game.sim.net.arcs.has("sourceArc")).toBe(false);
      expect(game.complete).toBe(false);
    });
  });

  it("stop consuming once enough matching tokens are on their way, then leave the map", () => {
    const game = new Game(level(true));
    run(game, 2);
    expect(game.goalsFor("sink")[0]).toMatchObject({ delivered: 2, done: true });
    expect(game.sim.net.places.get("p")!.marking).toEqual(["red"]);
    expect(game.resolved.has("sink")).toBe(true);

    run(game, RESOLVED_LINGER);
    expect(game.sim.net.transitions.has("sink")).toBe(false);
    expect(game.sim.net.arcs.size).toBe(0);
    expect(game.complete).toBe(false);
  });

  it("win once all goals are resolved, freezing the game", () => {
    const game = new Game(level());
    run(game, 2);
    expect(game.complete).toBe(true);
    const time = game.sim.time;
    run(game, 1);
    expect(game.sim.time).toBe(time);
    expect(game.sim.net.transitions.has("sink")).toBe(true);
  });
});
