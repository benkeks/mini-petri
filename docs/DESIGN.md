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
  Game levels use capacities 1, 7 and 19; other capacities are rejected because they do not have a matching visual size.
- Transition kinds: `normal` (fired by the player, optionally on an auto-fire interval), `source` (no inputs, fires on a timer that the level's `ramp` speeds up), `sink` (no outputs, auto-fires).
- `supply` bounds the remaining firings of a transition (used for sources); at 0 it is disabled.
- Open ports (`Transition.open`) are arcs without a place yet: `{ dir, color?, count? }`.
  A transition with open ports is disabled; `Net.connect` turns a port into an arc.
  Open ports count as their future arcs for the any-in/any-out check.

## Removal and ghosts
- Removing marks an arc, place or transition as a `ghost`; `inputs`/`outputs` and enabling ignore ghosts.
- The remove tool cannot remove source or sink transitions, though their arcs may still be removed.
- Ghosting an arc gives its (live) transition the arc back as an open port, so it is disabled until reconnected.
  Ghosting a transition ghosts its arcs; ghosting a place drops its marking and ghosts its arcs.
- Tokens already moving on ghost arcs finish their trip and firings in progress complete; output tokens arriving at a ghost place are dropped.
- `Simulation.step` garbage-collects ghosts: arcs with no tokens in flight and no pending firing outputs, then transitions with no firings and no arcs, then places with no arcs.
- Resolved goal sinks are still removed at once with `Simulation.removeTransition`.
- Exhausted sources show the same check mark and fade as resolved goals, then become ghosts so their outgoing tokens can finish before the source and its arcs are collected.
  Source exhaustion does not count towards level completion.

## Building and upgrades
- `Level.tools` declares which tools a level offers; usage is unlimited for now.
- The buildable plane is unbounded; new nodes must be within `BUILD_RANGE` (220) of a live node and keep `CLEARANCE` (24) between node footprints (places reserve 48 for their largest size, transitions 36).
- New connections must be at most `BUILD_RANGE + 80` (300) units between transition and place centers, including when building a place from a plug.
  Existing level arcs are unchanged.
- Built transitions come from kits (`{ id, ports }`) and start with all ports open; built ids are fresh (`p1`, `t1`, `c1`, …).
- Upgrades: auto (manual `normal` transition gets a 4 s interval; later upgrades multiply the interval by 0.6, down to 0.6 s), capacity (next of 1, 7 and 19).
  A place cannot be upgraded if the larger footprint would overlap another node.
- All `Game` actions take `apply = false` to only check feasibility; the view uses this to highlight targets.

## Input
- `NetView.pick` maps a world point to the topmost live object: plug, transition, place, arc (with a screen-space tolerance), else empty space.
- `Controller` dispatches taps by brush: fire (default), place, kit, remove, auto, capacity.
  Plugs can be picked with any brush, switching to the firing brush; the next tap on a place connects them.
  Tapping empty space with a plug selected builds and connects a capacity-1 place, subject to the place tool and ordinary placement rules.
  In firing mode, tapping a place first and then a plug connects them in the other order.
  Tapping a transition instead connects the selected place to its first eligible input port, then its first eligible output port; an explicitly tapped plug still takes precedence.
  After building a transition its first plug is selected, and after each connection the next one, so wiring is a sequence of taps on places.
  Build brushes revert to firing after a successful build; removal and upgrade brushes stay active.
- Denied taps shake the node, or show a red ripple on empty space.
- Background drags pan unless a placement brush is active; a tap is dispatched only after release without a drag or pinch.
  Wheel and two-pointer pinch gestures zoom around the pointer or pinch midpoint.
- The camera center stays within the live nodes' bounding box expanded by `BUILD_RANGE`.
  Zoom is capped so a full connection-range circle fits inside the HUD-free viewport, and selecting a loose end or place pans enough to show that circle.

## Continuous-time firing semantics
- Firing is atomic: input tokens are removed and output tokens are committed to their target places at the moment of firing.
- The animation has two phases: the consumed tokens travel into the transition; only when all of them have arrived do the produced tokens leave (overshoot time carries over, so timing is frame-rate independent).
- Output tokens join the target marking, and can enable further transitions, only on arrival, but they count towards the target's capacity immediately.
- Travel time is the arc's octilinear route length (see below) divided by `tokenSpeed` (230 units/s).
- `Simulation.removeTransition` removes a transition at once: it drops its arcs, the tokens travelling on them, its pending firings and its timer.

## Goals
- A goal is `{ sinkId, color, count }`.
  Delivery counts when a consumed token *arrives* at the sink.
- Consumed colors are reserved at firing time; once a sink's goals are fully reserved it is disabled, so it never over-consumes.
  Wrong-colored tokens taken through an any-arc are wasted.
- A sink whose goals are met is marked resolved, shown with a check mark, and removed from the net (with its arcs) after `RESOLVED_LINGER` (1.2 s).
  Tutorial levels complete when all goal sinks are resolved; `Game.step` and `playerFire` then do nothing (the game is frozen behind the win popup).

## Endless mode
- The app currently opens only endless mode, regardless of the URL hash.
  The level definitions and completion rules remain available for future tutorials or quizzes.
- Each game owns its goal list and score, so spawned goals and deliveries do not leak across restarts.
  The score increases by matching goal tokens on arrival, and resolving every current goal does not end the game.
- An unlimited blue source, two capacity-19 places, a manually fired color-preserving relay and a five-token blue sink form the initial network.
  Endless mode offers the relay kit but no green or yellow transition kits.
- Private progression gains one unit per elapsed second and ten units per token emitted by a source.
  Every 60 units creates a goal; the first five epochs produce blue goals.
  The sixth produces a red goal and source, and subsequent goals are randomly blue or red; each red goal has a paired five-token red source.
  New nodes have open colored ports and appear near live nodes, with normal placement clearance and a random bias towards the starting source.
  An outer-edge fallback allows growth when central areas are crowded.
  A red pair has room for a place connecting both endpoints.
- A sink's countdown starts after 180 seconds and expires 60 seconds later; every token arriving during the countdown extends its deadline by ten seconds.
  A spawned source's countdown starts after 240 seconds without an emission and expires 60 seconds later; emission resets the entire timer.
  The initial blue source has no countdown.
  Timed-out transitions are disabled, crossed out, and removed after the same linger as completed goals; source tokens already in flight finish traveling.
  Arrivals are processed before timeouts and automatic firing, and late sink arrivals cannot avert expiry or score.
  Building and upgrades remain unlimited.

## Presentation
- Mini Metro-like palette (`src/render/style.ts`); portrait screens (height > 1.1 × width) transpose node coordinates, so the flow runs top to bottom and transition bars lie horizontally.
- Arcs are octilinear: a diagonal leg at the place and a straight leg (≥ 44 units where possible) along the flow axis into the transition; steep arcs get an extra leg perpendicular to the flow at the place.
  Several arcs on the same side of a transition attach at spread-out points on the bar.
- Arcs are drawn in the color of the tokens they move (ink for "any"), with one chevron per token moved (up to 5, then a "×n" label).
- Tokens from one firing on the same arc travel side by side.
  Tokens hop (lift, grow, shadow) between their slot inside a place and the arc.
- Place size shows its capacity: one central token, a ring of six, and a second ring of twelve.
- Sources with a `supply` show one dot per remaining firing upstream of them; exhausted sources show a check mark and fade away.
- Active expiry countdowns show a shrinking red ring; timed-out sources and sinks show a cross before disappearing.
- Open ports dangle as short stubs with a plug, against the flow for inputs and along it for outputs; plugs pulse softly, the selected one strongly, with a line to the pointer.
- Ghosts are drawn at 30% opacity.
- Build brushes show the union of build ranges in white against a grey background, fading in and out over 250 ms, and preview the node under the pointer, red if it cannot go there.
- A ring shows the connection range around the selected plug's transition or selected place, and around a node preview while building.
  Reachable places, or transitions with loose ends and their plugs, pulse within the ring.
- Enabled player transitions are dark and pulse; disabled ones are grey and shake when tapped.
  Timed transitions (sources) fill up with their color (from the bottom; from the left in portrait).
- Goal sinks show one empty circle per token still wanted, to their right (below in portrait).
- The win popup dims the screen, pops in with a back-out ease and confetti, and blocks input.
  Its animation runs on real time because the simulation clock is stopped.
