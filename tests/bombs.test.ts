import { afterEach, describe, expect, it, vi } from "vitest";
import { endless } from "../src/game/endless";
import { BOMB_COUNTDOWN, CATASTROPHE_COUNTDOWN, EXPLOSION_TIME, Game } from "../src/game/game";
import { POWERUPS } from "../src/game/powerups";
import { brushesOf, Controller } from "../src/input/controller";
import type { Overlay, Pick } from "../src/render/netView";

function setup(infinite = false) {
  const level = structuredClone(endless);
  for (const transition of level.net.transitions) transition.autoInterval = undefined;
  if (infinite) level.goals[0].count = Infinity;
  const game = new Game(level, () => 0, { survival: true });
  game["inventory"].set("bomb", 3);
  return game;
}

afterEach(() => vi.restoreAllMocks());

describe("bombs", () => {
  it.each([499, 500])("only offers bombs from epoch 500 (epoch %i)", (epoch) => {
    const level = structuredClone(endless);
    let roll = 0;
    const offers = new Game(level, () => roll);
    offers["endlessEpoch"] = epoch;
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      roll = i / 100;
      offers["spawnOffer"]({ x: 0, y: 0 }, 0);
      for (const choice of [...offers.offers.values()].at(-1)!.choices) seen.add(choice.id);
    }
    expect(seen.has("bomb")).toBe(epoch === 500);
  });

  it("collects stocked bombs, places over a node, charges once and resets the brush", () => {
    const game = setup();
    game["inventory"].delete("bomb");
    const bomb = POWERUPS.find((item) => item.kind === "bomb")!;
    game.offers.set("reward", { id: "reward", x: 0, y: 0, expiresAt: 120, choices: [bomb, POWERUPS[0]] });
    expect(game.collectOffer("reward", 0)).toBe(true);
    expect(brushesOf(game)).toContainEqual({ kind: "bomb" });
    const view = {
      overlay: {} as Overlay,
      pick: (): Pick => ({ kind: "place", id: "starterDestination" }),
      deny: vi.fn(),
    };
    const controller = new Controller(game, view);
    controller.setBrush({ kind: "bomb" });
    controller.press({ x: 800, y: 400 });
    controller.sync();
    expect(view.overlay.bombPreview).toBe(true);
    controller.release({ x: 800, y: 400 });
    expect(view.deny).not.toHaveBeenCalled();
    expect(game.bombs.size).toBe(1);
    expect(game.coins).toBe(15);
    expect(game.powerupStock("bomb")).toBe(0);
    expect(controller.brush.kind).toBe("fire");
  });

  it("does not consume stock when unaffordable or paused and emits coin feedback", () => {
    const game = setup();
    game["coinBalance"] = 24;
    const denied = vi.fn();
    game.onInsufficientCoins(denied);
    expect(game.placeBomb(800, 400)).toBeUndefined();
    expect(denied).toHaveBeenCalledOnce();
    expect(game.powerupStock("bomb")).toBe(3);
    game["coinBalance"] = 40;
    game.paused = true;
    expect(game.placeBomb(800, 400)).toBeUndefined();
    expect(game.bombs.size).toBe(0);
    game.paused = false;
    expect(game.placeBomb(800, 400)).toBeDefined();
    expect(game.canPlaceBomb(800, 400)).toBe(false);
  });

  it("explodes at exactly three seconds, losing nodes and tokens without rewards or life loss", () => {
    const game = setup(true);
    const net = game.sim.net;
    net.addTransition({ id: "extraSource", x: 800, y: 350, kind: "source", supply: 10 });
    net.addArc({ id: "extraOutput", from: "extraSource", to: "starterDestination", color: "red" });
    net.places.get("starterDestination")!.marking = ["blue", "red"];
    const id = game.placeBomb(800, 400)!;
    expect(game.bombs.get(id)!.deadline).toBe(BOMB_COUNTDOWN);
    game.step(2.9);
    expect(net.places.has("starterDestination")).toBe(true);
    expect(game.sim.fire("extraSource")).toBe(true);
    game.step(0.1);
    expect(game.bombs.size).toBe(0);
    expect(net.places.has("starterDestination")).toBe(false);
    expect(net.transitions.has("starterRelay")).toBe(false);
    expect(net.transitions.has("starterSink")).toBe(false);
    expect(net.transitions.has("extraSource")).toBe(false);
    expect(game.sim.inFlight).toEqual([]);
    expect(game.goals()).toEqual([]);
    expect(game.offers.size).toBe(0);
    expect(game.coins).toBe(15);
    expect(game.lives).toBe(10);
    expect(game.score).toBe(0);
    expect(game.statistics.sinkDeaths).toHaveLength(1);
    expect(game.explosions).toHaveLength(1);
    const restored = new Game(game.level, () => 0, { snapshot: JSON.parse(JSON.stringify(game.snapshot())) });
    expect(restored.sim.liveTokens()).toEqual({});
    game.step(EXPLOSION_TIME);
    expect(game.explosions).toEqual([]);
  });

  it("protects the starting source, place, original arc and their tokens on the blast boundary", () => {
    const game = setup();
    game.sim.net.places.get("starterPlace")!.marking.push("blue");
    game.placeBomb(400, 400);
    game.step(3);
    expect(game.sim.net.transitions.has("starterSource")).toBe(true);
    expect(game.sim.net.places.get("starterPlace")!.marking).toEqual(["blue"]);
    expect(game.sim.net.arcs.has("starterOutput")).toBe(true);
    expect(game.sim.net.transitions.has("starterRelay")).toBe(false);
  });

  it("cancels travelling sink inputs and allows the surviving sink to be rewired", () => {
    const game = setup();
    const net = game.sim.net;
    net.transitions.get("starterSink")!.x = 1400;
    game.placeBomb(800, 400);
    game.step(2.9);
    net.places.get("starterDestination")!.marking = Array(5).fill("blue");
    for (let i = 0; i < 5; i++) expect(game.sim.fire("starterSink")).toBe(true);
    expect(net.transitions.get("starterSink")!.disabled).toBe(true);
    game.step(0.1);
    expect(game.sim.inFlight).toEqual([]);
    expect(net.transitions.get("starterSink")!.disabled).toBe(false);
    expect(net.transitions.get("starterSink")!.open).toEqual([{ dir: "in", color: "blue", count: 1 }]);
    expect(game["reserved"].get("starterSink:blue")).toBe(0);
    net.addPlace({ id: "replacement", x: 1200, y: 400, capacity: 7, marking: ["blue"] });
    expect(game.connect("starterSink", 0, "replacement")).toBe(true);
    expect(game.sim.fire("starterSink")).toBe(true);
    game.step(1);
    expect(game.score).toBe(1);
    expect(() => new Game(game.level, () => 0, { snapshot: JSON.parse(JSON.stringify(game.snapshot())) })).not.toThrow();
  });

  it("keeps delivery slots correct when an earlier ghost-arc firing is destroyed after a later delivery", () => {
    const game = setup();
    const net = game.sim.net;
    net.transitions.get("starterSink")!.x = 1400;
    game.placeBomb(800, 400);
    game.step(2.9);
    net.places.get("starterDestination")!.marking.push("blue");
    expect(game.sim.fire("starterSink")).toBe(true);
    net.ghostArc("starterInput");
    net.addPlace({ id: "replacement", x: 1200, y: 400, capacity: 7, marking: ["blue", "blue"] });
    expect(game.connect("starterSink", 0, "replacement")).toBe(true);
    expect(game.sim.fire("starterSink")).toBe(true);
    game.sim.step(1);
    expect(game.score).toBe(1);
    game.step(0.01);
    expect(game.sim.fire("starterSink")).toBe(true);
    game.step(1);
    const goal = game.goalsFor("starterSink")[0];
    expect(goal.delivered).toBe(2);
    expect(game.remainingGoalOrdinals(goal)).toHaveLength(3);
  });

  it("releases outputs reserved by a firing whose destination is destroyed", () => {
    const game = setup();
    const net = game.sim.net;
    net.transitions.get("starterRelay")!.x = 500;
    net.places.get("starterPlace")!.marking.push("blue");
    game.placeBomb(900, 400);
    game.step(2.9);
    expect(game.sim.fire("starterRelay")).toBe(true);
    expect(game.sim.incoming("starterDestination")).toEqual({ blue: 1 });
    game.step(0.1);
    expect(net.transitions.has("starterRelay")).toBe(true);
    expect(game.sim.isBusy("starterRelay")).toBe(false);
    expect(game.sim.inFlight).toEqual([]);
    expect(net.transitions.get("starterRelay")!.open).toEqual([{ dir: "out", count: 1, color: undefined }]);
    expect(() => new Game(game.level, () => 0, { snapshot: JSON.parse(JSON.stringify(game.snapshot())) })).not.toThrow();
  });

  it("severs crossing arcs and loses their flights while retaining nodes outside the blast", () => {
    const game = setup();
    const net = game.sim.net;
    net.addTransition({ id: "crossingSource", x: 400, y: 600, kind: "source", supply: 10 });
    net.addPlace({ id: "crossingPlace", x: 1200, y: 600, capacity: 7, marking: [] });
    net.addArc({ id: "crossingArc", from: "crossingSource", to: "crossingPlace", color: "red" });
    game.placeBomb(800, 600);
    game.step(2.9);
    expect(game.sim.fire("crossingSource")).toBe(true);
    game.step(0.1);
    expect(net.transitions.has("crossingSource")).toBe(true);
    expect(net.places.has("crossingPlace")).toBe(true);
    expect(net.arcs.has("crossingArc")).toBe(false);
    expect(game.sim.incoming("crossingPlace")).toEqual({});
    expect(game.sim.inFlight).toEqual([]);
    expect(net.transitions.get("crossingSource")!.open).toEqual([{ dir: "out", color: "red", count: 1 }]);
  });

  it("persists fuses, transposes bombs and freezes countdowns while paused", () => {
    const game = setup();
    const id = game.placeBomb(800, 300)!;
    const catastrophe = game["armBomb"]({ x: 500, y: 600 }, true);
    game.step(1);
    const restored = new Game(game.level, () => 0, { snapshot: JSON.parse(JSON.stringify(game.snapshot())) });
    restored.setPortrait(true);
    expect(restored.bombs.get(id)).toMatchObject({ x: 300, y: 800, deadline: 3 });
    expect(restored.bombs.get(catastrophe)).toMatchObject({ x: 600, y: 500, deadline: 120 });
    restored.paused = true;
    restored.step(20);
    expect(restored.sim.time).toBeCloseTo(1);
    restored.paused = false;
    restored.step(2);
    expect(restored.bombs.has(id)).toBe(false);
    expect(restored.bombs.has(catastrophe)).toBe(true);
    expect(restored.explosions[0]).toMatchObject({ x: 300, y: 800 });
  });

  it("accepts pre-bomb saves and rejects invalid saved countdowns", () => {
    const game = setup();
    const legacy = JSON.parse(JSON.stringify(game.snapshot()));
    for (const field of ["bombs", "nextBombId", "pendingCatastrophes", "nextCatastropheRetryAt"]) delete legacy[field];
    expect(new Game(game.level, () => 0, { snapshot: legacy }).bombs.size).toBe(0);
    game.placeBomb(800, 400);
    const broken = game.snapshot();
    broken.bombs[0].deadline = -1;
    expect(() => new Game(game.level, () => 0, { snapshot: broken })).toThrow("Invalid saved bomb");
  });
});

describe("catastrophes", () => {
  it.each([1099, 1100, 1101, 1200])("spawns only on hundredth epochs from 1100 (%i)", (epoch) => {
    const game = setup(true);
    game["endlessEpoch"] = epoch - 1;
    game["endlessProgress"] = 60;
    game.step(0);
    expect(game.epoch).toBe(epoch);
    const expected = epoch >= 1100 && epoch % 100 === 0;
    expect(game.bombs.size).toBe(expected ? 1 : 0);
    if (!expected) return;
    const bomb = [...game.bombs.values()][0];
    expect(bomb.deadline - bomb.placedAt).toBe(CATASTROPHE_COUNTDOWN);
    expect(bomb.catastrophe).toBe(true);
    expect([...game.sim.net.places.values()].some((place) => !place.ghost && place.id !== "starterPlace"
      && Math.hypot(place.x - bomb.x, place.y - bomb.y) <= game.bombRadius)).toBe(true);
    expect(Math.hypot(1000 - bomb.x, 400 - bomb.y)).toBeGreaterThan(game.bombRadius);
    game.step(0);
    expect(game.bombs.size).toBe(1);
  });

  it("cannot be deleted or destroyed by a player bomb, and preserves infinite sinks", () => {
    const game = setup();
    game.placeBomb(800, 400);
    const id = game["armBomb"]({ x: 810, y: 400 }, true);
    expect(game.remove(id, false)).toBe(false);
    expect(game.remove(id)).toBe(false);
    game.step(3);
    expect(game.bombs.has(id)).toBe(true);
    game.sim.net.addTransition({ id: "infinite", x: 900, y: 400, kind: "sink" });
    game["goalDefinitions"].push({ sinkId: "infinite", color: "blue", count: Infinity });
    game.sim.net.addPlace({ id: "victim", x: 810, y: 400, capacity: 7, marking: ["yellow"] });
    game.step(116.99);
    expect(game.sim.net.places.has("victim")).toBe(true);
    game.step(0.01);
    expect(game.bombs.has(id)).toBe(false);
    expect(game.sim.net.places.has("victim")).toBe(false);
    expect(game.sim.net.transitions.has("infinite")).toBe(true);
    expect(game.lives).toBe(10);
  });

  it("retains a deferred catastrophe until a safe place is available", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const game = setup(true);
    game.sim.destroyNodes(new Set(["starterDestination"]));
    game["endlessEpoch"] = 1099;
    game["endlessProgress"] = 60;
    game.step(0);
    expect(game.bombs.size).toBe(0);
    expect(game["pendingCatastrophes"]).toBe(1);
    expect(warning).toHaveBeenCalledOnce();
    const restored = new Game(game.level, () => 0, { snapshot: JSON.parse(JSON.stringify(game.snapshot())) });
    restored.sim.net.addPlace({ id: "target", x: 400, y: 800, capacity: 7, marking: [] });
    restored.step(1);
    expect(restored.bombs.size).toBe(1);
    expect(restored["pendingCatastrophes"]).toBe(0);
  });
});
