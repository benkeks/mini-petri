import { describe, expect, it, vi } from "vitest";
import { EventBoundary, FederatedPointerEvent, Graphics, Text } from "pixi.js";
import type { Color } from "../src/core/multiset";
import { ENDLESS_RULES, Game, placementClearance } from "../src/game/game";
import { endless } from "../src/game/endless";
import { level2 } from "../src/game/level2";
import { POWERUPS } from "../src/game/powerups";
import { brushesOf, Controller, type Brush } from "../src/input/controller";
import { tokenSlots } from "../src/render/geometry";
import { Hud, survivalPopupPosition, toolbarLayout } from "../src/render/hud";
import { NetView } from "../src/render/netView";
import { THEME, TOKEN_COLORS } from "../src/render/style";

function drawing(graphics: Graphics) {
  return graphics.context.instructions.flatMap((instruction) =>
    instruction.action === "fill" || instruction.action === "stroke" ? [{
      action: instruction.action,
      color: instruction.data.style.color,
      width: instruction.action === "stroke" ? instruction.data.style.width : undefined,
      path: instruction.data.path.instructions,
    }] : []);
}

function stubDrawing(view: NetView) {
  return view["stubChunks"].flatMap((node) => drawing(node.gfx));
}

function balancePositions(view: NetView, game: Game, id: string, radius: number): number[][] {
  const transition = game.sim.net.transitions.get(id)!;
  const node = view.root.children[5].children.find((node) => node.x === transition.x && node.y === transition.y)!;
  const graphics = node.children[0] as Graphics;
  return graphics.context.instructions.flatMap((instruction) =>
    instruction.action === "fill" ? instruction.data.path.instructions : [])
    .filter((shape) => shape.action === "roundRect" && shape.data[2] === radius * 2 && shape.data[3] === radius * 2)
    .map((shape) => [shape.data[0] + radius, shape.data[1] + radius]);
}

function flightBoxes(view: NetView) {
  return drawing(view.root.children[6] as Graphics).flatMap((item) => {
    if (item.action !== "fill") return [];
    const box = item.path.filter((shape) => shape.action === "roundRect").at(-1);
    if (!box) return [];
    const [x, y, width, height] = box.data;
    return [{ color: item.color, x: x + width / 2, y: y + height / 2 }];
  });
}

describe("transition firing effects", () => {
  const viewport = { x: 0, y: 0, width: 1400, height: 1000 };

  function effectWidths(view: NetView, id: string): number[] {
    const node = view["transitions"].get(id)!;
    const width = view["layouts"].get(id)!.bar.w;
    return drawing(node.gfx).filter((item) => item.action === "stroke" && item.width === 3 && item.color === THEME.ink)
      .flatMap((item) => item.path.filter((shape) => shape.action === "roundRect")
        .map((shape) => shape.data[2]).filter((w) => w > width + 11));
  }

  it("shrinks on attraction and expands only when the relay emits, even across a rebuild", () => {
    const definition = structuredClone(endless);
    definition.net.transitions.forEach((transition) => { transition.autoInterval = undefined; });
    definition.net.places.find((place) => place.id === "starterPlace")!.marking = ["blue", "blue"];
    const game = new Game(definition);
    const view = new NetView(game);
    expect(game.sim.fire("starterRelay")).toBe(true);
    view.update(0, viewport);
    const initial = effectWidths(view, "starterRelay");
    expect(initial).toHaveLength(1);
    game.sim.step(0.1);
    view.update(0, viewport);
    expect(effectWidths(view, "starterRelay")[0]).toBeLessThan(initial[0]);
    expect(game.sim.inFlight.every((token) => token.kind === "input")).toBe(true);

    const travelTime = game.sim.net.arcLength(game.sim.net.arcs.get("starterRelayInput")!) / game.sim.tokenSpeed;
    game.sim.step(travelTime - 0.1 + 0.01);
    view.update(0, viewport);
    expect(game.sim.inFlight.some((token) => token.kind === "output")).toBe(true);
    expect(effectWidths(view, "starterRelay")).toHaveLength(1);
    expect(effectWidths(view, "starterRelay")[0]).toBeCloseTo(view["layouts"].get("starterRelay")!.bar.w + 12 + 28 * 0.01 / 0.35);

    expect(game.sim.fire("starterRelay")).toBe(true);
    game.sim.net.addPlace({ id: "unrelated", x: 1300, y: 900, marking: [] });
    view.update(0, viewport);
    const overlapping = effectWidths(view, "starterRelay");
    expect(overlapping).toHaveLength(2);
    game.sim.step(0.1);
    view.update(0, viewport);
    const later = effectWidths(view, "starterRelay");
    expect(later[0]).toBeLessThan(overlapping[0]);
    expect(later[1]).toBeGreaterThan(overlapping[1]);
    view.root.destroy({ children: true });
  });

  it("shows only the expanding emission effect for a source", () => {
    const definition = structuredClone(endless);
    definition.net.transitions.forEach((transition) => { transition.autoInterval = undefined; });
    const game = new Game(definition);
    const view = new NetView(game);
    expect(game.sim.fire("starterSource")).toBe(true);
    view.update(0, viewport);
    const initial = effectWidths(view, "starterSource");
    expect(initial).toHaveLength(1);
    game.sim.step(0.1);
    view.update(0, viewport);
    expect(effectWidths(view, "starterSource")).toHaveLength(1);
    expect(effectWidths(view, "starterSource")[0]).toBeGreaterThan(initial[0]);
    view.root.destroy({ children: true });
  });

  it("shows only the shrinking attraction effect for a sink", () => {
    const definition = structuredClone(endless);
    definition.net.transitions.forEach((transition) => { transition.autoInterval = undefined; });
    definition.net.places.find((place) => place.id === "starterDestination")!.marking = ["blue"];
    const game = new Game(definition);
    const view = new NetView(game);
    expect(game.sim.fire("starterSink")).toBe(true);
    view.update(0, viewport);
    const initial = effectWidths(view, "starterSink");
    expect(initial).toHaveLength(1);
    game.sim.step(0.1);
    view.update(0, viewport);
    expect(effectWidths(view, "starterSink")[0]).toBeLessThan(initial[0]);
    const travelTime = game.sim.net.arcLength(game.sim.net.arcs.get("starterInput")!) / game.sim.tokenSpeed;
    game.sim.step(travelTime - 0.1 + 0.01);
    view.update(0, viewport);
    expect(game.score).toBe(1);
    expect(effectWidths(view, "starterSink")).toHaveLength(0);
    view.root.destroy({ children: true });
  });
});

describe("endpoint token layouts", () => {
  it("draws settled and flying deliveries as boxes while places remain circles", () => {
    const game = new Game(endless);
    game.sim.net.places.get("starterPlace")!.marking.push("blue");
    expect(game.sim.fire("starterSource")).toBe(true);
    const view = new NetView(game);
    view.update(0, { x: 0, y: 0, width: 1200, height: 800 });
    const places = drawing(view.root.children[4] as Graphics);
    expect(places.some((item) => item.path[0].action === "circle")).toBe(true);
    expect(places.filter((item) => item.color === TOKEN_COLORS.blue).flatMap((item) => item.path).map((shape) => shape.action)).toContain("roundRect");
    expect(places.some((item) => item.action === "stroke" && item.width === 2 && item.color === 0xffffff
      && item.path.some((shape) => shape.action === "roundRect"))).toBe(true);
    const flying = drawing(view.root.children[6] as Graphics);
    expect(flying.some((item) => item.color === TOKEN_COLORS.blue && item.path[0].action === "roundRect")).toBe(true);
    view.root.destroy({ children: true });
  });

  it("lands flying deliveries in the next bottom-up slot of the place", () => {
    const game = new Game(endless);
    const place = game.sim.net.places.get("starterPlace")!;
    place.marking.push("red", "blue");
    expect(game.sim.fire("starterSource")).toBe(true);
    game.sim.inFlight[0].progress = 1;
    const view = new NetView(game);
    view.update(0, { x: 0, y: 0, width: 1200, height: 800 });
    const box = drawing(view.root.children[6] as Graphics).find((item) =>
      item.action === "fill" && item.color === TOKEN_COLORS.blue)!.path.find((shape) => shape.action === "roundRect")!;
    const [x, y, width, height] = box.data;
    const slot = tokenSlots(place.capacity)[2];
    expect(x + width / 2).toBeCloseTo(place.x + slot.x);
    expect(y + height / 2).toBeCloseTo(place.y + slot.y);
    view.root.destroy({ children: true });
  });

  it.each([false, true])("starts finite source emissions at the consumed supply box, portrait=%s", (portrait) => {
    const definition = structuredClone(endless);
    definition.net.transitions.find((t) => t.id === "starterSource")!.supply = 5;
    const game = new Game(definition);
    game.setPortrait(portrait);
    const view = new NetView(game);
    const viewport = { x: 0, y: 0, width: 1400, height: 1400 };
    view.update(0, viewport);
    const source = game.starterSource ?? game.sim.net.transitions.get("starterSource")!;
    const origin = balancePositions(view, game, source.id, 3.2).at(-1)!;
    expect(game.sim.fire(source.id)).toBe(true);
    view.update(0, viewport);
    const flying = flightBoxes(view)[0];
    expect(flying.x).toBeCloseTo(source.x + origin[0]);
    expect(flying.y).toBeCloseTo(source.y + origin[1]);
    expect(source.supply).toBe(4);
    const rebuilt = new NetView(game);
    rebuilt.update(0, viewport);
    const afterRebuild = flightBoxes(rebuilt)[0];
    expect(afterRebuild.x).toBeCloseTo(flying.x);
    expect(afterRebuild.y).toBeCloseTo(flying.y);
    view.root.destroy({ children: true });
    rebuilt.root.destroy({ children: true });
  });

  it.each([false, true])("shows the initial source depletion warning only once limited, portrait=%s", (portrait) => {
    const game = new Game(endless);
    game.setPortrait(portrait);
    const source = game.starterSource!;
    const view = new NetView(game);
    const viewport = { x: 0, y: 0, width: 1200, height: 1200 };
    const sourceDrawing = () => {
      const node = view.root.children[5].children.find((child) => child.x === source.x && child.y === source.y)!;
      return drawing(node.children[0] as Graphics);
    };
    view.update(0, viewport);
    expect(sourceDrawing().some((item) => item.color === THEME.buildInvalid)).toBe(false);
    game["endlessEpoch"] = 2000;
    source.supply = 50;
    view.update(0, viewport);
    expect(sourceDrawing().some((item) => item.color === THEME.buildInvalid && item.action === "stroke")).toBe(true);
    expect(balancePositions(view, game, source.id, 3.2)).toHaveLength(50);
    source.supply = 0;
    view.update(0, viewport);
    expect(sourceDrawing().some((item) => item.color === THEME.buildInvalid)).toBe(false);
    view.root.destroy({ children: true });
  });

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
    "matches source and sink box positions for $count tokens, portrait=$portrait",
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

describe("grouped and infinite sink goals", () => {
  const groups: Color[][] = [["blue", "red"], ["yellow", "green"], ["blue", "red", "green", "yellow"]];
  function setup(colors: Color[], count: number, portrait: boolean) {
    const definition = structuredClone(endless);
    definition.goals = colors.map((color) => ({ sinkId: "starterSink", color, count }));
    definition.net.transitions.forEach((transition) => { transition.autoInterval = undefined; });
    definition.net.transitions.find((transition) => transition.id === "starterSink")!.open = colors.map((color) => ({ dir: "in", color }));
    definition.net.arcs = definition.net.arcs.filter((arc) => arc.id !== "starterInput");
    const game = new Game(definition);
    for (let i = 0; i < colors.length; i++) game.connect("starterSink", 0, "starterDestination");
    game.setPortrait(portrait);
    const view = new NetView(game);
    const viewport = { x: 0, y: 0, width: 1400, height: 1400 };
    view.update(0, viewport);
    return { game, view, viewport };
  }

  it.each([["blue"] satisfies Color[], ...groups].flatMap((colors) =>
    [5, Infinity].flatMap((count) => [false, true].map((portrait) => ({ colors, count, portrait })))))(
    "hops each $colors delivery onto its matching demand box, count=$count, portrait=$portrait",
    ({ colors, count, portrait }) => {
      const { game, view, viewport } = setup(colors, count, portrait);
      const sink = game.sim.net.transitions.get("starterSink")!;
      game.sim.net.places.get("starterDestination")!.marking.push(...colors);
      expect(game.sim.fire(sink.id)).toBe(true);
      for (const token of game.sim.inFlight) token.progress = 1 - 1e-10;
      view.update(0, viewport);
      const node = view["transitions"].get(sink.id)!;
      const boxes = flightBoxes(view);
      for (const [index, color] of colors.entries()) {
        const key = Number.isFinite(count) ? `${index}:0` : `infinite:${index}`;
        const target = node.balance.get(key)!.position;
        const flying = boxes.find((box) => box.color === TOKEN_COLORS[color])!;
        expect(flying.x).toBeCloseTo(node.container.x + target.x * node.container.scale.x, 4);
        expect(flying.y).toBeCloseTo(node.container.y + target.y * node.container.scale.y, 4);
      }
      view.root.destroy({ children: true });
    },
  );

  it("removes the box actually reached when later firings arrive first", () => {
    const { game, view, viewport } = setup(["blue"], 5, false);
    game.sim.net.places.get("starterDestination")!.marking.push("blue", "blue");
    expect(game.sim.fire("starterSink")).toBe(true);
    expect(game.sim.fire("starterSink")).toBe(true);
    const [first, second] = game.sim.inFlight;
    expect([first.goalOrdinal, second.goalOrdinal]).toEqual([0, 1]);
    first.progress = 0.1;
    second.progress = 0.9;
    game.sim.step(0.2);
    view.update(0, viewport);
    expect(game.remainingGoalOrdinals(game.goalsFor("starterSink")[0])).toEqual([0, 2, 3, 4]);
    const balance = view["transitions"].get("starterSink")!.balance;
    expect(balance.has("0:0")).toBe(true);
    expect(balance.has("0:1")).toBe(false);
    first.progress = 1 - 1e-10;
    view.update(0, viewport);
    const node = view["transitions"].get("starterSink")!;
    const target = node.balance.get("0:0")!.position;
    const box = flightBoxes(view)[0];
    expect(box.x).toBeCloseTo(node.container.x + target.x * node.container.scale.x, 4);
    expect(box.y).toBeCloseTo(node.container.y + target.y * node.container.scale.y, 4);
    view.root.destroy({ children: true });
  });

  it("does not direct a wrong-color delivery to a sink demand box", () => {
    const definition = structuredClone(endless);
    definition.net.arcs.find((arc) => arc.id === "starterInput")!.color = undefined;
    definition.net.places.find((place) => place.id === "starterDestination")!.marking = ["red"];
    definition.net.transitions.forEach((transition) => { transition.autoInterval = undefined; });
    const game = new Game(definition);
    const view = new NetView(game);
    const viewport = { x: 0, y: 0, width: 1400, height: 1400 };
    view.update(0, viewport);
    expect(game.sim.fire("starterSink")).toBe(true);
    expect(game.sim.inFlight[0].goalOrdinal).toBeUndefined();
    game.sim.inFlight[0].progress = 1 - 1e-10;
    view.update(0, viewport);
    const node = view["transitions"].get("starterSink")!;
    const target = node.balance.get("0:0")!.position;
    const box = flightBoxes(view)[0];
    expect(Math.hypot(box.x - node.container.x - target.x, box.y - node.container.y - target.y)).toBeGreaterThan(10);
    view.root.destroy({ children: true });
  });

  it.each([["blue"] satisfies Color[], ...groups])("shows every %j goal color on the sink outline", (...colors) => {
    const { game, view } = setup(colors, 5, false);
    const node = view["transitions"].get("starterSink")!;
    const outline = drawing(node.gfx).filter((item) => item.action === "stroke" && item.width === 4);
    for (const color of colors) expect(outline.some((item) => item.color === TOKEN_COLORS[color])).toBe(true);
    expect(game.goalsFor("starterSink")).toHaveLength(colors.length);
    view.root.destroy({ children: true });
  });

  it.each(groups.flatMap((colors) => [5, 15].flatMap((count) => [false, true].map((portrait) => ({ colors, count, portrait })))))(
    "renders $count overlapping $colors groups, portrait=$portrait, and removes one whole group on delivery",
    ({ colors, count, portrait }) => {
      const { game, view, viewport } = setup(colors, count, portrait);
      const dots = balancePositions(view, game, "starterSink", 7);
      expect(dots).toHaveLength(count * colors.length);
      for (let group = 0; group < count; group++) {
        const boxes = dots.slice(group * colors.length, (group + 1) * colors.length);
        for (const [x, y] of boxes.slice(1)) {
          expect(Math.hypot(x - boxes[0][0], y - boxes[0][1])).toBeLessThan(8);
          expect(Math.hypot(x - boxes[0][0], y - boxes[0][1])).toBeGreaterThan(0);
        }
      }
      const sink = view.root.children[5].children.find((node) =>
        node.x === game.sim.net.transitions.get("starterSink")!.x && node.y === game.sim.net.transitions.get("starterSink")!.y)!;
      const colorsDrawn = drawing(sink.children[0] as Graphics).filter((instruction) =>
        instruction.action === "stroke" && instruction.path.some((shape) =>
          shape.action === "roundRect" && shape.data[2] === 14 && shape.data[3] === 14))
        .map((instruction) => instruction.color);
      for (const color of colors) expect(colorsDrawn.filter((drawn) => drawn === TOKEN_COLORS[color])).toHaveLength(count);
      game.sim.net.places.get("starterDestination")!.marking.push(...colors);
      expect(game.sim.fire("starterSink")).toBe(true);
      game.sim.step(1);
      view.update(0.25, viewport);
      expect(balancePositions(view, game, "starterSink", 7)).toHaveLength((count - 1) * colors.length);
      view.root.destroy({ children: true });
    });

  it.each([["blue"] satisfies Color[], ...groups].flatMap((colors) => [false, true].map((portrait) => ({ colors, portrait }))))(
    "renders a bounded $colors infinity marker, portrait=$portrait, without consuming the display on delivery",
    ({ colors, portrait }) => {
      const { game, view, viewport } = setup(colors, Infinity, portrait);
      expect(balancePositions(view, game, "starterSink", 7)).toHaveLength(colors.length);
      const sink = game.sim.net.transitions.get("starterSink")!;
      const node = view.root.children[5].children.find((node) => node.x === sink.x && node.y === sink.y)!;
      const marker = drawing(node.children[0] as Graphics).filter((instruction) =>
        instruction.action === "stroke" && instruction.path.some((shape) => shape.action === "bezierCurveTo"));
      expect(marker.map((instruction) => instruction.color)).toEqual(colors.map((color) => TOKEN_COLORS[color]));
      expect(marker.every((instruction) => instruction.path.filter((shape) => shape.action === "bezierCurveTo").length === 2)).toBe(true);
      game.sim.net.places.get("starterDestination")!.marking.push(...colors);
      expect(game.sim.fire("starterSink")).toBe(true);
      game.sim.step(1);
      view.update(0.25, viewport);
      expect(balancePositions(view, game, "starterSink", 7)).toHaveLength(colors.length);
      expect(game.resolved.has("starterSink")).toBe(false);
      view.root.destroy({ children: true });
    });
});

describe("sink warning colors", () => {
  it.each([["blue"] satisfies Color[], ["blue", "red"] satisfies Color[],
    ["yellow", "green"] satisfies Color[], ["blue", "red", "green", "yellow"] satisfies Color[]])(
    "shows all %j goal colors in one clickable warning", (...colors) => {
      const definition = structuredClone(endless);
      definition.goals = colors.map((color) => ({ sinkId: "starterSink", color, count: Infinity }));
      definition.net.transitions.forEach((transition) => { transition.autoInterval = undefined; });
      const game = new Game(definition, () => 0.5, { survival: true });
      const view = new NetView(game);
      const controller = new Controller(game, view);
      const focus = vi.fn();
      const hud = new Hud(game, controller, {
        restart: () => {}, requestRestart: () => {}, togglePause: () => {},
        selectBrush: () => {}, focusSink: focus,
      });
      vi.spyOn(hud, "layout").mockReturnValue({ top: 0, bottom: 0 });
      game.sim.step(colors.includes("yellow") ? 360 : 180);
      expect(game.endangeredSinks()[0].colors).toEqual(colors);
      hud["updateWarnings"]();
      const warning = hud.root.getChildByLabel("danger-starterSink", true);
      expect(warning).toBeInstanceOf(Graphics);
      const graphic = warning as Graphics;
      const fills = drawing(graphic).filter((instruction) => instruction.action === "fill");
      expect(fills.slice(0, colors.length).map((instruction) => instruction.color)).toEqual(colors.map((color) => TOKEN_COLORS[color]));
      expect(fills.at(-1)?.path.some((shape) => shape.action === "circle")).toBe(true);
      controller.setBrush({ kind: "kit", kit: endless.tools!.kits![0] });
      controller.selectedPlace = "starterPlace";
      graphic.emit("pointertap", new FederatedPointerEvent(new EventBoundary(hud.root)));
      expect(focus).toHaveBeenCalledWith("starterSink");
      expect(controller.brush.kind).toBe("fire");
      expect(controller.selectedPlace).toBeUndefined();
      game.sim.step(colors.includes("yellow") ? 121 : 61);
      hud["updateWarnings"]();
      expect(hud.root.getChildByLabel("danger-starterSink", true)).toBeNull();
      hud.root.destroy({ children: true });
      view.root.destroy({ children: true });
    });
});

describe("delivery HUD", () => {
  function makeHud(game: Game) {
    const view = new NetView(game);
    const controller = new Controller(game, view);
    const hud = new Hud(game, controller, {
      restart: () => {}, requestRestart: () => {}, togglePause: () => {},
      selectBrush: () => {}, focusSink: () => {},
    });
    const icon = (color: Color) => hud.root.getChildByLabel(`delivery-${color}`, true) as Graphics;
    return { hud, view, icon };
  }

  it("keeps the epoch label fixed as the time changes up to 999 minutes", () => {
    const width = vi.spyOn(Text.prototype, "width", "get").mockImplementation(function (this: Text) {
      return [...this.text].reduce((sum, character) => sum + (character === "1" ? 5 : 10), 0);
    });
    const height = vi.spyOn(Text.prototype, "height", "get").mockReturnValue(14);
    const game = new Game(endless, Math.random, { survival: true });
    const { hud, view } = makeHud(game);
    hud["drawBackplates"] = vi.fn();
    hud.layout(1200, 800);
    const positions = [0, 9, 59, 60, 599, 600, 5999, 6000, 999 * 60 + 59].map((time) => {
      game.sim.time = time;
      hud.update(0, (point) => point);
      expect(hud["epoch"].x).toBeGreaterThan(hud["meta"].x + hud["meta"].width);
      return hud["epoch"].x;
    });
    expect(new Set(positions).size).toBe(1);
    expect(hud["meta"].text).toBe("TIME 999:59");
    expect(hud["epoch"].text).toBe("EPOCH 0");
    hud.setGame(new Game(level2));
    expect(hud["epoch"].visible).toBe(false);
    hud.root.destroy({ children: true });
    view.root.destroy({ children: true });
    width.mockRestore();
    height.mockRestore();
  });

  it("keeps the delivery label and icons stationary until a digit is added", () => {
    const width = vi.spyOn(Text.prototype, "width", "get").mockImplementation(function (this: Text) {
      return this.text.length * Number(this.style.fontSize) / 2;
    });
    const height = vi.spyOn(Text.prototype, "height", "get").mockReturnValue(24);
    const game = new Game(endless, Math.random, { survival: true });
    const { hud, view } = makeHud(game);
    hud["drawBackplates"] = vi.fn();
    hud.layout(1200, 800);
    const positions = (score: number) => {
      game.score = score;
      hud.update(0, (point) => point);
      return [hud["statsLabel"].x, hud["deliveryIcons"].x];
    };
    expect(positions(1)).toEqual(positions(8));
    const single = positions(9);
    const double = positions(10);
    expect(double[0]).toBeGreaterThan(single[0]);
    expect(positions(11)).toEqual(positions(99));
    expect(positions(100)[0]).toBeGreaterThan(double[0]);

    game.continueEndless();
    const gainPositions = (gain: number) => {
      game.score = 100 + gain;
      hud.update(0, (point) => point);
      return hud["deliveryIcons"].x;
    };
    expect(gainPositions(1)).toBe(gainPositions(9));
    expect(gainPositions(10)).toBeGreaterThan(gainPositions(9));
    hud.root.destroy({ children: true });
    view.root.destroy({ children: true });
    width.mockRestore();
    height.mockRestore();
  });

  it("hops on gains and tilts on losses for both resource counters", () => {
    const game = new Game(endless, Math.random, { survival: true });
    const { hud, view } = makeHud(game);
    hud["coinBaseX"] = 34;
    hud["lifeBaseX"] = 88;
    hud["resourceBaseY"] = 400;
    hud["lives"].visible = true;
    game["changeCoins"](20, { x: 0, y: 0 });
    hud["updateResources"](0.09);
    expect(hud["coins"].y).toBeCloseTo(393);
    expect(hud["coinIcon"].y).toBeCloseTo(393);
    expect(hud["coins"].rotation).toBe(0);

    game["lifeBalance"] = 8;
    expect(game.buyLife({ x: 0, y: 0 })).toBe(true);
    hud["updateResources"](0.09);
    expect(hud["coins"].rotation).toBeCloseTo(0.22);
    expect(hud["coinIcon"].rotation).toBeCloseTo(0.22);
    expect(hud["lives"].y).toBeCloseTo(393);
    expect(hud["lifeIcon"].y).toBeCloseTo(393);

    game["failTransition"]("starterSink", 0);
    hud["updateResources"](0.09);
    expect(hud["lives"].rotation).toBeCloseTo(0.22);
    expect(hud["lifeIcon"].rotation).toBeCloseTo(0.22);
    hud["updateResources"](0.18);
    expect(hud["coins"].rotation).toBe(0);
    expect(hud["lives"].rotation).toBe(0);
    expect(hud["coins"].y).toBe(400);
    expect(hud["lives"].y).toBe(400);
    const life = POWERUPS.find((choice) => choice.kind === "life")!;
    game.offers.set("heart", { id: "heart", x: 0, y: 0, expiresAt: 120, choices: [life, POWERUPS[0]] });
    expect(game.collectOffer("heart", 0)).toBe(true);
    hud["updateResources"](0.09);
    expect(hud["lives"].y).toBeCloseTo(393);
    hud.setGame(new Game(endless, Math.random, { survival: true }));
    game["changeCoins"](1, { x: 0, y: 0 });
    expect(hud["coinMotion"]).toBeUndefined();
    expect(hud["lifeMotion"]).toBeUndefined();
    hud.root.destroy({ children: true });
    view.root.destroy({ children: true });
  });

  it("opens statistics from the delivery count and survival result", () => {
    const game = new Game(endless, Math.random, { survival: true });
    const view = new NetView(game);
    const controller = new Controller(game, view);
    const showStatistics = vi.fn();
    const hud = new Hud(game, controller, {
      restart: () => {}, requestRestart: () => {}, togglePause: () => {},
      selectBrush: () => {}, focusSink: () => {}, showStatistics,
    });
    const event = new FederatedPointerEvent(new EventBoundary(hud.root));
    hud.root.getChildByLabel("delivery-score", true)!.emit("pointertap", event);
    expect(showStatistics).toHaveBeenCalledTimes(1);
    game.survivalFailed = true;
    hud.root.getChildByLabel("result-score", true)!.emit("pointertap", event);
    expect(showStatistics).toHaveBeenCalledTimes(2);
    game.complete = true;
    hud["showPopup"]();
    expect(showStatistics).toHaveBeenCalledTimes(2);
    const statisticsButton = hud.root.getChildByLabel("result-statistics", true)!;
    expect(statisticsButton.visible).toBe(true);
    expect(drawing(statisticsButton.children[0] as Graphics).some((item) =>
      item.action === "fill" && item.path.some((shape) => shape.action === "roundRect"))).toBe(true);
    statisticsButton.emit("pointertap", event);
    expect(showStatistics).toHaveBeenCalledTimes(3);
    hud.root.destroy({ children: true });
    view.root.destroy({ children: true });
  });

  it("adds outlined boxes in unlock order at the exact epoch thresholds", () => {
    const game = new Game(endless);
    const { hud, view, icon } = makeHud(game);
    const colors: Color[] = ["blue", "red", "green", "yellow"];
    for (const [epoch, visible] of [
      [0, ["blue"]], [ENDLESS_RULES.blueOnlyEpochs, ["blue"]],
      [ENDLESS_RULES.blueOnlyEpochs + 1, ["blue", "red"]],
      [ENDLESS_RULES.greenFrom - 1, ["blue", "red"]],
      [ENDLESS_RULES.greenFrom, ["blue", "red", "green"]],
      [ENDLESS_RULES.yellowFrom - 1, ["blue", "red", "green"]],
      [ENDLESS_RULES.yellowFrom, colors],
    ] as [number, Color[]][]) {
      game["endlessEpoch"] = epoch;
      hud["updateDeliveryIcons"](0);
      expect(colors.filter((color) => icon(color).visible)).toEqual(visible);
      visible.forEach((color, index) => expect(icon(color).x).toBe(index * 16));
    }
    for (const color of colors) {
      expect(drawing(icon(color)).map((item) => [item.action, item.color])).toEqual([
        ["fill", TOKEN_COLORS[color]], ["stroke", 0xffffff],
      ]);
    }
    hud.root.destroy({ children: true });
    view.root.destroy({ children: true });
  });

  it("jumps only colors that scored, settles, and resets on restart", () => {
    const definition = structuredClone(endless);
    definition.goals = [
      { sinkId: "starterSink", color: "blue", count: 1 },
      { sinkId: "starterSink", color: "red", count: 3 },
    ];
    definition.net.transitions.find((transition) => transition.id === "starterSink")!.autoInterval = undefined;
    definition.net.places.find((place) => place.id === "starterDestination")!.marking = ["blue", "blue", "red", "red"];
    definition.net.arcs.push({ id: "redInput", from: "starterDestination", to: "starterSink", color: "red" });
    const game = new Game(definition);
    const { hud, view, icon } = makeHud(game);
    expect(game.sim.fire("starterSink")).toBe(true);
    game.sim.step(1);
    hud["updateDeliveryIcons"](0.4 / 6);
    expect(icon("blue").y).toBeCloseTo(-7);
    expect(icon("red").y).toBeCloseTo(-7);
    expect(icon("green").y).toBe(0);
    hud["updateDeliveryIcons"](0.4 / 6);
    expect(icon("blue").y).toBe(0);
    expect(icon("red").y).toBe(0);
    expect(game.sim.fire("starterSink")).toBe(true);
    game.sim.step(1);
    hud["updateDeliveryIcons"](0.1);
    expect(icon("blue").y).toBe(0);
    expect(icon("red").y).toBeLessThan(0);
    const next = new Game(endless);
    hud.setGame(next);
    expect(icon("red").visible).toBe(false);
    expect(icon("red").y).toBe(0);
    game.sim.net.places.get("starterDestination")!.marking.push("blue", "red");
    expect(game.sim.fire("starterSink")).toBe(true);
    game.sim.step(1);
    hud["updateDeliveryIcons"](0.1);
    expect(icon("red").visible).toBe(false);
    expect(icon("red").y).toBe(0);
    hud.root.destroy({ children: true });
    view.root.destroy({ children: true });
  });
});

describe("long-running net rendering", () => {
  it("splits many dangling connectors into bounded graphics batches", () => {
    const game = new Game(endless);
    for (let i = 0; i < 40; i++) {
      game.sim.net.addTransition({ id: `loose${i}`, x: 1200 + i * 80, y: 800, kind: "source", open: [{ dir: "out", color: "red" }] });
    }
    const view = new NetView(game);
    view.update(0, { x: 0, y: 0, width: 5000, height: 1000 });
    expect(view["stubChunks"].length).toBeGreaterThan(1);
    expect(view["stubChunks"].every((chunk) => chunk.gfx.context.instructions.length <= 16 * 8)).toBe(true);
    const circles = stubDrawing(view).flatMap((instruction) => instruction.path)
      .filter((shape) => shape.action === "arc");
    expect(circles).toHaveLength(40 * 4);
    view.root.destroy({ children: true });
  });

  it("reuses unchanged connector graphics and removes them when their port disappears", () => {
    const game = new Game(endless);
    game.sim.net.addTransition({ id: "loose", x: 1200, y: 800, kind: "source", open: [{ dir: "out", color: "red" }] });
    const view = new NetView(game);
    const viewport = { x: 0, y: 0, width: 1400, height: 1000 };
    view.update(0, viewport);
    const stub = view["stubChunks"][0];
    const clear = vi.spyOn(stub.gfx, "clear");
    game.sim.net.addPlace({ id: "extra", x: 0, y: 0, marking: [] });
    view.update(0, viewport);
    expect(view["stubChunks"][0]).toBe(stub);
    expect(clear).not.toHaveBeenCalled();
    game.sim.net.connect("loose", 0, "extra");
    view.update(0, viewport);
    expect(view["stubChunks"]).toHaveLength(0);
    expect(stub.root.destroyed).toBe(true);
    expect(stub.labels.destroyed).toBe(true);
    view.root.destroy({ children: true });
  });

  it("reuses unchanged sink graphics while updating deliveries and countdowns", () => {
    const definition = structuredClone(endless);
    definition.net.transitions.forEach((transition) => { transition.autoInterval = undefined; });
    const game = new Game(definition);
    const view = new NetView(game);
    const viewport = { x: 0, y: 0, width: 1200, height: 800 };
    view.update(0.1, viewport);
    const node = view["transitions"].get("starterSink")!;
    const clear = vi.spyOn(node.gfx, "clear");
    view.update(0.1, viewport);
    expect(clear).not.toHaveBeenCalled();

    game.sim.net.addPlace({ id: "extra", x: 0, y: 0, marking: [] });
    view.update(0.1, viewport);
    expect(view["transitions"].get("starterSink")).toBe(node);
    expect(clear).toHaveBeenCalledTimes(1);

    game.sim.net.places.get("starterDestination")!.marking.push("blue");
    expect(game.sim.fire("starterSink")).toBe(true);
    game.sim.step(1);
    view.update(0.1, viewport);
    expect(clear).toHaveBeenCalledTimes(2);
    expect(node.balance.size).toBe(4);
    game.sim.step(180);
    view.update(0.1, viewport);
    expect(clear).toHaveBeenCalledTimes(3);
    view.root.destroy({ children: true });
  });
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
    it("dismisses confirmation and pause backdrops while preserving a survival result", () => {
      const game = new Game(endless, Math.random, { survival: true });
      const view = new NetView(game);
      const controller = new Controller(game, view);
      const hud = new Hud(game, controller, {
        restart: () => {}, requestRestart: () => {},
        togglePause: () => { game.paused = !game.paused; hud.setPaused(game.paused); },
        selectBrush: () => {}, focusSink: () => {},
      });
      const event = new FederatedPointerEvent(new EventBoundary(hud.root));
      hud.showEndlessConfirmation();
      hud["confirmationShade"].emit("pointertap", event);
      expect(hud.confirming).toBe(false);
      expect(game.paused).toBe(false);
      game.paused = true;
      hud.setPaused(true);
      hud.showRestartConfirmation();
      hud["confirmationShade"].emit("pointertap", event);
      expect(game.paused).toBe(true);
      hud["pauseShade"].emit("pointertap", event);
      expect(game.paused).toBe(false);
      game.complete = true;
      game.survivalFailed = true;
      hud["showPopup"]();
      hud["shade"].emit("pointertap", event);
      expect(hud["popup"].visible).toBe(true);
      game.survivalFailed = false;
      hud["shade"].emit("pointertap", event);
      expect(hud["popup"].visible).toBe(false);
      expect(hud["resultDismissed"]).toBe(true);
      hud.root.destroy({ children: true });
      view.root.destroy({ children: true });
    });

    it("fades the pause overlay and confirmation independently and resumes from the center button", () => {
      const game = new Game(endless, Math.random, { survival: true });
      const view = new NetView(game);
      const controller = new Controller(game, view);
      const hud = new Hud(game, controller, {
        restart: () => {}, requestRestart: () => {},
        togglePause: () => {
          game.paused = !game.paused;
          hud.setPaused(game.paused);
        },
        selectBrush: () => {}, focusSink: () => {},
      });
      const pause = hud.root.getChildByLabel("end-pause", true)!;
      const shade = hud.root.getChildByLabel("pause-shade", true)!;
      game.paused = true;
      hud.setPaused(true);
      hud["animateModals"](0.08);
      expect(shade.visible).toBe(true);
      expect(shade.alpha).toBeCloseTo(0.2);
      expect(hud.blocks({ x: 200, y: 200 })).toBe(true);
      hud.showRestartConfirmation();
      hud["animateModals"](0.16);
      expect(shade.visible).toBe(false);
      expect(hud["confirmationShade"].alpha).toBeCloseTo(0.4);
      hud.cancelRestart();
      hud["animateModals"](0.16);
      expect(game.paused).toBe(true);
      expect(shade.visible).toBe(true);
      expect(hud["confirmationShade"].visible).toBe(false);
      pause.emit("pointertap", new FederatedPointerEvent(new EventBoundary(hud.root)));
      expect(game.paused).toBe(false);
      hud["animateModals"](0.08);
      expect(shade.alpha).toBeCloseTo(0.2);
      hud["animateModals"](0.08);
      expect(shade.visible).toBe(false);
      hud.root.destroy({ children: true });
      view.root.destroy({ children: true });
    });

    it("collapses mobile portrait controls and dismisses the menu after actions or outside taps", () => {
      const game = new Game(endless, Math.random, { survival: true });
      game.setPortrait(true);
      const view = new NetView(game);
      const controller = new Controller(game, view);
      let pauses = 0;
      let fullscreenToggles = 0;
      const showAbout = vi.fn();
      const hud = new Hud(game, controller, {
        toggleFullscreen: () => { fullscreenToggles++; },
        showAbout,
        restart: () => {},
        requestRestart: () => {},
        togglePause: () => { pauses++; },
        selectBrush: () => {},
        focusSink: () => {},
      });
      vi.spyOn(hud, "layout").mockReturnValue({ top: 102, bottom: 100 });
      const control = (label: string) => {
        const child = hud.root.children.find((item) => item.label === label);
        if (!child) throw new Error(`Missing ${label}`);
        return child;
      };
      const event = new FederatedPointerEvent(new EventBoundary(hud.root));
      expect(control("meta-menu").visible).toBe(true);
      expect(control("meta-fullscreen-icon").visible).toBe(true);
      expect(control("meta-fullscreen").visible).toBe(false);
      expect(control("meta-pause").visible).toBe(false);
      expect(control("meta-restart").visible).toBe(false);
      expect(control("meta-about").visible).toBe(false);
      control("meta-menu").emit("pointertap", event);
      expect(control("meta-pause").visible).toBe(true);
      expect(control("meta-endless").visible).toBe(true);
      expect(control("meta-restart").visible).toBe(true);
      expect(control("meta-about").visible).toBe(true);
      expect(game.paused).toBe(false);
      expect(hud.blocks({ x: 200, y: 200 })).toBe(true);
      control("meta-pause").emit("pointertap", event);
      expect(pauses).toBe(1);
      expect(control("meta-pause").visible).toBe(false);
      control("meta-menu").emit("pointertap", event);
      control("meta-menu-dismiss").emit("pointertap", event);
      expect(control("meta-restart").visible).toBe(false);
      control("meta-menu").emit("pointertap", event);
      control("meta-about").emit("pointertap", event);
      expect(showAbout).toHaveBeenCalledOnce();
      expect(control("meta-about").visible).toBe(false);
      control("meta-fullscreen-icon").emit("pointertap", event);
      expect(fullscreenToggles).toBe(1);
      control("meta-menu").emit("pointertap", event);
      expect(hud.closeMenu()).toBe(true);
      expect(hud.closeMenu()).toBe(false);
      hud.root.destroy({ children: true });
      view.root.destroy({ children: true });
    });

    it("keeps portrait desktop meta controls visible", () => {
      const game = new Game(endless);
      game.setPortrait(true);
      const view = new NetView(game);
      const controller = new Controller(game, view);
      const showAbout = vi.fn();
      const hud = new Hud(game, controller, {
        restart: () => {}, requestRestart: () => {}, togglePause: () => {},
        selectBrush: () => {}, focusSink: () => {}, showAbout,
      });
      expect(hud.root.children.find((child) => child.label === "meta-menu")?.visible).toBe(false);
      expect(hud.root.children.find((child) => child.label === "meta-pause")?.visible).toBe(true);
      expect(hud.root.children.find((child) => child.label === "meta-restart")?.visible).toBe(true);
      const about = hud.root.getChildByLabel("meta-about", true)!;
      expect(about.visible).toBe(true);
      about.emit("pointertap", new FederatedPointerEvent(new EventBoundary(hud.root)));
      expect(showAbout).toHaveBeenCalledOnce();
      hud.root.destroy({ children: true });
      view.root.destroy({ children: true });
    });

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
  it("uses the build-invalid color for an impossible preview and denial without changing normal denials", () => {
    const game = new Game(level2);
    const view = new NetView(game);
    const controller = new Controller(game, view);
    const kit = game.level.tools!.kits![0];
    const point = { x: 1050, y: 180 };
    const viewport = { x: 0, y: 0, width: 1400, height: 1000 };
    controller.setBrush({ kind: "kit", kit });
    controller.press(point);
    controller.sync();
    view.update(0, viewport);
    const preview = drawing(view.root.children[8].children[0] as Graphics);
    expect(preview.some((item) => item.color === THEME.buildInvalid)).toBe(true);
    controller.release(point);
    view.update(0, viewport);
    expect(drawing(view.root.children[8] as Graphics).some((item) => item.color === THEME.buildInvalid)).toBe(true);
    view.deny({ kind: "empty", x: 0, y: 0 });
    view.update(0, viewport);
    expect(drawing(view.root.children[8] as Graphics).some((item) => item.color === THEME.warn)).toBe(true);
    view.root.destroy({ children: true });
  });

  it("blinks a blocked connection between its warning color and its intended arc color", () => {
    const game = new Game({ ...level2, goals: [], net: {
      places: [{ id: "p", x: 1000, y: 1000, marking: [] }],
      transitions: [{ id: "t", x: 1400, y: 1000, kind: "normal", open: [{ dir: "in", color: "blue" }] }],
      arcs: [],
    } });
    const view = new NetView(game);
    view.overlay.connection = { tid: "t", index: 0, pid: "p" };
    const viewport = { x: 0, y: 0, width: 2000, height: 2000 };
    view.update(0, viewport);
    const preview = view.root.children[8].children[0] as Graphics;
    expect(drawing(preview).find((item) => item.action === "stroke" && item.width === 4)?.color).toBe(THEME.buildInvalid);
    game.sim.time = 0.4;
    view.update(0, viewport);
    expect(drawing(preview).find((item) => item.action === "stroke" && item.width === 4)?.color).toBe(TOKEN_COLORS.blue);
    view.root.destroy({ children: true });
  });

  it.each([false, true].flatMap((portrait) => (["in", "out"] as const).flatMap((dir) =>
    (["port-first", "place-first", "transition-body"] as const).map((order) => ({ portrait, dir, order })))))(
    "previews the committed arc between existing nodes: $dir, $order, portrait=$portrait", ({ portrait, dir, order }) => {
      const game = new Game({ ...level2, goals: [], net: {
        places: [{ id: "place", x: 1000, y: 1000, capacity: 19, marking: [] }],
        transitions: [{ id: "transition", x: 1220, y: 1000, kind: "normal", open: [{ dir, color: "yellow", count: 2 }] }],
        arcs: [],
      } });
      game.setPortrait(portrait);
      const view = new NetView(game);
      const controller = new Controller(game, view);
      const viewport = { x: 0, y: 0, width: 2400, height: 2400 };
      view.update(0, viewport);
      const port = portrait ? { x: 1000, y: 1220 + (dir === "in" ? -57 : 57) }
        : { x: 1220 + (dir === "in" ? -57 : 57), y: 1000 };
      const place = { x: 1000, y: 1000 };
      const body = portrait ? { x: 1000, y: 1220 } : { x: 1220, y: 1000 };
      const target = order === "port-first" ? place : order === "place-first" ? port : body;
      controller.tap(order === "port-first" ? port : place);
      const version = game.sim.net.version;
      expect(controller.press(target)).toBe(true);
      controller.sync();
      view.update(0, viewport);
      const proposed = drawing(view.root.children[8].children[0] as Graphics);
      expect(proposed.filter((item) => item.action === "stroke" && item.width === 4)).toHaveLength(1);
      expect(proposed[0].color).toBe(TOKEN_COLORS.yellow);
      expect(game.sim.net.version).toBe(version);
      controller.release(target);
      controller.sync();
      view.update(0, viewport);
      expect(drawing(view.root.children[2] as Graphics)).toEqual(proposed);
      expect(game.sim.net.places.size).toBe(1);
      expect(game.sim.net.transitions.size).toBe(1);
      view.root.destroy({ children: true });
    });

  it.each([false, true].flatMap((portrait) => [false, true].map((samePort) => ({ portrait, samePort }))))(
    "previews the exact place and colored weighted bridge arcs, portrait=$portrait, samePort=$samePort", ({ portrait, samePort }) => {
      const game = new Game({
        ...level2, goals: [], net: { places: [], arcs: [], transitions: [
          { id: "left", x: 1000, y: 1000, kind: "source", open: [{ dir: "out", color: "blue", count: 2 }] },
          { id: "right", x: 1220, y: 1000, kind: "sink", open: [{ dir: "in", color: "red" }] },
        ] },
      });
      game.setPortrait(portrait);
      const view = new NetView(game);
      const controller = new Controller(game, view);
      const viewport = { x: 0, y: 0, width: 2400, height: 2400 };
      view.update(0, viewport);
      const source = portrait ? { x: 1000, y: 1057 } : { x: 1057, y: 1000 };
      const target = samePort ? source : portrait ? { x: 1000, y: 1163 } : { x: 1163, y: 1000 };
      controller.tap(source);
      const version = game.sim.net.version;
      controller.press(target);
      controller.sync();
      view.update(0, viewport);
      const preview = view.root.children[8].children[0] as Graphics;
      const proposed = drawing(preview);
      expect(proposed[0].path[0].action).toBe("circle");
      const arcs = proposed.slice(2);
      expect(arcs.filter((item) => item.action === "stroke" && item.width === 4)).toHaveLength(samePort ? 1 : 2);
      expect(arcs.some((item) => item.color === TOKEN_COLORS.blue)).toBe(true);
      if (!samePort) expect(arcs.some((item) => item.color === TOKEN_COLORS.red)).toBe(true);
      expect(game.sim.net.version).toBe(version);
      expect(game.sim.net.places.size).toBe(0);
      controller.release(target);
      controller.sync();
      view.update(0, viewport);
      expect(drawing(view.root.children[2] as Graphics)).toEqual(arcs);
      const place = [...game.sim.net.places.values()][0];
      expect(proposed[0].path[0].data.slice(0, 2)).toEqual([place.x, place.y]);
      expect(drawing(view.root.children[4] as Graphics)[0].path).toEqual(proposed[0].path);
      view.root.destroy({ children: true });
    });

  it.each([false, true].flatMap((portrait) => ["split", "mix"].map((kitId) => ({ portrait, kitId }))))(
    "previews each specific $kitId connector before building, portrait=$portrait", ({ portrait, kitId }) => {
      const game = new Game({ ...level2, goals: [], net: {
        places: [{ id: "anchor", x: 1000, y: 1000, marking: [] }], transitions: [], arcs: [],
      } });
      game.setPortrait(portrait);
      const view = new NetView(game);
      const controller = new Controller(game, view);
      const kit = game.level.tools!.kits!.find((candidate) => candidate.id === kitId)!;
      const point = { x: 1180, y: 1000 };
      controller.setBrush({ kind: "kit", kit });
      controller.press(point);
      controller.sync();
      view.update(0, { x: 0, y: 0, width: 2400, height: 2400 });
      const preview = drawing(view.root.children[8].children[0] as Graphics);
      expect(preview[0].path[0].action).toBe("roundRect");
      expect(game.sim.net.transitions.size).toBe(0);
      controller.release(point);
      controller.sync();
      view.update(0, { x: 0, y: 0, width: 2400, height: 2400 });
      expect(stubDrawing(view)).toEqual(preview.slice(1));
      view.root.destroy({ children: true });
    });

  it.each([false, true])("previews a connected relay's actual orientation and input arc, portrait=%s", (portrait) => {
    const game = new Game({ ...level2, goals: [], net: {
      places: [{ id: "anchor", x: 1000, y: 1000, marking: [] }], transitions: [], arcs: [],
    } });
    game.setPortrait(portrait);
    const view = new NetView(game);
    const controller = new Controller(game, view);
    const point = portrait ? { x: 1180, y: 1000 } : { x: 1000, y: 1180 };
    controller.tap({ x: 1000, y: 1000 });
    controller.press(point);
    controller.sync();
    const viewport = { x: 0, y: 0, width: 2400, height: 2400 };
    view.update(0, viewport);
    const preview = drawing(view.root.children[8].children[0] as Graphics);
    expect(preview[0].path[0].data.slice(2, 4)).toEqual(portrait ? [22, 64] : [64, 22]);
    const arcs = preview.filter((item) => item.action === "stroke" && item.width === 4);
    expect(arcs).toHaveLength(1);
    controller.release(point);
    controller.sync();
    view.update(0, viewport);
    const actual = drawing(view.root.children[2] as Graphics).filter((item) => item.action === "stroke" && item.width === 4);
    expect(actual).toEqual(arcs);
    view.root.destroy({ children: true });
  });

  it("uses small dashed connectors without shrinking their hit tolerance", () => {
    const game = new Game(level2);
    game.sim.net.addTransition({ id: "plug", x: 1500, y: 1000, kind: "normal", open: [{ dir: "out", color: "red" }] });
    const view = new NetView(game);
    view.update(0, { x: 0, y: 0, width: 2000, height: 1400 });
    const arcs = stubDrawing(view).filter((instruction) => instruction.action === "stroke")
      .flatMap((instruction) => instruction.path)
      .filter((shape) => shape.action === "arc" && shape.data[0] === 1557 && shape.data[1] === 1000);
    expect(arcs).toHaveLength(4);
    expect(arcs.every((shape) => shape.data[2] === 5)).toBe(true);
    expect(view.pick({ x: 1576, y: 1000 })).toEqual({ kind: "port", tid: "plug", index: 0 });
    expect(view.pick({ x: 1583, y: 1000 })).toEqual({ kind: "port", tid: "plug", index: 0 });
    view.root.scale.set(0.25);
    expect(view.pick({ x: 1500, y: 1000 })).toEqual({ kind: "transition", id: "plug" });
    expect(view.pick({ x: 1617, y: 1000 })).toEqual({ kind: "port", tid: "plug", index: 0 });
    game.sim.net.addPlace({ id: "nearPlug", x: 1630, y: 1000, capacity: 1, marking: [] });
    expect(view.pick({ x: 1630, y: 1000 })).toEqual({ kind: "place", id: "nearPlug" });
    view.root.destroy({ children: true });
  });

  it("tints deletion mode and emphasizes only the held removable target", () => {
    const game = new Game(level2);
    const view = new NetView(game);
    const controller = new Controller(game, view);
    controller.setBrush({ kind: "remove" });
    controller.press({ x: 280, y: 520 });
    controller.sync();
    view.update(0, { x: -300, y: -300, width: 1800, height: 1400 });
    const tint = view.root.children[1].children[0] as Graphics;
    expect(tint.context.instructions.some((instruction) =>
      instruction.action === "fill" && instruction.data.style.color === THEME.removal && instruction.data.style.alpha === 0.28)).toBe(true);
    const overlay = view.root.children[8] as Graphics;
    expect(overlay.context.instructions.some((instruction) =>
      instruction.action === "stroke" && instruction.data.style.color === THEME.removalGlow
      && instruction.data.style.width === 8)).toBe(true);
    expect(game.sim.net.places.get("pB")!.ghost).toBeFalsy();
    controller.cancelPress();
    controller.move({ x: 100, y: 180 });
    controller.sync();
    view.update(0, { x: -300, y: -300, width: 1800, height: 1400 });
    expect(drawing(overlay).some((item) => item.color === THEME.removalGlow && item.width === 4.5)).toBe(false);
    controller.cancel();
    controller.sync();
    view.update(0, { x: -300, y: -300, width: 1800, height: 1400 });
    expect(tint.context.instructions).toHaveLength(0);
    view.root.destroy({ children: true });
  });

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
    const glow = view["portGlows"].get("far:0")!.gfx;
    expect([glow.x, glow.y]).toEqual([plug.x, plug.y]);
    const mutedPlug = glow.context.instructions.find((instruction) =>
      instruction.action === "stroke" && instruction.data.style.color === THEME.muted
      && instruction.data.path.instructions.some((shape) =>
        shape.action === "arc" && shape.data[0] === 0 && shape.data[1] === 0));
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
