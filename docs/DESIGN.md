# Design notes

Detailed gameplay rules and implementation decisions behind Mini Petri.
The [README](../README.md) covers setup and a quick introduction.

## Reading the map

| Game | Petri net |
| --- | --- |
| circles | places |
| bars | transitions |
| lines with arrowheads | arcs; the line color is the token color it moves (black = any color), the number of arrowheads its weight |
| colored dots | colored tokens; the dots in a place are its marking |
| tapping a bar | firing an enabled transition |
| colored bars that fill up | source transitions firing on a timer |
| goals | sink transitions with a target number of tokens to consume |
| room in a circle | place capacity |
| dots behind a source | a bounded number of firings |
| building, connecting and removing | editing the net's structure while it runs |

Empty circles beside a goal show the tokens it still needs; each matching arrival removes a circle.
Completed goals are checked off and disappear.

## Net model
- A place's marking is an ordered list of colors (arrival order).
- An arc is `{ color?, count? }`.
  No color means "any" (drawn in ink/black); `count` defaults to 1.
- "Any" input arcs take the oldest tokens of their place; colored input arcs are bound first.
  "Any" output arcs pass on the colors taken by the transition's "any" inputs, so a transition's any-outputs may not exceed its any-inputs (checked when the net is built).
  A transition explicitly marked `copyInputColor` is the exception: it adds a copy of the first any-color input to its outputs.
  The generic 2-to-3 kit preserves both input colors and duplicates the oldest input.
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
- An unconnected capacity-1 place is ghosted after 120 seconds without a tap or token arrival.
  Connecting it clears the idle timer; disconnecting it starts a fresh timer.
  Larger places never expire, and in-flight tokens on ghost arcs finish as usual.

## Building and upgrades
- `Level.tools` declares which actions a level offers; places are built from selected loose ends rather than a separate toolbar tool.
- The buildable plane is unbounded; new nodes must be within a live node's build range and keep `CLEARANCE` (16) between node footprints (places reserve 48 for their largest size, transitions 36).
  Transitions and capacity-1 places have the base `BUILD_RANGE` of 220.
  Each place capacity level adds one fifth of that base: capacity 7 reaches 264, and capacity 19 reaches 308, including pre-upgraded starting places.
  Capacity upgrades immediately update placement rules, the range overlay and camera bounds.
- Arc reach is determined by the connected place's capacity level: 300, 360 or 420 units between centers, increasing by one fifth of the original 300-unit range per level.
  Wiring works identically when selecting either endpoint; newly built one-token places retain the 300-unit limit.
  Only selected places display and frame their upgraded reach.
  Selected transitions and new transition previews show the primary 300-unit ring, but upgraded places beyond it remain highlighted and connectible.
  Existing level arcs are unchanged.
- Built transitions come from kits (`{ id, ports }`) and start with all ports open; built ids are fresh (`p1`, `t1`, `c1`, …).
- Upgrades: auto (manual `normal` transition gets a 4 s interval; later upgrades multiply the interval by 0.6, down to 0.6 s), capacity (next of 1, 7 and 19).
  A place cannot be upgraded if the larger footprint would overlap another node.
  In endless and survival runs, the capacity toolbar button and capacity rewards unlock at completed epoch 10; fixed levels retain their declared tools.
- Each run starts with 40 coins. Paid upgrades share a price starting at 5; each successful paid upgrade increases the next price by 1 for the rest of the run.
  Free upgrades, failed checks and removal do not change that price. Exhausting a finite source awards 5, and removing a place awards one per settled token.
  Removing a node refunds half of its total purchased upgrade costs, rounded to the nearest integer; existing upgrades and swallowed incoming tokens do not count.
  Ordinary node construction and connections are free; limited transition kits charge their displayed price when successfully built.
  An otherwise valid paid action that fails for insufficient coins briefly shakes the coin counter and its circle, without shaking the heart; feasibility and hover checks remain silent.
  A special kit can also convert an existing normal transition for the same stock and coin cost, preserving its identity, location, firing interval, timer and upgrade history.
  Conversion requires no more live incoming or outgoing arcs than the kit has ports in that direction; missing ports become open connectors.
  Existing arc endpoints are retained, matching colors are preferred, and weights/colors are changed to the kit's rules.
  Already committed firings finish with their original concrete tokens; only subsequent firings use the new functionality.
  Sources, sinks, incompatible connections and unavailable kits cannot be converted.
- When a resolved sink disappears, two distinct randomly selected powerups appear at its position for 120 seconds.
  Collecting one discards the other. The available rewards and their unlocks are listed in [Epoch progression](#epoch-progression).
  Free upgrades stack on the existing upgrade tool and are consumed before paid uses; limited kits stack in separate toolbar buttons.
  Free upgrades do not contribute to removal refunds. Invalid or unaffordable actions consume neither stock nor coins.
- All `Game` actions take `apply = false` to only check feasibility; the view uses this to highlight targets.

## Input
- `NetView.pick` maps a world point to the topmost live object: plug, transition, place, arc (with a screen-space tolerance), else empty space.
- `Controller` dispatches taps by brush: fire (default), kit, remove, auto, capacity.
  Tapping the selected toolbar tool again or pressing Escape returns to firing.
  Plugs can be picked with any brush, switching to the firing brush; the next tap on a place connects them.
  Tapping empty space with a plug selected builds and connects a capacity-1 place, subject to the place tool and ordinary placement rules.
  Tapping a connector while a plug is selected creates a nearby capacity-1 place connecting both ports, or just that port when tapped again.
  Touch creation from a selected plug requires either 40 screen pixels from its selection tap or 250 ms since selection, preventing accidental rapid nearby creation.
  This also protects automatically selected remaining plugs; mouse taps and connections to existing places are unchanged.
  Eligible transition bodies are highlighted too; tapping one chooses its first connectible input, then output, for the new place.
  Placement checks both endpoints' reach and all build and clearance constraints before changing the net; a blocked action gives denial feedback and preserves the selection.
  In firing mode, tapping a place first and then a plug connects them in the other order.
  Tapping a transition instead connects the selected place to its first eligible input port, then its first eligible output port; an explicitly tapped plug still takes precedence.
  Tapping empty space with a place selected builds an available one-to-one relay with its input connected, then selects its output.
  This ordinary relay has no redundant toolbar button; other transition kits retain theirs.
  After building a transition its first plug is selected, and after each connection the next one, so wiring is a sequence of taps on places.
  Build brushes revert to firing after a successful build; removal and upgrade brushes stay active.
  Special-transition brushes highlight compatible normal transitions and convert them when tapped, selecting any new open ports for wiring.
- Denied taps shake the node, or show a red ripple on empty space.
- Background drags pan unless a placement brush is active; a tap is dispatched only after release without a drag or pinch.
  Wheel and two-pointer pinch gestures zoom around the pointer or pinch midpoint.
- The world renders across the screen; compact HUD backplates protect text and controls, and those areas do not pass taps through to the net.
  Mouse hover highlights actionable targets and changes the cursor; empty draggable space uses a grab cursor.
- The camera center stays within the live nodes' bounds expanded by each node's build range.
  Selecting a loose end or place pans enough to show its connection-range circle where it fits, and centers axes where the circle is too large for the HUD-free viewport at the current zoom.

## Continuous-time firing semantics
- Firing is atomic: input tokens are removed and output tokens are committed to their target places at the moment of firing.
- Automatic transitions whose timers are ready are shuffled each step before firing, so competitors do not always favor insertion order.
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
- The app opens survival mode using the endless map and progression, regardless of the URL hash.
  The level definitions and completion rules remain available for future tutorials or quizzes.
- Each game owns its goal list and score, so spawned goals and deliveries do not leak across restarts.
  The score increases by matching goal tokens on arrival, and resolving every current goal does not end the game.
  The HUD shows the number of completed spawn epochs. Pausing freezes simulation time and player actions, but still allows camera navigation.
- An unlimited blue source, a capacity-19 source place, a capacity-7 destination, a manually fired color-preserving relay and a five-token blue sink form the initial network.
  Endless mode offers the relay kit initially; additional colored transition kits unlock over time.
- Epoch progression and spawning rules are detailed below.
- A sink's countdown starts after 180 seconds and expires 60 seconds later; yellow sinks instead have 360 seconds of grace and a 120-second countdown.
  Every token arriving during a countdown extends its deadline by ten seconds.
  A spawned source's countdown starts after 240 seconds without an emission and expires 60 seconds later; emission resets the entire timer.
  The initial blue source has no countdown.
  Timed-out transitions are disabled, crossed out, and removed after the same linger as completed goals; source tokens already in flight finish traveling.
  Arrivals are processed before timeouts and automatic firing, and late sink arrivals cannot avert expiry or score.

## Survival mode
- Each new run starts with 10 lives.
  Each sink timeout costs one life, even if partially filled; source timeouts and completed sinks do not cost lives.
  Losing the last life freezes the run and shows its score with restart and endless-continuation buttons.
  Restart creates a new survival run; endless continuation preserves the map, score, time, coins, inventory, progression and in-flight tokens, but removes life limits.
  On continuation, the HUD retains the attained survival score and epoch as the main numbers, followed by bracketed gains since switching (for example, `SCORE 100 [25]` and `EPOCH 50 [2]`).
  Internal score and epoch totals continue advancing normally, including powerup and spawn unlocks; restarting clears the survival snapshot.
- The `SKIP TO ENDLESS` button next to restart asks for confirmation before ending survival.
  Portrait screens shorten its label to `ENDLESS`.
  Pause, endless and restart form a horizontal row in landscape and a vertical stack in portrait, always against the right screen edge.
  The group is top-aligned with the score when space permits, or sits below the score metadata to avoid overlap.
  Subtle rounded boxes share the controls' clickable bounds.
  Likely smartphones (mobile user agent, or a small coarse-pointer touch screen) also show a fullscreen toggle before pause.
  In mobile portrait mode, pause, endless and restart collapse into a hamburger menu at the upper right.
  A separate rectangle-corner fullscreen icon sits immediately to its left and reflects enter/exit fullscreen state.
  The menu closes after an action, an outside tap or Escape, and when leaving portrait mode; opening it does not pause gameplay.
  Outside taps dismiss it without acting on the network behind it.
  Its label follows native fullscreen state; unavailable or denied fullscreen requests show a temporary HUD notice.
  Both confirmations pause the game while open, and cancellation restores its prior pause state.
- Coins appear inside an orange coin circle next to the survival heart and life count.
  Portrait screens center the counters below the toolbar; landscape screens bottom-align counters and tools in adjacent areas.
  Endless mode keeps the heart with an infinity counter.
  Each lost life animates a heart from the HUD to the timed-out sink, including the final life while the failure popup is open.
  In survival mode, each sink in countdown adds a small exclamation mark in its token color beside the heart.
  Clicking it smoothly scrolls the camera to that sink in 0.3 seconds; the final-life sink receives a slower 0.65-second scroll on game over.
  Camera scrolling continues while gameplay is frozen; manual pan or zoom interrupts it.
  Warnings jump during the last 15 seconds, stopping if a delivery extends the deadline out of that window.
  Resolved or expired sinks lose their warnings.
  Warning rows wrap and reserve HUD space without overlapping the toolbar.
  The heart toolbar button buys a life immediately for 50 coins initially, increasing by 10 per successful purchase.
  It appears after the first life loss and remains present even after recovering to the life cap, until survival ends.
  Lives are capped at 10; unaffordable purchases and purchases at the cap do nothing and do not increase the price.
- From completed epoch 50, survival reward selections have a 2% chance of containing one heart, doubled to 4% at 3 lives or fewer.
  Hearts are offered only below the life cap and add one life immediately when collected.
  A heart cannot be collected at the cap; its other option remains available.
  A heart already on the map when switching to endless gives 5 coins instead, so both choices remain useful.

## Epoch progression

The initial sink exists before the first epoch. Private progress gains 1 unit per elapsed second and 10 per emitted source token.
Every 60 units creates one new goal epoch; if placement fails, it retries rather than advancing.
New transitions have open colored ports, use normal clearance, and favor positions near the starting source, with an outer-edge fallback.

| Spawned epoch | Goal and source changes |
| --- | --- |
| 1–5 | Blue sink, requiring 5 tokens, one per firing. |
| 6 | Red sink and paired red source, each with 5 tokens. |
| 7–39 | Each epoch is 50% blue sink, 50% red sink with paired source. |
| 11 onward | Red endpoints are at least 250 units from existing nodes and 330 units apart instead of 219; the sink is 330 units from its anchor. Room is reserved for intermediate connections. |
| 21 onward | Red source and sink counts are sampled from 5 (75%), 10 (15%), or 15 (10%), subject to supply balancing. |
| 25–50 | Each blue sink has a 25% chance of consuming 2 tokens per firing; otherwise it consumes 1. |
| 40–99 | Each epoch is 45% blue, 45% red, or 10% green. Green sinks require 5 tokens and have no source. |
| 51 onward | Each blue sink has a 10% chance of consuming 3 tokens per firing, a 15% chance of consuming 2, and otherwise consumes 1. |
| 75 onward | Red sinks alternate between paired and source-free, starting with a paired sink. Paired sources reserve at least 5 tokens for the next source-free sink; sink demands and source supplies remain 5, 10, or 15. |
| 100 onward | Each epoch is 40% blue, 40% red, 10% green, or 10% yellow. Yellow sinks have no source, require 10, 20, or 30 tokens with equal probability, and have twice the normal grace and countdown. |

Blue sinks with multi-token inputs require 6 tokens in total; other blue sinks require 5. This keeps each target divisible by its input weight.
Red counts are adjusted when needed so cumulative red supply never falls below cumulative red sink demand, including source-free sinks.

### Powerup unlocks

These are available after the stated number of epochs have completed. A kit's price is paid when it is built, not when it is collected.
Below 50 coins, each unlocked coin reward has three times the selection weight of other non-heart rewards, for both choices without duplicates.
At 50 coins or more, non-heart rewards retain equal weights; survival heart probabilities are unchanged.
The table is checked against the powerup definitions by the tests.

| Completed epochs | ID | Reward | Kit cost |
| --- | --- | --- | --- |
| 0 | `coins5` | 5 coins | — |
| 10 | `capacity` | Free place upgrade | — |
| 0 | `auto` | Free time upgrade | — |
| 15 | `blueMultiply` | Blue 2→3 | 7 |
| 20 | `coins10` | 10 coins | — |
| 25 | `blueToRed` | Blue 2→red | 5 |
| 30 | `redToBlue` | Red→blue | 5 |
| 35 | `blueToGreen` | Blue→green | 10 |
| 40 | `splitAny` | Any 2→3 | 20 |
| 50 | `life` | Extra life | — |
| 60 | `redToGreen` | Red→green | 5 |
| 90 | `redBlueToYellow` | Red+blue→yellow | 10 |
| 120 | `redTwoBlueToYellow` | Red+2 blue→2 yellow | 20 |
| 150 | `coins20` | 20 coins | — |

When changing progression, update this overview and the boundary tests in [game.test.ts](../tests/game.test.ts) and [powerups.test.ts](../tests/powerups.test.ts).

## Presentation
- Transitions with connected arcs all predominantly above or below them use horizontal bars; arcs all predominantly left/right use vertical bars, including in portrait mode.
  Mixed or unconnected transitions retain the screen's default orientation.
  Arc routing, connectors, upgrade marks, hover bounds and picking use that same per-node orientation.
  Source/sink balances use the clear vertical side opposite their connections.
- Endless and survival runs begin with source-to-sink guidance until the first effective click (including selecting a tool or connector), or two completed epochs.
  Ineffective or denied clicks do not dismiss it.
  Default firing/wiring help disappears from epoch 11, and all tool help disappears from epoch 101.
  Pause status remains available, and hidden help releases its HUD space.
  At screen aspect ratios of at least 2:1, visible help sits to the right of the toolbar instead of above it.
  Standard landscape toolbar rows remain centered on the screen, aligned with their centered help text; symmetric side space keeps resource counters clear.
  These ultra-wide layouts use screen width for the zoom-in limit, allowing larger nodes on phones in landscape.
  When a connection circle cannot fit vertically at that zoom, its selected node stays centered on that axis rather than panning to an impossible fit.
- Finite source supply dots and sink goal circles share five-per-line grouping, spacing and distance from the node, mirrored upstream/downstream and transposed in portrait.
  Source dots remain smaller and filled; sink circles remain larger and outlined.
  Open connectors and balances prefer their normal flow side but flip to the opposite side if it has fewer live attached arcs.
  Ties keep the normal side, and perpendicular arcs do not force a flip.
  Connector arrows retain input/output semantics regardless of their physical side.
  Remaining balance circles tween to their new positions over 0.25 seconds on side changes and consumption, retaining animation state across net rebuilds.
- The warm off-white background has an extremely subtle soft rose tint.
- Sink deaths briefly tint the entire screen in the sink's token color, in both survival and endless modes.
  A single low-opacity flash fades over 0.22 seconds, including while the failure popup is open.
  Hearts use a darker red and removal crosses a browner red, distinct from red tokens.
- The survival-over card avoids the fatal sink's current screen position and its camera-scroll destination when space allows.
  It retains a clear position while the camera moves, accounts for its appearance overshoot and gentle bob, and falls back to the center if the screen is too constrained.
- Mini Metro-like palette (`src/render/style.ts`); portrait screens (height > 1.1 × width) transpose node coordinates, so the flow runs top to bottom and transition bars default to horizontal.
- Arcs are octilinear: a diagonal leg at the place and a straight leg (≥ 44 units where possible) along the flow axis into the transition; steep arcs get an extra leg perpendicular to the flow at the place.
  Several arcs on the same side of a transition attach at spread-out points on the bar.
- Arcs are drawn in the color of the tokens they move (ink for "any"), with one chevron per token moved (up to 5, then a "×n" label).
- Tokens from one firing on the same arc travel side by side.
  Tokens hop (lift, grow, shadow) between their slot inside a place and the arc.
- Place size shows its capacity: one central token, a ring of six, and a second ring of twelve.
- Sources with a `supply` show one dot per remaining firing upstream of them; exhausted sources show a check mark and fade away.
- Spawned sources and sinks fade and scale in, and shrink and fade out when resolved or timed out. Reward choices similarly animate in and out without delaying collection or expiry.
- Active expiry countdowns show a shrinking ring: black for sources, which cost no lives, and red for sinks.
  Timed-out sources and sinks show a cross before disappearing.
- Open ports dangle as short stubs with a plug, against the flow for inputs and along it for outputs; plugs pulse softly, the selected one strongly, with a line to the pointer.
- Ghosts are drawn at 30% opacity.
- Build brushes show the union of build ranges in white against a grey background, with blocked clearance areas around all nodes greyed out for the selected node kind. The overlay fades in and out over 250 ms and previews the node under the pointer, red if it cannot go there.
  When wiring from a place, plugs whose transitions cannot connect are dimmed instead of pulsing or highlighting on hover.
  Transition bodies show one small bar per successful player-applied time upgrade, including free upgrades but not pre-existing automation.
- A ring shows the connection range around the selected plug's transition or selected place, and around a node preview while building.
  Reachable places, or transitions with loose ends and their plugs, pulse within the ring.
- Enabled player transitions are dark and pulse; disabled ones are grey and shake when tapped.
  Timed transitions (sources) fill up with their color (from the bottom; from the left in portrait).
- Goal sinks show one empty circle per token still wanted, to their right (below in portrait).
- The win popup dims the screen, pops in with a back-out ease and confetti, and blocks input.
  Its animation runs on real time because the simulation clock is stopped.
- The HUD shows score, game time and epoch at the top left, and the coin balance at the bottom left, with small screen-space coin flights between the balance and the affected node.
  Pause and restart controls are at the top right; an in-game restart confirmation pauses play and restores its previous pause state when cancelled.
- UI text uses uppercase Fredoka, bundled under the SIL Open Font License.
- Reward choices use compact toolbar icons without text on pulsing grey backgrounds and remain screen-sized when zooming, with a shrinking expiry bar; numbers show coin amounts and kit prices.
  A collected choice is highlighted and flies toward its toolbar button or the coin balance; the unchosen item fades away.
  Camera bounds include uncollected rewards.
  The toolbar places unlocked upgrades after firing and before transition kits, with removal last and a little extra space before it.
  Selecting a tool gives its icon a subtle 0.2-second hop, then it rests on the same baseline as other tools; the button and hit area stay stationary.
  A white background and thicker border persist to indicate selection.
  It wraps into rows as needed and shows stock in green (free) or black (limited paid) badges, and prices in orange badges.
