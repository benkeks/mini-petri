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
  | { kind: "capacity" };

export const FIRE: Brush = { kind: "fire" };

/** The brushes a level offers, the default "fire" brush first. */
export function brushesOf(game: Game): Brush[] {
  const tools = game.level.tools;
  if (!tools) return [FIRE];
  const brushes: Brush[] = [FIRE];
  const kits = game.availableKits();
  const relay = game.relayKit();
  for (const kit of kits) if (kit === relay) brushes.push({ kind: "kit", kit });
  if (tools.auto) brushes.push({ kind: "auto" });
  if (tools.capacity) brushes.push({ kind: "capacity" });
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

  constructor(
    private game: Game,
    private view: ControllerView,
  ) {}

  attach(game: Game, view: ControllerView): void {
    this.game = game;
    this.view = view;
    this.brush = FIRE;
    this.selected = undefined;
    this.selectedPlace = undefined;
    this.pointer = undefined;
  }

  /** Selects `b`; selecting the active brush again switches back to firing. */
  setBrush(b: Brush): void {
    this.brush = sameBrush(b, this.brush) ? FIRE : b;
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
    if (pick.kind === "reward" || pick.kind === "port" || pick.kind === "place") return true;
    if (this.selected || this.selectedPlace) return true;
    switch (this.brush.kind) {
      case "fire":
        return pick.kind === "transition" && this.game.sim.net.transitions.get(pick.id)?.kind === "normal";
      case "kit":
        return pick.kind === "empty" || pick.kind === "transition";
      case "remove":
        return pick.kind === "transition" || pick.kind === "arc";
      case "auto":
        return pick.kind === "transition";
      case "capacity":
        return pick.kind === "transition";
    }
  }

  tap(p: Pt): void {
    this.pointer = p;
    const game = this.game;
    if (game.complete || game.paused) return;
    const pick = this.view.pick(p);
    if (pick.kind === "reward") {
      const offer = game.offers.get(pick.id);
      if (!game.collectOffer(pick.id, pick.index)) this.view.deny(pick);
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
      return;
    }
    if (this.selectedPlace && (pick.kind === "port" || pick.kind === "transition")) {
      const place = this.selectedPlace;
      const tid = pick.kind === "port" ? pick.tid : pick.id;
      const index = pick.kind === "port" ? pick.index : this.firstConnectiblePort(tid, place);
      this.selectedPlace = undefined;
      if (index === undefined || !game.connect(tid, index, place)) this.view.deny(pick);
      return;
    }
    if (pick.kind === "port") {
      this.brush = FIRE;
      this.selectedPlace = undefined;
      const same = this.selected?.tid === pick.tid && this.selected.index === pick.index;
      this.selected = same ? undefined : { tid: pick.tid, index: pick.index };
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
        return;
      }
      this.selected = undefined;
      if (pick.kind === "place" && game.connect(tid, index, pick.id)) {
        // Keep wiring the same transition while it has loose ends.
        if (game.sim.net.transitions.get(tid)?.open?.length) this.selected = { tid, index: 0 };
      } else if (pick.kind === "place") this.view.deny(pick);
      return;
    }
    if (this.brush.kind === "fire" && pick.kind === "place" && this.game.level.tools) {
      this.selectedPlace = this.selectedPlace === pick.id ? undefined : pick.id;
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
        ? (pick) => pick.kind === "place" && this.game.connect(this.selected!.tid, this.selected!.index, pick.id, false)
        : this.selectedPlace
          ? (pick) => pick.kind === "port"
            ? game.connect(pick.tid, pick.index, this.selectedPlace!, false)
            : pick.kind === "transition" && this.firstConnectiblePort(pick.id, this.selectedPlace!) !== undefined
        : b.kind === "fire" || b.kind === "kit"
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
    if (this.selected) return this.game.level.tools?.place
      ? "Tap a place inside the ring, or empty space to build a small place."
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
        return "Tap inside the white area to build this transition, then connect its loose ends to places.";
      case "remove":
        return "Tap an arc, place or transition to remove it. Sources and sinks cannot be removed.";
      case "auto":
        return this.game.powerupStock("auto") ? "Tap a transition to use a free time upgrade." : "Tap a transition to automate or speed it up (5 coins).";
      case "capacity":
        return this.game.powerupStock("capacity") ? "Tap a place to use a free capacity upgrade." : "Tap a place to increase its capacity (5 coins).";
    }
  }

  private firstConnectiblePort(tid: string, pid: string): number | undefined {
    const ports = this.game.sim.net.transitions.get(tid)?.open ?? [];
    for (const dir of ["in", "out"] as const) {
      const index = ports.findIndex((port, i) => port.dir === dir && this.game.connect(tid, i, pid, false));
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
        return apply ? game.playerFire(pick.id) : game.sim.isEnabled(pick.id);
      }
      case "kit": {
        if (pick.kind !== "empty") return false;
        if (!apply) return game.canBuildTransition(b.kit, pick.x, pick.y);
        const id = game.buildTransition(b.kit, pick.x, pick.y);
        if (id === undefined) return false;
        this.brush = FIRE;
        this.selected = { tid: id, index: 0 };
        return true;
      }
      case "remove":
        return pick.kind !== "empty" && pick.kind !== "port" && pick.kind !== "reward" && game.remove(pick.id, apply);
      case "auto":
        return pick.kind === "transition" && game.upgradeAuto(pick.id, apply);
      case "capacity":
        return pick.kind === "place" && game.upgradeCapacity(pick.id, apply);
    }
  }
}

export function sameBrush(a: Brush, b: Brush): boolean {
  return a.kind === b.kind && (a.kind !== "kit" || (b.kind === "kit" && a.kit === b.kit));
}
