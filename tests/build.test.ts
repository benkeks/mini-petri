import { describe, expect, it } from "vitest";
import { Net, type NetSpec } from "../src/core/net";
import { Simulation } from "../src/core/simulation";
import { Game } from "../src/game/game";
import { level2 } from "../src/game/level2";

// p1 --(red)--> t --(red)--> p2, nodes 100 units apart.
function spec(): NetSpec {
  return {
    places: [
      { id: "p1", x: 0, y: 0, marking: ["red", "red"] },
      { id: "p2", x: 200, y: 0, marking: [] },
    ],
    transitions: [{ id: "t", x: 100, y: 0, kind: "normal" }],
    arcs: [
      { id: "in", from: "p1", to: "t", color: "red" },
      { id: "out", from: "t", to: "p2", color: "red" },
    ],
  };
}

function run(sim: { step(dt: number): void }, seconds: number): void {
  for (let t = 0; t < seconds; t += 1 / 60) sim.step(1 / 60);
}

describe("supply", () => {
  it("disables a transition once its firings are used up", () => {
    const s = spec();
    s.transitions[0].supply = 1;
    const sim = new Simulation(new Net(s));
    expect(sim.fire("t")).toBe(true);
    expect(sim.net.transitions.get("t")!.supply).toBe(0);
    expect(sim.fire("t")).toBe(false);
  });
});

describe("ports", () => {
  it("disable a transition until they are connected", () => {
    const s = spec();
    s.arcs.pop();
    s.transitions[0].open = [{ dir: "out", color: "red" }];
    const sim = new Simulation(new Net(s));
    expect(sim.isEnabled("t")).toBe(false);
    sim.net.connect("t", 0, "p2");
    expect(sim.net.transitions.get("t")!.open).toEqual([]);
    expect(sim.fire("t")).toBe(true);
    run(sim, 2);
    expect(sim.net.places.get("p2")!.marking).toEqual(["red"]);
  });

  it("are reopened when an arc is removed", () => {
    const sim = new Simulation(new Net(spec()));
    sim.net.ghostArc("out");
    expect(sim.net.transitions.get("t")!.open).toEqual([{ dir: "out", color: "red", count: 1 }]);
    expect(sim.isEnabled("t")).toBe(false);
  });
});

describe("ghosts", () => {
  it("let a firing in progress finish before they disappear", () => {
    const sim = new Simulation(new Net(spec()));
    sim.fire("t");
    sim.net.ghostTransition("t");
    expect(sim.fire("t")).toBe(false);
    run(sim, 0.5);
    expect(sim.net.transitions.has("t")).toBe(true);
    run(sim, 1);
    expect(sim.net.places.get("p2")!.marking).toEqual(["red"]);
    expect(sim.net.transitions.has("t")).toBe(false);
    expect(sim.net.arcs.size).toBe(0);
  });

  it("drop a removed place's tokens, including those still arriving", () => {
    const sim = new Simulation(new Net(spec()));
    sim.fire("t");
    sim.net.ghostPlace("p1");
    sim.net.ghostPlace("p2");
    expect(sim.net.places.get("p1")!.marking).toEqual([]);
    run(sim, 2);
    expect(sim.net.places.has("p1")).toBe(false);
    expect(sim.net.places.has("p2")).toBe(false);
    expect(sim.inFlight).toEqual([]);
    expect(sim.net.transitions.get("t")!.open?.map((p) => p.dir)).toEqual(["in", "out"]);
  });
});

describe("building", () => {
  it("requires range, clearance and world bounds", () => {
    const game = new Game(level2);
    expect(game.placementIssue("place", 380, 180)).toBe("crowded");
    expect(game.placementIssue("place", 10, 400)).toBe("outside");
    expect(game.placementIssue("place", 850, 380)).toBeUndefined();
    expect(game.placementIssue("place", 1150, 800 - 60)).toBe("far");
    expect(game.buildPlace(380, 180)).toBeUndefined();
  });

  it("builds a place and a transition and wires them into the net", () => {
    const game = new Game(level2);
    const net = game.sim.net;
    const pG = game.buildPlace(820, 520)!;
    expect(game.connect("sinkG", 0, pG)).toBe(true);
    const mix = game.level.tools!.kits!.find((k) => k.id === "mix")!;
    const t = game.buildTransition(mix, 640, 480)!;
    expect(net.transitions.get(t)!.open).toHaveLength(3);
    expect(game.connect(t, 2, pG)).toBe(true);
    expect(game.connect(t, 1, "pB")).toBe(true);
    expect(game.connect(t, 0, "pR")).toBe(true);
    expect(game.playerFire(t)).toBe(true);
    run(game, 5);
    expect(game.goalsFor("sinkG")[0].delivered).toBe(1);
  });

  it("does not remove goal sinks", () => {
    const game = new Game(level2);
    expect(game.remove("sinkY")).toBe(false);
    expect(game.remove("tDrain")).toBe(true);
  });
});

describe("upgrades", () => {
  it("make transitions automatic, then faster, and places larger", () => {
    const game = new Game(level2);
    const t = game.sim.net.transitions.get("tSplit")!;
    expect(game.upgradeFaster("tSplit")).toBe(false);
    expect(game.upgradeAuto("tSplit")).toBe(true);
    expect(game.upgradeAuto("tSplit")).toBe(false);
    expect(game.upgradeFaster("tSplit")).toBe(true);
    expect(t.autoInterval).toBeCloseTo(2.4);
    expect(game.upgradeAuto("srcR")).toBe(false);
    expect(game.upgradeCapacity("pR")).toBe(true);
    expect(game.sim.net.places.get("pR")!.capacity).toBe(7);
  });
});

describe("level 2", () => {
  it.each([0, 60])("can be won by building and removing the drain after %ss", (wait) => {
    const game = new Game(level2);
    run(game, wait);
    const kit = (id: string) => game.level.tools!.kits!.find((k) => k.id === id)!;
    const wire = (t: string, ...places: string[]) => places.forEach((p) => expect(game.connect(t, 0, p)).toBe(true));
    expect(game.remove("tDrain")).toBe(true);
    const pG = game.buildPlace(820, 520)!;
    wire("sinkG", pG);
    const mix = game.buildTransition(kit("mix"), 640, 480)!;
    wire(mix, "pR", "pB", pG);
    const pR2 = game.buildPlace(800, 700)!;
    wire("srcR2", pR2);
    const mix2 = game.buildTransition(kit("mix"), 920, 690)!;
    wire(mix2, pR2, "pB", pG);
    for (const t of ["tSplit", mix, mix2]) expect(game.upgradeAuto(t)).toBe(true);
    run(game, 120);
    expect(game.complete).toBe(true);
  });
});
