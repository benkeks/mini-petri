import { describe, expect, it } from "vitest";
import { Net, type NetSpec } from "../src/core/net";
import { Simulation } from "../src/core/simulation";
import { Game } from "../src/game/game";
import { level2 } from "../src/game/level2";
import { brushesOf, Controller } from "../src/input/controller";
import type { Overlay, Pick } from "../src/render/netView";

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

describe("controller", () => {
  function setup(game = new Game(level2)) {
    let pick: Pick = { kind: "empty", x: 0, y: 0 };
    const denied: Pick[] = [];
    const view: { overlay: Overlay; pick(): Pick; deny(pick: Pick): void } = {
      overlay: {},
      pick: () => pick,
      deny: (p) => denied.push(p),
    };
    const controller = new Controller(game, view);
    const tap = (next: Pick) => {
      pick = next;
      controller.tap({ x: 0, y: 0 });
    };
    return { game, view, controller, tap, denied };
  }

  it("connects either input or output ports after selecting a place", () => {
    const { game, view, controller, tap } = setup();
    const pG = game.buildPlace(820, 520)!;
    tap({ kind: "place", id: pG });
    controller.sync();
    expect(view.overlay.target?.({ kind: "port", tid: "sinkG", index: 0 })).toBe(true);
    expect(view.overlay.target?.({ kind: "transition", id: "sinkG" })).toBe(true);
    expect(view.overlay.target?.({ kind: "transition", id: "tDrain" })).toBe(false);
    tap({ kind: "port", tid: "sinkG", index: 0 });
    expect(game.sim.net.inputs("sinkG")[0].from).toBe(pG);
    expect(controller.selectedPlace).toBeUndefined();

    const pR2 = game.buildPlace(800, 700)!;
    tap({ kind: "place", id: pR2 });
    tap({ kind: "port", tid: "srcR2", index: 0 });
    expect(game.sim.net.outputs("srcR2")[0].to).toBe(pR2);
  });

  it("connects a selected place to the first eligible input, then output, when tapping a transition", () => {
    const { game, view, controller, tap, denied } = setup();
    game.sim.net.addTransition({
      id: "multi", x: 450, y: 520, kind: "normal",
      open: [
        { dir: "out", color: "green" },
        { dir: "in", color: "red" },
        { dir: "out", color: "yellow" },
        { dir: "in", color: "blue" },
      ],
    });
    for (const [direction, color] of [["in", "red"], ["in", "blue"], ["out", "green"], ["out", "yellow"]] as const) {
      tap({ kind: "place", id: "pB" });
      controller.sync();
      expect(view.overlay.target?.({ kind: "transition", id: "multi" })).toBe(true);
      tap({ kind: "transition", id: "multi" });
      const arcs = direction === "in" ? game.sim.net.inputs("multi") : game.sim.net.outputs("multi");
      expect(arcs.at(-1)).toMatchObject(direction === "in" ? { from: "pB", color } : { to: "pB", color });
      expect(controller.selectedPlace).toBeUndefined();
    }
    tap({ kind: "place", id: "pB" });
    controller.sync();
    expect(view.overlay.target?.({ kind: "transition", id: "multi" })).toBe(false);
    tap({ kind: "transition", id: "multi" });
    expect(denied).toHaveLength(1);
    expect(game.sim.net.arcsOf("multi")).toHaveLength(4);
  });

  it("still lets a specific port override the default input-first order", () => {
    const { game, tap } = setup();
    game.sim.net.addTransition({
      id: "multi", x: 450, y: 520, kind: "normal",
      open: [{ dir: "out", color: "green" }, { dir: "in", color: "red" }],
    });
    tap({ kind: "place", id: "pB" });
    tap({ kind: "port", tid: "multi", index: 0 });
    expect(game.sim.net.outputs("multi")[0]).toMatchObject({ to: "pB", color: "green" });
    expect(game.sim.net.transitions.get("multi")!.open).toMatchObject([{ dir: "in", color: "red" }]);
  });

  it("denies unavailable transition targets instead of firing them", () => {
    const { game, view, controller, tap, denied } = setup();
    expect(game.sim.isEnabled("tSplit")).toBe(true);
    tap({ kind: "place", id: "pR" });
    controller.sync();
    expect(view.overlay.target?.({ kind: "transition", id: "tSplit" })).toBe(false);
    tap({ kind: "transition", id: "tSplit" });
    expect(denied).toHaveLength(1);
    expect(game.sim.net.places.get("pR")!.marking).toEqual(["red"]);
    tap({ kind: "place", id: "pB" });
    controller.sync();
    expect(view.overlay.target?.({ kind: "transition", id: "sinkG" })).toBe(false);
    tap({ kind: "transition", id: "sinkG" });
    expect(denied).toHaveLength(2);
    expect(game.sim.net.inputs("sinkG")).toHaveLength(0);
  });

  it("preserves port-first wiring and lets the player cancel or change tools", () => {
    const { game, controller, tap } = setup();
    const pG = game.buildPlace(820, 520)!;
    tap({ kind: "port", tid: "sinkG", index: 0 });
    tap({ kind: "place", id: pG });
    expect(game.sim.net.inputs("sinkG")[0].from).toBe(pG);

    tap({ kind: "place", id: "pR" });
    tap({ kind: "place", id: "pR" });
    expect(controller.selectedPlace).toBeUndefined();
    tap({ kind: "place", id: "pR" });
    controller.setBrush({ kind: "capacity" });
    tap({ kind: "place", id: "pR" });
    expect(game.sim.net.places.get("pR")!.capacity).toBe(19);
    expect(controller.selectedPlace).toBeUndefined();
  });

  it("switches from any tool to firing when selecting a loose end", () => {
    const tools = brushesOf(new Game(level2)).filter((brush) => brush.kind !== "fire");
    for (const tool of tools) {
      const { game, view, controller, tap } = setup();
      const pG = game.buildPlace(820, 520)!;
      controller.setBrush(tool);
      tap({ kind: "port", tid: "sinkG", index: 0 });
      expect(controller.brush.kind).toBe("fire");
      expect(controller.selected).toEqual({ tid: "sinkG", index: 0 });
      controller.sync();
      expect(view.overlay.removing).toBe(false);
      tap({ kind: "place", id: pG });
      expect(game.sim.net.inputs("sinkG")[0].from).toBe(pG);
      expect(controller.brush.kind).toBe("fire");
      tap({ kind: "place", id: pG });
      expect(game.sim.net.places.get(pG)?.ghost).toBeFalsy();
      expect(controller.selectedPlace).toBe(pG);
    }
  });

  it("keeps the firing tool when a loose-end selection is cancelled", () => {
    const { controller, tap } = setup();
    controller.setBrush({ kind: "remove" });
    tap({ kind: "port", tid: "sinkG", index: 0 });
    tap({ kind: "port", tid: "sinkG", index: 0 });
    expect(controller.selected).toBeUndefined();
    expect(controller.brush.kind).toBe("fire");
  });

  it.each([
    { tid: "sinkG", x: 820, y: 520, direction: "in" },
    { tid: "srcR2", x: 800, y: 700, direction: "out" },
  ])("builds and connects an upgradable one-token place from an $direction port", ({ tid, x, y, direction }) => {
    const { game, view, controller, tap } = setup();
    tap({ kind: "port", tid, index: 0 });
    controller.sync();
    expect(view.overlay.build).toEqual({ kind: "place", capacity: 1, connection: { tid, index: 0 } });
    tap({ kind: "empty", x, y });
    const arcs = direction === "in" ? game.sim.net.inputs(tid) : game.sim.net.outputs(tid);
    expect(arcs).toHaveLength(1);
    const id = direction === "in" ? arcs[0].from : arcs[0].to;
    expect(game.sim.net.places.get(id)).toMatchObject({ x, y, capacity: 1, marking: [] });
    expect(controller.selected).toBeUndefined();
    expect(game.upgradeCapacity(id)).toBe(true);
    expect(game.sim.net.places.get(id)!.capacity).toBe(7);
  });

  it("continues wiring other ports after building a place", () => {
    const { game, controller, tap } = setup();
    const kit = game.level.tools!.kits!.find((item) => item.id === "mix")!;
    const tid = game.buildTransition(kit, 640, 480)!;
    const nearby = game.buildPlace(520, 400)!;
    tap({ kind: "port", tid, index: 0 });
    tap({ kind: "empty", x: 820, y: 520 });
    expect(game.sim.net.inputs(tid)).toHaveLength(1);
    expect(controller.selected).toEqual({ tid, index: 0 });
    tap({ kind: "place", id: nearby });
    expect(game.sim.net.inputs(tid)).toHaveLength(2);
    expect(controller.selected).toEqual({ tid, index: 0 });
  });

  it("rejects invalid placement without losing the selected port or creating a place", () => {
    const { game, controller, tap, denied } = setup();
    tap({ kind: "port", tid: "sinkG", index: 0 });
    for (const point of [{ x: 10, y: 10 }, { x: 1000, y: 520 }, { x: 1150, y: 740 }]) {
      tap({ kind: "empty", ...point });
    }
    expect(denied).toHaveLength(3);
    expect(game.sim.net.places.size).toBe(3);
    expect(game.sim.net.inputs("sinkG")).toHaveLength(0);
    expect(controller.selected).toEqual({ tid: "sinkG", index: 0 });
    tap({ kind: "empty", x: 820, y: 520 });
    expect(game.sim.net.inputs("sinkG")).toHaveLength(1);
  });

  it("only highlights and connects nearby targets in either selection order", () => {
    const { game, view, controller, tap, denied } = setup();
    const near = game.buildPlace(820, 520)!;
    tap({ kind: "port", tid: "sinkG", index: 0 });
    controller.sync();
    expect(view.overlay.target?.({ kind: "place", id: near })).toBe(true);
    expect(view.overlay.target?.({ kind: "place", id: "pB" })).toBe(false);
    tap({ kind: "place", id: "pB" });
    expect(denied).toHaveLength(1);
    expect(game.sim.net.inputs("sinkG")).toHaveLength(0);
    tap({ kind: "place", id: "pB" });
    controller.sync();
    expect(view.overlay.target?.({ kind: "port", tid: "sinkG", index: 0 })).toBe(false);
    tap({ kind: "port", tid: "sinkG", index: 0 });
    expect(denied).toHaveLength(2);
    expect(game.sim.net.inputs("sinkG")).toHaveLength(0);
  });

  it("highlights transitions with reachable loose ends when previewing a place", () => {
    const { game, view, controller } = setup();
    game.sim.net.addTransition({ id: "outside", x: 1000.001, y: 520, kind: "normal", open: [{ dir: "in", color: "red" }] });
    controller.setBrush({ kind: "place" });
    controller.sync();
    const target = view.overlay.previewTarget!;
    const point = { x: 700, y: 520 };
    expect(target({ kind: "transition", id: "sinkG" }, point)).toBe(true);
    expect(target({ kind: "port", tid: "sinkG", index: 0 }, point)).toBe(true);
    expect(target({ kind: "transition", id: "outside" }, point)).toBe(false);
    expect(target({ kind: "port", tid: "outside", index: 0 }, point)).toBe(false);
    expect(target({ kind: "transition", id: "tDrain" }, point)).toBe(false);
    game.sim.net.ghostTransition("sinkG");
    expect(target({ kind: "transition", id: "sinkG" }, point)).toBe(false);
    expect(target({ kind: "port", tid: "sinkG", index: 0 }, point)).toBe(false);
  });

  it("highlights live places in range when previewing a transition", () => {
    const { game, view, controller } = setup();
    const kit = game.level.tools!.kits!.find((item) => item.id === "mix")!;
    controller.setBrush({ kind: "kit", kit });
    controller.sync();
    const target = view.overlay.previewTarget!;
    const point = { x: 580, y: 520 };
    expect(target({ kind: "place", id: "pB" }, point)).toBe(true);
    expect(target({ kind: "place", id: "pR" }, point)).toBe(false);
    expect(target({ kind: "place", id: "pB" }, { x: 580.001, y: 520 })).toBe(false);
    game.sim.net.ghostPlace("pB");
    expect(target({ kind: "place", id: "pB" }, point)).toBe(false);
    game.complete = true;
    expect(target({ kind: "place", id: "pY" }, { x: 700, y: 180 })).toBe(false);
  });

  it("rejects a new connected place outside connection range even if it is in build range", () => {
    const { game, view, controller, tap, denied } = setup();
    expect(game.placementIssue("place", 750, 700)).toBeUndefined();
    tap({ kind: "port", tid: "sinkG", index: 0 });
    controller.sync();
    expect(view.overlay.build?.connection).toEqual({ tid: "sinkG", index: 0 });
    expect(game.canConnectAt("sinkG", 0, 750, 700)).toBe(false);
    tap({ kind: "empty", x: 750, y: 700 });
    expect(denied).toHaveLength(1);
    expect(game.sim.net.places.size).toBe(3);
    expect(controller.selected).toEqual({ tid: "sinkG", index: 0 });
  });

  it("does not create places when building is disabled or the selected port is gone", () => {
    const disabled = new Game({ ...level2, tools: { ...level2.tools, place: false } });
    const first = setup(disabled);
    first.tap({ kind: "port", tid: "sinkG", index: 0 });
    first.controller.sync();
    expect(first.view.overlay.build).toBeUndefined();
    first.tap({ kind: "empty", x: 820, y: 520 });
    expect(first.denied).toHaveLength(1);
    expect(disabled.sim.net.places.size).toBe(3);

    const second = setup();
    const nearby = second.game.buildPlace(820, 520)!;
    second.tap({ kind: "port", tid: "sinkG", index: 0 });
    expect(second.game.connect("sinkG", 0, nearby)).toBe(true);
    second.tap({ kind: "empty", x: 820, y: 520 });
    expect(second.denied).toHaveLength(1);
    expect(second.game.sim.net.places.size).toBe(4);
  });

  it("rejects a connection if the selected place is removed", () => {
    const { game, controller, tap } = setup();
    tap({ kind: "place", id: "pR" });
    game.remove("pR");
    tap({ kind: "port", tid: "sinkG", index: 0 });
    expect(game.sim.net.inputs("sinkG")).toHaveLength(0);
    expect(controller.selectedPlace).toBeUndefined();
  });

  it("uses the same tool to automate and speed up a transition", () => {
    const { game, view, controller, tap } = setup();
    expect(brushesOf(game).filter((brush) => brush.kind === "auto")).toHaveLength(1);
    controller.setBrush({ kind: "auto" });
    controller.sync();
    expect(view.overlay.target?.({ kind: "transition", id: "tSplit" })).toBe(true);
    tap({ kind: "transition", id: "tSplit" });
    expect(game.sim.net.transitions.get("tSplit")!.autoInterval).toBe(4);
    controller.sync();
    expect(view.overlay.target?.({ kind: "transition", id: "tSplit" })).toBe(true);
    tap({ kind: "transition", id: "tSplit" });
    expect(game.sim.net.transitions.get("tSplit")!.autoInterval).toBeCloseTo(2.4);
    while (game.upgradeAuto("tSplit")) {}
    controller.sync();
    expect(view.overlay.target?.({ kind: "transition", id: "tSplit" })).toBe(false);
    expect(view.overlay.target?.({ kind: "transition", id: "srcR" })).toBe(false);
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
  it("requires range and clearance", () => {
    const game = new Game(level2);
    expect(game.placementIssue("place", 380, 180)).toBe("crowded");
    expect(game.placementIssue("place", 10, 400)).toBeUndefined();
    expect(game.placementIssue("place", 850, 380)).toBeUndefined();
    expect(game.placementIssue("place", 1150, 800 - 60)).toBe("far");
    expect(game.buildPlace(380, 180)).toBeUndefined();
  });

  it.each([
    { x: -70, y: 180 },
    { x: 1210, y: 520 },
    { x: 100, y: -30 },
    { x: 640, y: 910 },
  ])("builds places and transitions beyond the initial frame at ($x, $y), including in portrait", ({ x, y }) => {
    for (const portrait of [false, true]) {
      for (const kind of ["place", "transition"] as const) {
        const game = new Game(level2);
        game.setPortrait(portrait);
        const point = portrait ? { x: y, y: x } : { x, y };
        expect(game.placementIssue(kind, point.x, point.y)).toBeUndefined();
        const kit = game.level.tools!.kits![0];
        const id = kind === "place" ? game.buildPlace(point.x, point.y) : game.buildTransition(kit, point.x, point.y);
        const node = kind === "place" ? game.sim.net.places.get(id!) : game.sim.net.transitions.get(id!);
        expect(node).toMatchObject(point);
      }
    }
  });

  it("continues extending and connecting the net beyond the initial frame", () => {
    const game = new Game(level2);
    const first = game.buildConnectedPlace("sinkG", 0, 1220, 520)!;
    expect(game.sim.net.inputs("sinkG")[0].from).toBe(first);
    expect(game.upgradeCapacity(first)).toBe(true);
    expect(game.sim.net.places.get(first)!.capacity).toBe(7);
    const relay = game.level.tools!.kits!.find((kit) => kit.id === "relay")!;
    const transition = game.buildTransition(relay, 1440, 520)!;
    const last = game.buildConnectedPlace(transition, 1, 1660, 520)!;
    expect(game.connect(transition, 0, first)).toBe(true);
    expect(game.sim.net.outputs(transition)[0].to).toBe(last);
    expect(game.placementIssue("place", 1880.001, 520)).toBe("far");
  });

  it("allows connections up to 300 units between centers, but no farther", () => {
    const game = new Game(level2);
    game.sim.net.addPlace({ id: "boundary", x: 700, y: 520, marking: [] });
    game.sim.net.addPlace({ id: "tooFar", x: 699.999, y: 520, marking: [] });
    expect(game.connect("sinkG", 0, "tooFar", false)).toBe(false);
    expect(game.connect("sinkG", 0, "tooFar")).toBe(false);
    expect(game.connect("sinkG", 0, "boundary", false)).toBe(true);
    expect(game.sim.net.inputs("sinkG")).toHaveLength(0);
    expect(game.connect("sinkG", 0, "boundary")).toBe(true);
  });

  it("builds a place and a transition and wires them into the net", () => {
    const game = new Game(level2);
    const net = game.sim.net;
    const pG = game.buildPlace(580, 350)!;
    const mix = game.level.tools!.kits!.find((k) => k.id === "mix")!;
    const t = game.buildTransition(mix, 400, 350)!;
    expect(net.transitions.get(t)!.open).toHaveLength(3);
    expect(game.connect(t, 2, pG)).toBe(true);
    expect(game.connect(t, 1, "pB")).toBe(true);
    expect(game.connect(t, 0, "pR")).toBe(true);
    expect(game.playerFire(t)).toBe(true);
    run(game, 5);
    expect(net.places.get(pG)!.marking).toEqual(["green"]);
  });

  it("does not remove sources or sinks, while allowing their arcs and normal transitions to be removed", () => {
    const game = new Game(level2);
    game.sim.net.addTransition({ id: "otherSink", x: 900, y: 700, kind: "sink" });
    for (const id of ["srcR", "srcB", "sinkY", "sinkG", "otherSink"]) {
      expect(game.remove(id, false)).toBe(false);
      expect(game.remove(id)).toBe(false);
      expect(game.sim.net.transitions.get(id)?.ghost).toBeFalsy();
    }
    expect(game.remove("a1")).toBe(true);
    expect(game.remove("tDrain")).toBe(true);
  });
});

describe("upgrades", () => {
  it("make transitions automatic, then faster, and places larger", () => {
    const game = new Game(level2);
    const t = game.sim.net.transitions.get("tSplit")!;
    expect(game.upgradeAuto("tSplit", false)).toBe(true);
    expect(t.autoInterval).toBeUndefined();
    expect(game.upgradeAuto("tSplit")).toBe(true);
    expect(t.autoInterval).toBe(4);
    expect(game.upgradeAuto("tSplit", false)).toBe(true);
    expect(t.autoInterval).toBe(4);
    expect(game.upgradeAuto("tSplit")).toBe(true);
    expect(t.autoInterval).toBeCloseTo(2.4);
    expect(game.upgradeAuto("srcR")).toBe(false);
    expect(game.upgradeAuto("sinkY")).toBe(false);
    expect(game.upgradeAuto("tDrain")).toBe(true);
    expect(game.sim.net.transitions.get("tDrain")!.autoInterval).toBeCloseTo(1.5);
    while (game.upgradeAuto("tSplit")) {}
    expect(t.autoInterval).toBe(0.6);
    expect(game.upgradeAuto("tSplit", false)).toBe(false);
    expect(game.upgradeAuto("tSplit")).toBe(false);
    expect(game.sim.net.places.get("pB")!.capacity).toBe(1);
    expect(game.upgradeCapacity("pB")).toBe(true);
    expect(game.sim.net.places.get("pB")!.capacity).toBe(7);
    expect(game.upgradeCapacity("pB")).toBe(true);
    expect(game.sim.net.places.get("pB")!.capacity).toBe(19);
    expect(game.upgradeCapacity("pB")).toBe(false);
  });

  it("rejects upgrades that would overlap a node", () => {
    const game = new Game(level2);
    game.sim.net.addTransition({ id: "nearby", x: 370, y: 520, kind: "normal" });
    expect(game.upgradeCapacity("pB", false)).toBe(false);
    expect(game.upgradeCapacity("pB")).toBe(false);
    expect(game.sim.net.places.get("pB")!.capacity).toBe(1);
    game.sim.net.deleteNode("nearby");
    expect(game.upgradeCapacity("pB")).toBe(true);
  });

  it("rejects automation when the tool is disabled, the transition is removed, or the game is complete", () => {
    const disabled = new Game({ ...level2, tools: { ...level2.tools, auto: false } });
    expect(disabled.upgradeAuto("tSplit", false)).toBe(false);
    expect(disabled.upgradeAuto("tSplit")).toBe(false);

    const game = new Game(level2);
    expect(game.remove("tSplit")).toBe(true);
    expect(game.upgradeAuto("tSplit", false)).toBe(false);
    expect(game.upgradeAuto("tSplit")).toBe(false);
    game.complete = true;
    expect(game.upgradeAuto("tDrain", false)).toBe(false);
    expect(game.upgradeAuto("tDrain")).toBe(false);
  });
});

describe("level 2", () => {
  it.each([0, 60])("can be won by building and removing the drain after %ss", (wait) => {
    const game = new Game(level2);
    run(game, wait);
    const kit = (id: string) => game.level.tools!.kits!.find((k) => k.id === id)!;
    const wire = (t: string, ...places: string[]) => places.forEach((p) => expect(game.connect(t, 0, p)).toBe(true));
    expect(game.remove("tDrain")).toBe(true);
    run(game, 2);
    const pR2 = game.buildPlace(520, 730)!;
    wire("srcR2", pR2);
    const mix = game.buildTransition(kit("mix"), 440, 610)!;
    const pG = game.buildPlace(620, 520)!;
    wire(mix, pR2, "pB", pG);
    const relay = game.buildTransition(kit("relay"), 760, 520)!;
    const goalPlace = game.buildPlace(880, 520)!;
    wire(relay, pG, goalPlace);
    wire("sinkG", goalPlace);
    for (const t of ["tSplit", mix, relay]) expect(game.upgradeAuto(t)).toBe(true);
    run(game, 120);
    expect(game.complete).toBe(true);
  });
});
