import { withinConnectionRange, type Game, type PowerupOffer } from "../game/game";
import type { Kit } from "../game/level";
import type { Pt } from "../render/geometry";
import type { Overlay, Pick } from "../render/netView";

interface ControllerView {
  overlay: Overlay;
  pick(p: Pt): Pick;
  deny(pick: Pick): void;
  rewardCollected?(offer: PowerupOffer, index: number): void;
}

/** What a tap does when it cannot be inferred from what was tapped. */
export type Brush =
  | { kind: "fire" }
  | { kind: "kit"; kit: Kit }
  | { kind: "remove" }
  | { kind: "auto" }
  | { kind: "capacity" }
  | { kind: "life" };

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
  }

  /** Selects `b`; selecting the active brush again switches back to firing. */
  setBrush(b: Brush): void {
    if (b.kind === "life") {
      this.effect(this.game.buyLife({ x: this.game.size.width / 2, y: this.game.size.height / 2 }));
      return;
    }
    this.brush = sameBrush(b, this.brush) ? FIRE : b;
    this.hasInteracted = true;
    this.selected = undefined;
    this.selectedPlace = undefined;
  }

  cancel(): void {
    this.brush = FIRE;
    this.selected = undefined;
    this.selectedPlace = undefined;
  }

  move(p?: Pt): void {
    this.pointer = p;
  }

  /** Whether tapping this pick changes the game or gives interaction feedback. */
  interactive(pick: Pick): boolean {
    if (this.game.complete || this.game.paused) return false;
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

  tap(p: Pt): void {
    this.pointer = p;
    const game = this.game;
    if (game.complete || game.paused) return;
    const pick = this.view.pick(p);
    if (pick.kind === "reward") {
      const offer = game.offers.get(pick.id);
      if (!this.effect(game.collectOffer(pick.id, pick.index))) this.view.deny(pick);
      else if (offer) this.view.rewardCollected?.(offer, pick.index);
      return;
    }
    if (pick.kind === "place") game.touchPlace(pick.id);
    if (this.selectedPlace && pick.kind === "empty" && game.relayKit()) {
      const tid = game.buildConnectedTransition(this.selectedPlace, pick.x, pick.y);
      if (tid === undefined) {
        this.view.deny(pick);
        return;
      }
      this.selectedPlace = undefined;
      this.selected = { tid, index: 0 };
      this.hasInteracted = true;
      return;
    }
    if (this.selectedPlace && (pick.kind === "port" || pick.kind === "transition")) {
      const place = this.selectedPlace;
      const tid = pick.kind === "port" ? pick.tid : pick.id;
      const index = pick.kind === "port" ? pick.index : this.firstConnectiblePort(tid, place);
      this.selectedPlace = undefined;
      if (index === undefined || !this.effect(game.connect(tid, index, place))) this.view.deny(pick);
      return;
    }
    if (pick.kind === "port" || (pick.kind === "transition" && this.selected && game.level.tools?.place)) {
      const tid = pick.kind === "port" ? pick.tid : pick.id;
      const index = pick.kind === "port" ? pick.index : this.firstBridgeablePort(tid);
      if (index === undefined) {
        this.view.deny(pick);
        return;
      }
      this.brush = FIRE;
      this.selectedPlace = undefined;
      if (this.selected && game.level.tools?.place) {
        const from = this.selected;
        if (!this.effect(game.connectPorts(from, { tid, index }, true, p))) {
          this.view.deny(pick);
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
        if (game.buildConnectedPlace(tid, index, pick.x, pick.y) === undefined) {
          this.view.deny(pick);
          return;
        }
        this.selected = game.sim.net.transitions.get(tid)?.open?.length ? { tid, index: 0 } : undefined;
        this.hasInteracted = true;
        return;
      }
      this.selected = undefined;
      if (pick.kind === "place" && this.effect(game.connect(tid, index, pick.id))) {
        // Keep wiring the same transition while it has loose ends.
        if (game.sim.net.transitions.get(tid)?.open?.length) this.selected = { tid, index: 0 };
      } else if (pick.kind === "place") this.view.deny(pick);
      return;
    }
    if (this.brush.kind === "fire" && pick.kind === "place" && this.game.level.tools) {
      this.selectedPlace = this.selectedPlace === pick.id ? undefined : pick.id;
      this.hasInteracted = true;
      return;
    }
    this.selectedPlace = undefined;
    if (!this.act(pick, true)) this.view.deny(pick);
  }

  /** Updates what the view shows for the current brush and pointer; call once per frame. */
  sync(): void {
    const game = this.game;
    if (this.brush.kind === "kit" && !game.availableKits().includes(this.brush.kit)) this.brush = FIRE;
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
    const relay = this.selectedPlace && game.relayKit();
    this.view.overlay = {
      pointer: this.pointer,
      hoverAction: (pick) => this.interactive(pick),
      build: canBuildConnected ? { kind: "place", capacity: 1, connection: this.selected }
        : relay ? { kind: "transition", ports: relay.ports.filter((port) => port.dir === "out"), fromPlace: this.selectedPlace }
        : b.kind === "kit" ? { kind: "transition", ports: b.kit.ports, canPlace: (x, y) => game.canBuildTransition(b.kit, x, y) } : undefined,
      target: this.selected
        ? (pick) => pick.kind === "place"
          ? this.game.connect(this.selected!.tid, this.selected!.index, pick.id, false)
          : pick.kind === "port" ? !!game.level.tools?.place && game.connectPorts(this.selected!, pick, false, this.pointer)
            : pick.kind === "transition" && this.firstBridgeablePort(pick.id) !== undefined
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
      selected: this.selected,
      selectedPlace: this.selectedPlace,
    };
  }

  /** Explains what a tap does now. */
  hint(): string {
    if (this.game.level.mode === "endless") {
      if (this.game.epoch > 100) return "";
      if (!this.hasInteracted && this.game.epoch < 2) return "Move tokens from sources to sinks. Tap a transition to make it fire.";
      if (this.game.epoch > 10 && this.brush.kind === "fire") return "";
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
          : "Tap a dark transition to fire it. Fill the empty circles next to each goal by delivering tokens of their color.";
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
  private act(pick: Pick, apply: boolean): boolean {
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
            this.brush = FIRE;
            this.selected = game.sim.net.transitions.get(pick.id)?.open?.length ? { tid: pick.id, index: 0 } : undefined;
          }
          return true;
        }
        if (pick.kind !== "empty") return false;
        if (!apply) return game.canBuildTransition(b.kit, pick.x, pick.y);
        const id = game.buildTransition(b.kit, pick.x, pick.y);
        if (id === undefined) return false;
        this.brush = FIRE;
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
    }
  }
}

export function sameBrush(a: Brush, b: Brush): boolean {
  return a.kind === b.kind && (a.kind !== "kit" || (b.kind === "kit" && a.kit === b.kit));
}
