import { describe, expect, it } from "vitest";
import { Net, type NetSpec } from "../src/core/net";
import { Simulation } from "../src/core/simulation";

// p1 --(red)--> t --(2 blue)--> p2 --(blue)--> t2, nodes 100 units apart.
function spec(): NetSpec {
  return {
    places: [
      { id: "p1", x: 0, y: 0, marking: ["red"] },
      { id: "p2", x: 200, y: 0, marking: [] },
    ],
    transitions: [
      { id: "t", x: 100, y: 0, kind: "normal" },
      { id: "t2", x: 300, y: 0, kind: "normal" },
    ],
    arcs: [
      { id: "a1", from: "p1", to: "t", color: "red" },
      { id: "a2", from: "t", to: "p2", color: "blue", count: 2 },
      { id: "a3", from: "p2", to: "t2", color: "blue" },
    ],
  };
}

// src place p --(any ×count)--> t --(any ×count)--> q
function anySpec(marking: NetSpec["places"][0]["marking"], count = 1): NetSpec {
  return {
    places: [
      { id: "p", x: 0, y: 0, marking },
      { id: "q", x: 200, y: 0, marking: [] },
    ],
    transitions: [{ id: "t", x: 100, y: 0, kind: "normal" }],
    arcs: [
      { id: "in", from: "p", to: "t", count },
      { id: "out", from: "t", to: "q", count },
    ],
  };
}

describe("Simulation", () => {
  it("consumes inputs immediately and emits outputs only after the inputs reach the transition", () => {
    const sim = new Simulation(new Net(spec()), { tokenSpeed: 100 });
    expect(sim.fire("t")).toBe(true);
    expect(sim.net.places.get("p1")!.marking).toEqual([]);
    expect(sim.inFlight.map((t) => t.kind)).toEqual(["input"]);
    expect(sim.incoming("p2")).toEqual({ blue: 2 });

    sim.step(0.9);
    expect(sim.inFlight.map((t) => t.kind)).toEqual(["input"]);
    sim.step(0.2);
    expect(sim.inFlight.map((t) => [t.kind, t.color, t.slot, t.batch])).toEqual([
      ["output", "blue", 0, 2],
      ["output", "blue", 1, 2],
    ]);
    expect(sim.net.places.get("p2")!.marking).toEqual([]);

    sim.step(1);
    expect(sim.net.places.get("p2")!.marking).toEqual(["blue", "blue"]);
    expect(sim.inFlight).toHaveLength(0);
    expect(sim.incoming("p2")).toEqual({});
  });

  it("reports completion when inputs arrive", () => {
    const sim = new Simulation(new Net(spec()), { tokenSpeed: 100 });
    const done: number[] = [];
    sim.onComplete((e) => done.push(e.time));
    sim.fire("t");
    sim.step(0.5);
    expect(done).toEqual([]);
    sim.step(0.6);
    expect(done).toHaveLength(1);
  });

  it("does not let in-flight tokens enable transitions", () => {
    const sim = new Simulation(new Net(spec()), { tokenSpeed: 100 });
    sim.fire("t");
    expect(sim.isEnabled("t2")).toBe(false);
    expect(sim.fire("t2")).toBe(false);
    sim.step(2.05);
    expect(sim.isEnabled("t2")).toBe(true);
  });

  it("requires tokens of the arc's color", () => {
    const s = spec();
    s.places[0].marking = ["blue", "green"];
    const sim = new Simulation(new Net(s));
    expect(sim.isEnabled("t")).toBe(false);
  });

  it("disables transitions whose output place would exceed capacity, counting committed tokens", () => {
    const s = spec();
    s.places[0].marking = ["red", "red", "red"];
    s.places[1].capacity = 3;
    const sim = new Simulation(new Net(s), { tokenSpeed: 100 });
    expect(sim.fire("t")).toBe(true);
    // 2 blue committed to p2, another firing would make 4 > 3.
    expect(sim.isEnabled("t")).toBe(false);
    sim.step(2.05);
    expect(sim.net.places.get("p2")!.marking).toEqual(["blue", "blue"]);
    expect(sim.isEnabled("t")).toBe(false);
    sim.fire("t2");
    expect(sim.isEnabled("t")).toBe(true);
  });

  it("allows a full place to be refilled by a transition that also consumes from it", () => {
    const sim = new Simulation(
      new Net({
        places: [{ id: "p", x: 0, y: 0, capacity: 2, marking: ["red", "red"] }],
        transitions: [{ id: "t", x: 100, y: 0, kind: "normal" }],
        arcs: [
          { id: "in", from: "p", to: "t", color: "red" },
          { id: "out", from: "t", to: "p", color: "blue" },
        ],
      }),
    );
    expect(sim.isEnabled("t")).toBe(true);
  });

  it("auto-fires on interval and waits while disabled", () => {
    const s = spec();
    s.transitions[0].autoInterval = 1;
    s.places[0].marking = [];
    const sim = new Simulation(new Net(s), { tokenSpeed: 100 });
    const fired: number[] = [];
    sim.onFire((e) => fired.push(e.time));

    sim.step(1.5);
    expect(fired).toEqual([]);
    expect(sim.autoProgress("t")).toBe(1);

    sim.net.places.get("p1")!.marking.push("red", "red");
    sim.step(0.1);
    expect(fired).toHaveLength(1);
    expect(sim.autoProgress("t")).toBe(0);
    sim.step(1.1);
    expect(fired).toHaveLength(2);
  });

  it("always enables sources without inputs", () => {
    const sim = new Simulation(
      new Net({
        places: [{ id: "p", x: 50, y: 0, marking: [] }],
        transitions: [{ id: "src", x: 0, y: 0, kind: "source" }],
        arcs: [{ id: "a", from: "src", to: "p", color: "green" }],
      }),
      { tokenSpeed: 100 },
    );
    expect(sim.fire("src")).toBe(true);
    expect(sim.fire("src")).toBe(true);
    sim.step(1);
    expect(sim.net.places.get("p")!.marking).toEqual(["green", "green"]);
  });

  it("gives places a default capacity of 7", () => {
    const net = new Net(spec());
    expect(net.places.get("p1")!.capacity).toBe(7);
  });

  it("never fires disabled transitions", () => {
    const s = spec();
    s.transitions[0].disabled = true;
    const sim = new Simulation(new Net(s));
    expect(sim.fire("t")).toBe(false);
  });

  it("removes a transition with its arcs and travelling tokens", () => {
    const sim = new Simulation(new Net(spec()), { tokenSpeed: 100 });
    sim.fire("t");
    sim.removeTransition("t");
    expect(sim.net.transitions.has("t")).toBe(false);
    expect([...sim.net.arcs.keys()]).toEqual(["a3"]);
    expect(sim.inFlight).toEqual([]);
    expect(sim.incoming("p2")).toEqual({});
    sim.step(3);
    expect(sim.net.places.get("p2")!.marking).toEqual([]);
  });

  it("rejects arcs between two places", () => {
    const s = spec();
    s.arcs.push({ id: "bad", from: "p1", to: "p2", color: "red" });
    expect(() => new Net(s)).toThrow();
  });
});

describe("any-color arcs", () => {
  it("take the oldest tokens and pass their colors on", () => {
    const sim = new Simulation(new Net(anySpec(["green", "red", "blue"], 2)), { tokenSpeed: 100 });
    expect(sim.fire("t")).toBe(true);
    expect(sim.net.places.get("p")!.marking).toEqual(["blue"]);
    expect(sim.incoming("q")).toEqual({ green: 1, red: 1 });
    sim.step(2.05);
    expect(sim.net.places.get("q")!.marking).toEqual(["green", "red"]);
  });

  it("leave tokens needed by colored arcs from the same place", () => {
    const s = anySpec(["red", "blue"]);
    s.arcs.push({ id: "red", from: "p", to: "t", color: "red" });
    const sim = new Simulation(new Net(s));
    expect(sim.fire("t")).toBe(true);
    expect(sim.incoming("q")).toEqual({ blue: 1 });
    expect(sim.net.places.get("p")!.marking).toEqual([]);
  });

  it("need enough tokens of any color", () => {
    const sim = new Simulation(new Net(anySpec(["red"], 2)));
    expect(sim.isEnabled("t")).toBe(false);
  });

  it("cannot output more tokens than any-color inputs supply", () => {
    const s = anySpec([]);
    s.arcs[1].count = 2;
    expect(() => new Net(s)).toThrow();
  });
});
