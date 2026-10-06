# Twin Relay prototype

The smallest experiment that can tell whether NULLBASIS's core idea is fun
(see `docs/DESIGN.md` §21–22): can players with no linear-algebra background
work out that a screen is lying, as opposed to the signal really being bent, and
do they enjoy finding out?

## What's in it

- **Three lines:** an optional *Calibration Line* (honest screens), then *Relay A* and
  *Relay B*. A and B are the two twins (`relay-lie`, `relay-bend`) in random
  order. They look identical at the Relay; only the downstream geometry or a scan
  tells them apart.
- **Tools:** Projection Pulse, Dual Align (Spare / Honest), Shear Scan, Backprop
  Strike. Real-time mode adds Chain Freeze.
- **Clock:** turn-based (default) or real-time at 4 s per tick, chosen per session
  for A/B testing.
- **Playtest instrumentation:** after any change to the network, the player
  predicts what reaches the Core 3 ticks later, and the answer is checked when
  that tick arrives. The session summary has a JSON log (actions with
  timestamps, predictions, outcomes, retries) with a Copy button.
- **Debug view:** press `D` to show the selected node's true transform, its
  screen map, its believed metric, and the filter's aim and readout in true and
  screen coordinates.

## Code map

| File | Role |
|---|---|
| `src/math.ts` | 2×2 linear algebra: projectors, clip Jacobian, inverse transpose |
| `src/levels.ts` | The three lines as data |
| `src/sim.ts` | Pure, deterministic tick simulation. Everything in true coordinates |
| `src/scenarios.ts` | Scripted playthroughs shared by tests and `npm run scenarios` |
| `src/render.ts` | Canvas board. Each chamber drawn in its node's *display* coordinates |
| `src/main.ts` | Input, tools, clock, prediction prompts, session flow, telemetry |
| `tests/sim.test.ts` | Design-doc numbers, twin indistinguishability, duality and backprop invariants |

## Commands

```sh
npm install
npm run dev        # http://localhost:5173
npm test
npm run scenarios
npm run build      # dist/index.html (standalone) and dist/twin-relay.html (artifact body)
```
