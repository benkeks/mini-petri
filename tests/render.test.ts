import { describe, expect, it } from "vitest";
import { Game } from "../src/game/game";
import { endless } from "../src/game/endless";
import { level2 } from "../src/game/level2";
import { POWERUPS } from "../src/game/powerups";
import { Controller, type Brush } from "../src/input/controller";
import { Hud, toolbarLayout } from "../src/render/hud";
import { NetView } from "../src/render/netView";

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
