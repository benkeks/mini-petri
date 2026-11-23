import { describe, expect, it } from "vitest";
import { Game, RESOLVED_LINGER } from "../src/game/game";
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
