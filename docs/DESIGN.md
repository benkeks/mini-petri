# Design notes

Implementation-level decisions behind Mini Petri.
The [README](../README.md) covers gameplay.

## Net model
- A place's marking is an ordered list of colors (arrival order).
- An arc is `{ color?, count? }`.
  No color means "any" (drawn in ink/black); `count` defaults to 1.
- "Any" input arcs take the oldest tokens of their place; colored input arcs are bound first.
  "Any" output arcs pass on the colors taken by the transition's "any" inputs, so a transition's any-outputs may not exceed its any-inputs (checked when the net is built).
- Places have a capacity (`DEFAULT_CAPACITY = 7`).
  A transition is disabled if firing it would push an output place's occupancy (settled tokens + tokens committed to it + net change) above capacity.
- Transition kinds: `normal` (fired by the player, optionally on an auto-fire interval later), `source` (no inputs, fires on a timer that the level's `ramp` speeds up), `sink` (no outputs, auto-fires).

## Continuous-time firing semantics
- Firing is atomic: input tokens are removed and output tokens are committed to their target places at the moment of firing.
- The animation has two phases: the consumed tokens travel into the transition; only when all of them have arrived do the produced tokens leave (overshoot time carries over, so timing is frame-rate independent).
- Output tokens join the target marking, and can enable further transitions, only on arrival, but they count towards the target's capacity immediately.
- Travel time is the arc's octilinear route length (see below) divided by `tokenSpeed` (230 units/s).
- Removing a transition drops its arcs, the tokens travelling on them, its pending firings and its timer.

## Goals
- A goal is `{ sinkId, color, count }`.
  Delivery counts when a consumed token *arrives* at the sink.
- Consumed colors are reserved at firing time; once a sink's goals are fully reserved it is disabled, so it never over-consumes.
  Wrong-colored tokens taken through an any-arc are wasted.
- A sink whose goals are met is marked resolved, shown with a check mark, and removed from the net (with its arcs) after `RESOLVED_LINGER` (1.2 s).
  The level is complete when all goal sinks are resolved; `Game.step` and `playerFire` then do nothing (the game is frozen behind the win popup).

## Presentation
- Mini Metro-like palette (`src/render/style.ts`); portrait screens (height > 1.1 × width) transpose node coordinates, so the flow runs top to bottom and transition bars lie horizontally.
- Arcs are octilinear: a diagonal leg at the place and a straight leg (≥ 44 units where possible) along the flow axis into the transition; steep arcs get an extra leg perpendicular to the flow at the place.
  Several arcs on the same side of a transition attach at spread-out points on the bar.
- Arcs are drawn in the color of the tokens they move (ink for "any"), with one chevron per token moved (up to 5, then a "×n" label).
- Tokens from one firing on the same arc travel side by side.
  Tokens hop (lift, grow, shadow) between their slot inside a place and the arc.
- Places show a capacity ring: ink for settled tokens, grey for tokens on their way, red when full.
- Enabled player transitions are dark and pulse; disabled ones are grey and shake when tapped.
  Timed transitions (sources) fill up with their color (from the bottom; from the left in portrait).
- Goal sinks show one empty circle per token still wanted, to their right (below in portrait).
- The win popup dims the screen, pops in with a back-out ease and confetti, and blocks input.
  Its animation runs on real time because the simulation clock is stopped.
