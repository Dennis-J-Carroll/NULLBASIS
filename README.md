# NULLBASIS

**NULLBASIS: Chainwarden Protocol** is a real-time logic/puzzle game about
defending a living computational network: predict how disturbances propagate,
catch instruments that lie, and reach backward up the chain to unmake threats
at their source.

- [`docs/DESIGN.md`](docs/DESIGN.md): the full game design document (pitch, systems, tools,
  enemies, levels, boss, worked puzzle, schema, prototype architecture, premortem).
- [`prototype/`](prototype/): **Twin Relay**, the first playable experiment (§22.4 of the
  design doc). Two visually identical relay lines, one with a lying screen and one
  that really bends the signal, served in random order, with built-in prediction
  prompts and a copyable playtest log.

```sh
cd prototype
npm install
npm run dev        # play locally
npm test           # simulation tests (every number in DESIGN.md §10–12)
npm run scenarios  # prints each scripted playthrough tick by tick
npm run build      # single-file build: dist/index.html and dist/twin-relay.html
```
