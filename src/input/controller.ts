import { buildRange, withinConnectionRange, type Game, type PowerupOffer } from "../game/game";
import type { Kit } from "../game/level";
import type { Pt } from "../render/geometry";
import type { Overlay, Pick } from "../render/netView";

const TOUCH_CREATION_DELAY = 250;
const TOUCH_CREATION_DISTANCE = 40;

interface ControllerView {
  overlay: Overlay;
  pick(p: Pt): Pick;
  deny(pick: Pick, build?: boolean): void;
  rewardCollected?(offer: PowerupOffer, index: number): void;
}

/** What a tap does when it cannot be inferred from what was tapped. */
export type Brush =
  | { kind: "fire" }
  | { kind: "kit"; kit: Kit }
  | { kind: "remove" }
  | { kind: "auto" }
  | { kind: "capacity" }
  | { kind: "life" }
  | { kind: "bomb" };

export const FIRE: Brush = { kind: "fire" };

/** The brushes a level offers, the default "fire" brush first. */
export function brushesOf(game: Game): Brush[] {
  const tools = game.level.tools;
  if (!tools) return [FIRE];
  const brushes: Brush[] = [FIRE];
  const kits = game.availableKits();
  const relay = game.relayKit();
  if (tools.auto) brushes.push({ kind: "auto" });
  if (tools.capacity && (game.level.mode !== "endless" || game.epoch >= 10)) brushes.push({ kind: "capacity" });
  if (game.survival && game.hasLostLife) brushes.push({ kind: "life" });
  for (const kit of kits) if (kit !== relay) brushes.push({ kind: "kit", kit });
  if (game.powerupStock("bomb") > 0) brushes.push({ kind: "bomb" });
  if (tools.remove) brushes.push({ kind: "remove" });
  return brushes;
}

/**
 * Turns single-button taps into game actions. Picking an open port switches to firing and connects
 * it by tapping a place; everything else depends on the tapped object and the active brush.
 */
export class Controller {
  brush: Brush = FIRE;
  selected?: { tid: string; index: number };
  selectedPlace?: string;
  private pointer?: Pt;
  private hasInteracted = false;
  private touchSelection?: { port: { tid: string; index: number }; screen: Pt; time: number };
  private pressed?: Pick;
  private wiringStart?: Pick;
  private failureHint?: { text: string; remaining: number };
  private bridgePreview?: { key: string; position?: Pt };

  constructor(
    private game: Game,
    private view: ControllerView,
  ) {}

  attach(game: Game, view: ControllerView): void {
    if (this.game !== game) this.hasInteracted = false;
    this.game = game;
    this.view = view;
    this.brush = FIRE;
    this.selected = undefined;
    this.selectedPlace = undefined;
    this.pointer = undefined;
    this.touchSelection = undefined;
    this.pressed = undefined;
    this.wiringStart = undefined;
    this.failureHint = undefined;
    this.bridgePreview = undefined;
  }

  /** Selects `b`; selecting the active brush again switches back to firing. */
  setBrush(b: Brush): void {
    this.cancelPress();
    this.failureHint = undefined;
    if (b.kind === "life") {
      if (this.effect(this.game.buyLife({ x: this.game.size.width / 2, y: this.game.size.height / 2 }))) this.cancel();
      return;
    }
    this.brush = sameBrush(b, this.brush) ? FIRE : b;
    this.hasInteracted = true;
    this.selected = undefined;
    this.selectedPlace = undefined;
    this.touchSelection = undefined;
  }

  /** Starts an edit preview without mutating the net. Other actions remain ordinary taps. */
  press(p: Pt, touch?: { screen: Pt; time: number }): boolean {
    this.cancelPress();
    if (this.game.complete || this.game.paused) return false;
    this.pointer = p;
    const pick = this.view.pick(p);
    if ((this.brush.kind === "fire" || (this.brush.kind === "remove" && pick.kind === "port"))
      && this.game.level.tools && !this.selected && !this.selectedPlace
      && (pick.kind === "port" || pick.kind === "place")) {
      if (pick.kind === "port") this.brush = FIRE;
      this.wiringStart = pick;
      this.pressed = pick;
      if (pick.kind === "port") {
        this.selected = { tid: pick.tid, index: pick.index };
        this.touchSelection = touch ? { port: this.selected, screen: { ...touch.screen }, time: touch.time } : undefined;
      } else {
        this.selectedPlace = pick.id;
        this.game.touchPlace(pick.id);
      }
      this.hasInteracted = true;
      return true;
    }
    const edits = this.brush.kind === "kit" || this.brush.kind === "bomb" || (this.brush.kind === "remove" && pick.kind !== "empty")
      || (!!this.selected && (pick.kind === "empty" || pick.kind === "port" || pick.kind === "transition" || pick.kind === "place"))
      || (!!this.selectedPlace && (pick.kind === "port" || pick.kind === "transition" || pick.kind === "place"
        || (pick.kind === "empty" && !!this.game.relayKit())));
    if (edits && pick.kind !== "reward") this.pressed = pick;
    return !!this.pressed;
  }

  release(p: Pt, touch?: { screen: Pt; time: number }, chain = false): void {
    const pressed = this.pressed;
    const wiringStart = this.wiringStart;
    this.pressed = undefined;
    this.wiringStart = undefined;
    if (!pressed) return;
    if (wiringStart && samePick(wiringStart, this.view.pick(p))) {
      this.touchSelection = touch && this.selected
        ? { port: this.selected, screen: { ...touch.screen }, time: touch.time } : undefined;
      return;
    }
    // Dragging off a deletion target aborts instead of deleting a different object.
    if (this.brush.kind === "remove" && !samePick(pressed, this.view.pick(p))) return;
    this.tap(p, touch, chain);
  }

  cancelPress(): void {
    if (this.wiringStart) {
      this.selected = undefined;
      this.selectedPlace = undefined;
      this.touchSelection = undefined;
      this.wiringStart = undefined;
    }
    this.pressed = undefined;
  }

  cancel(): void {
    this.cancelPress();
    this.brush = FIRE;
    this.selected = undefined;
    this.selectedPlace = undefined;
    this.touchSelection = undefined;
    this.failureHint = undefined;
  }

  move(p?: Pt): void {
    this.pointer = p;
  }

  /** Whether tapping this pick changes the game or gives interaction feedback. */
  interactive(pick: Pick): boolean {
    if (this.game.complete || this.game.paused) return false;
    if (this.brush.kind === "bomb") return pick.kind === "reward"
      || (!!this.pointer && this.game.canPlaceBomb(this.pointer.x, this.pointer.y));
    if (pick.kind === "port" && this.selectedPlace) return this.game.connect(pick.tid, pick.index, this.selectedPlace, false);
    if (pick.kind === "port" && this.selected && this.game.level.tools?.place) return this.game.connectPorts(this.selected, pick, false, this.pointer);
    if (pick.kind === "transition" && this.selectedPlace) return this.firstConnectiblePort(pick.id, this.selectedPlace) !== undefined;
    if (pick.kind === "transition" && this.selected && this.game.level.tools?.place) return this.firstBridgeablePort(pick.id) !== undefined;
    if (pick.kind === "reward" || pick.kind === "port" || pick.kind === "place") return true;
    if (this.selected || this.selectedPlace) return true;
    switch (this.brush.kind) {
      case "fire":
        return pick.kind === "transition" && this.game.sim.net.transitions.get(pick.id)?.kind === "normal";
      case "kit":
        return pick.kind === "empty" || (pick.kind === "transition" && this.game.convertTransition(pick.id, this.brush.kit, false));
      case "remove":
        return pick.kind === "transition" || pick.kind === "arc";
      case "auto":
        return pick.kind === "transition";
      case "capacity":
        return pick.kind === "transition";
      case "life":
        return false;
    }
  }

  tap(p: Pt, touch?: { screen: Pt; time: number }, chain = false): void {
    this.pointer = p;
    const game = this.game;
    if (game.complete || game.paused) return;
    const pick = this.view.pick(p);
    if (!chain && this.abortBuild(pick, p)) {
      this.cancel();
      return;
    }
    if (chain && ((this.selected && pick.kind === "transition" && pick.id === this.selected.tid)
      || (this.selectedPlace && pick.kind === "place" && pick.id === this.selectedPlace))) {
      this.deny(pick);
      return;
    }
    const selection = this.touchSelection;
    if (touch && selection && selection.port === this.selected && game.level.tools?.place
      && (pick.kind === "empty" || pick.kind === "port" || pick.kind === "transition")
      && touch.time - selection.time < TOUCH_CREATION_DELAY
      && Math.hypot(touch.screen.x - selection.screen.x, touch.screen.y - selection.screen.y) < TOUCH_CREATION_DISTANCE) {
      this.deny(pick, "Wait 250 ms or move at least 40 screen pixels before creating a place.");
      return;
    }
    const selected = this.selected;
    this.applyTap(p, pick, chain);
    if (this.selected !== selected) {
      this.touchSelection = touch && this.selected
        ? { port: this.selected, screen: { ...touch.screen }, time: touch.time } : undefined;
    }
  }

  private abortBuild(pick: Pick, pointer: Pt): boolean {
    if (this.selected && pick.kind === "transition" && pick.id === this.selected.tid) return true;
    if (this.selectedPlace && pick.kind === "place" && pick.id === this.selectedPlace) return true;
    if (pick.kind === "reward") return false;
    const net = this.game.sim.net;
    const point = pick.kind === "place" ? net.places.get(pick.id)
      : pick.kind === "transition" ? net.transitions.get(pick.id)
        : pick.kind === "port" ? net.transitions.get(pick.tid)
          : pick.kind === "empty" ? pick : pointer;
    if (!point) return false;
    const origin = this.selected ? net.transitions.get(this.selected.tid)
      : this.selectedPlace ? net.places.get(this.selectedPlace) : undefined;
    if (origin && Math.hypot(point.x - origin.x, point.y - origin.y) > this.game.connectionRange(origin) * 1.5) {
      if (pick.kind === "place" && this.selected && this.game.connect(this.selected.tid, this.selected.index, pick.id, false)) return false;
      if (pick.kind === "port" && this.selectedPlace && this.game.connect(pick.tid, pick.index, this.selectedPlace, false)) return false;
      if (pick.kind === "port" && this.selected && this.game.connectPorts(this.selected, pick, false, pointer)) return false;
      if (pick.kind === "transition" && this.selectedPlace && this.firstConnectiblePort(pick.id, this.selectedPlace) !== undefined) return false;
      if (pick.kind === "transition" && this.selected && this.firstBridgeablePort(pick.id) !== undefined) return false;
      return true;
    }
    if (this.brush.kind === "kit") {
      if (pick.kind === "port" || (pick.kind === "transition" && this.game.convertTransition(pick.id, this.brush.kit, false))) return false;
      return net.liveNodes().every((node) => Math.hypot(point.x - node.x, point.y - node.y) > buildRange(node) * 1.5);
    }
    return false;
  }

  private applyTap(p: Pt, pick: Pick, chain: boolean): void {
    const game = this.game;
    if (pick.kind === "reward") {
      const offer = game.offers.get(pick.id);
      if (!this.effect(game.collectOffer(pick.id, pick.index))) this.deny(pick);
      else if (offer) this.view.rewardCollected?.(offer, pick.index);
      return;
    }
    if (this.brush.kind === "bomb") {
      if (!this.act(pick, true, chain)) this.deny(pick, "Cannot place a bomb. Check your stock and coins, and leave space from other bombs.");
      return;
    }
    if (pick.kind === "place") game.touchPlace(pick.id);
    if (this.selectedPlace && pick.kind === "empty" && (this.brush.kind === "kit" || game.relayKit())) {
      const kit = this.brush.kind === "kit" ? this.brush.kit : game.relayKit()!;
      const tid = game.buildConnectedTransition(this.selectedPlace, pick.x, pick.y, kit);
      if (tid === undefined) {
        this.deny(pick);
        return;
      }
      this.selectedPlace = undefined;
      this.selected = game.sim.net.transitions.get(tid)?.open?.length ? { tid, index: 0 } : undefined;
      if (!chain || !game.availableKits().includes(kit)) this.brush = FIRE;
      this.hasInteracted = true;
      return;
    }
    if (this.selectedPlace && (pick.kind === "port" || pick.kind === "transition")) {
      const place = this.selectedPlace;
      const tid = pick.kind === "port" ? pick.tid : pick.id;
      const index = pick.kind === "port" ? pick.index : this.firstConnectiblePort(tid, place);
      if (index === undefined || !this.effect(game.connect(tid, index, place))) {
        if (!chain) this.selectedPlace = undefined;
        this.deny(pick, undefined, true);
      } else {
        this.selectedPlace = undefined;
        if (!chain) this.brush = FIRE;
      }
      return;
    }
    if (chain && this.selectedPlace) {
      this.deny(pick, undefined, true);
      return;
    }
    if (pick.kind === "port" || (pick.kind === "transition" && this.selected && game.level.tools?.place)) {
      const tid = pick.kind === "port" ? pick.tid : pick.id;
      const index = pick.kind === "port" ? pick.index : this.firstBridgeablePort(tid);
      if (index === undefined) {
        this.deny(pick);
        return;
      }
      if (!chain) this.brush = FIRE;
      this.selectedPlace = undefined;
      if (this.selected && game.level.tools?.place) {
        const from = this.selected;
        if (!this.effect(game.connectPorts(from, { tid, index }, true, p))) {
          this.deny(pick);
          return;
        }
        const remaining = [from.tid, tid].find((tid) => game.sim.net.transitions.get(tid)?.open?.length);
        this.selected = remaining ? { tid: remaining, index: 0 } : undefined;
        return;
      }
      const same = this.selected?.tid === tid && this.selected.index === index;
      this.selected = same ? undefined : { tid, index };
      this.hasInteracted = true;
      return;
    }
    if (this.selected) {
      const { tid, index } = this.selected;
      if (pick.kind === "empty") {
        const place = game.buildConnectedPlace(tid, index, pick.x, pick.y);
        if (place === undefined) {
          this.deny(pick);
          return;
        }
        this.selected = game.sim.net.transitions.get(tid)?.open?.length ? { tid, index: 0 } : undefined;
        if (!chain) this.brush = FIRE;
        if (chain && !this.selected) this.selectedPlace = place;
        this.hasInteracted = true;
        return;
      }
      if (pick.kind === "place" && this.effect(game.connect(tid, index, pick.id))) {
        this.selected = undefined;
        if (!chain) this.brush = FIRE;
        // Keep wiring the same transition while it has loose ends.
        if (game.sim.net.transitions.get(tid)?.open?.length) this.selected = { tid, index: 0 };
        else if (chain) this.selectedPlace = pick.id;
      } else {
        if (!chain) this.selected = undefined;
        this.deny(pick, undefined, true);
      }
      return;
    }
    if (this.brush.kind === "fire" && pick.kind === "place" && this.game.level.tools) {
      this.selectedPlace = this.selectedPlace === pick.id ? undefined : pick.id;
      this.hasInteracted = true;
      return;
    }
    this.selectedPlace = undefined;
    const stock = this.brush.kind === "auto" || this.brush.kind === "capacity" ? game.powerupStock(this.brush.kind) : 0;
    if (!this.act(pick, true, chain)) this.deny(pick);
    else if ((this.brush.kind === "auto" || this.brush.kind === "capacity")
      && (!chain || (stock > 0 && game.powerupStock(this.brush.kind) === 0))) this.brush = FIRE;
  }

  /** Updates what the view shows for the current brush and pointer; call once per frame. */
  sync(dt = 0): void {
    if (this.failureHint) {
      this.failureHint.remaining -= dt;
      if (this.failureHint.remaining <= 0) this.failureHint = undefined;
    }
    const game = this.game;
    if (this.brush.kind === "kit" && !game.availableKits().includes(this.brush.kit)) this.brush = FIRE;
    if (this.brush.kind === "bomb" && game.powerupStock("bomb") === 0) this.brush = FIRE;
    const b = this.brush;
    if (this.selected) {
      const t = game.sim.net.transitions.get(this.selected.tid);
      if (!t || t.ghost || !t.open?.[this.selected.index]) this.selected = undefined;
    }
    if (this.selectedPlace) {
      const place = game.sim.net.places.get(this.selectedPlace);
      if (!place || place.ghost) this.selectedPlace = undefined;
    }
    const selectedTransition = this.selected && this.game.sim.net.transitions.get(this.selected.tid);
    const canBuildConnected = this.selected && this.game.level.tools?.place && selectedTransition && !selectedTransition.ghost
      && selectedTransition.open?.[this.selected.index];
    const relay = this.selectedPlace && (b.kind === "kit" ? b.kit : game.relayKit());
    const hover = this.pointer && this.view.pick(this.pointer);
    const existingPort = this.selectedPlace && hover?.kind === "transition"
      ? this.firstConnectiblePort(hover.id, this.selectedPlace) : undefined;
    const connection = this.selected && hover?.kind === "place"
      ? { ...this.selected, pid: hover.id }
      : this.selectedPlace && hover?.kind === "port"
        ? { tid: hover.tid, index: hover.index, pid: this.selectedPlace }
        : this.selectedPlace && hover?.kind === "transition" && existingPort !== undefined
          ? { tid: hover.id, index: existingPort, pid: this.selectedPlace } : undefined;
    const bridgeIndex = hover?.kind === "port" ? hover.index
      : hover?.kind === "transition" && this.selected && hover.id !== this.selected.tid ? this.firstBridgeablePort(hover.id) : undefined;
    let bridge: Pt | undefined;
    let bridgeTo: { tid: string; index: number } | undefined;
    if (this.pressed && this.selected && bridgeIndex !== undefined && hover
      && (hover.kind === "port" || hover.kind === "transition")) {
      const to = { tid: hover.kind === "port" ? hover.tid : hover.id, index: bridgeIndex };
      const key = JSON.stringify([game.sim.net.version, this.selected, to, this.pointer]);
      if (this.bridgePreview?.key !== key) {
        this.bridgePreview = { key, position: game.connectorPlacePosition(this.selected, to, this.pointer) };
      }
      bridge = this.bridgePreview.position;
      if (bridge) bridgeTo = to;
    }
    this.view.overlay = {
      pointer: this.pointer,
      connection,
      hoverAction: (pick) => this.interactive(pick),
      suppressTransitionConnections: b.kind === "fire" && !this.selected && !this.selectedPlace,
      bombPreview: b.kind === "bomb",
      build: canBuildConnected ? { kind: "place", capacity: 1, connection: this.selected, position: bridge, bridgeTo }
        : relay ? { kind: "transition", ports: relay.ports, fromPlace: this.selectedPlace,
          canPlace: (x, y) => game.canBuildConnectedTransition(this.selectedPlace!, x, y, relay) }
        : b.kind === "kit" ? { kind: "transition", ports: b.kit.ports, canPlace: (x, y) => game.canBuildTransition(b.kit, x, y) } : undefined,
      target: this.selected
        ? (pick) => pick.kind === "place"
          ? this.game.connect(this.selected!.tid, this.selected!.index, pick.id, false)
          : pick.kind === "port" ? !!game.level.tools?.place && game.connectPorts(this.selected!, pick, false, this.pointer)
            : pick.kind === "transition" && pick.id !== this.selected!.tid && this.firstBridgeablePort(pick.id) !== undefined
        : this.selectedPlace
          ? (pick) => pick.kind === "port"
            ? game.connect(pick.tid, pick.index, this.selectedPlace!, false)
            : pick.kind === "transition" && this.firstConnectiblePort(pick.id, this.selectedPlace!) !== undefined
        : b.kind === "kit"
          ? (pick) => pick.kind === "transition" && game.convertTransition(pick.id, b.kit, false)
        : b.kind === "fire"
          ? undefined
          : (pick) => this.act(pick, false),
      previewTarget: !this.selected && !this.selectedPlace && b.kind === "kit"
        ? (pick, point) => {
          if (game.complete) return false;
          const place = pick.kind === "place" && game.sim.net.places.get(pick.id);
          return !!place && !place.ghost && b.kit.ports.length > 0 && withinConnectionRange(place, point);
        }
        : undefined,
      removing: !this.selected && b.kind === "remove",
      pressed: this.pressed && hover && samePick(this.pressed, hover) ? hover : undefined,
      selected: this.selected,
      selectedPlace: this.selectedPlace,
    };
  }

  /** Explains what a tap does now. */
  hint(): string {
    if (this.brush.kind === "bomb") return this.failureHint?.text
      ?? "Place a bomb for 25 coins. Everything in the ring is destroyed after 3 seconds, except the starting source and place.";
    if (this.game.level.mode === "endless") {
      if (this.game.epoch > 100) return "";
      if (this.game.epoch > 10 && this.brush.kind === "fire") return "";
    }
    if (this.failureHint) return this.failureHint.text;
    if (this.game.level.mode === "endless") {
      if (!this.hasInteracted && this.game.epoch < 2) return "Move deliveries from sources to sinks. Tap a transition to make it fire.";
    }
    if (this.selected) return this.game.level.tools?.place
      ? "Tap a place to connect, a connector to add a nearby place, or empty space to build a small place."
      : "Tap a place inside the ring to connect this loose end.";
    if (this.selectedPlace) return this.game.relayKit()
      ? "Tap a transition or loose end, or empty space to build a relay."
      : "Tap a transition or loose end inside the ring to connect it to this place.";
    switch (this.brush.kind) {
      case "fire":
        return this.game.level.tools
          ? "Tap a dark transition to fire it. Tap a completed sink's reward to choose one. Pick a tool below to build, remove or upgrade."
          : "Tap a dark transition to fire it. Fill the empty boxes next to each goal with deliveries of their color.";
      case "kit":
        return "Tap inside the white area to build, or tap a compatible transition to convert it and keep its speed upgrades.";
      case "remove":
        return "Tap an arc, place or transition to remove it. Sources and sinks cannot be removed.";
      case "auto":
        return this.game.powerupStock("auto") ? "Tap a transition to use a free time upgrade." : `Tap a transition to automate or speed it up (${this.game.upgradePrice} coins).`;
      case "capacity":
        return this.game.powerupStock("capacity") ? "Tap a place to use a free capacity upgrade." : `Tap a place to increase its capacity (${this.game.upgradePrice} coins).`;
      case "life":
        return `Buy an extra life (${this.game.lifePrice} coins).`;
    }
  }

  private effect(success: boolean): boolean {
    if (success) this.hasInteracted = true;
    return success;
  }

  private deny(pick: Pick, reason?: string, build = !!this.selected || !!this.selectedPlace || this.brush.kind === "kit"): void {
    this.view.deny(pick, build);
    const game = this.game;
    if (reason) {
      this.failureHint = { text: reason, remaining: 10 };
    } else if (pick.kind === "empty" && (this.selected || this.selectedPlace || this.brush.kind === "kit")) {
      const kind = this.selected ? "place" : "transition";
      const issue = game.placementIssue(kind, pick.x, pick.y);
      const powerup = this.brush.kind === "kit" ? game.kitPowerup(this.brush.kit) : undefined;
      const text = issue === "far" ? "Outside building range. Build closer to your network."
        : issue === "crowded" ? "Not enough space. Leave more room between nodes."
        : this.selected || this.selectedPlace ? "Outside connection range. Build closer to the selected node."
        : powerup && game.powerupStock(powerup.id) === 0 ? "No transition kits remaining. Collect another kit reward."
        : "Not enough coins to build this transition.";
      this.failureHint = { text, remaining: 10 };
    } else if (this.selected && (pick.kind === "port" || pick.kind === "transition")) {
      this.failureHint = { text: "No space for a place within reach of both connectors. Move the connection closer or clear some room.", remaining: 10 };
    } else if (this.brush.kind === "kit") {
      this.failureHint = { text: "Cannot convert this node. Use a normal transition with compatible connections and enough coins.", remaining: 10 };
    } else if (this.brush.kind === "auto" || this.brush.kind === "capacity") {
      this.failureHint = { text: this.brush.kind === "auto"
        ? "Cannot upgrade. Choose a normal transition below maximum speed and check your coins."
        : "Cannot upgrade. Choose a place with room to grow, below maximum capacity, and check your coins.", remaining: 10 };
    }
  }

  private firstConnectiblePort(tid: string, pid: string): number | undefined {
    return this.firstPort(tid, (index) => this.game.connect(tid, index, pid, false));
  }

  private firstBridgeablePort(tid: string): number | undefined {
    const from = this.selected;
    return from && this.game.level.tools?.place
      ? this.firstPort(tid, (index) => this.game.connectPorts(from, { tid, index }, false, this.pointer))
      : undefined;
  }

  private firstPort(tid: string, connect: (index: number) => boolean): number | undefined {
    const ports = this.game.sim.net.transitions.get(tid)?.open ?? [];
    for (const dir of ["in", "out"] as const) {
      const index = ports.findIndex((port, i) => port.dir === dir && connect(i));
      if (index !== -1) return index;
    }
    return undefined;
  }

  /** Applies the active brush to `pick`, or only checks whether it would do something. */
  private act(pick: Pick, apply: boolean, chain = false): boolean {
    const game = this.game;
    const b = this.brush;
    switch (b.kind) {
      case "fire": {
        // Taps beside transitions, and on sources and sinks, are ignored rather than denied.
        if (pick.kind !== "transition") return apply;
        const t = game.sim.net.transitions.get(pick.id)!;
        if (t.kind !== "normal") return apply;
        return apply ? this.effect(game.playerFire(pick.id)) : game.sim.isEnabled(pick.id);
      }
      case "kit": {
        if (pick.kind === "transition") {
          if (!game.convertTransition(pick.id, b.kit, apply)) return false;
          if (apply) {
            this.hasInteracted = true;
            if (!chain || !game.availableKits().includes(b.kit)) this.brush = FIRE;
            this.selected = game.sim.net.transitions.get(pick.id)?.open?.length ? { tid: pick.id, index: 0 } : undefined;
          }
          return true;
        }
        if (pick.kind !== "empty") return false;
        if (!apply) return game.canBuildTransition(b.kit, pick.x, pick.y);
        const id = game.buildTransition(b.kit, pick.x, pick.y);
        if (id === undefined) return false;
        if (!chain || !game.availableKits().includes(b.kit)) this.brush = FIRE;
        this.selected = { tid: id, index: 0 };
        this.hasInteracted = true;
        return true;
      }
      case "remove":
        return pick.kind !== "empty" && pick.kind !== "port" && pick.kind !== "reward"
          && (apply ? this.effect(game.remove(pick.id)) : game.remove(pick.id, false));
      case "auto":
        return pick.kind === "transition" && (apply ? this.effect(game.upgradeAuto(pick.id)) : game.upgradeAuto(pick.id, false));
      case "capacity":
        return pick.kind === "place" && (apply ? this.effect(game.upgradeCapacity(pick.id)) : game.upgradeCapacity(pick.id, false));
      case "life":
        return false;
      case "bomb": {
        const point = this.pointer;
        if (!point) return false;
        if (!apply) return game.canPlaceBomb(point.x, point.y);
        if (game.placeBomb(point.x, point.y) === undefined) return false;
        this.hasInteracted = true;
        if (!chain || !game.powerupStock("bomb")) this.brush = FIRE;
        return true;
      }
    }
  }
}

export function sameBrush(a: Brush, b: Brush): boolean {
  return a.kind === b.kind && (a.kind !== "kit" || (b.kind === "kit" && a.kit === b.kit));
}

function samePick(a: Pick, b: Pick): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "port" && b.kind === "port") return a.tid === b.tid && a.index === b.index;
  return "id" in a && "id" in b && a.id === b.id;
}
