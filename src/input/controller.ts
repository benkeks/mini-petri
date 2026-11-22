import type { Game } from "../game/game";
import type { Kit } from "../game/level";
import type { Pt } from "../render/geometry";
import type { NetView, Pick } from "../render/netView";

/** What a tap does when it cannot be inferred from what was tapped. */
export type Brush =
  | { kind: "fire" }
  | { kind: "place" }
  | { kind: "kit"; kit: Kit }
  | { kind: "remove" }
  | { kind: "auto" }
  | { kind: "faster" }
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
  if (tools.faster) brushes.push({ kind: "faster" });
  if (tools.capacity) brushes.push({ kind: "capacity" });
  return brushes;
}

/**
 * Turns single-button taps into game actions. Open ports can be picked up with any brush and are
 * connected by tapping a place; everything else depends on the tapped object and the active brush.
 */
export class Controller {
  brush: Brush = FIRE;
  selected?: { tid: string; index: number };
  private pointer?: Pt;

  constructor(
    private game: Game,
    private view: NetView,
  ) {}

  attach(game: Game, view: NetView): void {
    this.game = game;
    this.view = view;
    this.brush = FIRE;
    this.selected = undefined;
    this.pointer = undefined;
  }

  /** Selects `b`; selecting the active brush again switches back to firing. */
  setBrush(b: Brush): void {
    this.brush = sameBrush(b, this.brush) ? FIRE : b;
    this.selected = undefined;
  }

  cancel(): void {
    this.brush = FIRE;
    this.selected = undefined;
  }

  move(p: Pt): void {
    this.pointer = p;
  }

  tap(p: Pt): void {
    this.pointer = p;
    const game = this.game;
    if (game.complete) return;
    const pick = this.view.pick(p);
    if (pick.kind === "port") {
      const same = this.selected?.tid === pick.tid && this.selected.index === pick.index;
      this.selected = same ? undefined : { tid: pick.tid, index: pick.index };
      return;
    }
    if (this.selected) {
      const { tid, index } = this.selected;
      this.selected = undefined;
      if (pick.kind === "place" && game.connect(tid, index, pick.id)) {
        // Keep wiring the same transition while it has loose ends.
        if (game.sim.net.transitions.get(tid)?.open?.length) this.selected = { tid, index: 0 };
      } else if (pick.kind === "place") this.view.deny(pick);
      return;
    }
    if (!this.act(pick, true)) this.view.deny(pick);
  }

  /** Updates what the view shows for the current brush and pointer; call once per frame. */
  sync(): void {
    const b = this.brush;
    this.view.overlay = {
      pointer: this.pointer,
      build: b.kind === "place" ? { kind: "place" } : b.kind === "kit" ? { kind: "transition", ports: b.kit.ports } : undefined,
      target: this.selected
        ? (pick) => pick.kind === "place" && this.game.connect(this.selected!.tid, this.selected!.index, pick.id, false)
        : b.kind === "fire" || b.kind === "place" || b.kind === "kit"
          ? undefined
          : (pick) => this.act(pick, false),
      removing: !this.selected && b.kind === "remove",
      selected: this.selected,
    };
  }

  /** Explains what a tap does now. */
  hint(): string {
    if (this.selected) return "Tap a place to connect this loose end to it.";
    switch (this.brush.kind) {
      case "fire":
        return this.game.level.tools
          ? "Tap a dark transition to fire it. Tap a loose end to connect it. Pick a tool below to build, remove or upgrade."
          : "Tap a dark transition to fire it. Fill the empty circles next to each goal by delivering tokens of their color.";
      case "place":
        return "Tap inside the shaded area to build a place.";
      case "kit":
        return "Tap inside the shaded area to build this transition, then connect its loose ends to places.";
      case "remove":
        return "Tap an arc, place or transition to remove it. Goals cannot be removed.";
      case "auto":
        return "Tap a manual transition to make it fire on its own.";
      case "faster":
        return "Tap an automatic transition to make it fire more often.";
      case "capacity":
        return "Tap a place to let it hold more tokens.";
    }
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
      case "faster":
        return pick.kind === "transition" && game.upgradeFaster(pick.id, apply);
      case "capacity":
        return pick.kind === "place" && game.upgradeCapacity(pick.id, apply);
    }
  }
}

export function sameBrush(a: Brush, b: Brush): boolean {
  return a.kind === b.kind && (a.kind !== "kit" || (b.kind === "kit" && a.kit === b.kit));
}
