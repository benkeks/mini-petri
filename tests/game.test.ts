import { describe, expect, it } from "vitest";
import { BUILD_RANGE, CLEARANCE, Game, PLACE_FOOTPRINT, RESOLVED_LINGER, TRANSITION_FOOTPRINT, withinConnectionRange } from "../src/game/game";
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

      expect(game.sim.fire("sink")).toBe(true);
      expect(game.score).toBe(0);
      run(game, 0.5);
      expect(game.score).toBe(1);
      expect(game.sim.fire("sink")).toBe(true);
      run(game, 0.5);
      expect(game.score).toBe(1);
      expect(game.sim.fire("sink")).toBe(true);
      expect(game.score).toBe(1);
      run(game, 0.5);
      expect(game.score).toBe(2);
      expect(game.complete).toBe(false);
      run(game, RESOLVED_LINGER + 0.1);
      expect(game.sim.net.transitions.has("sink")).toBe(false);
      expect(game.goals()).toEqual([]);
      expect(game.score).toBe(2);
      expect(game.complete).toBe(false);
    });

    function pausedGame(random = () => 0): Game {
      const game = new Game(endless, random);
      game.sim.net.transitions.get("starterSource")!.autoInterval = undefined;
      return game;
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

    it("starts with a manual blue relay between two large places", () => {
      const game = new Game(endless);
      expect([...game.sim.net.places.values()].map((p) => p.capacity)).toEqual([19, 19]);
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

    it("spawns an epoch for six emissions, sixty seconds, or a proportional mixture", () => {
      const emitted = pausedGame();
      for (let i = 0; i < 5; i++) expect(emitted.sim.fire("starterSource")).toBe(true);
      emitted.step(0);
      expect(emitted.goals()).toHaveLength(1);
      expect(emitted.sim.fire("starterSource")).toBe(true);
      emitted.step(0);
      expect(emitted.goals()).toHaveLength(2);

      const mixed = pausedGame();
      for (let i = 0; i < 3; i++) expect(mixed.sim.fire("starterSource")).toBe(true);
      mixed.step(29.9);
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
      for (let i = 0; i < 3; i++) expect(multiGame.sim.fire("starterSource")).toBe(true);
      multiGame.step(0);
      expect(multiGame.goals()).toHaveLength(2);
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
        for (let token = 0; token < 6; token++) expect(game.sim.fire("starterSource")).toBe(true);
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
