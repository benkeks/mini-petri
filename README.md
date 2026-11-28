# Mini Petri

A small Mini Metro-style browser and smartphone game built on colored Petri nets (TypeScript + PixiJS v8).

[![Play Mini Petri](docs/animatedscreenshot.gif)](https://benkeks.github.io/mini-petri/)

Play current development version: <https://benkeks.github.io/mini-petri/>

## How to play

Route colored deliveries from sources to matching goals (sinks).
Circles hold box-shaped deliveries; bars are transitions; colored lines show which deliveries a connection moves.
Dashed x-ray segments reveal connections hidden by unrelated nodes; focus a node to highlight its connections and their endpoints.
Empty boxes beside a goal show what it still needs.
Filled goals disappear, and your score counts matching deliveries; new sources, goals and colors appear as epochs advance.

**Tap a dark transition to fire it**, consuming its inputs and sending deliveries onward.
Grey transitions are blocked: they need the right deliveries, connected ports and room at their destinations; sources and sinks fire automatically.
Place sizes indicate capacities of 1, 7 or 19 deliveries, and finite sources show their remaining supply.
Later goals can require multiple colors or colors produced by special transitions.

Drag empty space to pan; use the mouse wheel, trackpad or a two-finger pinch to zoom.
Tap the delivery count for color-stacked statistics; the survival result also offers this screen.
**Pause** freezes gameplay, **Restart** begins a fresh run after confirmation, and supported smartphones offer fullscreen.

Games save automatically in this browser; when several sessions exist, choose one at startup.
Restart keeps your current session unless you choose to discard it; saves stay on this device and can be cleared by the browser.

### Building and upgrades

Use the bottom toolbar; tap the selected tool again or press Escape to return to firing.
Hold to preview a build, drag to adjust it, and release at a valid position to commit.
Release outside the play area, select the starting node again, release far beyond build range, or press Escape to cancel.

- **Connect:** tap or drag between a loose plug and a place, or build a connected place or relay in empty space.
- **Extend:** select a place and build a connected relay; special-transition tools build or convert transitions with different functionality.
- **Auto** (clock) automates a transition; further uses make it faster.
- **Capacity** (plus, unlocked at epoch 10) enlarges a place and increases its building and connection ranges.
- **Remove** (cross) removes connections or player nodes, but not sources, sinks, the first source's large output place or its original source arc.

New transitions cannot fire until every plug is connected.
An unconnected one-delivery place expires after 30 idle seconds; connecting or upgrading it prevents this.

### Survival and rewards

You start with **10 lives and 40 coins**.
Sinks that go too long without deliveries expire and cost a life; tap an exclamation mark beside the heart to find one in danger.
At zero lives, restart or continue in endless mode with your network intact; you can also skip to endless at any time.

Building and wiring are free, while upgrades cost coins.
Filled sinks offer a choice of rewards, including coins, free upgrades and transition kits.
After your first lost life, the heart tool offers replacement lives.

## Petri nets behind the game

The map *is* a colored Petri net, edited while it runs.

See the [design notes](docs/DESIGN.md) for detailed rules, controls, Petri-net terminology and epoch progression.

## Development

Build instructions, code layout, saving and PWA details are in the [development notes](docs/DEVELOPMENT.md).

### License

MIT — see [LICENSE](LICENSE).
