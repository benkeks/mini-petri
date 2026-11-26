import { describe, expect, it } from "vitest";
import { Net, type NetSpec } from "../src/core/net";
import { Simulation } from "../src/core/simulation";
import { Game, STARTING_COINS, UPGRADE_COST } from "../src/game/game";
import { endless } from "../src/game/endless";
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
    const tap = (next: Pick, touch?: Parameters<Controller["tap"]>[1]) => {
      pick = next;
      controller.tap({ x: 0, y: 0 }, touch);
    };
    const press = (next: Pick) => {
      pick = next;
      return controller.press(next.kind === "empty" ? { x: next.x, y: next.y } : { x: 0, y: 0 });
    };
    const release = (next: Pick) => {
      pick = next;
      controller.release(next.kind === "empty" ? { x: next.x, y: next.y } : { x: 0, y: 0 });
    };
    return { game, view, controller, tap, press, release, denied };
  }

  it.each(["port-first", "place-first", "transition-body"] as const)("drags between existing endpoints: %s", (order) => {
    const { game, controller, press, release, view } = setup();
    const place = { kind: "place", id: "pB" } as const;
    const port = { kind: "port", tid: "sinkG", index: 0 } as const;
    const from = order === "port-first" ? port : place;
    const to = order === "port-first" ? place : order === "place-first" ? port : { kind: "transition", id: "sinkG" } as const;
    game.sim.net.transitions.get("sinkG")!.x = 500;
    expect(press(from)).toBe(true);
    const version = game.sim.net.version;
    controller.sync();
    expect(game.sim.net.version).toBe(version);
    release(to);
    expect(game.sim.net.inputs("sinkG")).toHaveLength(1);
    expect(game.sim.net.inputs("sinkG")[0].from).toBe("pB");
    controller.sync();
    expect(view.overlay.connection).toBeUndefined();
  });

  it("drags a place into empty space to build a relay, and a port to build a place", () => {
    const { game, controller, press, release } = setup();
    expect(press({ kind: "place", id: "pB" })).toBe(true);
    const version = game.sim.net.version;
    controller.move({ x: 280, y: 700 });
    controller.sync();
    expect(game.sim.net.version).toBe(version);
    release({ kind: "empty", x: 280, y: 700 });
    const tid = controller.selected!.tid;
    expect(game.sim.net.inputs(tid)[0].from).toBe("pB");
    expect(press({ kind: "port", tid, index: 0 })).toBe(true);
    release({ kind: "empty", x: 450, y: 760 });
    expect(game.sim.net.outputs(tid)).toHaveLength(1);
    expect(controller.selected).toBeUndefined();
  });

  it("starts wiring by dragging a connector in deletion mode without deleting the target", () => {
    const { game, controller, press, release } = setup();
    game.sim.net.transitions.get("sinkG")!.x = 500;
    controller.setBrush({ kind: "remove" });
    expect(press({ kind: "port", tid: "sinkG", index: 0 })).toBe(true);
    release({ kind: "place", id: "pB" });
    expect(game.sim.net.inputs("sinkG")[0].from).toBe("pB");
    expect(game.sim.net.places.get("pB")?.ghost).toBeFalsy();
    expect(controller.brush.kind).toBe("fire");
  });

  it("cancels wiring on the selected node body and beyond 150% of the connection range", () => {
    const { game, controller, tap, press, release, denied } = setup();
    const port = { kind: "port", tid: "sinkG", index: 0 } as const;
    tap(port);
    tap({ kind: "transition", id: "sinkG" });
    expect(controller.selected).toBeUndefined();
    tap({ kind: "place", id: "pB" });
    tap({ kind: "place", id: "pB" });
    expect(controller.selectedPlace).toBeUndefined();
    tap(port);
    tap({ kind: "empty", x: 1450, y: 520 });
    expect(controller.selected).toEqual({ tid: "sinkG", index: 0 });
    expect(denied).toHaveLength(1);
    press({ kind: "empty", x: 1450, y: 520 });
    release({ kind: "empty", x: 1450.01, y: 520 });
    expect(controller.selected).toBeUndefined();
    expect(game.sim.net.inputs("sinkG")).toHaveLength(0);
    tap({ kind: "place", id: "pB" });
    press({ kind: "empty", x: 730.01, y: 520 });
    release({ kind: "empty", x: 730.01, y: 520 });
    expect(controller.selectedPlace).toBeUndefined();
  });

  it("cancels kit placement only outside 150% of every live build range", () => {
    const { game, controller, tap, press, release, denied } = setup();
    const kit = game.level.tools!.kits![0];
    controller.setBrush({ kind: "kit", kit });
    tap({ kind: "empty", x: 1330, y: 520 });
    expect(controller.brush.kind).toBe("kit");
    expect(denied).toHaveLength(1);
    press({ kind: "empty", x: 1330, y: 520 });
    controller.move({ x: 2000, y: 520 });
    release({ kind: "empty", x: 1330, y: 520 });
    expect(controller.brush.kind).toBe("kit");
    press({ kind: "empty", x: 1330, y: 520 });
    release({ kind: "empty", x: 1330.01, y: 520 });
    expect(controller.brush.kind).toBe("fire");
  });

  it("keeps a simple press/release as endpoint selection and cancels an uncommitted wiring drag", () => {
    const { game, controller, press, release } = setup();
    const port = { kind: "port", tid: "sinkG", index: 0 } as const;
    const version = game.sim.net.version;
    press(port);
    release(port);
    expect(controller.selected).toEqual({ tid: "sinkG", index: 0 });
    expect(game.sim.net.version).toBe(version);
    controller.cancel();
    press({ kind: "place", id: "pB" });
    controller.cancelPress();
    release({ kind: "empty", x: 280, y: 700 });
    expect(controller.selectedPlace).toBeUndefined();
    expect(game.sim.net.version).toBe(version);
  });

  it("retains touch creation protection when starting a wiring drag", () => {
    const { game, controller, view, denied } = setup();
    view.pick = () => ({ kind: "port", tid: "sinkG", index: 0 });
    const version = game.sim.net.version;
    controller.press({ x: 960, y: 520 }, { screen: { x: 100, y: 100 }, time: 0 });
    view.pick = () => ({ kind: "empty", x: 820, y: 520 });
    controller.release({ x: 820, y: 520 }, { screen: { x: 139, y: 100 }, time: 249 });
    expect(game.sim.net.version).toBe(version);
    expect(denied).toHaveLength(1);
    controller.press({ x: 820, y: 520 });
    controller.release({ x: 820, y: 520 }, { screen: { x: 140, y: 100 }, time: 249 });
    expect(game.sim.net.inputs("sinkG")).toHaveLength(1);
  });

  it("previews a place on press and builds only at the valid release position", () => {
    const { game, controller, view, tap, press, release } = setup();
    tap({ kind: "port", tid: "sinkG", index: 0 });
    const before = game.sim.net.places.size;
    expect(press({ kind: "empty", x: 820, y: 520 })).toBe(true);
    controller.sync();
    expect(view.overlay.pointer).toEqual({ x: 820, y: 520 });
    expect(view.overlay.build?.kind).toBe("place");
    expect(game.sim.net.places.size).toBe(before);
    release({ kind: "empty", x: 830, y: 520 });
    expect(game.sim.net.places.size).toBe(before + 1);
    const id = game.sim.net.inputs("sinkG")[0].from;
    expect(game.sim.net.places.get(id)).toMatchObject({ x: 830, y: 520 });
  });

  it("previews a transition without spending coins or stock, and revalidates release", () => {
    const { game, controller, view, press, release } = setup();
    controller.setBrush({ kind: "kit", kit: game.level.tools!.kits![0] });
    const before = game.sim.net.transitions.size;
    press({ kind: "empty", x: 820, y: 520 });
    controller.sync();
    expect(view.overlay.build?.kind).toBe("transition");
    expect(game.sim.net.transitions.size).toBe(before);
    expect(game.coins).toBe(STARTING_COINS);
    // Another node appears during the press, making this formerly valid point unavailable.
    game.sim.net.addPlace({ id: "blocker", x: 820, y: 520, capacity: 1, marking: [] });
    release({ kind: "empty", x: 820, y: 520 });
    expect(game.sim.net.transitions.size).toBe(before);
    expect(controller.brush.kind).toBe("kit");
    expect(controller.hint()).toContain("Not enough space");
    press({ kind: "empty", x: 800, y: 700 });
    release({ kind: "empty", x: 800, y: 700 });
    expect(game.sim.net.transitions.size).toBe(before + 1);
    expect(controller.brush.kind).toBe("fire");
  });

  it("can abort a build with cancellation or tool selection", () => {
    const { game, controller, press, release } = setup();
    const kit = game.level.tools!.kits![0];
    const before = game.sim.net.transitions.size;
    controller.setBrush({ kind: "kit", kit });
    press({ kind: "empty", x: 820, y: 520 });
    controller.cancelPress();
    release({ kind: "empty", x: 820, y: 520 });
    expect(game.sim.net.transitions.size).toBe(before);
    press({ kind: "empty", x: 820, y: 520 });
    controller.setBrush({ kind: "remove" });
    release({ kind: "empty", x: 820, y: 520 });
    expect(game.sim.net.transitions.size).toBe(before);
  });

  it("previews deletions and aborts when released off the original target", () => {
    const { game, controller, view, press, release } = setup();
    controller.setBrush({ kind: "remove" });
    press({ kind: "place", id: "pR" });
    controller.sync();
    expect(view.overlay.removing).toBe(true);
    expect(view.overlay.pressed).toEqual({ kind: "place", id: "pR" });
    expect(game.sim.net.places.get("pR")!.ghost).toBeFalsy();
    release({ kind: "place", id: "pB" });
    expect(game.sim.net.places.get("pR")!.ghost).toBeFalsy();
    expect(game.sim.net.places.get("pB")!.ghost).toBeFalsy();
    press({ kind: "place", id: "pR" });
    controller.cancelPress();
    release({ kind: "place", id: "pR" });
    expect(game.sim.net.places.get("pR")!.ghost).toBeFalsy();
    press({ kind: "place", id: "pR" });
    release({ kind: "place", id: "pR" });
    expect(game.sim.net.places.get("pR")!.ghost).toBe(true);
    expect(controller.brush.kind).toBe("remove");
  });

  it("leaves empty-space deletion presses available for camera panning", () => {
    const { controller, press, release, denied } = setup();
    controller.setBrush({ kind: "remove" });
    expect(press({ kind: "empty", x: 820, y: 520 })).toBe(false);
    release({ kind: "place", id: "pR" });
    expect(denied).toHaveLength(0);
    expect(controller.brush.kind).toBe("remove");
  });

  it("shows a build failure reason for ten real seconds or until tool selection", () => {
    const { game, controller, tap } = setup();
    const kit = game.level.tools!.kits![0];
    controller.setBrush({ kind: "kit", kit });
    game.sim.net.addPlace({ id: "hintAnchor", x: 5000, y: 5000, capacity: 1, marking: [] });
    tap({ kind: "empty", x: 5260, y: 5000 });
    expect(controller.hint()).toContain("Outside building range");
    controller.sync(9.999);
    expect(controller.hint()).toContain("Outside building range");
    controller.sync(0.002);
    expect(controller.hint()).toContain("Tap inside the white area");
    tap({ kind: "empty", x: 5260, y: 5000 });
    controller.setBrush({ kind: "auto" });
    expect(controller.hint()).toContain("automate");
    expect(controller.hint()).not.toContain("Outside building range");
    controller.cancel();
    tap({ kind: "port", tid: "sinkG", index: 0 });
    game.sim.net.addPlace({ id: "farAnchor", x: 1320, y: 520, capacity: 1, marking: [] });
    tap({ kind: "empty", x: 1320, y: 640 });
    expect(controller.hint()).toContain("Outside connection range");
  });

  it("returns to the default tool after capacity upgrades and life purchases", () => {
    const { game, controller, tap } = setup();
    controller.setBrush({ kind: "capacity" });
    tap({ kind: "place", id: "pR" });
    expect(game.sim.net.places.get("pR")!.capacity).toBe(19);
    expect(controller.brush.kind).toBe("fire");
    const survival = new Game(endless, Math.random, { survival: true });
    survival.sim.net.transitions.get("starterSource")!.autoInterval = undefined;
    survival.sim.step(240);
    const { controller: other } = setup(survival);
    survival.offers.set("money", {
      id: "money", x: 0, y: 0, expiresAt: survival.sim.time + 120,
      choices: [{ id: "money", label: "Coins", afterEpoch: 0, kind: "coins", amount: 20 },
        { id: "other", label: "Coins", afterEpoch: 0, kind: "coins", amount: 5 }],
    });
    survival.collectOffer("money", 0);
    other.setBrush({ kind: "remove" });
    other.setBrush({ kind: "life" });
    expect(survival.lives).toBe(10);
    expect(other.brush.kind).toBe("fire");
  });

  it("keeps the introduction after ineffective clicks and unlocks help after a successful firing", () => {
    const game = new Game(endless);
    const { controller, view, tap } = setup(game);
    const introduction = controller.hint();
    expect(introduction).toContain("Move deliveries from sources to sinks");
    tap({ kind: "empty", x: 0, y: 0 });
    tap({ kind: "transition", id: "starterRelay" });
    expect(controller.hint()).toBe(introduction);
    expect(game.sim.fire("starterSource")).toBe(true);
    game.sim.step(1);
    tap({ kind: "transition", id: "starterRelay" });
    expect(controller.hint()).toContain("Tap a dark transition");
    controller.attach(game, view);
    expect(controller.hint()).toContain("Tap a dark transition");
    controller.attach(new Game(endless), view);
    expect(controller.hint()).toBe(introduction);
  });

  it("unlocks help at two epochs, hides default help after ten, and hides every tool's help after one hundred", () => {
    const game = new Game(endless, () => 0.9);
    game.sim.net.transitions.get("starterSource")!.autoInterval = undefined;
    const { controller } = setup(game);
    const reach = (epoch: number) => {
      while (game.epoch < epoch) {
        game.sim.net.places.get("starterPlace")!.marking = [];
        for (let i = 0; i < 6; i++) expect(game.sim.fire("starterSource")).toBe(true);
        game.step(0);
        game.sim.step(1);
      }
    };
    reach(1);
    expect(controller.hint()).toContain("Move deliveries");
    reach(2);
    expect(controller.hint()).toContain("Tap a dark transition");
    reach(10);
    expect(controller.hint()).not.toBe("");
    reach(11);
    expect(controller.hint()).toBe("");
    controller.setBrush({ kind: "capacity" });
    expect(controller.hint()).toContain("capacity");
    reach(100);
    expect(controller.hint()).not.toBe("");
    reach(101);
    expect(controller.hint()).toBe("");
    controller.setBrush({ kind: "kit", kit: game.relayKit()! });
    controller.tap({ x: 100000, y: 100000 });
    expect(controller.hint()).toBe("");
  });

  it("identifies interactive hover targets in firing, wiring and build modes", () => {
    const { game, controller, view, tap } = setup();
    expect(controller.interactive({ kind: "transition", id: "tSplit" })).toBe(true);
    expect(controller.interactive({ kind: "transition", id: "srcB" })).toBe(false);
    expect(controller.interactive({ kind: "place", id: "pB" })).toBe(true);
    expect(controller.interactive({ kind: "port", tid: "sinkG", index: 0 })).toBe(true);
    expect(controller.interactive({ kind: "arc", id: "a1" })).toBe(false);
    tap({ kind: "port", tid: "sinkG", index: 0 });
    controller.sync();
    expect(view.overlay.hoverAction?.({ kind: "place", id: "pB" })).toBe(true);
    expect(controller.interactive({ kind: "empty", x: 0, y: 0 })).toBe(true);
    controller.cancel();
    controller.setBrush({ kind: "remove" });
    expect(controller.interactive({ kind: "arc", id: "a1" })).toBe(true);
    controller.setBrush({ kind: "capacity" });
    expect(controller.interactive({ kind: "transition", id: "tSplit" })).toBe(true);
    game.paused = true;
    expect(controller.interactive({ kind: "arc", id: "a1" })).toBe(false);
  });

  it("clears a selected loose end when its goal times out", () => {
    const game = new Game(endless, () => 0);
    game.sim.net.transitions.get("starterSource")!.autoInterval = undefined;
    game.step(60.1);
    const sink = [...game.sim.net.transitions.values()].find((t) => t.kind === "sink" && t.open?.length)!;
    const { controller, view, tap } = setup(game);
    tap({ kind: "port", tid: sink.id, index: 0 });
    expect(controller.selected?.tid).toBe(sink.id);
    game.step(240);
    expect(game.failed.has(sink.id)).toBe(true);
    controller.sync();
    expect(controller.selected).toBeUndefined();
    expect(view.overlay.build).toBeUndefined();
  });

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
    game.sim.net.transitions.get("sinkG")!.x = 680;
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

  it("builds a nearby place when tapping the selected connector and keeps the firing tool", () => {
    const { game, controller, tap } = setup();
    controller.setBrush({ kind: "remove" });
    tap({ kind: "port", tid: "sinkG", index: 0 });
    tap({ kind: "port", tid: "sinkG", index: 0 });
    expect(controller.selected).toBeUndefined();
    expect(controller.brush.kind).toBe("fire");
    const id = game.sim.net.inputs("sinkG")[0].from;
    expect(game.sim.net.places.get(id)?.capacity).toBe(1);
  });

  it.each([
    { tid: "sinkG", x: 820, y: 520, direction: "in" },
    { tid: "srcR2", x: 800, y: 700, direction: "out" },
  ])("builds and connects an upgradable one-token place from an $direction port", ({ tid, x, y, direction }) => {
    const { game, view, controller, tap } = setup();
    tap({ kind: "port", tid, index: 0 });
    controller.sync();
    expect(view.overlay.build).toMatchObject({ kind: "place", capacity: 1, connection: { tid, index: 0 } });
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

  it("builds a one-to-one relay from a selected place and continues wiring its output", () => {
    const { game, view, controller, tap, denied } = setup();
    tap({ kind: "place", id: "pB" });
    controller.sync();
    expect(view.overlay.build).toMatchObject({ kind: "transition", fromPlace: "pB" });
    expect(game.placementIssue("transition", 700, 400)).toBeUndefined();
    for (const point of [{ x: 700, y: 400 }, { x: 280, y: 520 }, { x: 280, y: 180 }]) {
      tap({ kind: "empty", ...point });
    }
    expect(denied).toHaveLength(3);
    expect(controller.selectedPlace).toBe("pB");

    tap({ kind: "empty", x: 400, y: 400 });
    const tid = controller.selected!.tid;
    expect(game.sim.net.inputs(tid)).toMatchObject([{ from: "pB", to: tid, count: 1 }]);
    expect(game.sim.net.transitions.get(tid)?.open).toMatchObject([{ dir: "out", count: 1 }]);
    expect(controller.selectedPlace).toBeUndefined();
    expect(controller.selected).toEqual({ tid, index: 0 });
    tap({ kind: "empty", x: 550, y: 400 });
    const place = game.sim.net.outputs(tid)[0].to;
    expect(game.playerFire(tid)).toBe(true);
    run(game, 2);
    expect(game.sim.net.places.get(place)?.marking).toEqual(["blue"]);
  });

  it("does not build a relay from a place when no one-to-one kit is available", () => {
    const game = new Game({ ...level2, tools: { ...level2.tools, kits: [] } });
    const { controller, view, tap } = setup(game);
    tap({ kind: "place", id: "pB" });
    controller.sync();
    expect(view.overlay.build).toBeUndefined();
    tap({ kind: "empty", x: 400, y: 400 });
    expect(controller.selectedPlace).toBeUndefined();
    expect(game.sim.net.transitions.size).toBe(level2.net.transitions.length);
  });

  it("rejects invalid placement without losing the selected port or creating a place", () => {
    const { game, controller, tap, denied } = setup();
    tap({ kind: "port", tid: "sinkG", index: 0 });
    for (const point of [{ x: 1000, y: 520 }, { x: 1150, y: 740 }, { x: 1000, y: 180 }]) {
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
    game.sim.net.places.get("pB")!.x = 600;
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
    expect(controller.interactive({ kind: "port", tid: "sinkG", index: 0 })).toBe(false);
    expect(controller.interactive({ kind: "transition", id: "sinkG" })).toBe(false);
    tap({ kind: "port", tid: "sinkG", index: 0 });
    expect(denied).toHaveLength(2);
    expect(game.sim.net.inputs("sinkG")).toHaveLength(0);
  });

  it("omits the place tool and puts removal last", () => {
    const kinds = brushesOf(new Game(level2)).map((brush) => brush.kind);
    expect(kinds).not.toContain("place");
    expect(kinds.at(-1)).toBe("remove");
    const names = brushesOf(new Game(level2)).map((brush) => brush.kind === "kit" ? brush.kit.id : brush.kind);
    expect(names).toEqual(["fire", "auto", "capacity", "split", "mix", "remove"]);
  });

  it("reveals the life tool after the first loss and retains it after recovering to ten lives", () => {
    const definition = structuredClone(endless);
    definition.net.transitions.find((t) => t.id === "starterSource")!.autoInterval = undefined;
    const game = new Game(definition, () => 0.5, { survival: true });
    const visible = () => brushesOf(game).some((brush) => brush.kind === "life");
    expect(visible()).toBe(false);
    game.sim.step(239.9);
    expect(visible()).toBe(false);
    game.sim.step(0.1);
    expect(visible()).toBe(true);
    game.sim.net.addPlace({ id: "funds", x: -1000, y: 0, capacity: 19, marking: Array(10).fill("blue") });
    expect(game.remove("funds")).toBe(true);
    expect(game.buyLife({ x: 0, y: 0 })).toBe(true);
    expect(game.lives).toBe(10);
    expect(visible()).toBe(true);
    game.continueEndless();
    expect(visible()).toBe(false);
    expect(brushesOf(new Game(definition, () => 0.5, { survival: true })).some((brush) => brush.kind === "life")).toBe(false);
  });

  it("signals money-constrained upgrade taps, but not invalid targets or feasibility checks", () => {
    const { game, controller, tap } = setup();
    for (let i = 0; i < 5; i++) {
      game.sim.net.addTransition({ id: `spend${i}`, x: -2000 - i * 100, y: 0, kind: "normal" });
      expect(game.upgradeAuto(`spend${i}`)).toBe(true);
    }
    game.sim.net.addPlace({ id: "small", x: 4000, y: 4000, capacity: 1, marking: [] });
    let insufficient = 0;
    game.onInsufficientCoins(() => { insufficient++; });
    expect(game.upgradeAuto("tSplit", false)).toBe(false);
    expect(game.upgradeCapacity("small", false)).toBe(false);
    controller.setBrush({ kind: "auto" });
    tap({ kind: "transition", id: "srcB" });
    expect(insufficient).toBe(0);
    tap({ kind: "transition", id: "tSplit" });
    expect(insufficient).toBe(1);
    controller.setBrush({ kind: "capacity" });
    tap({ kind: "place", id: "small" });
    expect(insufficient).toBe(2);
    expect(game.coins).toBe(5);
    expect(game.sim.net.places.get("small")!.capacity).toBe(1);
    expect(game.sim.net.transitions.get("tSplit")!.autoInterval).toBeUndefined();
  });

  function connectorGame(distance = 220, portrait = false) {
    const game = new Game({
      ...level2, goals: [], net: {
        places: [], arcs: [],
        transitions: [
          { id: "left", x: 1000, y: 1000, kind: "source", supply: 1, open: [{ dir: "out", color: "blue" }] },
          { id: "right", x: 1000 + distance, y: 1000, kind: "sink", open: [{ dir: "in", color: "blue" }] },
        ],
      },
    });
    game.setPortrait(portrait);
    return game;
  }

  it("does not cancel a valid connector bridge beyond 150% of the primary range", () => {
    const { game, controller, tap } = setup(connectorGame(500));
    tap({ kind: "port", tid: "left", index: 0 });
    tap({ kind: "port", tid: "right", index: 0 });
    expect(game.sim.net.arcs.size).toBe(2);
    expect(controller.selected).toBeUndefined();
  });

  it("previews the exact bridge position without mutation until release", () => {
    const { game, controller, view, tap, press, release } = setup(connectorGame());
    tap({ kind: "port", tid: "left", index: 0 });
    press({ kind: "port", tid: "right", index: 0 });
    controller.sync();
    const preview = view.overlay.build?.position;
    expect(preview).toBeDefined();
    expect(game.sim.net.places.size).toBe(0);
    expect(game.sim.net.arcs.size).toBe(0);
    release({ kind: "port", tid: "right", index: 0 });
    expect([...game.sim.net.places.values()][0]).toMatchObject(preview!);
    expect(game.sim.net.arcs.size).toBe(2);
  });

  it.each([
    { kind: "port", tid: "left", index: 0 },
    { kind: "port", tid: "right", index: 0 },
    { kind: "transition", id: "right" },
    { kind: "empty", x: 1000, y: 1120 },
  ] satisfies Pick[])("blocks rapid nearby touch creation on $kind until 250 ms", (pick) => {
    const { game, controller, tap, denied } = setup(connectorGame(220, true));
    tap({ kind: "port", tid: "left", index: 0 }, { screen: { x: 100, y: 100 }, time: 1000 });
    tap(pick, { screen: { x: 139.99, y: 100 }, time: 1249 });
    expect(game.sim.net.places.size).toBe(0);
    expect(game.sim.net.arcs.size).toBe(0);
    expect(controller.selected).toEqual({ tid: "left", index: 0 });
    expect(denied).toEqual([pick]);
    tap(pick, { screen: { x: 139.99, y: 100 }, time: 1250 });
    expect(game.sim.net.places.size).toBe(1);
    expect(denied).toHaveLength(1);
  });

  it("allows immediate touch creation at a 40-screen-pixel distance", () => {
    const { game, tap, denied } = setup(connectorGame());
    tap({ kind: "port", tid: "left", index: 0 }, { screen: { x: 100, y: 100 }, time: 1000 });
    tap({ kind: "port", tid: "right", index: 0 }, { screen: { x: 124, y: 132 }, time: 1001 });
    expect(game.sim.net.places.size).toBe(1);
    expect(denied).toHaveLength(0);
  });

  it("allows rapid nearby touch connections to existing places", () => {
    const { game, tap, denied } = setup();
    const id = game.buildPlace(820, 520)!;
    tap({ kind: "port", tid: "sinkG", index: 0 }, { screen: { x: 100, y: 100 }, time: 1000 });
    tap({ kind: "place", id }, { screen: { x: 100, y: 100 }, time: 1001 });
    expect(game.sim.net.inputs("sinkG")[0].from).toBe(id);
    expect(denied).toHaveLength(0);
  });

  it("protects the next automatically selected port after a touch creation", () => {
    const game = connectorGame();
    game.sim.net.transitions.get("left")!.open!.push({ dir: "out", color: "red" });
    const { controller, tap, denied } = setup(game);
    const pick = { kind: "port", tid: "left", index: 0 } as const;
    tap(pick, { screen: { x: 100, y: 100 }, time: 1000 });
    tap(pick, { screen: { x: 100, y: 100 }, time: 1250 });
    expect(game.sim.net.places.size).toBe(1);
    expect(controller.selected).toEqual({ tid: "left", index: 0 });
    tap(pick, { screen: { x: 100, y: 100 }, time: 1251 });
    expect(game.sim.net.places.size).toBe(1);
    expect(denied).toHaveLength(1);
    tap(pick, { screen: { x: 100, y: 100 }, time: 1500 });
    expect(game.sim.net.places.size).toBe(2);
  });

  it("does not delay mouse creation after selecting a port by touch", () => {
    const { game, tap, denied } = setup(connectorGame());
    const pick = { kind: "port", tid: "left", index: 0 } as const;
    tap(pick, { screen: { x: 100, y: 100 }, time: 1000 });
    tap(pick);
    expect(game.sim.net.places.size).toBe(1);
    expect(denied).toHaveLength(0);
  });

  it.each([false, true].flatMap((portrait) => [false, true].map((reverse) => ({ portrait, reverse }))))(
    "bridges connectors with a location, portrait=$portrait, reverse=$reverse", ({ portrait, reverse }) => {
      const { game, view, controller, tap, denied } = setup(connectorGame(220, portrait));
      const first = { kind: "port", tid: reverse ? "right" : "left", index: 0 } as const;
      const second = { kind: "port", tid: reverse ? "left" : "right", index: 0 } as const;
      tap(first);
      controller.sync();
      expect(view.overlay.target?.(second)).toBe(true);
      expect(view.overlay.target?.({ kind: "transition", id: second.tid })).toBe(true);
      expect(controller.interactive(second)).toBe(true);
      expect(game.sim.net.places.size).toBe(0);
      expect(game.sim.net.arcs.size).toBe(0);
      tap(second);
      expect(denied).toHaveLength(0);
      const place = [...game.sim.net.places.values()][0];
      expect(place.capacity).toBe(1);
      expect(game.sim.net.outputs("left")[0]).toMatchObject({ to: place.id, color: "blue", count: 1 });
      expect(game.sim.net.inputs("right")[0]).toMatchObject({ from: place.id, color: "blue", count: 1 });
      expect(controller.selected).toBeUndefined();
      expect(game.sim.fire("left")).toBe(true);
      expect(game.sim.fire("right")).toBe(false);
      game.sim.step(2);
      expect(game.sim.fire("right")).toBe(true);
    });

  it("finds a narrow nearby gap between clearance circles instead of missing it with angular sampling", () => {
    const game = connectorGame(300);
    const target = game.sim.net.transitions.get("right")!;
    for (let i = 0; i < 10; i++) {
      const x = target.x + 190.3 * Math.cos(i * Math.PI / 5);
      const y = target.y + 190.3 * Math.sin(i * Math.PI / 5);
      expect(game.placementIssue("transition", x, y)).toBeUndefined();
      game.sim.net.addTransition({ id: `block${i}`, x, y, kind: "normal" });
    }
    expect(game.connectPorts({ tid: "left", index: 0 }, { tid: "right", index: 0 }, true, { x: target.x - 57, y: target.y })).toBe(true);
    const place = [...game.sim.net.places.values()][0];
    expect(Math.hypot(place.x - target.x, place.y - target.y)).toBeLessThan(101);
    for (const node of game.sim.net.transitions.values()) {
      expect(Math.hypot(place.x - node.x, place.y - node.y)).toBeGreaterThanOrEqual(100);
    }
  });

  it.each([false, true])("denies impossible connector bridges without partial creation, crowded=%s", (crowded) => {
    const { game, controller, view, tap, denied } = setup(connectorGame(crowded ? 220 : 700));
    if (crowded) for (let x = 700; x <= 1600; x += 80) for (let y = 700; y <= 1300; y += 80) {
      game.sim.net.addTransition({ id: `block${x}-${y}`, x, y, kind: "normal" });
    }
    tap({ kind: "port", tid: "left", index: 0 });
    controller.sync();
    const target = { kind: "port", tid: "right", index: 0 } as const;
    expect(view.overlay.target?.(target)).toBe(false);
    expect(controller.interactive(target)).toBe(false);
    tap(target);
    expect(denied).toHaveLength(crowded ? 1 : 0);
    expect(game.sim.net.places.size).toBe(0);
    expect(game.sim.net.arcs.size).toBe(0);
    expect(controller.selected).toEqual(crowded ? { tid: "left", index: 0 } : undefined);
    if (crowded) {
      for (const id of [...game.sim.net.transitions.keys()]) if (id.startsWith("block")) game.sim.net.deleteNode(id);
      expect(view.overlay.target?.(target)).toBe(true);
    }
  });

  it("preserves port identities when bridging two connectors on the same transition", () => {
    const { game, controller, tap } = setup(connectorGame());
    const transition = game.sim.net.transitions.get("left")!;
    transition.open = [{ dir: "out", color: "blue" }, { dir: "in", color: "blue" }, { dir: "in", color: "red", count: 2 }];
    tap({ kind: "port", tid: "left", index: 0 });
    tap({ kind: "port", tid: "left", index: 2 });
    const place = [...game.sim.net.places.values()][0];
    expect(game.sim.net.outputs("left")[0]).toMatchObject({ to: place.id, color: "blue" });
    expect(game.sim.net.inputs("left")[0]).toMatchObject({ from: place.id, color: "red", count: 2 });
    expect(transition.open).toEqual([{ dir: "in", color: "blue" }]);
    expect(controller.selected).toEqual({ tid: "left", index: 0 });
  });

  it("highlights and connects an eligible transition body during connector wiring", () => {
    const { game, controller, view, tap } = setup(connectorGame());
    tap({ kind: "port", tid: "left", index: 0 });
    controller.sync();
    const target = { kind: "transition", id: "right" } as const;
    expect(view.overlay.target?.(target)).toBe(true);
    expect(controller.interactive(target)).toBe(true);
    tap(target);
    expect(game.sim.net.inputs("right")[0].from).toBe(game.sim.net.outputs("left")[0].to);
    expect(controller.selected).toBeUndefined();
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

  it("returns to firing after each automation or speed upgrade", () => {
    const { game, view, controller, tap } = setup();
    expect(brushesOf(game).filter((brush) => brush.kind === "auto")).toHaveLength(1);
    controller.setBrush({ kind: "auto" });
    controller.sync();
    expect(view.overlay.target?.({ kind: "transition", id: "tSplit" })).toBe(true);
    tap({ kind: "transition", id: "tSplit" });
    expect(game.sim.net.transitions.get("tSplit")!.autoInterval).toBe(4);
    expect(controller.brush.kind).toBe("fire");
    controller.setBrush({ kind: "auto" });
    controller.sync();
    expect(view.overlay.target?.({ kind: "transition", id: "tSplit" })).toBe(true);
    tap({ kind: "transition", id: "tSplit" });
    expect(game.sim.net.transitions.get("tSplit")!.autoInterval).toBeCloseTo(2.4);
    expect(controller.brush.kind).toBe("fire");
    while (game.upgradeAuto("tSplit")) {}
    controller.setBrush({ kind: "auto" });
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
  it.each([false, true])("increases location build range by 44 per capacity upgrade, portrait=%s", (portrait) => {
    const game = new Game(level2);
    game.setPortrait(portrait);
    game.sim.net.addPlace({ id: "range", x: 1600, y: 1000, capacity: 1, marking: [] });
    for (const range of [220, 264, 308]) {
      for (const kind of ["place", "transition"] as const) {
        expect(game.placementIssue(kind, 1600 + range, 1000)).toBeUndefined();
        expect(game.placementIssue(kind, 1600 + range + 0.001, 1000)).toBe("far");
      }
      if (range < 308) expect(game.upgradeCapacity("range")).toBe(true);
    }
    expect(game.upgradeCapacity("range")).toBe(false);
    expect(game.buildPlace(1908, 1000, 1)).toBeDefined();
    game.sim.net.addTransition({ id: "fixedRange", x: 2400, y: 1000, kind: "normal" });
    expect(game.upgradeAuto("fixedRange")).toBe(true);
    expect(game.placementIssue("place", 2620, 1000)).toBeUndefined();
    expect(game.placementIssue("place", 2620.001, 1000)).toBe("far");
  });

  it("allows nodes at the reduced clearance boundary", () => {
    const game = new Game(level2);
    expect(game.placementIssue("transition", 100, 267.999)).toBe("crowded");
    expect(game.placementIssue("transition", 100, 268)).toBeUndefined();
    expect(game.placementIssue("place", 100, 279.999)).toBe("crowded");
    expect(game.placementIssue("place", 100, 280)).toBeUndefined();
  });

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
    game.sim.net.addPlace({ id: "boundary", x: 700, y: 520, capacity: 1, marking: [] });
    game.sim.net.addPlace({ id: "tooFar", x: 699.999, y: 520, capacity: 1, marking: [] });
    expect(game.connect("sinkG", 0, "tooFar", false)).toBe(false);
    expect(game.connect("sinkG", 0, "tooFar")).toBe(false);
    expect(game.connect("sinkG", 0, "boundary", false)).toBe(true);
    expect(game.sim.net.inputs("sinkG")).toHaveLength(0);
    expect(game.connect("sinkG", 0, "boundary")).toBe(true);
  });

  it.each([false, true].flatMap((portrait) => (["in", "out"] as const).map((dir) => ({ portrait, dir }))))(
    "uses upgraded place arc reach for $dir arcs, portrait=$portrait", ({ portrait, dir }) => {
      const game = new Game(level2);
      game.setPortrait(portrait);
      game.sim.net.addPlace({ id: "reach", x: 1600, y: 1000, capacity: 1, marking: [] });
      const place = game.sim.net.places.get("reach")!;
      const axis = portrait ? "y" : "x";
      for (const radius of [300, 360, 420]) {
        const id = `reach${radius}`;
        game.sim.net.addTransition({
          id, x: place.x + (portrait ? 0 : radius), y: place.y + (portrait ? radius : 0),
          kind: "normal", open: [{ dir, color: "blue" }],
        });
        const transition = game.sim.net.transitions.get(id)!;
        expect(game.connect(id, 0, place.id, false)).toBe(true);
        transition[axis] += 0.001;
        expect(game.connect(id, 0, place.id, false)).toBe(false);
        transition[axis] -= 0.001;
        expect(game.connect(id, 0, place.id)).toBe(true);
        if (dir === "in") expect(game.sim.net.inputs(id)[0].from).toBe(place.id);
        else expect(game.sim.net.outputs(id)[0].to).toBe(place.id);
        if (radius < 420) expect(game.upgradeCapacity(place.id)).toBe(true);
      }
      const sink = game.sim.net.transitions.get("sinkG")!;
      expect(game.canConnectAt(sink.id, 0, sink.x, sink.y + 300)).toBe(true);
      expect(game.canConnectAt(sink.id, 0, sink.x, sink.y + 300.001)).toBe(false);
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

describe("idle small places", () => {
  it("removes only unconnected size-1 places after 30 seconds", () => {
    const game = new Game(level2);
    const idle = game.buildPlace(580, 350, 1)!;
    const upgraded = game.buildPlace(820, 350, 1)!;
    expect(game.upgradeCapacity(upgraded)).toBe(true);
    const connected = game.buildConnectedPlace("sinkG", 0, 820, 520)!;
    game.step(29.9);
    expect(game.sim.net.places.has(idle)).toBe(true);
    game.step(0.2);
    expect(game.sim.net.places.has(idle)).toBe(false);
    expect(game.sim.net.places.has(upgraded)).toBe(true);
    expect(game.sim.net.places.has(connected)).toBe(true);
  });

  it("resets the timer when an unconnected place is tapped", () => {
    const game = new Game(level2);
    const id = game.buildPlace(580, 350, 1)!;
    const pick: Pick = { kind: "place", id };
    const controller = new Controller(game, { overlay: {}, pick: () => pick, deny: () => {} });
    game.step(29);
    controller.tap({ x: 580, y: 350 });
    game.step(29);
    expect(game.sim.net.places.has(id)).toBe(true);
    game.step(1.1);
    controller.sync();
    expect(game.sim.net.places.has(id)).toBe(false);
    expect(controller.selectedPlace).toBeUndefined();
  });

  it("restarts the timer when a connected place is disconnected", () => {
    const game = new Game(level2);
    const id = game.buildPlace(820, 520, 1)!;
    game.step(20);
    expect(game.connect("sinkG", 0, id)).toBe(true);
    game.step(50);
    expect(game.sim.net.places.has(id)).toBe(true);
    expect(game.remove(game.sim.net.inputs("sinkG")[0].id)).toBe(true);
    game.step(29.9);
    expect(game.sim.net.places.has(id)).toBe(true);
    game.step(0.2);
    expect(game.sim.net.places.has(id)).toBe(false);
  });

  it("uses the actual arrival time to reset the timer on a disconnected ghost arc", () => {
    const game = new Game(level2);
    const id = game.buildConnectedPlace("srcR2", 0, 800, 700)!;
    expect(game.sim.fire("srcR2")).toBe(true);
    expect(game.remove(game.sim.net.outputs("srcR2")[0].id)).toBe(true);
    game.step(29);
    expect(game.sim.net.places.get(id)?.marking).toEqual(["red"]);
    game.step(1);
    expect(game.sim.net.places.has(id)).toBe(true);
    game.step(1);
    expect(game.sim.net.places.has(id)).toBe(false);
  });

  it("does not revive a place when a token arrives after its idle deadline", () => {
    const definition = structuredClone(level2);
    definition.net.places.push({ id: "farPlace", x: 28640, y: 700, capacity: 1, marking: [] });
    definition.net.transitions.find((t) => t.id === "srcR2")!.open = [];
    definition.net.arcs.push({ id: "longArc", from: "srcR2", to: "farPlace", color: "red" });
    const game = new Game(definition);
    expect(game.sim.fire("srcR2")).toBe(true);
    expect(game.remove("longArc")).toBe(true);
    game.step(42);
    expect(game.sim.net.places.get("farPlace")?.ghost).toBe(true);
    game.step(80);
    expect(game.sim.net.places.has("farPlace")).toBe(false);
  });
});

describe("upgrades", () => {
  it("charges only successful upgrades and refunds half of purchased upgrades plus settled tokens", () => {
    const game = new Game(level2);
    const events: number[] = [];
    game.onCoins((event) => events.push(event.amount));
    const place = game.sim.net.places.get("pB")!;
    const tokenCount = place.marking.length;
    expect(game.upgradeCapacity("pB", false)).toBe(true);
    expect(game.coins).toBe(STARTING_COINS);
    expect(game.upgradePrice).toBe(UPGRADE_COST);
    expect(game.upgradeCapacity("pB")).toBe(true);
    expect(game.upgradeCapacity("pB")).toBe(true);
    expect(game.upgradeCapacity("pB")).toBe(false);
    expect(game.upgradePrice).toBe(UPGRADE_COST + 2);
    expect(game.coins).toBe(STARTING_COINS - 11);
    expect(game.remove("pB", false)).toBe(true);
    expect(game.coins).toBe(STARTING_COINS - 11);
    expect(game.remove("pB")).toBe(true);
    expect(game.coins).toBe(STARTING_COINS - 11 + 6 + tokenCount);
    expect(game.upgradePrice).toBe(UPGRADE_COST + 2);
    expect(game.remove("pB")).toBe(false);
    expect(events).toEqual([-5, -6, ...(tokenCount ? [tokenCount] : []), 6]);
  });

  it("reimburses a single transition upgrade rounded up, not pre-existing automation", () => {
    const game = new Game(level2);
    expect(game.upgradeAuto("tDrain")).toBe(true);
    expect(game.remove("tDrain")).toBe(true);
    expect(game.coins).toBe(STARTING_COINS - 5 + 3);
    expect(game.remove("tSplit")).toBe(true);
    expect(game.coins).toBe(STARTING_COINS - 5 + 3);
  });

  it("denies upgrades without enough coins, including feasibility checks", () => {
    const game = new Game(level2);
    for (let i = 0; i < 5; i++) {
      const id = `economy${i}`;
      game.sim.net.addTransition({ id, x: -1000 - i * 100, y: 0, kind: "normal" });
      expect(game.upgradeAuto(id)).toBe(true);
    }
    expect(game.coins).toBe(5);
    expect(game.upgradePrice).toBe(10);
    expect(game.upgradeAuto("tSplit", false)).toBe(false);
    expect(game.upgradeAuto("tSplit")).toBe(false);
    expect(game.upgradeCapacity("pB", false)).toBe(false);
    expect(game.upgradeCapacity("pB")).toBe(false);
    expect(game.remove("economy0")).toBe(true);
    expect(game.coins).toBe(8);
    expect(game.upgradePrice).toBe(10);
    expect(game.upgradeAuto("tSplit")).toBe(false);
  });

  it("rewards a finite source once when its last token is emitted", () => {
    const definition = structuredClone(level2);
    definition.net.transitions.find((t) => t.id === "srcR")!.supply = 1;
    const game = new Game(definition);
    const events: number[] = [];
    game.onCoins((event) => events.push(event.amount));
    expect(game.sim.fire("srcR")).toBe(true);
    expect(game.coins).toBe(STARTING_COINS + 5);
    expect(game.sim.fire("srcR")).toBe(false);
    game.step(2);
    expect(game.coins).toBe(STARTING_COINS + 5);
    expect(events).toEqual([5]);
  });

  it("returns only settled matching tokens when a removed place swallows an incoming token", () => {
    const game = new Game(level2);
    expect(game.sim.fire("srcR")).toBe(true);
    expect(game.sim.incoming("pR")).toEqual({ red: 1 });
    expect(game.remove("pR")).toBe(true);
    expect(game.sim.net.transitions.get("srcR")!.supply).toBe(6);
    expect(game.coins).toBe(STARTING_COINS);
    game.step(2);
    expect(game.sim.net.transitions.get("srcR")!.supply).toBe(6);
    expect(game.coins).toBe(STARTING_COINS);
  });

  it("caps returned source tokens at the initial supply and rewards only the leftovers", () => {
    const game = new Game(level2);
    const source = game.sim.net.transitions.get("srcR")!;
    const place = game.sim.net.places.get("pR")!;
    expect(game.sim.fire("srcR")).toBe(true);
    game.sim.step(1);
    place.marking.push("red", "blue");
    const marking = [...place.marking];
    expect(game.remove("pR", false)).toBe(true);
    expect(source.supply).toBe(5);
    expect(place.marking).toEqual(marking);
    expect(game.remove("pR")).toBe(true);
    expect(source.supply).toBe(6);
    expect(game.coins).toBe(STARTING_COINS + marking.length - 1);
    expect(place.marking).toEqual([]);
  });

  it("revives a still-visible exhausted source without paying another exhaustion reward", () => {
    const definition = structuredClone(level2);
    definition.net.transitions.find((t) => t.id === "srcR")!.supply = 1;
    definition.net.places.find((p) => p.id === "pR")!.marking = [];
    const game = new Game(definition);
    expect(game.sim.fire("srcR")).toBe(true);
    game.sim.step(1);
    expect(game.exhausted.has("srcR")).toBe(true);
    expect(game.remove("pR")).toBe(true);
    expect(game.exhausted.has("srcR")).toBe(false);
    expect(game.sim.net.transitions.get("srcR")!.supply).toBe(1);
    const destination = game.buildConnectedPlace("srcR", 0, 100, 360);
    expect(destination).toBeDefined();
    expect(game.sim.fire("srcR")).toBe(true);
    expect(game.coins).toBe(STARTING_COINS + 5);
  });

  it("refunds complete weighted source emissions, but not disconnected tokens", () => {
    const definition = structuredClone(level2);
    definition.net.arcs.find((a) => a.id === "a1")!.count = 2;
    definition.net.places.find((p) => p.id === "pR")!.marking = [];
    const game = new Game(definition);
    expect(game.sim.fire("srcR")).toBe(true);
    game.sim.step(1);
    game.sim.net.places.get("pR")!.marking.push("red", "blue");
    game.remove("pR");
    expect(game.sim.net.transitions.get("srcR")!.supply).toBe(6);
    expect(game.coins).toBe(STARTING_COINS + 2);

    const disconnected = new Game(level2);
    disconnected.sim.fire("srcR");
    disconnected.remove("a1");
    disconnected.remove("pR");
    expect(disconnected.sim.net.transitions.get("srcR")!.supply).toBe(5);
    expect(disconnected.coins).toBe(STARTING_COINS + 1);
  });

  it("protects the first source's output and place, while allowing other arcs to be rewired", () => {
    const game = new Game(endless);
    const version = game.sim.net.version;
    expect(game.remove("starterPlace", false)).toBe(false);
    expect(game.remove("starterPlace")).toBe(false);
    expect(game.sim.net.version).toBe(version);
    expect(game.sim.net.places.get("starterPlace")!.ghost).toBeFalsy();
    expect(game.remove("starterOutput", false)).toBe(false);
    expect(game.remove("starterOutput")).toBe(false);
    expect(game.sim.net.version).toBe(version);
    expect(game.sim.net.arcs.get("starterOutput")!.ghost).toBeFalsy();
    expect(game.remove("starterRelayInput", false)).toBe(true);
    expect(game.remove("starterRelayInput")).toBe(true);
  });

  it("make transitions automatic, then faster, and places larger", () => {
    const game = new Game(level2);
    game.sim.net.addPlace({ id: "funds", x: -1000, y: 0, capacity: 19, marking: Array(19).fill("blue") });
    game.sim.net.addPlace({ id: "funds2", x: -1100, y: 0, capacity: 19, marking: Array(19).fill("blue") });
    expect(game.remove("funds")).toBe(true);
    expect(game.remove("funds2")).toBe(true);
    const t = game.sim.net.transitions.get("tSplit")!;
    expect(game.autoUpgradeLevel("tDrain")).toBe(0);
    expect(game.upgradeAuto("tSplit", false)).toBe(true);
    expect(game.autoUpgradeLevel("tSplit")).toBe(0);
    expect(t.autoInterval).toBeUndefined();
    expect(game.upgradeAuto("tSplit")).toBe(true);
    expect(t.autoInterval).toBe(4);
    expect(game.upgradeAuto("tSplit", false)).toBe(true);
    expect(t.autoInterval).toBe(4);
    expect(game.upgradeAuto("tSplit")).toBe(true);
    expect(t.autoInterval).toBeCloseTo(2.4);
    expect(game.autoUpgradeLevel("tSplit")).toBe(2);
    expect(game.upgradeAuto("srcR")).toBe(false);
    expect(game.upgradeAuto("sinkY")).toBe(false);
    expect(game.upgradeAuto("tDrain")).toBe(true);
    expect(game.sim.net.transitions.get("tDrain")!.autoInterval).toBeCloseTo(1.5);
    while (game.upgradeAuto("tSplit")) {}
    expect(t.autoInterval).toBe(0.6);
    expect(game.upgradeAuto("tSplit", false)).toBe(false);
    expect(game.upgradeAuto("tSplit")).toBe(false);
    expect(game.autoUpgradeLevel("tSplit")).toBe(5);
    expect(game.sim.net.places.get("pB")!.capacity).toBe(1);
    expect(game.upgradeCapacity("pB")).toBe(true);
    expect(game.sim.net.places.get("pB")!.capacity).toBe(7);
    expect(game.upgradeCapacity("pB")).toBe(true);
    expect(game.sim.net.places.get("pB")!.capacity).toBe(19);
    expect(game.upgradeCapacity("pB")).toBe(false);
  });

  it("rejects upgrades that would overlap a node", () => {
    const game = new Game(level2);
    game.sim.net.addTransition({ id: "nearby", x: 365.999, y: 520, kind: "normal" });
    expect(game.upgradeCapacity("pB", false)).toBe(false);
    expect(game.upgradeCapacity("pB")).toBe(false);
    expect(game.sim.net.places.get("pB")!.capacity).toBe(1);
    game.sim.net.transitions.get("nearby")!.x = 366;
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
