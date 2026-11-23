import { withinConnectionRange, type Game } from "../game/game";
import type { Kit } from "../game/level";
import type { Pt } from "../render/geometry";
import type { Overlay, Pick } from "../render/netView";

interface ControllerView {
  overlay: Overlay;
  pick(p: Pt): Pick;
  deny(pick: Pick): void;
}

/** What a tap does when it cannot be inferred from what was tapped. */
export type Brush =
  | { kind: "fire" }
  | { kind: "place" }
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
  if (tools.place) brushes.push({ kind: "place" });
  for (const kit of tools.kits ?? []) brushes.push({ kind: "kit", kit });
  if (tools.remove) brushes.push({ kind: "remove" });
  if (tools.auto) brushes.push({ kind: "auto" });
  if (tools.capacity) brushes.push({ kind: "capacity" });
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

  move(p: Pt): void {
    this.pointer = p;
  }

  tap(p: Pt): void {
    this.pointer = p;
    const game = this.game;
    if (game.complete) return;
    const pick = this.view.pick(p);
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
    const b = this.brush;
    const game = this.game;
    const selectedTransition = this.selected && this.game.sim.net.transitions.get(this.selected.tid);
    const canBuildConnected = this.selected && this.game.level.tools?.place && selectedTransition && !selectedTransition.ghost
      && selectedTransition.open?.[this.selected.index];
    this.view.overlay = {
      pointer: this.pointer,
      build: canBuildConnected ? { kind: "place", capacity: 1, connection: this.selected } : b.kind === "place" ? { kind: "place" } : b.kind === "kit" ? { kind: "transition", ports: b.kit.ports } : undefined,
      target: this.selected
        ? (pick) => pick.kind === "place" && this.game.connect(this.selected!.tid, this.selected!.index, pick.id, false)
        : this.selectedPlace
          ? (pick) => pick.kind === "port"
            ? game.connect(pick.tid, pick.index, this.selectedPlace!, false)
            : pick.kind === "transition" && this.firstConnectiblePort(pick.id, this.selectedPlace!) !== undefined
        : b.kind === "fire" || b.kind === "place" || b.kind === "kit"
          ? undefined
          : (pick) => this.act(pick, false),
      previewTarget: !this.selected && !this.selectedPlace && (b.kind === "place" || b.kind === "kit")
        ? (pick, point) => {
          if (game.complete) return false;
          if (b.kind === "kit") {
            const place = pick.kind === "place" && game.sim.net.places.get(pick.id);
            return !!place && !place.ghost && b.kit.ports.length > 0 && withinConnectionRange(place, point);
          }
          if (pick.kind === "port") return game.canConnectAt(pick.tid, pick.index, point.x, point.y);
          if (pick.kind !== "transition") return false;
          return game.sim.net.transitions.get(pick.id)?.open?.some((_, index) =>
            game.canConnectAt(pick.id, index, point.x, point.y)) ?? false;
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
    if (this.selectedPlace) return "Tap a transition or loose end inside the ring to connect it to this place.";
    switch (this.brush.kind) {
      case "fire":
        return this.game.level.tools
          ? "Tap a dark transition to fire it. Connect a place and a loose end in either order. Pick a tool below to build, remove or upgrade."
          : "Tap a dark transition to fire it. Fill the empty circles next to each goal by delivering tokens of their color.";
      case "place":
        return "Tap inside the white area to build a place.";
      case "kit":
        return "Tap inside the white area to build this transition, then connect its loose ends to places.";
      case "remove":
        return "Tap an arc, place or transition to remove it. Sources and sinks cannot be removed.";
      case "auto":
        return "Tap a transition to automate it; tap again to make it faster.";
      case "capacity":
        return "Tap a place to let it hold more tokens.";
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
      case "place":
      case "kit": {
        if (pick.kind !== "empty") return false;
        const kind = b.kind === "place" ? "place" : "transition";
        if (!apply) return !game.placementIssue(kind, pick.x, pick.y);
        const id = b.kind === "place" ? game.buildPlace(pick.x, pick.y) : game.buildTransition(b.kit, pick.x, pick.y);
        if (id === undefined) return false;
        this.brush = FIRE;
        if (b.kind === "kit") this.selected = { tid: id, index: 0 };
        return true;
      }
      case "remove":
        return pick.kind !== "empty" && pick.kind !== "port" && game.remove(pick.id, apply);
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
