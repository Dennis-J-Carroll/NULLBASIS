# NULLBASIS

**NULLBASIS: Chainwarden Protocol** is a real-time logic/puzzle game about
defending a living computational network: predict how disturbances propagate,
catch instruments that lie, and reach backward up the chain to unmake threats
at their source.

- [`docs/DESIGN.md`](docs/DESIGN.md): the full game design document (pitch, systems, tools,
  enemies, levels, boss, worked puzzle, schema, prototype architecture, premortem).
- [`scripts/verify-leaning-relay.mjs`](scripts/verify-leaning-relay.mjs): headless,
  dependency-free simulation of the worked encounter. Every number in the design
  doc's §10–12 comes from it.

```sh
node scripts/verify-leaning-relay.mjs
```
