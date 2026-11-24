import { describe, expect, it, vi } from "vitest";
import { EventBoundary, FederatedPointerEvent, Graphics, Text } from "pixi.js";
import { Game, placementClearance } from "../src/game/game";
import { endless } from "../src/game/endless";
import { level2 } from "../src/game/level2";
import { POWERUPS } from "../src/game/powerups";
import { brushesOf, Controller, type Brush } from "../src/input/controller";
import { Hud, survivalPopupPosition, toolbarLayout } from "../src/render/hud";
import { NetView } from "../src/render/netView";
import { THEME } from "../src/render/style";

function balancePositions(view: NetView, game: Game, id: string, radius: number): number[][] {
  const transition = game.sim.net.transitions.get(id)!;
  const node = view.root.children[5].children.find((node) => node.x === transition.x && node.y === transition.y)!;
  const graphics = node.children[0] as Graphics;
  return graphics.context.instructions.flatMap((instruction) =>
    instruction.action === "fill" ? instruction.data.path.instructions : [])
    .filter((shape) => shape.action === "circle" && shape.data[2] === radius)
    .map((shape) => shape.data.slice(0, 2));
}

describe("endpoint token layouts", () => {
  it("turns a portrait transition vertically for horizontal arcs, including its connector and hit area", () => {
    const game = new Game(level2);
    game.setPortrait(true);
    game.sim.net.addPlace({ id: "left", x: 250, y: 520, capacity: 1, marking: [] });
    game.sim.net.addTransition({ id: "turn", x: 450, y: 520, kind: "normal", open: [{ dir: "in", color: "blue" }] });
    const view = new NetView(game);
    expect(view.pick({ x: 450, y: 463 })).toEqual({ kind: "port", tid: "turn", index: 0 });
    game.sim.net.addArc({ id: "sideways", from: "left", to: "turn", color: "blue" });
    expect(view.pick({ x: 507, y: 520 })).toEqual({ kind: "port", tid: "turn", index: 0 });
    expect(view.pick({ x: 450, y: 545 })).toEqual({ kind: "transition", id: "turn" });
    expect(view.pick({ x: 475, y: 520 }).kind).not.toBe("transition");
    expect(game.remove("sideways")).toBe(true);
    expect(view.pick({ x: 450, y: 463 })).toEqual({ kind: "port", tid: "turn", index: 0 });
    view.root.destroy({ children: true });
  });

  it.each(["source", "sink"])("turns the portrait %s balance to the clear horizontal side", (kind) => {
    const game = new Game(level2);
    game.setPortrait(true);
    const source = kind === "source";
    const id = source ? "srcR2" : "sinkG";
    const t = game.sim.net.transitions.get(id)!;
    const side = source ? -1 : 1;
    game.sim.net.addPlace({ id: "sideways", x: t.x + side * 200, y: t.y, capacity: 7, marking: [] });
    const view = new NetView(game);
    const viewport = { x: 0, y: 0, width: 1400, height: 1400 };
    view.update(0, viewport);
    expect(game.connect(id, 0, "sideways")).toBe(true);
    view.update(0.25, viewport);
    const dots = balancePositions(view, game, id, source ? 3.2 : 7);
    expect(dots.length).toBeGreaterThan(0);
    expect(dots.every(([x]) => Math.sign(x) === -side)).toBe(true);
    expect(view.pick({ x: t.x, y: t.y + 25 })).toEqual({ kind: "transition", id });
    view.root.destroy({ children: true });
  });

  it.each(["source", "sink"].flatMap((kind) => [false, true].map((portrait) => ({ kind, portrait }))))(
    "tweens the $kind balance to the clear side, portrait=$portrait",
    ({ kind, portrait }) => {
      const game = new Game(level2);
      const source = kind === "source";
      const id = source ? "srcR2" : "sinkG";
      const t = game.sim.net.transitions.get(id)!;
      game.sim.net.addPlace({ id: "adjacent", x: t.x + (source ? -200 : 200), y: t.y, capacity: 7, marking: [] });
      game.setPortrait(portrait);
      const view = new NetView(game);
      const viewport = { x: 0, y: 0, width: 1400, height: 1400 };
      const radius = source ? 3.2 : 7;
      const axis = portrait ? 1 : 0;
      view.update(0, viewport);
      const before = balancePositions(view, game, id, radius);
      expect(game.connect(id, 0, "adjacent")).toBe(true);
      view.update(0, viewport);
      expect(balancePositions(view, game, id, radius)).toEqual(before);
      view.update(0.125, viewport);
      const middle = balancePositions(view, game, id, radius);
      expect(middle[0][axis]).not.toBe(before[0][axis]);
      expect(Math.abs(middle[0][axis])).toBeLessThan(Math.abs(before[0][axis]));
      view.update(0.125, viewport);
      expect(balancePositions(view, game, id, radius)).toEqual(before.map(([x, y]) => portrait ? [x, -y] : [-x, y]));
      view.root.destroy({ children: true });
    },
  );

  it.each((["in", "out"] as const).flatMap((dir) => [false, true].map((portrait) => ({ dir, portrait }))))(
    "flips $dir connectors away from incoming arcs and restores them on removal, portrait=$portrait",
    ({ dir, portrait }) => {
      const game = new Game(level2);
      const side = dir === "in" ? -1 : 1;
      game.sim.net.addPlace({ id: "attach", x: 450 + side * 200, y: 520, capacity: 1, marking: [] });
      game.sim.net.addTransition({ id: "flip", x: 450, y: 520, kind: "normal", open: [{ dir, color: "blue" }] });
      game.setPortrait(portrait);
      const view = new NetView(game);
      const plug = (side: number) => portrait ? { x: 520, y: 450 + side * 57 } : { x: 450 + side * 57, y: 520 };
      expect(view.pick(plug(side))).toEqual({ kind: "port", tid: "flip", index: 0 });
      game.sim.net.addArc({ id: "incoming", from: "attach", to: "flip", color: "blue" });
      expect(view.pick(plug(-side))).toEqual({ kind: "port", tid: "flip", index: 0 });
      expect(view.pick(plug(side)).kind).not.toBe("port");
      expect(game.remove("incoming")).toBe(true);
      expect(view.pick(plug(side))).toEqual({ kind: "port", tid: "flip", index: 0 });
      view.root.destroy({ children: true });
    },
  );

  it("rotates the bar and connector when all connected arcs are vertical", () => {
    const game = new Game(level2);
    game.sim.net.addPlace({ id: "above", x: 450, y: 320, capacity: 1, marking: [] });
    game.sim.net.addTransition({ id: "flip", x: 450, y: 520, kind: "normal", open: [{ dir: "in", color: "blue" }] });
    game.sim.net.addArc({ id: "incoming", from: "above", to: "flip", color: "blue" });
    const view = new NetView(game);
    expect(view.pick({ x: 450, y: 577 })).toEqual({ kind: "port", tid: "flip", index: 0 });
    expect(view.pick({ x: 475, y: 520 })).toEqual({ kind: "transition", id: "flip" });
    expect(view.pick({ x: 450, y: 545 }).kind).not.toBe("transition");
    game.sim.net.addArc({ id: "mixed", from: "pB", to: "flip", color: "blue" });
    expect(view.pick({ x: 475, y: 520 }).kind).not.toBe("transition");
    view.root.destroy({ children: true });
  });

  it.each(["source", "sink"].flatMap((kind) => [-1, 1].map((side) => ({ kind, side }))))(
    "places the $kind balance vertically opposite a vertical arc on side $side",
    ({ kind, side }) => {
      const game = new Game(level2);
      const source = kind === "source";
      const id = source ? "srcR2" : "sinkG";
      const t = game.sim.net.transitions.get(id)!;
      game.sim.net.addPlace({ id: "vertical", x: t.x, y: t.y + side * 200, capacity: 7, marking: [] });
      const view = new NetView(game);
      const viewport = { x: 0, y: 0, width: 1400, height: 1400 };
      view.update(0, viewport);
      expect(game.connect(id, 0, "vertical")).toBe(true);
      view.update(0.25, viewport);
      const dots = balancePositions(view, game, id, source ? 3.2 : 7);
      expect(dots.length).toBeGreaterThan(0);
      expect(dots.every(([, y]) => Math.sign(y) === -side)).toBe(true);
      expect(view.pick({ x: t.x + 25, y: t.y })).toEqual({ kind: "transition", id });
      view.root.destroy({ children: true });
    },
  );
  it.each([5, 10, 15].flatMap((count) => [false, true].map((portrait) => ({ count, portrait }))))(
    "matches source and sink circle positions for $count tokens, portrait=$portrait",
    ({ count, portrait }) => {
      const definition = structuredClone(endless);
      const source = definition.net.transitions.find((t) => t.id === "starterSource")!;
      source.supply = count;
      source.autoInterval = undefined;
      definition.net.transitions.find((t) => t.id === "starterSink")!.autoInterval = undefined;
      definition.goals[0].count = count;
      const game = new Game(definition);
      game.setPortrait(portrait);
      const view = new NetView(game);
      const viewport = { x: 0, y: 0, width: 1200, height: 1200 };
      const positions = (id: string, radius: number) => balancePositions(view, game, id, radius);
      const expectMatching = (remaining: number) => {
        const supply = positions("starterSource", 3.2);
        const demand = positions("starterSink", 7);
        expect(supply).toHaveLength(remaining);
        expect(demand).toEqual(supply.map(([x, y]) => portrait ? [x, -y] : [-x, y]));
      };
      view.update(0, viewport);
      expectMatching(count);
      game.sim.net.places.get("starterDestination")!.marking.push("blue");
      expect(game.sim.fire("starterSource")).toBe(true);
      expect(game.sim.fire("starterSink")).toBe(true);
      game.sim.step(2);
      view.update(0, viewport);
      const beforeSupply = positions("starterSource", 3.2);
      const beforeDemand = positions("starterSink", 7);
      view.update(0.125, viewport);
      expect(positions("starterSource", 3.2)).not.toEqual(beforeSupply);
      expect(positions("starterSink", 7)).not.toEqual(beforeDemand);
      view.update(0.125, viewport);
      expectMatching(count - 1);
      view.root.destroy({ children: true });
    },
  );
});

describe("survival popup placement", () => {
  it("places the card clear of a centered sink, keeping its appearance overshoot on screen", () => {
    const sink = { x: 600, y: 400, radius: 50 };
    const position = survivalPopupPosition(1200, 800, [sink]);
    expect(position.y + 90 * 1.14 + 4).toBeLessThanOrEqual(sink.y - sink.radius);
    expect(position.x - 170 * 1.14).toBeGreaterThanOrEqual(12);
    expect(position.y - 90 * 1.14 - 4).toBeGreaterThanOrEqual(12);
  });

  it("avoids the sink's current position and the camera destination without moving an already safe card", () => {
    const avoid = [{ x: 600, y: 220, radius: 50 }, { x: 600, y: 400, radius: 50 }];
    const position = survivalPopupPosition(1200, 800, avoid);
    expect(position.y - 90 * 1.14 - 4).toBeGreaterThanOrEqual(450);
    const previous = { x: 850, y: 400 };
    expect(survivalPopupPosition(1200, 800, avoid, previous)).toEqual(previous);
  });

  it("uses horizontal space on a short screen and scales down on a narrow one", () => {
    const wide = survivalPopupPosition(1000, 240, [{ x: 500, y: 120, radius: 40 }]);
    expect(wide.x + 170 * 1.14).toBeLessThanOrEqual(460);
    const narrow = survivalPopupPosition(320, 640, [{ x: 160, y: 320, radius: 50 }]);
    expect(narrow.x).toBe(160);
    expect(narrow.y).toBeLessThanOrEqual(320 - 50 - 90 * ((320 - 24) / 340) - 4);
  });

  it("keeps the centered fallback when there is no clearance and recenters after resize", () => {
    expect(survivalPopupPosition(200, 160, [{ x: 100, y: 80, radius: 60 }])).toEqual({ x: 100, y: 80 });
    expect(survivalPopupPosition(320, 640, [], { x: 850, y: 400 })).toEqual({ x: 160, y: 320 });
  });
});

describe("toolbar layout", () => {
  const brushes = (count: number): Brush[] => [
    ...Array.from({ length: count - 1 }, (): Brush => ({ kind: "fire" })),
    { kind: "remove" },
  ];

  it("keeps removal close to the other tools with an extra gap", () => {
    const layout = toolbarLayout(390, brushes(5));
    expect(layout.rows).toBe(1);
    const positions = layout.positions;
    expect(positions[4].x - positions[3].x - layout.size).toBe(16);
    expect(positions[3].x - positions[2].x - layout.size).toBe(8);
    expect(positions[0].x + positions[4].x).toBe(390);
  });

  describe("restart confirmation", () => {
    it("provides a fullscreen toggle when requested and updates its enter/exit label", () => {
      const game = new Game(endless);
      const view = new NetView(game);
      const controller = new Controller(game, view);
      let toggles = 0;
      const hud = new Hud(game, controller, {
        toggleFullscreen: () => { toggles++; },
        restart: () => {},
        requestRestart: () => {},
        togglePause: () => {},
        selectBrush: () => {},
        focusSink: () => {},
      });
      const button = hud.root.children.find((child) => child.label === "meta-fullscreen");
      if (!(button instanceof Text)) throw new Error("Fullscreen control missing");
      const event = new FederatedPointerEvent(new EventBoundary(hud.root));
      button.emit("pointertap", event);
      expect(toggles).toBe(1);
      hud.setFullscreenActive(true);
      expect(button.text).toBe("EXIT FULLSCREEN");
      button.emit("pointertap", event);
      expect(toggles).toBe(2);
      hud.setFullscreenActive(false);
      expect(button.text).toBe("FULLSCREEN");
      hud.root.destroy({ children: true });
      view.root.destroy({ children: true });
    });

    it("confirms endless skipping, preserves pause on cancellation and does not restart", () => {
      const game = new Game(endless, Math.random, { survival: true });
      const view = new NetView(game);
      const controller = new Controller(game, view);
      let restarts = 0;
      const hud = new Hud(game, controller, {
        restart: () => { restarts++; },
        requestRestart: () => hud.showRestartConfirmation(),
        togglePause: () => { game.paused = !game.paused; },
        selectBrush: (brush) => controller.setBrush(brush),
        focusSink: () => {},
      });
      expect(brushesOf(game).some((brush) => brush.kind === "life")).toBe(false);
      game.paused = true;
      hud.showEndlessConfirmation();
      hud.cancelRestart();
      expect(game.paused).toBe(true);
      expect(game.survival).toBe(true);
      hud.showEndlessConfirmation();
      hud.confirmRestart();
      expect(game.paused).toBe(false);
      expect(game.survival).toBe(false);
      expect(hud.confirming).toBe(false);
      expect(restarts).toBe(0);
      expect(brushesOf(game).some((brush) => brush.kind === "life")).toBe(false);
      hud.root.destroy({ children: true });
      view.root.destroy({ children: true });
    });

    it("pauses while open, preserves the prior pause state on cancel, and restarts only on confirmation", () => {
      const game = new Game(endless);
      const view = new NetView(game);
      const controller = new Controller(game, view);
      let restarts = 0;
      const hud = new Hud(game, controller, {
        restart: () => { restarts++; },
        requestRestart: () => {},
        togglePause: () => { game.paused = !game.paused; },
        selectBrush: (brush) => controller.setBrush(brush),
        focusSink: () => {},
      });

      hud.showRestartConfirmation();
      expect(hud.confirming).toBe(true);
      expect(game.paused).toBe(true);
      game.step(5);
      expect(game.sim.time).toBe(0);
      hud.showRestartConfirmation();
      hud.cancelRestart();
      expect(hud.confirming).toBe(false);
      expect(game.paused).toBe(false);
      expect(restarts).toBe(0);

      game.paused = true;
      hud.showRestartConfirmation();
      hud.cancelRestart();
      expect(game.paused).toBe(true);
      hud.showRestartConfirmation();
      hud.confirmRestart();
      expect(hud.confirming).toBe(false);
      expect(restarts).toBe(1);
      hud.confirmRestart();
      expect(restarts).toBe(1);
      hud.root.destroy({ children: true });
      view.root.destroy({ children: true });
    });
  });

  it("wraps tools in order without leaving removal alone when it fits with a neighbor", () => {
    const layout = toolbarLayout(320, brushes(6));
    expect(layout.positions.map((position) => position.row)).toEqual([0, 0, 0, 0, 1, 1]);
    expect(layout.positions[5].x - layout.positions[4].x - layout.size).toBe(16);
    for (const position of layout.positions) {
      expect(position.x - layout.size / 2).toBeGreaterThanOrEqual(8);
      expect(position.x + layout.size / 2).toBeLessThanOrEqual(312);
    }
  });
});

describe("build area", () => {
  it("updates connection rings and reachable targets from either selected endpoint after capacity upgrades", () => {
    const definition = structuredClone(level2);
    for (const place of definition.net.places) {
      place.capacity = 1;
      place.marking = [];
    }
    const game = new Game(definition);
    game.sim.net.addPlace({ id: "reach", x: 1600, y: 1000, capacity: 1, marking: [] });
    game.sim.net.addTransition({ id: "target", x: 1940, y: 1000, kind: "normal", open: [{ dir: "in", color: "blue" }] });
    const view = new NetView(game);
    const controller = new Controller(game, view);
    const overlay = view.root.children[8] as Graphics;
    const circles = () => overlay.context.instructions.flatMap((instruction) =>
      instruction.action === "stroke" ? instruction.data.path.instructions : [])
      .filter((instruction) => instruction.action === "circle")
      .map((instruction) => instruction.data.slice(0, 3));
    for (const radius of [300, 360, 420]) {
      controller.selected = undefined;
      controller.selectedPlace = "reach";
      controller.sync();
      view.update(0, { x: 0, y: 0, width: 2400, height: 1600 });
      expect(circles()).toContainEqual([1600, 1000, radius]);
      expect(view.overlay.target?.({ kind: "port", tid: "target", index: 0 })).toBe(radius > 300);
      controller.selectedPlace = undefined;
      controller.selected = { tid: "target", index: 0 };
      controller.sync();
      view.update(0, { x: 0, y: 0, width: 2400, height: 1600 });
      expect(circles()).toContainEqual([1940, 1000, 300]);
      expect(view.overlay.target?.({ kind: "place", id: "reach" })).toBe(radius > 300);
      const highlightedPlace = overlay.context.instructions.some((instruction) =>
        instruction.action === "stroke" && instruction.data.style.color === THEME.enabledGlow
        && instruction.data.path.instructions.some((shape) =>
          shape.action === "circle" && shape.data[0] === 1600 && shape.data[1] === 1000));
      expect(highlightedPlace).toBe(radius > 300);
      if (radius < 420) expect(game.upgradeCapacity("reach")).toBe(true);
    }
    view.root.destroy({ children: true });
  });

  it("refreshes the build-range mask to match successive place upgrades", () => {
    const game = new Game(level2);
    game.sim.net.addPlace({ id: "range", x: 1600, y: 1000, capacity: 1, marking: [] });
    const view = new NetView(game);
    view.overlay = { build: { kind: "transition" } };
    const viewport = { x: 0, y: 0, width: 2400, height: 1400 };
    const mask = view.root.children[0].children[2] as Graphics;
    for (const range of [220, 264, 308]) {
      view.update(0.25, viewport);
      const circles = mask.context.instructions.flatMap((instruction) =>
        instruction.action === "fill" ? instruction.data.path.instructions : [])
        .filter((instruction) => instruction.action === "circle")
        .map((instruction) => instruction.data.slice(0, 3));
      expect(circles).toContainEqual([1600, 1000, range]);
      expect(circles).toContainEqual([1000, 520, 220]);
      if (range < 308) expect(game.upgradeCapacity("range")).toBe(true);
    }
    view.root.destroy({ children: true });
  });

  it("greys out placement clearance for the selected kind, including ghost nodes during fade-out", () => {
    const game = new Game(level2);
    const view = new NetView(game);
    const viewport = { x: -300, y: -300, width: 1800, height: 1400 };
    const collision = view.root.children[0].children[3] as Graphics;
    const circles = () => collision.context.instructions.flatMap((instruction) =>
      instruction.action === "fill" ? instruction.data.path.instructions : [])
      .filter((instruction) => instruction.action === "circle")
      .map((instruction) => instruction.data.slice(0, 3));

    view.overlay = { build: { kind: "place" } };
    view.update(0.25, viewport);
    expect(circles()).toContainEqual([280, 520, placementClearance("place", "place")]);
    expect(circles()).toContainEqual([1000, 520, placementClearance("place", "transition")]);
    expect(game.placementIssue("place", 391.99, 520)).toBe("crowded");
    expect(game.placementIssue("place", 392, 520)).toBeUndefined();

    view.overlay = { build: { kind: "transition" } };
    view.update(0, viewport);
    expect(circles()).toContainEqual([280, 520, placementClearance("transition", "place")]);
    expect(circles()).toContainEqual([1000, 520, placementClearance("transition", "transition")]);
    expect(game.placementIssue("transition", 379.99, 520)).toBe("crowded");
    expect(game.placementIssue("transition", 380, 520)).toBeUndefined();
    expect(game.remove("pB")).toBe(true);
    view.overlay = {};
    view.update(0.1, viewport);
    expect(circles()).toContainEqual([280, 520, placementClearance("transition", "place")]);
    view.root.destroy({ children: true });
  });

  it("dims a plug when its transition center is out of range, even if the plug itself is in range", () => {
    const game = new Game(level2);
    game.sim.net.addTransition({ id: "far", x: 590, y: 520, kind: "normal", open: [{ dir: "in" }] });
    const view = new NetView(game);
    const controller = new Controller(game, view);
    const viewport = { x: -300, y: -300, width: 1800, height: 1400 };
    controller.tap({ x: 280, y: 520 });
    const plug = { x: 533, y: 520 };
    controller.move(plug);
    controller.sync();
    expect(view.pick(plug)).toEqual({ kind: "port", tid: "far", index: 0 });
    expect(controller.interactive(view.pick(plug))).toBe(false);
    view.update(0.25, viewport);
    const overlay = view.root.children[8] as Graphics;
    const mutedPlug = overlay.context.instructions.find((instruction) =>
      instruction.action === "stroke" && instruction.data.style.color === THEME.muted
      && instruction.data.path.instructions.some((shape) =>
        shape.action === "circle" && shape.data[0] === plug.x && shape.data[1] === plug.y));
    expect(mutedPlug).toBeDefined();
    view.root.destroy({ children: true });
  });

  it.each([false, true])("shows only applied transition upgrades in %s portrait mode", (portrait) => {
    const game = new Game(level2);
    game.setPortrait(portrait);
    const view = new NetView(game);
    const viewport = { x: -300, y: -300, width: 1800, height: 1400 };
    view.update(0, viewport);
    const transition = game.sim.net.transitions.get("tSplit")!;
    const node = view.root.children[5].children.find((child) => child.x === transition.x && child.y === transition.y)!;
    const graphics = node.children[0] as Graphics;
    const bars = () => graphics.context.instructions.flatMap((instruction) =>
      instruction.action === "fill" && instruction.data.style.color === 0xffffff
        ? instruction.data.path.instructions.filter((shape) => shape.action === "roundRect")
        : []);
    expect(bars()).toHaveLength(0);
    expect(game.upgradeAuto("tSplit", false)).toBe(true);
    expect(game.upgradeAuto("tSplit")).toBe(true);
    expect(game.upgradeAuto("tSplit")).toBe(true);
    view.update(0, viewport);
    expect(bars()).toHaveLength(2);
    for (const bar of bars()) {
      expect(portrait ? bar.data[2] : bar.data[3]).toBe(3);
      expect(portrait ? bar.data[3] : bar.data[2]).toBe(12);
    }
    view.root.destroy({ children: true });
  });

  it("picks newly connected arcs before the next render", () => {
    const game = new Game(level2);
    const view = new NetView(game);
    view.update(0, { x: 0, y: 0, width: 1200, height: 800 });
    game.sim.net.addPlace({ id: "newPlace", x: 3000, y: 3000, marking: [] });
    game.sim.net.addTransition({ id: "newTransition", x: 3200, y: 3000, kind: "normal" });
    game.sim.net.addArc({ id: "newArc", from: "newPlace", to: "newTransition" });
    expect(view.pick({ x: 3100, y: 3000 })).toEqual({ kind: "arc", id: "newArc" });
    view.root.destroy({ children: true });
  });

  it("fades in and out over 250 ms, including when reversed partway", () => {
    const game = new Game(level2);
    const view = new NetView(game);
    const viewport = { x: -300, y: -300, width: 1800, height: 1400 };
    const background = view.root.children[0];
    view.overlay = { build: { kind: "place" } };
    view.update(0.125, viewport);
    expect(background.visible).toBe(true);
    expect(background.alpha).toBeCloseTo(0.5);
    view.update(0.125, viewport);
    expect(background.alpha).toBe(1);
    view.overlay = {};
    view.update(0.125, viewport);
    expect(background.alpha).toBeCloseTo(0.5);
    view.overlay = { build: { kind: "transition" } };
    view.update(0.125, viewport);
    expect(background.alpha).toBe(1);
    game.complete = true;
    view.update(0.25, viewport);
    expect(background.visible).toBe(false);
    view.root.destroy({ children: true });
  });

  describe("endless lifecycle animations", () => {
    const viewport = { x: -300, y: -300, width: 1800, height: 1400 };

    it.each([
      { id: "srcB", color: THEME.ink },
      { id: "sinkG", color: THEME.warn },
    ])("draws the $id expiry countdown in the appropriate color", ({ id, color }) => {
      const game = new Game(level2);
      const countdown = vi.spyOn(game, "countdownProgress").mockImplementation((tid) => tid === id ? 0.5 : undefined);
      const view = new NetView(game);
      try {
        view.update(0, viewport);
        const transition = game.sim.net.transitions.get(id)!;
        const node = view.root.children[5].children.find((child) => child.x === transition.x && child.y === transition.y)!;
        const graphics = node.children[0] as Graphics;
        const rings = graphics.context.instructions.filter((instruction) =>
          instruction.action === "stroke" && instruction.data.path.instructions.some((shape) => shape.action === "arc"));
        expect(rings).toHaveLength(1);
        const ring = rings[0];
        expect(ring.action).toBe("stroke");
        if (ring.action === "stroke") expect(ring.data.style.color).toBe(color);
      } finally {
        countdown.mockRestore();
        view.root.destroy({ children: true });
      }
    });

    it("animates spawned sinks in and failed sinks out", () => {
      const game = new Game(endless, () => 0.9);
      game.sim.net.transitions.get("starterSource")!.autoInterval = undefined;
      const view = new NetView(game);
      view.update(0, viewport);
      for (let i = 0; i < 6; i++) expect(game.sim.fire("starterSource")).toBe(true);
      game.step(0);
      const sink = game.sim.net.transitions.get(game.goals().at(-1)!.sinkId)!;
      view.update(0, viewport);
      const layer = view.root.children[5];
      const node = layer.children.find((child) => child.x === sink.x && child.y === sink.y)!;
      expect(node.alpha).toBe(0);
      game.step(0.2);
      view.update(0.2, viewport);
      expect(node.alpha).toBeCloseTo(0.5);
      game.step(0.2);
      view.update(0.2, viewport);
      expect(node.alpha).toBeCloseTo(1);
      game.failed.set(sink.id, game.sim.time);
      game.step(1);
      view.update(1, viewport);
      expect(node.alpha).toBeGreaterThan(0);
      expect(node.alpha).toBeLessThan(1);
      expect(node.scale.x).toBeLessThan(1);
      game.step(0.3);
      view.update(0.3, viewport);
      expect(game.sim.net.transitions.has(sink.id)).toBe(false);
      view.root.destroy({ children: true });
    });

    it("animates spawned sources in and exhausted sources out", () => {
      const game = new Game(endless, () => 0.9);
      game.sim.net.transitions.get("starterSource")!.autoInterval = undefined;
      for (let epoch = 0; epoch < 6; epoch++) {
        game.sim.net.places.get("starterPlace")!.marking = [];
        for (let i = 0; i < 6; i++) expect(game.sim.fire("starterSource")).toBe(true);
        game.step(0);
        if (epoch < 5) game.sim.step(1);
      }
      const source = [...game.sim.net.transitions.values()].find((transition) =>
        transition.kind === "source" && transition.id !== "starterSource")!;
      const view = new NetView(game);
      view.update(0, viewport);
      const layer = view.root.children[5];
      const node = layer.children.find((child) => child.x === source.x && child.y === source.y)!;
      expect(node.alpha).toBe(0);
      game.step(0.4);
      view.update(0.4, viewport);
      expect(node.alpha).toBeCloseTo(1);
      game.exhausted.set(source.id, game.sim.time);
      game.step(1);
      view.update(1, viewport);
      expect(node.alpha).toBeGreaterThan(0);
      expect(node.alpha).toBeLessThan(1);
      expect(node.scale.x).toBeLessThan(1);
      view.root.destroy({ children: true });
    });

    it("fades rewards in and out without keeping a collected reward selectable", () => {
      const game = new Game(endless);
      game.sim.net.transitions.get("starterSource")!.autoInterval = undefined;
      const view = new NetView(game);
      game.offers.set("offer", { id: "offer", x: 100, y: 100, expiresAt: 120, choices: [POWERUPS[0], POWERUPS[1]] });
      game.offerVersion++;
      view.update(0, viewport);
      const layer = view.root.children.at(-1)!;
      const reward = layer.children[0];
      expect(reward.alpha).toBe(0);
      game.step(0.2);
      view.update(0.2, viewport);
      expect(reward.alpha).toBeCloseTo(0.5);
      game.step(0.2);
      view.update(0.2, viewport);
      expect(reward.alpha).toBeCloseTo(1);
      expect(game.collectOffer("offer", 0)).toBe(true);
      view.update(0, viewport);
      expect(view.pick({ x: 72, y: 100 }).kind).not.toBe("reward");
      game.step(0.15);
      view.update(0.15, viewport);
      expect(reward.alpha).toBeCloseTo(0.5);
      game.step(0.16);
      view.update(0.16, viewport);
      expect(layer.children).toHaveLength(0);
      view.root.destroy({ children: true });
    });

    it("highlights the selected reward and moves it toward its toolbar target", () => {
      const game = new Game(endless);
      game.sim.net.transitions.get("starterSource")!.autoInterval = undefined;
      const view = new NetView(game);
      const controller = new Controller(game, view);
      view.rewardTarget = () => ({ x: 300, y: 400 });
      game.offers.set("offer", { id: "offer", x: 100, y: 100, expiresAt: 120, choices: [POWERUPS[0], POWERUPS[1]] });
      game.offerVersion++;
      view.update(0, viewport);
      game.step(0.4);
      view.update(0.4, viewport);
      const layer = view.root.children.at(-1)!;
      const reward = layer.children[0];
      const other = reward.children[0];
      const selected = reward.children[1];
      controller.tap({ x: 128, y: 100 });
      expect(game.powerupStock("capacity")).toBe(1);
      view.update(0, viewport);
      expect(selected.x).toBe(28);
      expect(selected.alpha).toBe(1);
      game.step(0.4);
      view.update(0.4, viewport);
      expect(other.alpha).toBe(0);
      expect(selected.x).toBeGreaterThan(28);
      expect(selected.y).toBeGreaterThan(0);
      expect(selected.alpha).toBeGreaterThan(0);
      game.step(0.36);
      view.update(0.36, viewport);
      expect(layer.children).toHaveLength(0);
      view.root.destroy({ children: true });
    });

    it("animates expired rewards out after they stop being collectible", () => {
      const game = new Game(endless);
      game.sim.net.transitions.get("starterSource")!.autoInterval = undefined;
      const view = new NetView(game);
      game.offers.set("offer", { id: "offer", x: 100, y: 100, expiresAt: 120, choices: [POWERUPS[0], POWERUPS[1]] });
      game.offerVersion++;
      game.sim.step(119.9);
      view.update(0, viewport);
      const layer = view.root.children.at(-1)!;
      game.step(0.11);
      view.update(0.11, viewport);
      expect(game.offers.has("offer")).toBe(false);
      expect(layer.children).toHaveLength(1);
      expect(view.pick({ x: 72, y: 100 }).kind).not.toBe("reward");
      game.step(0.31);
      view.update(0.31, viewport);
      expect(layer.children).toHaveLength(0);
      view.root.destroy({ children: true });
    });
  });
});
