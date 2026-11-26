import { describe, expect, it, vi } from "vitest";
import { Net } from "../src/core/net";
import { Simulation } from "../src/core/simulation";
import { ENDLESS_EPOCH_PROGRESS, Game } from "../src/game/game";
import { endless } from "../src/game/endless";
import { level2 } from "../src/game/level2";
import { Statistics } from "../src/game/statistics";
import type { Kit, Level } from "../src/game/level";

describe("statistics", () => {
  it("records initial sink colors from goals, including multiple colors", () => {
    const game = new Game(level2);
    expect(game.statistics.sinkCreations).toEqual([
      { time: 0, colors: ["yellow"] },
      { time: 0, colors: ["green"] },
    ]);
    const definition = structuredClone(endless);
    definition.goals.push({ sinkId: "starterSink", color: "red", count: 5 });
    expect(new Game(definition).statistics.sinkCreations).toEqual([{ time: 0, colors: ["blue", "red"] }]);
  });

  it("records successful sink spawns once at their actual time, even after removal and continuation", () => {
    const game = new Game(endless, () => 0.5, { survival: true });
    expect(game.statistics.sinkCreations).toEqual([{ time: 0, colors: ["blue"] }]);
    game["endlessEpoch"] = 5;
    game["endlessProgress"] = ENDLESS_EPOCH_PROGRESS;
    game.sim.time = 12.5;
    const blocked = vi.spyOn(game, "placementIssue").mockReturnValue("crowded");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    game.step(0);
    expect(game.statistics.sinkCreations).toHaveLength(1);
    blocked.mockRestore();
    warning.mockRestore();
    game.sim.step(1);
    game.step(0);
    expect(game.statistics.sinkCreations).toEqual([
      { time: 0, colors: ["blue"] }, { time: 13.5, colors: ["red"] },
    ]);
    const spawned = [...game.sim.net.transitions.values()].find((transition) =>
      transition.kind === "sink" && transition.id !== "starterSink")!;
    game.sim.removeTransition(spawned.id);
    game.continueEndless();
    expect(game.statistics.sinkCreations).toHaveLength(2);
    expect(new Game(endless).statistics.sinkCreations).toEqual([{ time: 0, colors: ["blue"] }]);
  });

  it("keeps cumulative color totals at ten-second boundaries and minute delivery totals", () => {
    const stats = new Statistics({ blue: 1 });
    stats.record("sources", 0, { blue: 1 });
    stats.record("deliveries", 9.9, { blue: 2 });
    stats.record("deliveries", 10, { red: 1 });
    stats.sample({ blue: 2, red: 1 });
    stats.record("built", 10.1, { green: 2 });
    stats.record("deliveries", 60, { red: 2 });
    stats.record("deliveries", 60.1, { green: 1 });
    for (let i = 0; i < 5; i++) stats.sample({ green: i });
    const history = stats.history(60.2, { yellow: 1 });
    expect(history[0]).toMatchObject({ time: 0, sources: { blue: 1 }, alive: { blue: 1 } });
    expect(history[1]).toMatchObject({ time: 10, deliveries: { blue: 2, red: 1 }, alive: { blue: 2, red: 1 } });
    expect(history[2]).toMatchObject({ time: 20, built: { green: 2 }, deliveries: { blue: 2, red: 1 } });
    expect(history.at(-1)).toMatchObject({ time: 60.2, deliveries: { blue: 2, red: 3, green: 1 }, alive: { yellow: 1 } });
    expect(stats.deliveriesPerMinute(60.2)).toEqual([
      { time: 0, deliveries: { blue: 2, red: 1 } },
      { time: 60, deliveries: { red: 2, green: 1 } },
    ]);
  });

  it("counts inputs waiting for other arrivals without counting committed outputs early", () => {
    const net = new Net({
      places: [
        { id: "near", x: 0, y: 0, marking: ["red"] },
        { id: "far", x: -200, y: 0, marking: ["blue"] },
        { id: "out", x: 300, y: 0, marking: [] },
      ],
      transitions: [{ id: "mix", x: 100, y: 0, kind: "normal" }],
      arcs: [
        { id: "red", from: "near", to: "mix", color: "red" },
        { id: "blue", from: "far", to: "mix", color: "blue" },
        { id: "green", from: "mix", to: "out", color: "green", count: 2 },
      ],
    });
    const sim = new Simulation(net, { tokenSpeed: 100 });
    expect(sim.liveTokens()).toEqual({ red: 1, blue: 1 });
    expect(sim.fire("mix")).toBe(true);
    sim.step(1.5);
    expect(sim.liveTokens()).toEqual({ red: 1, blue: 1 });
    sim.step(2);
    expect(sim.liveTokens()).toEqual({ green: 2 });
    net.ghostPlace("out");
    sim.step(3);
    expect(sim.liveTokens()).toEqual({});
  });

  it("records source output and player-built transition output separately", () => {
    const kit: Kit = { id: "convert", ports: [{ dir: "in", color: "red" }, { dir: "out", color: "yellow", count: 2 }] };
    const level: Level = {
      name: "stats", mode: "endless", width: 1000, height: 800, goals: [],
      ramp: { every: Infinity, factor: 1, min: 1 }, tools: { kits: [kit] },
      net: {
        places: [
          { id: "input", x: 100, y: 200, marking: ["red"] },
          { id: "output", x: 500, y: 200, marking: [] },
          { id: "sourcePlace", x: 100, y: 600, marking: [] },
        ],
        transitions: [{ id: "source", x: 100, y: 400, kind: "source" }],
        arcs: [{ id: "sourceArc", from: "source", to: "sourcePlace", color: "blue" }],
      },
    };
    const game = new Game(level);
    const built = game.buildTransition(kit, 300, 200);
    expect(built).toBeDefined();
    expect(game.connect(built!, 0, "input")).toBe(true);
    expect(game.connect(built!, 0, "output")).toBe(true);
    expect(game.sim.fire("source")).toBe(true);
    expect(game.sim.fire(built!)).toBe(true);
    game.step(2);
    const end = game.statistics.history(game.sim.time, game.sim.liveTokens()).at(-1)!;
    expect(end.sources).toEqual({ blue: 1 });
    expect(end.built).toEqual({ yellow: 2 });
    expect(end.alive).toEqual({ blue: 1, yellow: 2 });
    game.step(18);
    const history = game.statistics.history(game.sim.time, game.sim.liveTokens());
    expect(history.map((point) => point.time)).toEqual([0, 10, 20]);
    expect(history[1].alive).toEqual({ blue: 1, yellow: 2 });
    expect(history[1].built).toEqual({ yellow: 2 });
  });

  it("does not count the initial relay as a player-built transition", () => {
    const definition = structuredClone(endless);
    definition.net.transitions.forEach((transition) => { transition.autoInterval = undefined; });
    definition.net.places.find((place) => place.id === "starterPlace")!.marking = ["blue"];
    const game = new Game(definition);
    expect(game.sim.fire("starterRelay")).toBe(true);
    game.step(2);
    const end = game.statistics.history(game.sim.time, game.sim.liveTokens()).at(-1)!;
    expect(end.built).toEqual({});
    expect(end.alive).toEqual({ blue: 1 });
  });

  it("counts only successfully scored colors, preserving history on endless continuation", () => {
    const level: Level = {
      name: "scoring", mode: "endless", width: 400, height: 200,
      goals: [{ sinkId: "sink", color: "red", count: 2 }],
      ramp: { every: Infinity, factor: 1, min: 1 },
      net: {
        places: [{ id: "p", x: 0, y: 0, marking: ["red", "blue", "red"] }],
        transitions: [{ id: "sink", x: 100, y: 0, kind: "sink" }],
        arcs: [{ id: "a", from: "p", to: "sink" }],
      },
    };
    const game = new Game(level, Math.random, { survival: true });
    for (let i = 0; i < 3; i++) {
      expect(game.sim.fire("sink")).toBe(true);
      game.step(0.5);
    }
    game.continueEndless();
    expect(game.statistics.history(game.sim.time, game.sim.liveTokens()).at(-1)?.deliveries).toEqual({ red: 2 });
    expect(game.statistics.deliveriesPerMinute(game.sim.time)[0].deliveries).toEqual({ red: 2 });
    const restarted = new Game(level, Math.random, { survival: true });
    expect(restarted.statistics.history(0, restarted.sim.liveTokens())[0].deliveries).toEqual({});
  });

  it("retains the exact deadline and all colors of a starved sink after its removal in endless mode", () => {
    const definition = structuredClone(endless);
    definition.net.transitions.forEach((transition) => { transition.autoInterval = undefined; });
    definition.goals.push({ sinkId: "starterSink", color: "red", count: 5 });
    const game = new Game(definition, Math.random, { survival: true });
    game.continueEndless();
    game.sim.step(240.5);
    expect(game.statistics.sinkDeaths).toEqual([{ time: 240, colors: ["blue", "red"] }]);
    game.step(2);
    expect(game.sim.net.transitions.has("starterSink")).toBe(false);
    expect(game.statistics.sinkDeaths).toEqual([{ time: 240, colors: ["blue", "red"] }]);
    expect(new Game(definition).statistics.sinkDeaths).toEqual([]);
  });

  it("retains the final starvation deadline when it is just ahead of simulation time", () => {
    const game = new Game(endless, Math.random, { survival: true });
    game["lifeBalance"] = 1;
    game.sim.time = 240 - 5e-9;
    game.sim.step(0);
    expect(game.survivalFailed).toBe(true);
    expect(game.completedAt).toBe(240);
    expect(game.sim.time).toBeLessThan(240);
    expect(game.statistics.sinkDeaths).toEqual([{ time: 240, colors: ["blue"] }]);
    game.continueEndless();
    expect(game.statistics.sinkDeaths).toEqual([{ time: 240, colors: ["blue"] }]);
  });
});
