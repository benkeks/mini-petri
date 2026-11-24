import { describe, expect, it } from "vitest";
import design from "../docs/DESIGN.md?raw";
import { Net } from "../src/core/net";
import { Simulation } from "../src/core/simulation";
import { endless } from "../src/game/endless";
import { Game, POWERUP_LIFETIME, RESOLVED_LINGER, STARTING_COINS } from "../src/game/game";
import { POWERUPS } from "../src/game/powerups";
import { brushesOf, Controller } from "../src/input/controller";
import type { Overlay, Pick } from "../src/render/netView";

function setup(count = 1) {
  const definition = structuredClone(endless);
  definition.goals = [];
  definition.net.transitions.find((t) => t.id === "starterSource")!.autoInterval = undefined;
  definition.net.transitions.find((t) => t.id === "starterSink")!.autoInterval = undefined;
  for (let i = 0; i < count; i++) {
    definition.goals.push({ sinkId: `goal${i}`, color: "blue", count: 1 });
    definition.net.transitions.push({ id: `goal${i}`, x: 1000, y: 400, kind: "sink" });
    definition.net.arcs.push({ id: `goalArc${i}`, from: "starterDestination", to: `goal${i}`, color: "blue" });
  }
  let seed = 42;
  let fixed: number | undefined;
  const game = new Game(definition, () => {
    if (fixed !== undefined) return fixed;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  });
  const finish = (index: number) => {
    game.sim.net.places.get("starterDestination")!.marking.push("blue");
    expect(game.sim.fire(`goal${index}`)).toBe(true);
    game.step(3);
    const offer = [...game.offers.values()].at(-1);
    expect(offer).toBeDefined();
    return offer!;
  };
  const reachEpoch = (epochs: number) => {
    for (let epoch = 0; epoch < epochs; epoch++) {
      game.sim.net.places.get("starterPlace")!.marking = [];
      for (let i = 0; i < 6; i++) expect(game.sim.fire("starterSource")).toBe(true);
      game.step(0);
      game.sim.step(1);
    }
  };
  const buildPoint = () => game.sim.net.liveNodes().flatMap((node) =>
    Array.from({ length: 32 }, (_, i) => ({
      x: node.x + 200 * Math.cos(i * Math.PI / 16),
      y: node.y + 200 * Math.sin(i * Math.PI / 16),
    }))).find((point) => !game.placementIssue("transition", point.x, point.y));
  return { game, finish, reachEpoch, buildPoint, setRandom: (value: number) => { fixed = value; } };
}

describe("sink rewards", () => {
  it("keeps the documented powerup unlock table in sync with the definitions", () => {
    const section = design.split("### Powerup unlocks")[1]?.split("## Presentation")[0];
    expect(section).toBeDefined();
    const rows = section!.split("\n").filter((line) => /^\| \d+ \|/.test(line));
    const expected = POWERUPS.map((powerup) => {
      const label = powerup.kind === "kit" ? powerup.label.split("\n")[0] : powerup.label.replace("\n", " ");
      const cost = powerup.kind === "kit" ? String(powerup.price) : "—";
      return `| ${powerup.afterEpoch} | \`${powerup.id}\` | ${label} | ${cost} |`;
    });
    expect(rows).toEqual(expected);
  });

  it("appears only after a filled sink disappears, and lets one choice be collected", () => {
    const { game, setRandom } = setup();
    setRandom(0);
    game.sim.net.places.get("starterDestination")!.marking.push("blue");
    expect(game.sim.fire("goal0")).toBe(true);
    game.step(1);
    expect(game.resolved.has("goal0")).toBe(true);
    const resolvedAt = game.resolved.get("goal0")!;
    expect(game.offers.size).toBe(0);
    game.step(1.3);
    expect(game.sim.net.transitions.has("goal0")).toBe(false);
    const offer = [...game.offers.values()][0];
    expect(offer.choices.map((choice) => choice.id)).toEqual(["coins5", "capacity"]);
    expect(offer.expiresAt).toBeCloseTo(resolvedAt + RESOLVED_LINGER + POWERUP_LIFETIME);
    expect(game.collectOffer(offer.id, 0)).toBe(true);
    expect(game.coins).toBe(STARTING_COINS + 5);
    expect(game.collectOffer(offer.id, 1)).toBe(false);
    expect(game.powerupStock("capacity")).toBe(0);
    expect(game.offers.size).toBe(0);
  });

  it("expires exactly two minutes after appearing and cannot be collected afterwards", () => {
    const { game, finish } = setup();
    const offer = finish(0);
    const appearingAt = offer.expiresAt - POWERUP_LIFETIME;
    expect(appearingAt).toBeGreaterThan(0);
    game.step(offer.expiresAt - game.sim.time - 0.01);
    expect(game.offers.has(offer.id)).toBe(true);
    game.step(0.02);
    expect(game.offers.has(offer.id)).toBe(false);
    expect(game.collectOffer(offer.id, 0)).toBe(false);
  });

  it("keeps reward positions aligned when the world orientation changes", () => {
    const { game, finish } = setup();
    const offer = finish(0);
    const { x, y } = offer;
    game.setPortrait(true);
    expect(offer).toMatchObject({ x: y, y: x });
    game.setPortrait(false);
    expect(offer).toMatchObject({ x, y });
  });

  it("collects rewards through the controller without losing an existing wiring selection", () => {
    const { game, finish, setRandom } = setup();
    setRandom(0);
    const offer = finish(0);
    let pick: Pick = { kind: "port", tid: "starterRelay", index: 0 };
    game.sim.net.ghostArc("starterRelayInput");
    const view: { overlay: Overlay; pick(): Pick; deny(): void } = { overlay: {}, pick: () => pick, deny: () => {} };
    const controller = new Controller(game, view);
    controller.tap({ x: 0, y: 0 });
    const selected = controller.selected;
    pick = { kind: "reward", id: offer.id, index: 1 };
    controller.tap({ x: 0, y: 0 });
    expect(game.powerupStock("capacity")).toBe(1);
    expect(controller.selected).toEqual(selected);
  });

  it("does not collect rewards through the controller while paused", () => {
    const { game, finish } = setup();
    const offer = finish(0);
    const view: { overlay: Overlay; pick(): Pick; deny(): void } = {
      overlay: {}, pick: () => ({ kind: "reward", id: offer.id, index: 0 }), deny: () => {},
    };
    const controller = new Controller(game, view);
    game.paused = true;
    controller.tap({ x: offer.x, y: offer.y });
    expect(game.offers.has(offer.id)).toBe(true);
    game.paused = false;
    controller.tap({ x: offer.x, y: offer.y });
    expect(game.offers.has(offer.id)).toBe(false);
  });

  it.each([
    [0, "auto"], [14, "auto"], [15, "blueMultiply"], [19, "blueMultiply"], [20, "coins10"],
    [24, "coins10"], [25, "blueToRed"], [29, "blueToRed"], [30, "redToBlue"],
    [34, "redToBlue"], [35, "blueToGreen"], [39, "blueToGreen"], [40, "splitAny"],
    [59, "splitAny"], [60, "redToGreen"], [89, "redToGreen"], [90, "redBlueToYellow"],
    [119, "redBlueToYellow"], [120, "redTwoBlueToYellow"],
  ])("unlocks the latest offer at epoch %i", (epoch, expected) => {
    const { game, finish, reachEpoch, setRandom } = setup();
    reachEpoch(epoch);
    setRandom(0.999);
    const offer = finish(0);
    expect(offer.choices[0].id).toBe(expected);
    expect(offer.choices[0].id).not.toBe(offer.choices[1].id);
    expect(game.offers.size).toBe(1);
  });

  it("stacks free upgrades, uses them before coins, and never refunds free upgrades", () => {
    const { game, finish, setRandom } = setup(3);
    setRandom(0.999);
    for (let i = 0; i < 2; i++) {
      const offer = finish(i);
      expect(offer.choices[0].id).toBe("auto");
      expect(game.collectOffer(offer.id, 0)).toBe(true);
    }
    const placeOffer = finish(2);
    expect(placeOffer.choices[1].id).toBe("capacity");
    expect(game.collectOffer(placeOffer.id, 1)).toBe(true);
    expect(game.powerupStock("auto")).toBe(2);
    expect(game.upgradeAuto("starterRelay", false)).toBe(true);
    expect(game.powerupStock("auto")).toBe(2);
    expect(game.upgradeAuto("starterRelay")).toBe(true);
    expect(game.upgradeAuto("starterRelay")).toBe(true);
    expect(game.coins).toBe(STARTING_COINS);
    expect(game.powerupStock("auto")).toBe(0);
    expect(game.upgradeAuto("starterRelay")).toBe(true);
    expect(game.coins).toBe(STARTING_COINS - 5);
    game.sim.net.addPlace({ id: "small", x: 2000, y: 2000, capacity: 1, marking: [] });
    expect(game.upgradeCapacity("small")).toBe(true);
    expect(game.powerupStock("capacity")).toBe(0);
    expect(game.coins).toBe(STARTING_COINS - 5);
    expect(game.remove("small")).toBe(true);
    expect(game.coins).toBe(STARTING_COINS - 5);
    expect(game.remove("starterRelay")).toBe(true);
    expect(game.coins).toBe(STARTING_COINS - 2);
  });

  it("awards ten coins after the twentieth epoch", () => {
    const { game, finish, reachEpoch, setRandom } = setup();
    reachEpoch(20);
    setRandom(0.999);
    const offer = finish(0);
    expect(offer.choices[0].id).toBe("coins10");
    expect(game.collectOffer(offer.id, 0)).toBe(true);
    expect(game.coins).toBe(STARTING_COINS + 10);
  });

  it("keeps a limited kit until a valid affordable placement and charges each use", () => {
    const { game, finish, reachEpoch, buildPoint, setRandom } = setup(2);
    reachEpoch(40);
    setRandom(0.999);
    for (let i = 0; i < 2; i++) {
      const offer = finish(i);
      expect(offer.choices[0].id).toBe("splitAny");
      expect(game.collectOffer(offer.id, 0)).toBe(true);
    }
    const powerup = POWERUPS.find((item) => item.id === "splitAny");
    if (!powerup || powerup.kind !== "kit") throw new Error("Missing splitter");
    const kit = powerup.kit;
    expect(game.powerupStock(powerup.id)).toBe(2);
    expect(brushesOf(game).some((brush) => brush.kind === "kit" && brush.kit === kit)).toBe(true);
    expect(brushesOf(game).map((brush) => brush.kind === "kit" ? brush.kit.id : brush.kind))
      .toEqual(["fire", "relay", "auto", "capacity", "splitAny", "remove"]);
    expect(game.buildTransition(kit, 400, 400)).toBeUndefined();
    expect(game.powerupStock(powerup.id)).toBe(2);
    expect(game.coins).toBe(STARTING_COINS);
    const point = buildPoint()!;
    expect(point).toBeDefined();
    const id = game.buildTransition(kit, point.x, point.y);
    expect(id).toBeDefined();
    expect(game.sim.net.transitions.get(id!)?.copyInputColor).toBe(true);
    expect(game.powerupStock(powerup.id)).toBe(1);
    expect(game.coins).toBe(STARTING_COINS - 20);
    for (let i = 0; i < 4; i++) {
      game.sim.net.addTransition({ id: `spend${i}`, x: -1000 - 100 * i, y: 0, kind: "normal" });
      expect(game.upgradeAuto(`spend${i}`)).toBe(true);
    }
    expect(game.coins).toBe(0);
    const nextPoint = buildPoint()!;
    expect(nextPoint).toBeDefined();
    expect(game.buildTransition(kit, nextPoint.x, nextPoint.y)).toBeUndefined();
    expect(game.powerupStock(powerup.id)).toBe(1);
  });

  it("allows free upgrades with no coins and leaves a reward intact when the upgrade is invalid", () => {
    const { game, finish, setRandom } = setup(2);
    setRandom(0.999);
    const auto = finish(0);
    const capacity = finish(1);
    for (let i = 0; i < 8; i++) {
      game.sim.net.addTransition({ id: `buyer${i}`, x: -6000 - i * 100, y: 0, kind: "normal" });
      expect(game.upgradeAuto(`buyer${i}`)).toBe(true);
    }
    expect(game.coins).toBe(0);
    expect(game.collectOffer(auto.id, 0)).toBe(true);
    expect(game.collectOffer(capacity.id, 1)).toBe(true);
    expect(game.upgradeCapacity("starterPlace")).toBe(false);
    expect(game.powerupStock("capacity")).toBe(1);
    game.sim.net.addPlace({ id: "freePlace", x: -4000, y: 0, capacity: 1, marking: [] });
    expect(game.upgradeCapacity("freePlace")).toBe(true);
    expect(game.upgradeAuto("starterRelay")).toBe(true);
    expect(game.coins).toBe(0);
    expect(game.upgradeAuto("starterRelay")).toBe(false);
  });

  it.each([
    [15, "blueMultiply", 7], [25, "blueToRed", 5], [30, "redToBlue", 5], [35, "blueToGreen", 10],
    [40, "splitAny", 20], [60, "redToGreen", 5], [90, "redBlueToYellow", 10], [120, "redTwoBlueToYellow", 20],
  ])("charges %i-epoch kit %s its %i coin price", (epoch, id, price) => {
    const { game, finish, reachEpoch, buildPoint, setRandom } = setup();
    reachEpoch(epoch);
    setRandom(0.999);
    const offer = finish(0);
    expect(offer.choices[0].id).toBe(id);
    expect(game.collectOffer(offer.id, 0)).toBe(true);
    const item = POWERUPS.find((candidate) => candidate.id === id);
    if (!item || item.kind !== "kit") throw new Error(`Missing kit ${id}`);
    const point = buildPoint()!;
    expect(point).toBeDefined();
    expect(game.buildTransition(item.kit, point.x, point.y)).toBeDefined();
    expect(game.coins).toBe(STARTING_COINS - price);
    expect(game.powerupStock(id)).toBe(0);
    expect(brushesOf(game).some((brush) => brush.kind === "kit" && brush.kit === item.kit)).toBe(false);
  });
});

describe("generic splitter", () => {
  it.each(["blue", "red", "green", "yellow"] as const)("copies a %s token with capacity and animation rules intact", (color) => {
    const powerup = POWERUPS.find((item) => item.id === "splitAny");
    if (!powerup || powerup.kind !== "kit") throw new Error("Missing splitter");
    const input = powerup.kit.ports.find((port) => port.dir === "in")!;
    const output = powerup.kit.ports.find((port) => port.dir === "out")!;
    const sim = new Simulation(new Net({
      places: [
        { id: "in", x: 0, y: 0, marking: [color] },
        { id: "out", x: 200, y: 0, capacity: 2, marking: [] },
      ],
      transitions: [{ id: "t", x: 100, y: 0, kind: "normal", copyInputColor: powerup.kit.copyInputColor }],
      arcs: [{ id: "a", from: "in", to: "t", count: input.count }, { id: "b", from: "t", to: "out", count: output.count }],
    }), { tokenSpeed: 100 });
    expect(sim.fire("t")).toBe(false);
    sim.net.places.get("in")!.marking.push(color);
    expect(sim.fire("t")).toBe(false);
    sim.net.places.get("out")!.capacity = 3;
    expect(sim.fire("t")).toBe(true);
    expect(sim.incoming("out")).toEqual({ [color]: 3 });
    expect(sim.inFlight.map((token) => token.kind)).toEqual(["input", "input"]);
    sim.step(1.1);
    expect(sim.inFlight.map((token) => token.color)).toEqual([color, color, color]);
    sim.step(1);
    expect(sim.net.places.get("out")!.marking).toEqual([color, color, color]);
  });

  it("preserves both colors and duplicates the oldest when inputs differ", () => {
    const sim = new Simulation(new Net({
      places: [
        { id: "in", x: 0, y: 0, marking: ["red", "blue"] },
        { id: "out", x: 200, y: 0, capacity: 3, marking: [] },
      ],
      transitions: [{ id: "t", x: 100, y: 0, kind: "normal", copyInputColor: true }],
      arcs: [{ id: "a", from: "in", to: "t", count: 2 }, { id: "b", from: "t", to: "out", count: 3 }],
    }));
    expect(sim.fire("t")).toBe(true);
    expect(sim.incoming("out")).toEqual({ red: 2, blue: 1 });
    sim.step(1);
    expect(sim.net.places.get("out")!.marking).toEqual(["red", "blue", "red"]);
  });

  it.each([
    ["blueToRed", "blue", 2, "red", 1],
    ["redToBlue", "red", 1, "blue", 1],
    ["blueToGreen", "blue", 1, "green", 1],
    ["redToGreen", "red", 1, "green", 1],
    ["blueMultiply", "blue", 2, "blue", 3],
  ] as const)("builds %s with its specified token transformation", (id, inputColor, inputCount, outputColor, outputCount) => {
    const powerup = POWERUPS.find((item) => item.id === id);
    if (!powerup || powerup.kind !== "kit") throw new Error(`Missing kit ${id}`);
    const input = powerup.kit.ports.find((port) => port.dir === "in")!;
    const output = powerup.kit.ports.find((port) => port.dir === "out")!;
    const sim = new Simulation(new Net({
      places: [
        { id: "in", x: 0, y: 0, marking: Array(inputCount).fill(inputColor) },
        { id: "out", x: 200, y: 0, capacity: 19, marking: [] },
      ],
      transitions: [{ id: "t", x: 100, y: 0, kind: "normal" }],
      arcs: [
        { id: "a", from: "in", to: "t", color: input.color, count: input.count },
        { id: "b", from: "t", to: "out", color: output.color, count: output.count },
      ],
    }));
    expect(sim.fire("t")).toBe(true);
    expect(sim.net.places.get("in")!.marking).toHaveLength(0);
    expect(sim.incoming("out")).toEqual({ [outputColor]: outputCount });
    sim.step(1);
    expect(sim.net.places.get("out")!.marking).toEqual(Array(outputCount).fill(outputColor));
  });

  it.each([
    ["redBlueToYellow", 1, 1],
    ["redTwoBlueToYellow", 2, 2],
  ] as const)("fires %s only with the required red and blue tokens", (id, blueCount, yellowCount) => {
    const powerup = POWERUPS.find((item) => item.id === id);
    if (!powerup || powerup.kind !== "kit") throw new Error(`Missing kit ${id}`);
    const inputs = powerup.kit.ports.filter((port) => port.dir === "in");
    const output = powerup.kit.ports.find((port) => port.dir === "out")!;
    const sim = new Simulation(new Net({
      places: [
        { id: "in", x: 0, y: 0, marking: ["red"] },
        { id: "out", x: 200, y: 0, capacity: 7, marking: [] },
      ],
      transitions: [{ id: "t", x: 100, y: 0, kind: "normal" }],
      arcs: [
        ...inputs.map((port, index) => ({ id: `a${index}`, from: "in", to: "t", color: port.color, count: port.count })),
        { id: "b", from: "t", to: "out", color: output.color, count: output.count },
      ],
    }));
    expect(sim.fire("t")).toBe(false);
    sim.net.places.get("in")!.marking.push(...Array(blueCount).fill("blue"));
    expect(sim.fire("t")).toBe(true);
    expect(sim.incoming("out")).toEqual({ yellow: yellowCount });
    sim.step(1);
    expect(sim.net.places.get("out")!.marking).toEqual(Array(yellowCount).fill("yellow"));
  });
});
