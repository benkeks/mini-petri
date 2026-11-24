import type { Color } from "../core/multiset";

export const TOKEN_COLORS: Record<Color, number> = {
  red: 0xe0443e,
  blue: 0x2f7de1,
  green: 0x3aa856,
  yellow: 0xf2b632,
};

export const THEME = {
  background: 0xf5f0ed,
  buildOutside: 0xd8d6d1,
  ink: 0x2b2b2b,
  muted: 0xb8b2a7,
  arc: 0x8c867c,
  placeFill: 0xffffff,
  warn: 0xd8342c,
  heart: 0xb52b45,
  removal: 0x965342,
  enabledGlow: 0x2b2b2b,
  font: "Fredoka, sans-serif",
};

export const TOKEN_RADIUS = 6;
export const TRANSITION_W = 22;
export const TRANSITION_H = 64;
