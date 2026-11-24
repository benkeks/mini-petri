import { Container, Graphics, Text } from "pixi.js";
import { arcCount, type Arc, type Port, type Transition } from "../core/net";
import { buildRange, connectionRange, placementClearance, POWERUP_LIFETIME, RESOLVED_LINGER, type NodeKind, type PowerupOffer } from "../game/game";
import type { Game } from "../game/game";
import type { Powerup } from "../game/powerups";
import { placeRadius } from "../game/placeSize";
import {
  arcRoute,
  distanceToPolyline,
  lerp,
  offsetPolyline,
  outsidePlace,
  pointAt,
  polylineLength,
  subpath,
  TOKEN_SLOTS,
  type ArcRoute,
  type BarSize,
  type Pt,
} from "./geometry";
import { THEME, TOKEN_COLORS, TOKEN_RADIUS, TRANSITION_H, TRANSITION_W } from "./style";
import { drawToolIcon } from "./toolIcon";

const FLASH_TIME = 0.35;
const SHAKE_TIME = 0.3;
const MAX_ARROWHEADS = 5;
const HOP_HEIGHT = 18;
/** Length of the dangling stub of an open port, beyond the transition's outline. */
const STUB_LENGTH = 46;
const PLUG_RADIUS = 8;
/** Extra pick tolerance around targets, in screen pixels. */
const PICK_SLOP = 12;
const GHOST_ALPHA = 0.3;
const BUILD_FADE_TIME = 0.25;
const REWARD_WIDTH = 48;
const REWARD_HEIGHT = 48;
const REWARD_GAP = 8;
const REWARD_PICK_SLOP = 4;
const APPEAR_TIME = 0.4;
const REWARD_EXIT_TIME = 0.3;
const REWARD_FLIGHT_TIME = 0.75;
const BALANCE_TWEEN_TIME = 0.25;

/** What a tap at some point of the world hits. */
export type Pick =
  | { kind: "reward"; id: string; index: number }
  | { kind: "port"; tid: string; index: number }
  | { kind: "transition"; id: string }
  | { kind: "place"; id: string }
  | { kind: "arc"; id: string }
  | { kind: "empty"; x: number; y: number };

/** What the input controller wants shown on top of the net. */
export interface Overlay {
  /** Pointer position in world coordinates, if known. */
  pointer?: Pt;
  /** Picks whose tap would have an effect or give feedback. */
  hoverAction?: (pick: Pick) => boolean;
  /** Shows the build range and a preview of the node to build under the pointer. */
  build?: { kind: NodeKind; ports?: Port[]; capacity?: number; connection?: { tid: string; index: number }; fromPlace?: string; canPlace?: (x: number, y: number) => boolean };
  /** Picks the active brush can act on; they are highlighted. */
  target?: (pick: Pick) => boolean;
  /** Nodes and ports reachable from a node preview at the given world position. */
  previewTarget?: (pick: Pick, point: Pt) => boolean;
  /** The active brush removes things: the target under the pointer is tinted red. */
  removing?: boolean;
  /** The open port waiting to be connected to a place. */
  selected?: { tid: string; index: number };
  /** The place waiting to be connected to an open port. */
  selectedPlace?: string;
}

interface PortStub {
  tid: string;
  index: number;
  port: Port;
  /** Where the stub leaves the transition's outline, and its loose end. */
  edge: Pt;
  plug: Pt;
}

interface TransitionNode {
  t: Transition;
  container: Container;
  gfx: Graphics;
  firedAt: number;
  deniedAt: number;
  balance: Map<string, { position: Pt; from: Pt; target: Pt; elapsed: number }>;
}

interface RewardNode {
  offer: PowerupOffer;
  root: Container;
  timer: Graphics;
  choices: { root: Container; background: Graphics; border: Graphics }[];
  removedAt?: number;
  selected?: number;
}

/** Draws the net in world coordinates and tells which part of it lies under a point. */
export class NetView {
  readonly root = new Container();
  overlay: Overlay = {};
  rewardTarget?: (choice: Powerup) => Pt;
  private readonly rangeLayer = new Container();
  private readonly rangeBackground = new Graphics();
  private readonly rangeArea = new Graphics();
  private readonly rangeMask = new Graphics();
  private readonly collisionArea = new Graphics();
  private rangeFade = 0;
  private rangeVersion = -1;
  private rangeKind?: NodeKind;
  private rangeViewport?: { x: number; y: number; width: number; height: number };
  private readonly ghostLayer = new Container();
  private readonly ghostArcLayer = new Graphics();
  private readonly ghostPlaceLayer = new Graphics();
  private readonly arcLayer = new Graphics();
  private readonly stubLayer = new Graphics();
  private readonly placeLayer = new Graphics();
  private readonly tokenLayer = new Graphics();
  private readonly overlayLayer = new Graphics();
  private readonly rewardLayer = new Container();
  private rewardVersion = -1;
  private rewards: RewardNode[] = [];
  private readonly transitionLayer = new Container();
  private readonly labelLayer = new Container();
  /** Labels that belong to arcs and transitions; rebuilt with them. */
  private readonly staticLabels = new Container();
  private builtVersion = -1;
  private readonly overflowTexts = new Map<string, Text>();
  private readonly transitions = new Map<string, TransitionNode>();
  private readonly routes = new Map<string, ArcRoute>();
  private readonly layouts = new Map<string, { portrait: boolean; bar: BarSize }>();
  private stubs: PortStub[] = [];
  private readonly placeDeniedAt = new Map<string, number>();
  private ripples: { x: number; y: number; at: number }[] = [];
  /** Transition bars stand across the flow direction: vertical in landscape, horizontal in portrait. */
  private readonly bar: BarSize;

  constructor(private readonly game: Game) {
    this.bar = game.portrait ? { w: TRANSITION_H, h: TRANSITION_W } : { w: TRANSITION_W, h: TRANSITION_H };
    this.ghostLayer.alpha = GHOST_ALPHA;
    this.ghostLayer.addChild(this.ghostArcLayer, this.ghostPlaceLayer);
    this.rangeArea.mask = this.rangeMask;
    this.rangeLayer.addChild(this.rangeBackground, this.rangeArea, this.rangeMask, this.collisionArea);
    this.rangeLayer.visible = false;
    this.root.addChild(
      this.rangeLayer,
      this.ghostLayer,
      this.arcLayer,
      this.stubLayer,
      this.placeLayer,
      this.transitionLayer,
      this.tokenLayer,
      this.labelLayer,
      this.overlayLayer,
      this.rewardLayer,
    );
    this.labelLayer.addChild(this.staticLabels);
    game.sim.onFire((e) => {
      const n = this.transitions.get(e.transitionId);
      if (n) n.firedAt = game.sim.time;
    });
  }

  update(dt: number, viewport: { x: number; y: number; width: number; height: number }): void {
    const now = this.game.sim.time;
    if (this.builtVersion !== this.game.sim.net.version) this.buildStatic();
    this.updateBuildArea(dt, viewport);
    this.drawPlaces();
    for (const n of this.transitions.values()) this.drawTransition(n, now, dt);
    this.drawInFlight();
    this.drawOverlay(now);
    this.drawRewards();
  }

  private updateBuildArea(dt: number, viewport: { x: number; y: number; width: number; height: number }): void {
    const active = !!this.overlay.build && !this.game.complete;
    this.rangeFade = Math.max(0, Math.min(1, this.rangeFade + (active ? dt : -dt) / BUILD_FADE_TIME));
    this.rangeLayer.visible = this.rangeFade > 0;
    if (!this.rangeLayer.visible) return;
    this.rangeLayer.alpha = this.rangeFade;
    const kind = this.overlay.build?.kind ?? this.rangeKind;
    if (this.rangeVersion !== this.game.sim.net.version || this.rangeKind !== kind) {
      this.rangeVersion = this.game.sim.net.version;
      this.rangeKind = kind;
      const net = this.game.sim.net;
      const nodes = net.liveNodes();
      this.rangeMask.clear();
      for (const n of nodes) this.rangeMask.circle(n.x, n.y, buildRange(n)).fill(0xffffff);
      this.rangeArea.visible = nodes.length > 0;
      this.collisionArea.clear();
      if (kind) {
        for (const node of [...net.places.values(), ...net.transitions.values()]) {
          const otherKind = net.places.has(node.id) ? "place" : "transition";
          this.collisionArea.circle(node.x, node.y, placementClearance(kind, otherKind)).fill(THEME.buildOutside);
        }
      }
    }
    const { x, y, width, height } = viewport;
    const previous = this.rangeViewport;
    if (!previous || previous.x !== x || previous.y !== y || previous.width !== width || previous.height !== height) {
      this.rangeViewport = { ...viewport };
      this.rangeBackground.clear().rect(x, y, width, height).fill(THEME.buildOutside);
      this.rangeArea.clear().rect(x, y, width, height).fill(0xffffff);
    }
  }

  /** Feedback for a tap that had no effect. */
  deny(pick: Pick): void {
    const now = this.game.sim.time;
    if (pick.kind === "transition" || pick.kind === "port") {
      const n = this.transitions.get(pick.kind === "port" ? pick.tid : pick.id);
      if (n) n.deniedAt = now;
    } else if (pick.kind === "place") this.placeDeniedAt.set(pick.id, now);
    else if (pick.kind === "empty") this.ripples.push({ x: pick.x, y: pick.y, at: now });
  }

  rewardCollected(offer: PowerupOffer, index: number): void {
    const reward = this.rewards.find((item) => item.offer.id === offer.id);
    if (reward) {
      reward.selected = index;
      reward.removedAt = this.game.sim.time;
    }
  }

  /** The topmost live part of the net at world point `p`: plugs, then transitions, places and arcs. */
  pick(p: Pt): Pick {
    const net = this.game.sim.net;
    if (this.builtVersion !== net.version) this.buildStatic();
    const scale = this.root.scale.x || 1;
    for (const offer of [...this.game.offers.values()].reverse()) {
      if (this.game.sim.time >= offer.expiresAt) continue;
      const x = (p.x - offer.x) * scale;
      const y = (p.y - offer.y) * scale;
      for (const index of [0, 1]) {
        const center = (index - 0.5) * (REWARD_WIDTH + REWARD_GAP);
        if (Math.abs(x - center) <= REWARD_WIDTH / 2 + REWARD_PICK_SLOP
          && Math.abs(y) <= REWARD_HEIGHT / 2 + REWARD_PICK_SLOP) {
          return { kind: "reward", id: offer.id, index };
        }
      }
    }
    const slop = PICK_SLOP / (this.root.scale.x || 1);
    const closest = <T>(items: Iterable<T>, dist: (x: T) => number, max: number): T | undefined => {
      let best: T | undefined;
      let bestD = max;
      for (const x of items) {
        const d = dist(x);
        if (d < bestD) [best, bestD] = [x, d];
      }
      return best;
    };
    const stub = closest(this.stubs, (s) => Math.hypot(s.plug.x - p.x, s.plug.y - p.y), PLUG_RADIUS + slop);
    if (stub) return { kind: "port", tid: stub.tid, index: stub.index };
    const live = <T extends { ghost?: boolean }>(m: Map<string, T>) => [...m.values()].filter((x) => !x.ghost);
    const t = closest(
      live(net.transitions),
      (t) => {
        const { w, h } = this.layouts.get(t.id)!.bar;
        return Math.abs(t.x - p.x) <= w / 2 + slop && Math.abs(t.y - p.y) <= h / 2 + slop ? Math.hypot(t.x - p.x, t.y - p.y) : Infinity;
      },
      Infinity,
    );
    if (t) return { kind: "transition", id: t.id };
    const place = closest(live(net.places), (q) => Math.hypot(q.x - p.x, q.y - p.y) - placeRadius(q.capacity), slop / 2);
    if (place) return { kind: "place", id: place.id };
    const arc = closest(live(net.arcs), (a) => distanceToPolyline(p, this.visibleRoute(a)), 5 + slop);
    if (arc) return { kind: "arc", id: arc.id };
    return { kind: "empty", x: p.x, y: p.y };
  }

  private drawRewards(): void {
    const now = this.game.sim.time;
    if (this.rewardVersion !== this.game.offerVersion) {
      this.rewardVersion = this.game.offerVersion;
      for (const reward of this.rewards) {
        if (!this.game.offers.has(reward.offer.id) && reward.removedAt === undefined) reward.removedAt = now;
      }
      for (const offer of this.game.offers.values()) {
        if (this.rewards.some((reward) => reward.offer.id === offer.id)) continue;
        const root = new Container();
        const timer = new Graphics();
        const choices: RewardNode["choices"] = [];
        for (const [index, choice] of offer.choices.entries()) {
          const x = (index - 0.5) * (REWARD_WIDTH + REWARD_GAP);
          const item = new Container();
          item.position.set(x, 0);
          const background = new Graphics().roundRect(-REWARD_WIDTH / 2, -REWARD_HEIGHT / 2, REWARD_WIDTH, REWARD_HEIGHT, 8).fill(0xb9b8b4);
          const border = new Graphics();
          const icon = new Graphics();
          item.addChild(background, border, icon);
          if (choice.kind === "coins") {
            icon.circle(0, 0, 13).fill(0xdd8a25);
            const amount = new Text({ text: String(choice.amount), style: { fontFamily: THEME.font, fontSize: 11, fill: 0xffffff, fontWeight: "bold" } });
            amount.anchor.set(0.5);
            item.addChild(amount);
          } else {
            drawToolIcon(icon, choice.kind === "kit" ? { kind: "kit", kit: choice.kit } : { kind: choice.kind });
            if (choice.kind === "kit") {
              const badge = new Graphics().circle(19, 19, 10).fill(0xdd8a25);
              const price = new Text({ text: String(choice.price), style: { fontFamily: THEME.font, fontSize: 11, fill: 0xffffff, fontWeight: "bold" } });
              price.anchor.set(0.5);
              price.position.set(19, 19);
              item.addChild(badge, price);
            }
          }
          root.addChild(item);
          choices.push({ root: item, background, border });
        }
        root.addChild(timer);
        this.rewardLayer.addChild(root);
        this.rewards.push({ offer, root, timer, choices });
      }
    }
    const scale = this.root.scale.x || 1;
    for (const reward of this.rewards) {
      const { offer, root, timer, choices, removedAt, selected } = reward;
      const enter = Math.max(0, Math.min(1, (now - (offer.expiresAt - POWERUP_LIFETIME)) / APPEAR_TIME));
      const exit = removedAt === undefined ? 1 : Math.max(0, 1 - (now - removedAt) / REWARD_EXIT_TIME);
      const flight = removedAt === undefined ? 0 : Math.max(0, Math.min(1, (now - removedAt) / REWARD_FLIGHT_TIME));
      root.position.set(offer.x, offer.y);
      root.scale.set(selected === undefined ? (0.75 + 0.25 * (1 - (1 - enter) ** 3)) * (0.75 + 0.25 * exit) / scale : 1 / scale);
      root.alpha = selected === undefined ? enter * exit : 1;
      const hover = this.overlay.pointer && removedAt === undefined ? this.pick(this.overlay.pointer) : undefined;
      choices.forEach((item, index) => {
        const chosen = selected === index;
        const hovered = hover?.kind === "reward" && hover.id === offer.id && hover.index === index
          && this.overlay.hoverAction?.(hover);
        item.background.alpha = 0.72 + 0.2 * Math.sin(now * 3);
        item.border.clear().roundRect(-REWARD_WIDTH / 2, -REWARD_HEIGHT / 2, REWARD_WIDTH, REWARD_HEIGHT, 8)
          .stroke({ width: chosen || hovered ? 4 : 2, color: chosen ? 0x32944c : THEME.ink });
        item.root.alpha = selected === undefined || chosen ? 1 : exit;
        const startX = (index - 0.5) * (REWARD_WIDTH + REWARD_GAP);
        if (chosen) {
          const move = Math.max(0, (flight - 0.2) / 0.8);
          const target = this.rewardTarget?.(offer.choices[index]) ?? { x: offer.x, y: offer.y + 200 / scale };
          const ease = 1 - (1 - move) ** 3;
          item.root.position.set(startX + ((target.x - offer.x) * scale - startX) * ease, (target.y - offer.y) * scale * ease);
          item.root.scale.set(1 + 0.12 * Math.sin(Math.PI * Math.min(1, flight * 2)));
          item.root.alpha = Math.min(1, (1 - flight) * 4);
        } else {
          item.root.position.set(startX, 0);
          item.root.scale.set(hovered ? 1.08 : 1);
        }
      });
      timer.alpha = selected === undefined ? 1 : exit;
      const width = 2 * REWARD_WIDTH + REWARD_GAP;
      const left = Math.max(0, Math.min(1, (offer.expiresAt - this.game.sim.time) / POWERUP_LIFETIME));
      timer.clear().roundRect(-width / 2, -REWARD_HEIGHT / 2 - 7, width, 3, 1.5).fill(THEME.muted)
        .roundRect(-width / 2, -REWARD_HEIGHT / 2 - 7, width * left, 3, 1.5).fill(0x5ba76a);
    }
    this.rewards = this.rewards.filter((reward) => {
      const duration = reward.selected === undefined ? REWARD_EXIT_TIME : REWARD_FLIGHT_TIME;
      if (reward.removedAt === undefined || now - reward.removedAt < duration) return true;
      reward.root.destroy({ children: true });
      return false;
    });
  }

  /** (Re)builds arcs, ports, transitions and labels whenever the net's structure changes. */
  private buildStatic(): void {
    this.builtVersion = this.game.sim.net.version;
    this.arcLayer.clear();
    this.ghostArcLayer.clear();
    this.stubLayer.clear();
    for (const c of this.staticLabels.removeChildren()) c.destroy();
    for (const t of this.overflowTexts.values()) t.destroy();
    this.overflowTexts.clear();
    for (const c of this.transitionLayer.removeChildren()) c.destroy({ children: true });
    const old = new Map(this.transitions);
    this.transitions.clear();
    this.routes.clear();
    this.buildRoutes();
    this.drawArcs();
    this.drawStubs();
    this.buildTransitions();
    this.buildPlaceLabels();
    for (const [id, n] of this.transitions) {
      const prev = old.get(id);
      if (prev) Object.assign(n, { firedAt: prev.firedAt, deniedAt: prev.deniedAt, balance: prev.balance });
    }
  }

  /**
   * Spreads the arcs and open ports on each side of a transition across its bar, ordered to avoid
   * crossings. Open ports prefer their flow side, but flip away from connected arcs.
   */
  private buildRoutes(): void {
    const net = this.game.sim.net;
    this.layouts.clear();
    this.stubs = [];
    for (const t of net.transitions.values()) {
      const arcs = net.arcsOf(t.id);
      const live = arcs.filter((arc) => !arc.ghost);
      const directions = live.map((arc) => {
        const place = net.pos(arc.from === t.id ? arc.to : arc.from);
        const dx = Math.abs(place.x - t.x);
        const dy = Math.abs(place.y - t.y);
        return dy > dx ? "vertical" : dx > dy ? "horizontal" : "diagonal";
      });
      const portrait = directions.length && directions.every((direction) => direction === "vertical") ? true
        : directions.length && directions.every((direction) => direction === "horizontal") ? false : this.game.portrait;
      const bar = portrait ? { w: TRANSITION_H, h: TRANSITION_W } : { w: TRANSITION_W, h: TRANSITION_H };
      this.layouts.set(t.id, { portrait, bar });
      const length = portrait ? bar.w : bar.h;
      const half = (portrait ? bar.h : bar.w) / 2;
      const ports = (t.open ?? []).map((port, index) => ({
        port, index, side: this.clearSide(t, port.dir === "in" ? -1 : 1),
      }));
      for (const sign of [-1, 1] as const) {
        const side = arcs.filter((a) => (this.arcSide(t, a) || (a.to === t.id ? -1 : 1)) === sign);
        const placeOf = (a: Arc) => net.pos(a.from === t.id ? a.to : a.from);
        const across = (a: Arc) => (portrait ? placeOf(a).x : placeOf(a).y);
        const sorted = [...side].sort((a, b) => across(a) - across(b));
        const open = ports.filter((port) => port.side === sign);
        const n = sorted.length + open.length;
        const spacing = Math.min(16, length / Math.max(1, n));
        const shiftOf = (i: number) => (i - (n - 1) / 2) * spacing;
        sorted.forEach((arc, i) => {
          this.routes.set(arc.id, arcRoute(net, bar, portrait, arc.from, arc.to, shiftOf(i)));
        });
        open.forEach(({ port, index }, i) => {
          const shift = shiftOf(sorted.length + i);
          const at = (along: number): Pt => (portrait ? { x: t.x + shift, y: t.y + along } : { x: t.x + along, y: t.y + shift });
          this.stubs.push({ tid: t.id, index, port, edge: at(sign * half), plug: at(sign * (half + STUB_LENGTH)) });
        });
      }
    }
  }

  private arcSide(t: Transition, arc: Arc): -1 | 0 | 1 {
    const place = this.game.sim.net.pos(arc.from === t.id ? arc.to : arc.from);
    const along = this.layouts.get(t.id)!.portrait ? place.y - t.y : place.x - t.x;
    return along < 0 ? -1 : along > 0 ? 1 : 0;
  }

  private clearSide(t: Transition, preferred: -1 | 1): -1 | 1 {
    const counts = { [-1]: 0, [1]: 0 };
    for (const arc of this.game.sim.net.arcsOf(t.id)) {
      const side = this.arcSide(t, arc);
      if (!arc.ghost && side !== 0) counts[side]++;
    }
    const other = preferred === -1 ? 1 : -1;
    return counts[preferred] > counts[other] ? other : preferred;
  }

  /** The drawn part of an arc: from the place's outline to the transition's outline, in arc direction. */
  private visibleRoute(arc: Arc): Pt[] {
    const route = this.routes.get(arc.id)!;
    const pts = outsidePlace(route.pts, placeRadius(this.game.sim.net.places.get(route.placeId)!.capacity));
    return route.fromPlace ? pts : pts.reverse();
  }

  /** Arcs are drawn in the color of the tokens they move (ink for "any"), with one arrowhead per token. */
  private drawArcs(): void {
    for (const arc of this.game.sim.net.arcs.values()) {
      const g = arc.ghost ? this.ghostArcLayer : this.arcLayer;
      const label = this.drawArrow(g, this.visibleRoute(arc), arc.color ? TOKEN_COLORS[arc.color] : THEME.ink, arcCount(arc));
      if (label && !arc.ghost) this.staticLabels.addChild(label);
    }
  }

  /** Dangling stubs of open ports, each with a plug at its loose end. */
  private drawStubs(): void {
    const g = this.stubLayer;
    for (const s of this.stubs) {
      const color = s.port.color ? TOKEN_COLORS[s.port.color] : THEME.ink;
      const len = Math.hypot(s.plug.x - s.edge.x, s.plug.y - s.edge.y);
      const ux = (s.plug.x - s.edge.x) / len;
      const uy = (s.plug.y - s.edge.y) / len;
      const loose = { x: s.plug.x - ux * PLUG_RADIUS, y: s.plug.y - uy * PLUG_RADIUS };
      const pts = s.port.dir === "in" ? [loose, s.edge] : [s.edge, { x: loose.x - ux * 2, y: loose.y - uy * 2 }];
      const label = this.drawArrow(g, pts, color, arcCount(s.port), 0.8);
      if (label) this.staticLabels.addChild(label);
      g.circle(s.plug.x, s.plug.y, PLUG_RADIUS).fill(THEME.background).stroke({ width: 3, color });
      g.circle(s.plug.x, s.plug.y, 2.5).fill(color);
    }
  }

  /** A polyline with `count` arrowheads at its end; returns a count label if there are too many to draw. */
  private drawArrow(g: Graphics, pts: Pt[], color: number, count: number, size = 1): Text | undefined {
    const b = pts[pts.length - 1];
    const a = pts[pts.length - 2] ?? b;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const head = 20 * size;
    const spacing = 13 * size;
    const heads = Math.min(count, MAX_ARROWHEADS);

    g.moveTo(pts[0].x, pts[0].y);
    for (const q of pts.slice(1, -1)) g.lineTo(q.x, q.y);
    g.lineTo(b.x - ux * head * 0.5, b.y - uy * head * 0.5).stroke({ width: 4, color, cap: "round", join: "round" });
    for (let i = 0; i < heads; i++) {
      const tx = b.x - ux * spacing * i;
      const ty = b.y - uy * spacing * i;
      g.poly([
        tx, ty,
        tx - ux * head - uy * head * 0.5, ty - uy * head + ux * head * 0.5,
        tx - ux * head * 0.65, ty - uy * head * 0.65,
        tx - ux * head + uy * head * 0.5, ty - uy * head - ux * head * 0.5,
      ]).fill(color).stroke({ width: 2, color: THEME.background, join: "round" });
    }
    if (count > MAX_ARROWHEADS) {
      const label = new Text({ text: `×${count}`, style: { fontFamily: THEME.font, fontSize: 14, fill: color, fontWeight: "bold" } });
      label.anchor.set(0.5);
      label.position.set(b.x - ux * (spacing * heads + 14) - uy * 14, b.y - uy * (spacing * heads + 14) + ux * 14);
      return label;
    }
    return undefined;
  }

  private buildTransitions(): void {
    for (const t of this.game.sim.net.transitions.values()) {
      const container = new Container();
      container.position.set(t.x, t.y);
      const gfx = new Graphics();
      container.addChild(gfx);
      if (t.ghost) container.alpha = GHOST_ALPHA;
      const node: TransitionNode = { t, container, gfx, firedAt: -Infinity, deniedAt: -Infinity, balance: new Map() };
      this.transitions.set(t.id, node);
      this.transitionLayer.addChild(container);
    }
  }

  private buildPlaceLabels(): void {
    for (const p of this.game.sim.net.places.values()) {
      if (p.ghost) continue;
      const txt = new Text({ text: "", style: { fontFamily: THEME.font, fontSize: 13, fill: THEME.ink, fontWeight: "bold" } });
      txt.anchor.set(0.5);
      const radius = placeRadius(p.capacity);
      txt.position.set(p.x + radius * 0.8, p.y - radius * 0.8);
      this.labelLayer.addChild(txt);
      this.overflowTexts.set(p.id, txt);
    }
  }

  private drawPlaces(): void {
    const g = this.placeLayer.clear();
    this.ghostPlaceLayer.clear();
    const sim = this.game.sim;
    const now = sim.time;
    for (const p of sim.net.places.values()) {
      const radius = placeRadius(p.capacity);
      if (p.ghost) {
        this.ghostPlaceLayer.circle(p.x, p.y, radius).fill(THEME.placeFill).stroke({ width: 5, color: THEME.ink });
        continue;
      }
      const shakeT = this.game.complete ? Infinity : now - (this.placeDeniedAt.get(p.id) ?? -Infinity);
      const x = p.x + (shakeT < SHAKE_TIME ? Math.sin(shakeT * 60) * 5 * (1 - shakeT / SHAKE_TIME) : 0);
      g.circle(x, p.y, radius)
        .fill(THEME.placeFill)
        .stroke({ width: 5, color: shakeT < SHAKE_TIME ? THEME.warn : THEME.ink });

      const colors = p.marking;
      colors.slice(0, TOKEN_SLOTS.length).forEach((c, i) => {
        const s = TOKEN_SLOTS[i];
        g.circle(x + s.x, p.y + s.y, TOKEN_RADIUS).fill(TOKEN_COLORS[c]);
      });
      const extra = colors.length - TOKEN_SLOTS.length;
      const label = this.overflowTexts.get(p.id);
      if (label) label.text = extra > 0 ? `+${extra}` : "";
    }
  }

  private drawTransition(n: TransitionNode, now: number, dt: number): void {
    const { t, gfx: g } = n;
    const sim = this.game.sim;
    const enabled = sim.isEnabled(t.id);
    g.clear();
    const spawnedAt = this.game.spawnedAt.get(t.id);
    const entering = spawnedAt === undefined ? 1 : Math.max(0, Math.min(1, (now - spawnedAt) / APPEAR_TIME));
    const gone = t.ghost && (this.game.exhausted.has(t.id) || this.game.failed.has(t.id));
    n.container.alpha = gone ? 0 : (t.ghost ? GHOST_ALPHA : entering);
    n.container.scale.set(0.75 + 0.25 * (1 - (1 - entering) ** 3));

    // Effects are timed by the simulation clock, which stops once the level is won.
    const frozen = this.game.complete;
    const shakeT = frozen ? Infinity : now - n.deniedAt;
    const shake = shakeT < SHAKE_TIME ? Math.sin(shakeT * 60) * 5 * (1 - shakeT / SHAKE_TIME) : 0;
    n.container.position.set(t.x + shake, t.y);

    const { portrait, bar: { w, h } } = this.layouts.get(t.id)!;
    const flashT = frozen ? Infinity : now - n.firedAt;
    if (flashT < FLASH_TIME) {
      const k = flashT / FLASH_TIME;
      g.roundRect(-w / 2 - 6 - k * 14, -h / 2 - 6 - k * 14, w + 12 + k * 28, h + 12 + k * 28, 10).stroke({
        width: 3,
        color: THEME.ink,
        alpha: 1 - k,
      });
    }

    if (t.kind === "normal" && enabled && !t.ghost) {
      const pulse = 0.5 + 0.5 * Math.sin(now * 5);
      g.roundRect(-w / 2 - 5, -h / 2 - 5, w + 10, h + 10, 9).fill({ color: THEME.enabledGlow, alpha: 0.12 + pulse * 0.12 });
    }

    let fill: number = THEME.ink;
    if (t.kind === "normal") fill = enabled ? THEME.ink : THEME.muted;
    if (t.kind === "source") {
      const first = sim.net.outputs(t.id)[0]?.color ?? t.open?.find((port) => port.dir === "out")?.color;
      fill = t.supply === 0 ? THEME.muted : first ? TOKEN_COLORS[first] : THEME.ink;
      if (t.supply !== undefined) this.drawSupply(n, fill, dt);
    }
    if (t.kind === "sink") fill = 0xffffff;

    // Timed transitions fill up (from the bottom; from the left in portrait) until they fire.
    const prog = t.kind === "sink" || t.supply === 0 ? undefined : sim.autoProgress(t.id);
    if (prog === undefined) {
      g.roundRect(-w / 2, -h / 2, w, h, 6).fill(fill);
    } else {
      g.roundRect(-w / 2, -h / 2, w, h, 6).fill({ color: fill, alpha: 0.22 });
      if (prog > 0) {
        const r = (len: number) => Math.min(6, len / 2);
        if (portrait) g.roundRect(-w / 2, -h / 2, w * prog, h, r(w * prog)).fill(fill);
        else g.roundRect(-w / 2, h / 2 - h * prog, w, h * prog, r(h * prog)).fill(fill);
      }
      g.roundRect(-w / 2, -h / 2, w, h, 6).stroke({ width: 3, color: fill });
    }
    if (t.kind === "sink") g.roundRect(-w / 2, -h / 2, w, h, 6).stroke({ width: 4, color: THEME.ink });
    if (shakeT < SHAKE_TIME) g.roundRect(-w / 2, -h / 2, w, h, 6).stroke({ width: 3, color: THEME.warn });

    const upgrades = this.game.autoUpgradeLevel(t.id);
    const spacing = Math.min(7, ((portrait ? w : h) - 12) / Math.max(1, upgrades - 1));
    const thickness = Math.min(3, spacing * 0.6);
    for (let i = 0; i < upgrades; i++) {
      const along = (i - (upgrades - 1) / 2) * spacing;
      const [x, y, width, height] = portrait
        ? [along - thickness / 2, -6, thickness, 12]
        : [-6, along - thickness / 2, 12, thickness];
      g.roundRect(x, y, width, height, 1).fill(0xffffff).stroke({ width: 1, color: THEME.ink });
    }

    const failedAt = this.game.failed.get(t.id);
    const exhaustedAt = this.game.exhausted.get(t.id);
    const countdown = this.game.countdownProgress(t.id);
    if (countdown !== undefined && countdown > 0) {
      const radius = Math.max(w, h) / 2 + 11;
      if (countdown >= 1) g.circle(0, 0, radius);
      else g.moveTo(0, -radius).arc(0, 0, radius, -Math.PI / 2, -Math.PI / 2 + countdown * Math.PI * 2);
      g.stroke({ width: 4, color: t.kind === "source" ? THEME.ink : THEME.warn, cap: "round" });
    }
    if (failedAt !== undefined) this.drawResolved(n, now, failedAt, true);
    else if (exhaustedAt !== undefined) this.drawResolved(n, now, exhaustedAt);
    else if (t.kind === "sink") this.drawGoal(n, now, dt);
  }

  /** One dot per remaining firing, stacked upstream of a source. */
  private drawSupply(n: TransitionNode, color: number, dt: number): void {
    const supply = n.t.supply!;
    this.drawBalance(n, Array.from({ length: supply }, (_, i) => ({ key: String(i), color })), -1, 3.2, true, dt);
  }

  private drawBalance(n: TransitionNode, tokens: { key: string; color: number }[], preferred: -1 | 1, radius: number, filled: boolean, dt: number): void {
    const side = this.clearSide(n.t, preferred);
    const active = new Set(tokens.map((token) => token.key));
    for (const key of n.balance.keys()) if (!active.has(key)) n.balance.delete(key);
    tokens.forEach((token, i) => {
      const target = this.endpointCirclePosition(n.t, i, tokens.length, side);
      let dot = n.balance.get(token.key);
      if (!dot) {
        dot = { position: target, from: target, target, elapsed: BALANCE_TWEEN_TIME };
        n.balance.set(token.key, dot);
      } else if (dot.target.x !== target.x || dot.target.y !== target.y) {
        dot.from = dot.position;
        dot.target = target;
        dot.elapsed = 0;
      }
      dot.elapsed = Math.min(BALANCE_TWEEN_TIME, dot.elapsed + dt);
      const ease = 1 - (1 - dot.elapsed / BALANCE_TWEEN_TIME) ** 3;
      dot.position = lerp(dot.from, dot.target, ease);
      n.gfx.circle(dot.position.x, dot.position.y, radius).fill(filled ? token.color : THEME.background);
      if (!filled) n.gfx.stroke({ width: 2.5, color: token.color });
    });
  }

  private endpointCirclePosition(t: Transition, index: number, count: number, side: -1 | 1): Pt {
    const perLine = 5;
    const gap = 19;
    const line = Math.floor(index / perLine);
    const inLine = Math.min(perLine, count - line * perLine);
    const across = ((index % perLine) - (inLine - 1) / 2) * gap;
    const { portrait, bar } = this.layouts.get(t.id)!;
    const along = side * ((portrait ? bar.h : bar.w) / 2 + 21 + line * gap);
    return portrait ? { x: across, y: along } : { x: along, y: across };
  }

  /** Build range, preview, highlights of the active brush's targets and denied-tap ripples. */
  private drawOverlay(now: number): void {
    const g = this.overlayLayer.clear();
    const net = this.game.sim.net;
    const o = this.overlay;
    const pulse = 0.5 + 0.5 * Math.sin(now * 6);
    const { w, h } = this.bar;
    const hover = o.pointer && !this.game.complete ? this.pick(o.pointer) : undefined;
    const selectedTransition = o.selected && net.transitions.get(o.selected.tid);
    const selectedPlace = o.selectedPlace && net.places.get(o.selectedPlace);
    const connectionOrigin = selectedTransition && !selectedTransition.ghost && selectedTransition.open?.[o.selected!.index]
      ? selectedTransition
      : selectedPlace && !selectedPlace.ghost ? selectedPlace : undefined;
    if (connectionOrigin && !this.game.complete) {
      g.circle(connectionOrigin.x, connectionOrigin.y, this.game.connectionRange(connectionOrigin)).stroke({ width: 3, color: THEME.arc, alpha: 0.7 });
    }

    if (o.build) {
      if (o.pointer && hover?.kind === "empty") {
        const { x, y } = o.pointer;
        if (!connectionOrigin) g.circle(x, y, o.build.kind === "transition" ? this.game.connectionRange()
          : connectionRange({ x, y, capacity: o.build.capacity ?? 1 })).stroke({ width: 3, color: THEME.arc, alpha: 0.7 });
        const connection = o.build.connection;
        const invalid = this.game.placementIssue(o.build.kind, x, y)
          || (o.build.canPlace && !o.build.canPlace(x, y))
          || (connection && !this.game.canConnectAt(connection.tid, connection.index, x, y))
          || (o.build.fromPlace && !this.game.canBuildConnectedTransition(o.build.fromPlace, x, y));
        const color = invalid ? THEME.warn : THEME.ink;
        if (o.build.kind === "place") g.circle(x, y, placeRadius(o.build.capacity)).fill({ color: THEME.placeFill, alpha: 0.6 }).stroke({ width: 5, color, alpha: 0.6 });
        else {
          for (const dir of [-1, 1]) {
            if (!o.build.ports?.some((port) => (port.dir === "in") === (dir < 0))) continue;
            const half = (this.game.portrait ? h : w) / 2;
            const [dx, dy] = this.game.portrait ? [0, dir] : [dir, 0];
            g.moveTo(x + dx * half, y + dy * half)
              .lineTo(x + dx * (half + STUB_LENGTH), y + dy * (half + STUB_LENGTH))
              .stroke({ width: 4, color, alpha: 0.4 });
          }
          g.roundRect(x - w / 2, y - h / 2, w, h, 6).fill({ color, alpha: 0.6 });
        }
      }
    }

    const ring = (pick: Pick, color: number, alpha: number, width: number) => {
      if (pick.kind === "transition") {
        const t = net.transitions.get(pick.id)!;
        const { w, h } = this.layouts.get(t.id)!.bar;
        g.roundRect(t.x - w / 2 - 9, t.y - h / 2 - 9, w + 18, h + 18, 12).stroke({ width, color, alpha });
      } else if (pick.kind === "place") {
        const p = net.places.get(pick.id)!;
        g.circle(p.x, p.y, placeRadius(p.capacity) + 10).stroke({ width, color, alpha });
      } else if (pick.kind === "arc") {
        const pts = this.visibleRoute(net.arcs.get(pick.id)!);
        g.moveTo(pts[0].x, pts[0].y);
        for (const q of pts.slice(1)) g.lineTo(q.x, q.y);
        g.stroke({ width: width + 6, color, alpha: alpha * 0.6, cap: "round", join: "round" });
      } else if (pick.kind === "port") {
        const s = this.stubs.find((x) => x.tid === pick.tid && x.index === pick.index);
        if (s) g.circle(s.plug.x, s.plug.y, PLUG_RADIUS + 6).stroke({ width, color, alpha });
      }
    };

    if (o.target || (o.previewTarget && o.pointer && hover?.kind === "empty")) {
      const candidates: Pick[] = [
        ...net.liveNodes().map((n): Pick => (net.places.has(n.id) ? { kind: "place", id: n.id } : { kind: "transition", id: n.id })),
        ...this.stubs.map((s): Pick => ({ kind: "port", tid: s.tid, index: s.index })),
      ];
      for (const c of candidates) {
        if (o.target?.(c) || (o.previewTarget && o.pointer && hover?.kind === "empty" && o.previewTarget(c, o.pointer))) {
          ring(c, THEME.enabledGlow, 0.2 + 0.35 * pulse, 3 + pulse);
        }
      }
    }
    if (hover && hover.kind !== "empty" && (o.hoverAction?.(hover) ?? false)) {
      ring(hover, o.removing ? THEME.removal : THEME.ink, 0.5 + 0.35 * pulse, 4 + pulse);
    }

    if (selectedPlace && !selectedPlace.ghost) {
      g.circle(selectedPlace.x, selectedPlace.y, placeRadius(selectedPlace.capacity) + 10 + 3 * pulse)
        .stroke({ width: 3, color: THEME.ink, alpha: 0.65 + 0.25 * pulse });
      if (o.pointer) {
        g.moveTo(selectedPlace.x, selectedPlace.y).lineTo(o.pointer.x, o.pointer.y)
          .stroke({ width: 3, color: THEME.ink, alpha: 0.35, cap: "round" });
      }
    }

    // Keep the selected port clear, but dim connectors that cannot accept the current wiring.
    for (const s of this.stubs) {
      const selected = o.selected?.tid === s.tid && o.selected.index === s.index;
      if ((selectedPlace || (selectedTransition && !selected && this.game.level.tools?.place))
        && !o.target?.({ kind: "port", tid: s.tid, index: s.index })) {
        g.circle(s.plug.x, s.plug.y, PLUG_RADIUS + 2).fill(THEME.background)
          .stroke({ width: 2, color: THEME.muted });
        continue;
      }
      const r = PLUG_RADIUS + 4 + (selected ? 4 + 3 * pulse : 2 * pulse);
      g.circle(s.plug.x, s.plug.y, r).stroke({ width: selected ? 3 : 2, color: THEME.ink, alpha: selected ? 0.9 : 0.25 });
      if (selected && o.pointer) {
        g.moveTo(s.plug.x, s.plug.y).lineTo(o.pointer.x, o.pointer.y).stroke({ width: 3, color: THEME.ink, alpha: 0.35, cap: "round" });
      }
    }

    this.ripples = this.ripples.filter((r) => now - r.at < SHAKE_TIME * 1.5 && now >= r.at);
    for (const r of this.ripples) {
      const k = (now - r.at) / (SHAKE_TIME * 1.5);
      g.circle(r.x, r.y, 10 + k * 26).stroke({ width: 3, color: THEME.warn, alpha: 1 - k });
    }
  }

  /** Empty circles downstream of a goal sink, one per token still wanted; a check mark once resolved. */
  private drawGoal(n: TransitionNode, now: number, dt: number): void {
    const resolvedAt = this.game.resolved.get(n.t.id);
    if (resolvedAt !== undefined) {
      this.drawResolved(n, now, resolvedAt);
      return;
    }
    const wanted: { key: string; color: number }[] = [];
    this.game.goalsFor(n.t.id).forEach((goal, index) => {
      for (let i = goal.delivered; i < goal.count; i++) wanted.push({ key: `${index}:${i}`, color: TOKEN_COLORS[goal.color] });
    });
    this.drawBalance(n, wanted, 1, 7, false, dt);
  }

  private drawResolved(n: TransitionNode, now: number, at: number, failed = false): void {
    const k = (now - at) / RESOLVED_LINGER;
    const fade = k < 0.6 ? 1 : Math.max(0, 1 - (k - 0.6) / 0.4);
    n.container.alpha *= fade;
    n.container.scale.set(n.container.scale.x * (0.75 + 0.25 * fade));
    const s = 1 + 0.3 * Math.max(0, 1 - k * 4);
    n.gfx.circle(0, 0, 20 * s).fill(failed ? THEME.removal : THEME.ink);
    if (failed) {
      n.gfx.moveTo(-7 * s, -7 * s).lineTo(7 * s, 7 * s)
        .moveTo(-7 * s, 7 * s).lineTo(7 * s, -7 * s);
    } else {
      n.gfx.moveTo(-9 * s, 0).lineTo(-3 * s, 7 * s).lineTo(10 * s, -7 * s);
    }
    n.gfx.stroke({ width: 4, color: 0xffffff, cap: "round", join: "round" });
  }

  private drawInFlight(): void {
    const g = this.tokenLayer.clear();
    const net = this.game.sim.net;
    const gap = TOKEN_RADIUS * 2 + 3;
    for (const tok of this.game.sim.inFlight) {
      const route = this.routes.get(tok.arcId);
      if (!route) continue;
      const place = net.places.get(route.placeId)!;
      // Tokens moved along the same arc by one firing travel side by side.
      const off = (tok.slot - (tok.batch - 1) / 2) * gap * (route.fromPlace ? 1 : -1);
      const routeLen = polylineLength(route.pts);
      const lane = offsetPolyline(subpath(route.pts, Math.min(placeRadius(place.capacity) + 16, routeLen / 2)), off);
      // The token leaves from (or lands in) the slot it vacates (or will fill) inside the place.
      const slot = TOKEN_SLOTS[place.marking.length + tok.slot] ?? { x: 0, y: 0 };
      const home: Pt = { x: place.x + slot.x, y: place.y + slot.y };
      const hopStart = lane[0];
      const hopLen = Math.hypot(hopStart.x - home.x, hopStart.y - home.y);
      const laneLen = polylineLength(lane);
      // Distance travelled, measured from the place end.
      const total = hopLen + laneLen;
      const d = (route.fromPlace ? tok.progress : 1 - tok.progress) * total;

      let p: Pt;
      let lift = 0;
      if (d < hopLen) {
        const u = d / hopLen;
        p = lerp(home, hopStart, u);
        lift = Math.sin(Math.PI * u);
      } else {
        p = pointAt(lane, d - hopLen);
      }
      const r = TOKEN_RADIUS + 1;
      if (lift > 0) g.ellipse(p.x, p.y, r * (1 - 0.3 * lift), r * 0.45 * (1 - 0.3 * lift)).fill({ color: THEME.ink, alpha: 0.18 });
      const up = lift * HOP_HEIGHT;
      // Up is towards the top of the screen in both orientations.
      g.circle(p.x, p.y - up, r * (1 + 0.25 * lift))
        .fill(TOKEN_COLORS[tok.color])
        .stroke({ width: 2, color: 0xffffff });
    }
  }
}
