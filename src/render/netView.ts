import { Container, Graphics, Rectangle, Text } from "pixi.js";
import type { Color } from "../core/multiset";
import { arcCount, type Transition } from "../core/net";
import { RESOLVED_LINGER } from "../game/game";
import type { Game } from "../game/game";
import {
  arcRoute,
  lerp,
  offsetPolyline,
  pointAt,
  polylineLength,
  subpath,
  TOKEN_SLOTS,
  type ArcRoute,
  type BarSize,
  type Pt,
} from "./geometry";
import { PLACE_RADIUS, THEME, TOKEN_COLORS, TOKEN_RADIUS, TRANSITION_H, TRANSITION_W } from "./style";

const FLASH_TIME = 0.35;
const SHAKE_TIME = 0.3;
const MAX_ARROWHEADS = 5;
/** Tokens hop between their slot inside a place and this distance from its center along the arc. */
const HOP_REACH = PLACE_RADIUS + 16;
const HOP_HEIGHT = 18;

interface TransitionNode {
  t: Transition;
  container: Container;
  gfx: Graphics;
  firedAt: number;
  deniedAt: number;
}

/** Draws the net in world coordinates and turns taps on transitions into fire attempts. */
export class NetView {
  readonly root = new Container();
  private readonly arcLayer = new Graphics();
  private readonly placeLayer = new Graphics();
  private readonly tokenLayer = new Graphics();
  private readonly transitionLayer = new Container();
  private readonly labelLayer = new Container();
  /** Labels that belong to arcs and transitions; rebuilt with them. */
  private readonly staticLabels = new Container();
  private builtVersion = -1;
  private readonly overflowTexts = new Map<string, Text>();
  private readonly transitions = new Map<string, TransitionNode>();
  private readonly routes = new Map<string, ArcRoute>();
  /** Transition bars stand across the flow direction: vertical in landscape, horizontal in portrait. */
  private readonly bar: BarSize;

  constructor(private readonly game: Game) {
    this.bar = game.portrait ? { w: TRANSITION_H, h: TRANSITION_W } : { w: TRANSITION_W, h: TRANSITION_H };
    this.root.addChild(this.arcLayer, this.placeLayer, this.transitionLayer, this.tokenLayer, this.labelLayer);
    this.labelLayer.addChild(this.staticLabels);
    this.buildPlaceLabels();
    game.sim.onFire((e) => {
      const n = this.transitions.get(e.transitionId);
      if (n) n.firedAt = game.sim.time;
    });
  }

  update(): void {
    const now = this.game.sim.time;
    if (this.builtVersion !== this.game.sim.net.version) this.buildStatic();
    this.drawPlaces();
    for (const n of this.transitions.values()) this.drawTransition(n, now);
    this.drawInFlight();
  }

  /** (Re)builds arcs and transitions, e.g. after a resolved goal sink left the map. */
  private buildStatic(): void {
    this.builtVersion = this.game.sim.net.version;
    this.arcLayer.clear();
    for (const c of this.staticLabels.removeChildren()) c.destroy();
    for (const c of this.transitionLayer.removeChildren()) c.destroy({ children: true });
    const old = new Map(this.transitions);
    this.transitions.clear();
    this.routes.clear();
    this.buildRoutes();
    this.drawArcs();
    this.buildTransitions();
    for (const [id, n] of this.transitions) {
      const prev = old.get(id);
      if (prev) Object.assign(n, { firedAt: prev.firedAt, deniedAt: prev.deniedAt });
    }
  }

  /** Spreads the arcs on each side of a transition across its bar, ordered to avoid crossings. */
  private buildRoutes(): void {
    const net = this.game.sim.net;
    const portrait = this.game.portrait;
    const length = portrait ? this.bar.w : this.bar.h;
    for (const t of net.transitions.values()) {
      for (const side of [net.inputs(t.id), net.outputs(t.id)]) {
        const placeOf = (a: (typeof side)[number]) => net.pos(a.from === t.id ? a.to : a.from);
        const across = (a: (typeof side)[number]) => (portrait ? placeOf(a).x : placeOf(a).y);
        const sorted = [...side].sort((a, b) => across(a) - across(b));
        const spacing = Math.min(16, length / Math.max(1, sorted.length));
        sorted.forEach((arc, i) => {
          const shift = (i - (sorted.length - 1) / 2) * spacing;
          this.routes.set(arc.id, arcRoute(net, this.bar, portrait, arc.from, arc.to, shift));
        });
      }
    }
  }

  /** Arcs are drawn in the color of the tokens they move (ink for "any"), with one arrowhead per token. */
  private drawArcs(): void {
    const g = this.arcLayer;
    const net = this.game.sim.net;
    for (const arc of net.arcs.values()) {
      const color = arc.color ? TOKEN_COLORS[arc.color] : THEME.ink;
      const route = this.routes.get(arc.id)!;
      // Visible part: from the place's outline to the transition's outline, in arc direction.
      let pts = subpath(route.pts, PLACE_RADIUS);
      if (!route.fromPlace) pts = pts.reverse();
      const b = pts[pts.length - 1];
      const a = pts[pts.length - 2] ?? b;
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      const head = 20;
      const spacing = 13;
      const heads = Math.min(arcCount(arc), MAX_ARROWHEADS);

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
      if (arcCount(arc) > MAX_ARROWHEADS) {
        const label = new Text({ text: `×${arcCount(arc)}`, style: { fontFamily: THEME.font, fontSize: 14, fill: color, fontWeight: "bold" } });
        label.anchor.set(0.5);
        label.position.set(b.x - ux * (spacing * heads + 14) - uy * 14, b.y - uy * (spacing * heads + 14) + ux * 14);
        this.staticLabels.addChild(label);
      }
    }
  }

  private buildTransitions(): void {
    for (const t of this.game.sim.net.transitions.values()) {
      const container = new Container();
      container.position.set(t.x, t.y);
      const gfx = new Graphics();
      container.addChild(gfx);
      if (t.kind === "normal") {
        container.eventMode = "static";
        container.cursor = "pointer";
        // Generous hit area for touch screens.
        const { w, h } = this.bar;
        container.hitArea = new Rectangle(-w / 2 - 22, -h / 2 - 22, w + 44, h + 44);
        container.on("pointerdown", () => {
          if (!this.game.playerFire(t.id)) node.deniedAt = this.game.sim.time;
        });
      }
      const node: TransitionNode = { t, container, gfx, firedAt: -Infinity, deniedAt: -Infinity };
      this.transitions.set(t.id, node);
      this.transitionLayer.addChild(container);
    }
  }

  private buildPlaceLabels(): void {
    for (const p of this.game.sim.net.places.values()) {
      const txt = new Text({ text: "", style: { fontFamily: THEME.font, fontSize: 13, fill: THEME.ink, fontWeight: "bold" } });
      txt.anchor.set(0.5);
      txt.position.set(p.x + PLACE_RADIUS * 0.8, p.y - PLACE_RADIUS * 0.8);
      this.labelLayer.addChild(txt);
      this.overflowTexts.set(p.id, txt);
    }
  }

  private drawPlaces(): void {
    const g = this.placeLayer.clear();
    const sim = this.game.sim;
    for (const p of sim.net.places.values()) {
      g.circle(p.x, p.y, PLACE_RADIUS).fill(THEME.placeFill).stroke({ width: 5, color: THEME.ink });

      // Capacity ring: settled tokens in ink, tokens already committed to this place in grey.
      if (p.capacity !== undefined && Number.isFinite(p.capacity)) {
        const r = PLACE_RADIUS + 8;
        const settled = p.marking.length;
        const occupied = sim.occupancy(p.id);
        const full = occupied >= p.capacity;
        const arcTo = (from: number, to: number, color: number, alpha = 1) => {
          if (to <= from) return;
          const a0 = -Math.PI / 2 + (from / p.capacity!) * Math.PI * 2;
          const a1 = -Math.PI / 2 + (Math.min(to, p.capacity!) / p.capacity!) * Math.PI * 2;
          g.moveTo(p.x + Math.cos(a0) * r, p.y + Math.sin(a0) * r);
          g.arc(p.x, p.y, r, a0, a1).stroke({ width: 4, color, alpha });
        };
        arcTo(0, p.capacity, THEME.muted, 0.3);
        arcTo(0, settled, full ? THEME.warn : THEME.ink);
        arcTo(settled, occupied, full ? THEME.warn : THEME.muted, full ? 0.5 : 1);
      }

      const colors = p.marking;
      colors.slice(0, TOKEN_SLOTS.length).forEach((c, i) => {
        const s = TOKEN_SLOTS[i];
        g.circle(p.x + s.x, p.y + s.y, TOKEN_RADIUS).fill(TOKEN_COLORS[c]);
      });
      const extra = colors.length - TOKEN_SLOTS.length;
      this.overflowTexts.get(p.id)!.text = extra > 0 ? `+${extra}` : "";
    }
  }

  private drawTransition(n: TransitionNode, now: number): void {
    const { t, gfx: g } = n;
    const sim = this.game.sim;
    const enabled = sim.isEnabled(t.id);
    g.clear();

    // Effects are timed by the simulation clock, which stops once the level is won.
    const frozen = this.game.complete;
    const shakeT = frozen ? Infinity : now - n.deniedAt;
    const shake = shakeT < SHAKE_TIME ? Math.sin(shakeT * 60) * 5 * (1 - shakeT / SHAKE_TIME) : 0;
    n.container.position.set(t.x + shake, t.y);

    const { w, h } = this.bar;
    const flashT = frozen ? Infinity : now - n.firedAt;
    if (flashT < FLASH_TIME) {
      const k = flashT / FLASH_TIME;
      g.roundRect(-w / 2 - 6 - k * 14, -h / 2 - 6 - k * 14, w + 12 + k * 28, h + 12 + k * 28, 10).stroke({
        width: 3,
        color: THEME.ink,
        alpha: 1 - k,
      });
    }

    if (t.kind === "normal" && enabled) {
      const pulse = 0.5 + 0.5 * Math.sin(now * 5);
      g.roundRect(-w / 2 - 5, -h / 2 - 5, w + 10, h + 10, 9).fill({ color: THEME.enabledGlow, alpha: 0.12 + pulse * 0.12 });
    }

    let fill: number = THEME.ink;
    if (t.kind === "normal") fill = enabled ? THEME.ink : THEME.muted;
    if (t.kind === "source") {
      const first = sim.net.outputs(t.id)[0]?.color;
      fill = first ? TOKEN_COLORS[first] : THEME.ink;
    }
    if (t.kind === "sink") fill = 0xffffff;

    // Timed transitions fill up (from the bottom; from the left in portrait) until they fire.
    const prog = t.kind === "sink" ? undefined : sim.autoProgress(t.id);
    if (prog === undefined) {
      g.roundRect(-w / 2, -h / 2, w, h, 6).fill(fill);
    } else {
      g.roundRect(-w / 2, -h / 2, w, h, 6).fill({ color: fill, alpha: 0.22 });
      if (prog > 0) {
        const r = (len: number) => Math.min(6, len / 2);
        if (this.game.portrait) g.roundRect(-w / 2, -h / 2, w * prog, h, r(w * prog)).fill(fill);
        else g.roundRect(-w / 2, h / 2 - h * prog, w, h * prog, r(h * prog)).fill(fill);
      }
      g.roundRect(-w / 2, -h / 2, w, h, 6).stroke({ width: 3, color: fill });
    }
    if (t.kind === "sink") g.roundRect(-w / 2, -h / 2, w, h, 6).stroke({ width: 4, color: THEME.ink });
    if (shakeT < SHAKE_TIME) g.roundRect(-w / 2, -h / 2, w, h, 6).stroke({ width: 3, color: THEME.warn });

    if (t.kind === "sink") this.drawGoal(n, now);
  }

  /** Empty circles downstream of a goal sink, one per token still wanted; a check mark once resolved. */
  private drawGoal(n: TransitionNode, now: number): void {
    const g = n.gfx;
    const { w, h } = this.bar;
    const resolvedAt = this.game.resolved.get(n.t.id);
    if (resolvedAt !== undefined) {
      const k = (now - resolvedAt) / RESOLVED_LINGER;
      n.container.alpha = k < 0.6 ? 1 : Math.max(0, 1 - (k - 0.6) / 0.4);
      const s = 1 + 0.3 * Math.max(0, 1 - k * 4);
      g.circle(0, 0, 20 * s).fill(THEME.ink);
      g.moveTo(-9 * s, 0).lineTo(-3 * s, 7 * s).lineTo(10 * s, -7 * s).stroke({ width: 4, color: 0xffffff, cap: "round", join: "round" });
      return;
    }
    const wanted: Color[] = [];
    for (const goal of this.game.goalsFor(n.t.id)) {
      for (let i = goal.delivered; i < goal.count; i++) wanted.push(goal.color);
    }
    const r = 7;
    const gap = 19;
    const perLine = 5;
    wanted.forEach((c, i) => {
      const line = Math.floor(i / perLine);
      const inLine = Math.min(perLine, wanted.length - line * perLine);
      const across = (i % perLine) - (inLine - 1) / 2;
      const along = (this.game.portrait ? h : w) / 2 + 14 + r + line * gap;
      const [x, y] = this.game.portrait ? [across * gap, along] : [along, across * gap];
      g.circle(x, y, r).fill(THEME.background).stroke({ width: 2.5, color: TOKEN_COLORS[c] });
    });
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
      const lane = offsetPolyline(subpath(route.pts, Math.min(HOP_REACH, routeLen / 2)), off);
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
