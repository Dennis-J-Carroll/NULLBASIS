// Scripted playthroughs of the twin encounters. Shared by the unit tests and `npm run scenarios`.
// Keys are the tick the player is VIEWING when they act; effects land when the next tick is processed.
import { LEVELS, type LevelId } from './levels.ts';
import { type Action, type State, act, advance, componentAt, createState } from './sim.ts';

type Step = Action | ((s: State) => Action);
export interface Scenario { name: string; level: LevelId; plan: Record<number, Step[]> }

const red = (node: 1 | 2): Step => (s) => ({ kind: 'pulse', node, aim: componentAt(s, node, 'hostile')! });
const spareCyan = (node: 1 | 2): Step => (s) => ({ kind: 'alignSpare', node, tag: 'friendly', dir: componentAt(s, node, 'friendly')! });

export const SCENARIOS: Scenario[] = [
  { name: 'No action', level: 'relay-lie', plan: {} },
  { name: 'FAIL: naive pulse at N1, aimed by the screen', level: 'relay-lie', plan: { 0: [red(1)] } },
  { name: 'B: spare cyan, pulse red at N1', level: 'relay-lie', plan: { 0: [spareCyan(1), red(1)] } },
  { name: 'A: scan N1, then honest align + pulse', level: 'relay-lie',
    plan: { 0: [{ kind: 'scan', node: 1 }], 1: [{ kind: 'alignHonest', node: 1 }, red(1)] } },
  { name: 'C: Backprop Strike from the Core', level: 'relay-lie', plan: { 0: [{ kind: 'strike' }] } },
  { name: 'FAIL: strike through your own N2 filter is blocked', level: 'relay-lie', plan: { 0: [red(2), { kind: 'strike' }] } },
  { name: 'D: strip downstream at N2 only', level: 'relay-lie', plan: { 0: [red(2)] } },
  { name: 'FAIL: late strike through a saturated Booster', level: 'relay-lie', plan: { 4: [{ kind: 'strike' }] } },
  { name: 'FAIL: strike back through a miscalibrated filter hits your own source', level: 'relay-lie',
    plan: { 0: [red(1)], 1: [{ kind: 'strike' }] } },
  { name: 'RECOVERY: naive pulse, then spare cyan once the Core fires', level: 'relay-lie',
    plan: { 0: [red(1)], 3: [spareCyan(1)] } },
  { name: 'TWIN no action', level: 'relay-bend', plan: {} },
  { name: 'TWIN FAIL: naive pulse at N1', level: 'relay-bend', plan: { 0: [red(1)] } },
  { name: 'TWIN FAIL: scan, honest align, pulse (honest changes nothing here)', level: 'relay-bend',
    plan: { 0: [{ kind: 'scan', node: 1 }], 1: [{ kind: 'alignHonest', node: 1 }, red(1)] } },
  { name: 'TWIN: spare cyan, pulse red at N1', level: 'relay-bend', plan: { 0: [spareCyan(1), red(1)] } },
  { name: 'TWIN: Backprop Strike from the Core', level: 'relay-bend', plan: { 0: [{ kind: 'strike' }] } },
  { name: 'WARMUP: naive pulse at N1 works on an honest line', level: 'warmup', plan: { 0: [red(1)] } },
];

export function run(sc: Scenario, maxTicks = 20): State {
  const s = createState(LEVELS[sc.level]);
  while (s.status === 'playing' && s.tick < maxTicks) {
    for (const step of sc.plan[s.tick] ?? []) {
      const a = typeof step === 'function' ? step(s) : step;
      const err = act(s, a);
      if (err) throw new Error(`${sc.name} @t${s.tick} ${a.kind}: ${err}`);
    }
    advance(s);
  }
  return s;
}

/** Re-runs a scenario, recording every tick's events. */
export function trace(sc: Scenario, maxTicks = 20): { state: State; log: State['events'][] } {
  const s = createState(LEVELS[sc.level]);
  const log: State['events'][] = [];
  while (s.status === 'playing' && s.tick < maxTicks) {
    for (const step of sc.plan[s.tick] ?? []) act(s, typeof step === 'function' ? step(s) : step);
    advance(s);
    log.push(s.events);
  }
  return { state: s, log };
}
