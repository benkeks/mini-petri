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
      for (let i = 0; i < 10; i++) expect(game.sim.fire("starterSource")).toBe(true);
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
  it.each([
    [49, 1, 0, false], [50, 0, 0, false],
    [50, 1, 0.019, true], [50, 1, 0.02, false],
    [50, 7, 0.039, true], [50, 7, 0.04, false],
  ])("offers rare survival hearts at epoch %i after %i losses with roll %f: %s", (epoch, losses, roll, heart) => {
    const definition = structuredClone(endless);
    definition.net.transitions.find((t) => t.id === "starterSource")!.autoInterval = undefined;
    definition.net.transitions.push({ id: "reward", x: 900, y: 400, kind: "sink" });
    definition.net.arcs.push({ id: "rewardArc", from: "starterDestination", to: "reward", color: "yellow" });
    definition.goals.push({ sinkId: "reward", color: "yellow", count: 1 });
    for (let i = 1; i < losses; i++) {
      definition.net.transitions.push({ id: `loss${i}`, x: 1000 + i * 120, y: 0, kind: "sink" });
      definition.goals.push({ sinkId: `loss${i}`, color: "blue", count: 5 });
    }
    let fixed = 0.5;
    const game = new Game(definition, () => fixed, { survival: true });
    if (losses) game.sim.step(240);
    for (let i = 0; i < epoch; i++) {
      game.sim.net.places.get("starterPlace")!.marking = [];
      for (let j = 0; j < 10; j++) expect(game.sim.fire("starterSource")).toBe(true);
      game.step(0);
      game.sim.step(1);
    }
    expect(game.epoch).toBe(epoch);
    fixed = roll;
    game.sim.net.places.get("starterDestination")!.marking.push("yellow");
    expect(game.sim.fire("reward")).toBe(true);
    game.step(3);
    const offer = [...game.offers.values()].find((offer) => offer.x === 900 && offer.y === 400)!;
    expect(offer).toBeDefined();
    expect(offer.choices.some((choice) => choice.kind === "life")).toBe(heart);
    expect(offer.choices[0].id).not.toBe(offer.choices[1].id);
    if (heart) {
      const before = game.lives;
      expect(game.collectOffer(offer.id, 1)).toBe(true);
      expect(game.lives).toBe(before + 1);
      expect(game.lifePrice).toBe(50);
      expect(game.powerupStock("life")).toBe(0);
    }
  });

  it("keeps a heart offer at the cap and makes existing hearts useful after switching to endless", () => {
    const game = new Game(endless, Math.random, { survival: true });
    const life = POWERUPS.find((choice) => choice.kind === "life")!;
    game.offers.set("heart", { id: "heart", x: 0, y: 0, expiresAt: 120, choices: [life, POWERUPS[0]] });
    expect(game.collectOffer("heart", 0)).toBe(false);
    expect(game.offers.has("heart")).toBe(true);
    game.continueEndless();
    const coins = game.coins;
    expect(game.collectOffer("heart", 0)).toBe(true);
    expect(game.coins).toBe(coins + 5);
  });

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
    expect(offer.choices.map((choice) => choice.id)).toEqual(["coins5", "auto"]);
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
    const coins = game.coins;
    const events: { amount: number; x: number; y: number }[] = [];
    game.onCoins((event) => events.push(event));
    expect(appearingAt).toBeGreaterThan(0);
    game.step(offer.expiresAt - game.sim.time - 0.01);
    expect(game.offers.has(offer.id)).toBe(true);
    expect(game.coins).toBe(coins);
    game.step(0.02);
    expect(game.offers.has(offer.id)).toBe(false);
    expect(game.collectOffer(offer.id, 0)).toBe(false);
    expect(game.coins).toBe(coins + 1);
    expect(events).toEqual([{ amount: 1, x: offer.x, y: offer.y }]);
    game.step(1);
    expect(game.coins).toBe(coins + 1);
  });

  it("does not grant an expiry coin for a collected offer", () => {
    const { game, finish } = setup();
    const offer = finish(0);
    expect(game.collectOffer(offer.id, 0)).toBe(true);
    const coins = game.coins;
    game.step(POWERUP_LIFETIME + 1);
    expect(game.coins).toBe(coins);
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
    const { game, finish, reachEpoch, setRandom } = setup();
    reachEpoch(10);
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
    [119, "redBlueToYellow"], [120, "redTwoBlueToYellow"], [149, "redTwoBlueToYellow"], [150, "coins20"],
  ])("unlocks the latest offer at epoch %i", (epoch, expected) => {
    const { game, finish, reachEpoch, setRandom } = setup();
    reachEpoch(epoch);
    setRandom(0.999);
    const offer = finish(0);
    expect(offer.choices[0].id).toBe(expected);
    expect(offer.choices[0].id).not.toBe(offer.choices[1].id);
    expect(game.offers.size).toBe(1);
  });

  it.each([[9, false], [10, true]] as const)("unlocks capacity rewards and the tool at epoch %i: %s", (epoch, unlocked) => {
    const { game, finish, reachEpoch, setRandom } = setup();
    reachEpoch(epoch);
    setRandom(0);
    const offer = finish(0);
    expect(offer.choices.some((choice) => choice.kind === "capacity")).toBe(unlocked);
    expect(brushesOf(game).some((brush) => brush.kind === "capacity")).toBe(unlocked);
    expect(brushesOf(game).some((brush) => brush.kind === "kit" && brush.kit === game.relayKit())).toBe(false);
  });

  it("stacks free upgrades, uses them before coins, and never refunds free upgrades", () => {
    const { game, finish, reachEpoch, setRandom } = setup(3);
    reachEpoch(10);
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
    expect(game.upgradePrice).toBe(5);
    expect(game.autoUpgradeLevel("starterRelay")).toBe(2);
    expect(game.powerupStock("auto")).toBe(0);
    expect(game.upgradeAuto("starterRelay")).toBe(true);
    expect(game.coins).toBe(STARTING_COINS - 5);
    expect(game.upgradePrice).toBe(6);
    expect(game.autoUpgradeLevel("starterRelay")).toBe(3);
    game.sim.net.addPlace({ id: "small", x: 2000, y: 2000, capacity: 1, marking: [] });
    expect(game.upgradeCapacity("small")).toBe(true);
    expect(game.powerupStock("capacity")).toBe(0);
    expect(game.coins).toBe(STARTING_COINS - 5);
    expect(game.remove("small")).toBe(true);
    expect(game.coins).toBe(STARTING_COINS - 5);
    expect(game.remove("starterRelay")).toBe(true);
    expect(game.coins).toBe(STARTING_COINS - 2);
    expect(game.autoUpgradeLevel("starterRelay")).toBe(0);
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

  it("awards twenty coins after the hundred-and-fiftieth epoch", () => {
    const { game, finish, reachEpoch, setRandom } = setup();
    reachEpoch(150);
    setRandom(0.999);
    const offer = finish(0);
    expect(offer.choices[0].id).toBe("coins20");
    expect(game.collectOffer(offer.id, 0)).toBe(true);
    expect(game.coins).toBe(STARTING_COINS + 20);
  });

  it.each([
    [7, 1], [8, 0.66], [15, 0.66], [16, 0.4356], [25, 0.4356], [26, 0.287496],
  ])("reduces transition offer weights at stock %i to %f", (stock, weight) => {
    const boundary = 3 / (3 + weight);
    let roll = boundary - 1e-8;
    const game = new Game(endless, () => roll);
    game["endlessEpoch"] = 15;
    game["coinBalance"] = 50;
    game["inventory"].set("blueMultiply", stock);
    game["spawnOffer"]({ x: 0, y: 0 }, 0);
    expect([...game.offers.values()].at(-1)!.choices.map((choice) => choice.id)).toEqual(["auto", "blueMultiply"]);
    roll = boundary + 1e-8;
    game["spawnOffer"]({ x: 0, y: 0 }, 0);
    expect([...game.offers.values()].at(-1)!.choices.map((choice) => choice.id)).toEqual(["blueMultiply", "auto"]);
    expect(game.powerupStock("blueMultiply")).toBe(stock);
  });

  it.each([
    [249, "redToGreen", "redToBlueGreen"],
    [250, "redToBlueGreen", "redToGreen"],
    [299, "coins10", "coins50"],
    [300, "coins50", "coins10"],
  ])("replaces offers at epoch %i with %s rather than %s", (epoch, wanted, excluded) => {
    let roll = 0;
    const game = new Game(endless, () => roll);
    game["endlessEpoch"] = epoch;
    game["coinBalance"] = 50;
    for (let i = 0; i < 100; i++) {
      roll = (i + 0.5) / 100;
      game["spawnOffer"]({ x: 0, y: 0 }, 0);
    }
    const offered = [...game.offers.values()].flatMap((offer) => offer.choices.map((choice) => choice.id));
    expect(offered).toContain(wanted);
    expect(offered).not.toContain(excluded);
  });

  it("keeps old conversion offers usable and awards fifty coins from the replacement", () => {
    const game = new Game(endless, () => 0.999);
    const old = POWERUPS.find((choice) => choice.id === "redToGreen")!;
    game.offers.set("old", { id: "old", x: 0, y: 0, expiresAt: 120, choices: [old, POWERUPS[0]] });
    game["endlessEpoch"] = 300;
    expect(game.collectOffer("old", 0)).toBe(true);
    expect(game.powerupStock("redToGreen")).toBe(1);
    expect(game.availableKits().some((kit) => kit.id === "redToGreen")).toBe(true);
    game["spawnOffer"]({ x: 0, y: 0 }, 0);
    const offer = [...game.offers.values()].at(-1)!;
    expect(offer.choices[0].id).toBe("coins50");
    const restored = new Game(endless, () => 0, { snapshot: game.snapshot() });
    expect(restored.offers.get(offer.id)!.choices).toEqual(offer.choices);
    expect(restored.powerupStock("redToGreen")).toBe(1);
    const coins = game.coins;
    expect(game.collectOffer(offer.id, 0)).toBe(true);
    expect(game.coins).toBe(coins + 50);
  });

  it("converts one red token into one blue and one green with the replacement kit", () => {
    const powerup = POWERUPS.find((choice) => choice.id === "redToBlueGreen");
    if (!powerup || powerup.kind !== "kit") throw new Error("Missing red-to-blue-green kit");
    const net = new Net({
      places: [{ id: "input", x: 0, y: 0, marking: ["red"] }, { id: "output", x: 200, y: 0, marking: [] }],
      transitions: [{ id: "convert", x: 100, y: 0, kind: "normal", open: powerup.kit.ports }], arcs: [],
    });
    net.connect("convert", 0, "input");
    net.connect("convert", 0, "output");
    net.connect("convert", 0, "output");
    const sim = new Simulation(net, { tokenSpeed: 100 });
    expect(sim.fire("convert")).toBe(true);
    expect(sim.incoming("output")).toEqual({ blue: 1, green: 1 });
    sim.step(2.1);
    expect(net.places.get("input")!.marking).toEqual([]);
    expect(net.places.get("output")!.marking).toEqual(["blue", "green"]);
  });

  it.each([
    [49, 0.3, ["coins5", "auto"]],
    [50, 0.3, ["capacity", "auto"]],
    [51, 0.3, ["capacity", "auto"]],
    [49, 0.65, ["blueMultiply", "coins10"]],
    [50, 0.65, ["blueMultiply", "auto"]],
    [51, 0.65, ["blueMultiply", "auto"]],
  ])("weights both reward choices at %i coins with roll %f", (balance, roll, expected) => {
    const { game, finish, reachEpoch, setRandom } = setup();
    game.offers.set("balance", {
      id: "balance", x: 0, y: 0, expiresAt: 120,
      choices: [
        { id: "balance", label: "Coins", afterEpoch: 0, kind: "coins", amount: balance - STARTING_COINS },
        POWERUPS[0],
      ],
    });
    expect(game.collectOffer("balance", 0)).toBe(true);
    reachEpoch(20);
    expect(game.coins).toBe(balance);
    game["inventory"].set("auto", 26);
    game["inventory"].set("capacity", 26);
    setRandom(roll);
    const offer = finish(0);
    expect(offer.choices.map((choice) => choice.id)).toEqual(expected);
    expect(offer.choices[0].id).not.toBe(offer.choices[1].id);
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
      .toEqual(["fire", "auto", "capacity", "splitAny", "remove"]);
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
    for (let i = 0; i < 3; i++) {
      game.sim.net.addTransition({ id: `spend${i}`, x: -1000 - 100 * i, y: 0, kind: "normal" });
      expect(game.upgradeAuto(`spend${i}`)).toBe(true);
    }
    expect(game.coins).toBe(2);
    const nextPoint = buildPoint()!;
    expect(nextPoint).toBeDefined();
    let insufficient = 0;
    game.onInsufficientCoins(() => { insufficient++; });
    expect(game.canBuildTransition(kit, nextPoint.x, nextPoint.y)).toBe(false);
    expect(game.buildTransition(kit, 400, 400)).toBeUndefined();
    expect(insufficient).toBe(0);
    expect(game.buildTransition(kit, nextPoint.x, nextPoint.y)).toBeUndefined();
    expect(insufficient).toBe(1);
    expect(game.powerupStock(powerup.id)).toBe(1);
  });

  it("converts a wired relay through the tool, retaining speed upgrades and already committed tokens", () => {
    const { game, finish, reachEpoch, setRandom } = setup();
    reachEpoch(15);
    setRandom(0.999);
    const offer = finish(0);
    const powerup = offer.choices[0];
    if (powerup.kind !== "kit") throw new Error("Expected blue multiplier kit");
    expect(game.collectOffer(offer.id, 0)).toBe(true);
    const transition = game.sim.net.transitions.get("starterRelay")!;
    expect(game.upgradeAuto(transition.id)).toBe(true);
    expect(game.upgradeAuto(transition.id)).toBe(true);
    const interval = transition.autoInterval;
    const upgradePrice = game.upgradePrice;
    const coins = game.coins;
    const arcs = game.sim.net.arcsOf(transition.id);
    game.sim.net.places.get("starterPlace")!.marking = ["red", "blue", "blue"];
    expect(game.sim.fire(transition.id)).toBe(true);
    game.sim.step(0.2);
    const timer = game.sim.autoProgress(transition.id);
    const denied: Pick[] = [];
    const view = { overlay: {} as Overlay, pick: (): Pick => ({ kind: "transition", id: transition.id }), deny: (pick: Pick) => denied.push(pick) };
    const controller = new Controller(game, view);
    controller.setBrush({ kind: "kit", kit: powerup.kit });
    controller.sync();
    expect(view.overlay.target?.({ kind: "transition", id: transition.id })).toBe(true);
    expect(game.coins).toBe(coins);
    expect(game.powerupStock(powerup.id)).toBe(1);
    expect(controller.press({ x: transition.x, y: transition.y })).toBe(true);
    controller.sync();
    expect(view.overlay.pressed).toEqual({ kind: "transition", id: transition.id });
    expect(game.sim.net.inputs(transition.id)[0].color).toBeUndefined();
    expect(game.coins).toBe(coins);
    expect(game.powerupStock(powerup.id)).toBe(1);
    controller.release({ x: transition.x, y: transition.y });
    expect(denied).toHaveLength(0);
    expect(controller.brush.kind).toBe("fire");
    expect(controller.selected).toBeUndefined();
    expect(game.sim.net.transitions.get(transition.id)).toBe(transition);
    expect(transition.autoInterval).toBe(interval);
    expect(game.sim.autoProgress(transition.id)).toBe(timer);
    expect(game.autoUpgradeLevel(transition.id)).toBe(2);
    expect(game.upgradePrice).toBe(upgradePrice);
    expect(game.coins).toBe(coins - 7);
    expect(game.powerupStock(powerup.id)).toBe(0);
    for (const arc of arcs) expect(game.sim.net.arcs.get(arc.id)).toBe(arc);
    expect(game.sim.net.inputs(transition.id)[0]).toMatchObject({ color: "blue", count: 2 });
    expect(game.sim.net.outputs(transition.id)[0]).toMatchObject({ color: "blue", count: 3 });
    expect(game.sim.incoming("starterDestination")).toEqual({ red: 1 });
    expect(game.sim.fire(transition.id)).toBe(true);
    expect(game.sim.incoming("starterDestination")).toEqual({ red: 1, blue: 3 });
    game.sim.step(2);
    expect(game.sim.net.places.get("starterDestination")!.marking).toEqual(["red", "blue", "blue", "blue"]);
  });

  it("preserves matching arc colors and selects newly required ports after a partial conversion", () => {
    const { game, finish, reachEpoch, setRandom } = setup();
    reachEpoch(90);
    setRandom(0.999);
    const offer = finish(0);
    const powerup = offer.choices[0];
    if (powerup.kind !== "kit") throw new Error("Expected red/blue to yellow kit");
    expect(game.collectOffer(offer.id, 0)).toBe(true);
    game.sim.net.arcs.get("starterRelayInput")!.color = "blue";
    const view = { overlay: {} as Overlay, pick: (): Pick => ({ kind: "transition", id: "starterRelay" }), deny: () => { throw new Error("Conversion denied"); } };
    const controller = new Controller(game, view);
    controller.setBrush({ kind: "kit", kit: powerup.kit });
    controller.tap({ x: 600, y: 400 });
    expect(game.sim.net.inputs("starterRelay")[0]).toMatchObject({ color: "blue", count: 1 });
    expect(game.sim.net.outputs("starterRelay")[0]).toMatchObject({ color: "yellow", count: 1 });
    expect(game.sim.net.transitions.get("starterRelay")!.open).toEqual([{ dir: "in", color: "red", count: 1 }]);
    expect(controller.selected).toEqual({ tid: "starterRelay", index: 0 });
    expect(controller.brush.kind).toBe("fire");
  });

  it("switches color-copy functionality without altering tokens committed by the previous type", () => {
    const { game, finish, reachEpoch, setRandom } = setup(2);
    reachEpoch(15);
    setRandom(0.999);
    const blue = finish(0);
    expect(game.collectOffer(blue.id, 0)).toBe(true);
    reachEpoch(25);
    const copy = finish(1);
    expect(game.collectOffer(copy.id, 0)).toBe(true);
    const kit = (id: string) => game.availableKits().find((kit) => kit.id === id)!;
    expect(game.convertTransition("starterRelay", kit("splitAny"))).toBe(true);
    expect(game.sim.net.transitions.get("starterRelay")!.copyInputColor).toBe(true);
    game.sim.net.places.get("starterPlace")!.marking = ["red", "blue"];
    expect(game.sim.fire("starterRelay")).toBe(true);
    expect(game.convertTransition("starterRelay", kit("blueMultiply"))).toBe(true);
    expect(game.sim.net.transitions.get("starterRelay")!.copyInputColor).toBeUndefined();
    game.sim.step(2);
    expect(game.sim.net.places.get("starterDestination")!.marking).toEqual(["red", "blue", "red"]);
  });

  it("does not spend a kit on a transition with equivalent live and open ports", () => {
    const { game, finish, reachEpoch, setRandom } = setup();
    reachEpoch(15);
    setRandom(0.999);
    const offer = finish(0);
    const powerup = offer.choices[0];
    if (powerup.kind !== "kit") throw new Error("Expected multiplier kit");
    expect(game.collectOffer(offer.id, 0)).toBe(true);
    const input = game.sim.net.arcs.get("starterRelayInput")!;
    const output = game.sim.net.arcs.get("starterRelayOutput")!;
    input.color = "blue";
    input.count = 2;
    output.color = "blue";
    output.count = 3;
    const transition = game.sim.net.transitions.get("starterRelay")!;
    const version = game.sim.net.version;
    const coins = game.coins;
    expect(game.convertTransition(transition.id, powerup.kit, false)).toBe(false);
    expect(game.convertTransition(transition.id, powerup.kit)).toBe(false);
    expect(game.sim.net.version).toBe(version);
    expect(game.coins).toBe(coins);
    expect(game.powerupStock(powerup.id)).toBe(1);
    expect(game.remove(output.id)).toBe(true);
    const open = transition.open;
    expect(game.convertTransition(transition.id, powerup.kit)).toBe(false);
    expect(transition.open).toBe(open);
    expect(game.powerupStock(powerup.id)).toBe(1);
    input.count = 1;
    expect(game.convertTransition(transition.id, powerup.kit)).toBe(true);
  });

  it("rejects source, sink, incompatible and unaffordable conversions without spending", () => {
    const { game, finish, reachEpoch, setRandom } = setup();
    reachEpoch(15);
    setRandom(0.999);
    const offer = finish(0);
    const powerup = offer.choices[0];
    if (powerup.kind !== "kit") throw new Error("Expected multiplier kit");
    expect(game.collectOffer(offer.id, 0)).toBe(true);
    game.sim.net.addTransition({ id: "incompatible", x: 2000, y: 0, kind: "normal" });
    for (let i = 0; i < 2; i++) game.sim.net.addArc({ id: `extra${i}`, from: "starterPlace", to: "incompatible", color: "blue" });
    const coins = game.coins;
    const version = game.sim.net.version;
    for (const id of ["starterSource", "starterSink", "incompatible", "missing"]) {
      expect(game.convertTransition(id, powerup.kit, false)).toBe(false);
      expect(game.convertTransition(id, powerup.kit)).toBe(false);
    }
    game.paused = true;
    expect(game.convertTransition("starterRelay", powerup.kit)).toBe(false);
    game.paused = false;
    expect(game.sim.net.version).toBe(version);
    expect(game.coins).toBe(coins);
    expect(game.powerupStock(powerup.id)).toBe(1);
    for (let i = 0; i < 5; i++) {
      game.sim.net.addTransition({ id: `spend${i}`, x: -2000 - i * 100, y: 0, kind: "normal" });
      expect(game.upgradeAuto(`spend${i}`)).toBe(true);
    }
    expect(game.coins).toBe(5);
    let insufficient = 0;
    game.onInsufficientCoins(() => { insufficient++; });
    expect(game.convertTransition("starterRelay", powerup.kit, false)).toBe(false);
    expect(game.convertTransition("incompatible", powerup.kit)).toBe(false);
    expect(game.convertTransition("starterSource", powerup.kit)).toBe(false);
    expect(insufficient).toBe(0);
    expect(game.convertTransition("starterRelay", powerup.kit)).toBe(false);
    expect(insufficient).toBe(1);
    expect(game.powerupStock(powerup.id)).toBe(1);
  });

  it("allows free upgrades with no coins and leaves a reward intact when the upgrade is invalid", () => {
    const { game, finish, reachEpoch, buildPoint, setRandom } = setup(3);
    setRandom(0.999);
    const auto = finish(0);
    reachEpoch(10);
    const capacity = finish(1);
    reachEpoch(15);
    const kitOffer = finish(2);
    expect(kitOffer.choices[0].id).toBe("blueToRed");
    expect(game.collectOffer(kitOffer.id, 0)).toBe(true);
    const powerup = POWERUPS.find((item) => item.id === "blueToRed");
    if (!powerup || powerup.kind !== "kit") throw new Error("Missing blue-to-red kit");
    const point = buildPoint()!;
    expect(game.buildTransition(powerup.kit, point.x, point.y)).toBeDefined();
    for (let i = 0; i < 5; i++) {
      game.sim.net.addTransition({ id: `buyer${i}`, x: -6000 - i * 100, y: 0, kind: "normal" });
      expect(game.upgradeAuto(`buyer${i}`)).toBe(true);
    }
    expect(game.coins).toBe(0);
    let insufficient = 0;
    game.onInsufficientCoins(() => { insufficient++; });
    expect(game.collectOffer(auto.id, 0)).toBe(true);
    expect(game.collectOffer(capacity.id, 1)).toBe(true);
    expect(game.upgradeCapacity("starterPlace")).toBe(false);
    expect(game.powerupStock("capacity")).toBe(1);
    game.sim.net.addPlace({ id: "freePlace", x: -4000, y: 0, capacity: 1, marking: [] });
    expect(game.upgradeCapacity("freePlace")).toBe(true);
    expect(game.upgradeAuto("starterRelay")).toBe(true);
    expect(game.coins).toBe(0);
    expect(insufficient).toBe(0);
    expect(game.upgradeAuto("starterRelay")).toBe(false);
    expect(insufficient).toBe(1);
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
