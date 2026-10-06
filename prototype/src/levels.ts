import type { Mat2, Vec2 } from './math.ts';

export type NodeIndex = 0 | 1 | 2;
export type LevelId = 'warmup' | 'relay-lie' | 'relay-bend';

export interface NodeDef {
  id: 'N0' | 'N1' | 'N2';
  name: string;
  /** Short label shown on the board when the node is not sealed. */
  glyph: string;
  /** Physical Jacobian, applied to every component entering the node. */
  J: Mat2;
  /** True → displayed coordinates (x' = D x). Identity when the node's screen is honest. */
  display: Mat2;
  cap?: number;
  integrity?: number;
  /** Whether filters can be installed on the output port. */
  port: boolean;
  /** Sealed nodes hide their transform from the player. */
  sealed: boolean;
}

export interface LevelDef {
  id: LevelId;
  title: string;
  nodes: readonly [NodeDef, NodeDef, NodeDef];
  friendly: { dir: Vec2; mag: number; hp: number };
  /** Waves ≤ 0 carry a faint trickle; from wave 1 the Leech wakes: min(max, base + perTick·wave). */
  leech: { dir: Vec2; trickle: number; base: number; perTick: number; max: number; hp: number };
  core: { supply: Vec2; threat: Vec2; need: number; safe: number; hp: number; hold: number };
  resources: { bw: number; bwCap: number; bwRegen: number; heatDecay: number };
  maxTicks: number;
  /** Shown after the encounter ends. */
  truth: { headline: string; body: string };
}

const SHEAR: Mat2 = [1, 1, 0, 1];
const I: Mat2 = [1, 0, 0, 1];

const intake: NodeDef = { id: 'N0', name: 'Intake', glyph: 'INTAKE', J: I, display: I, port: false, sealed: false };
const booster: NodeDef = {
  id: 'N2', name: 'Booster', glyph: 'BOOST ×3 ↕', J: [1, 0, 0, 3], display: I, cap: 6, integrity: 8, port: true, sealed: false,
};

const base = {
  friendly: { dir: [1, 0] as Vec2, mag: 2, hp: 3 },
  core: { supply: [1, 0] as Vec2, threat: [0, 1] as Vec2, need: 1.8, safe: 0.5, hp: 12, hold: 8 },
  resources: { bw: 10, bwCap: 12, bwRegen: 1, heatDecay: 10 },
  maxTicks: 40,
};

export const LEVELS: Record<LevelId, LevelDef> = {
  warmup: {
    ...base,
    id: 'warmup',
    title: 'Calibration Line',
    nodes: [intake, { id: 'N1', name: 'Relay', glyph: 'RELAY', J: I, display: I, port: true, sealed: false }, booster],
    leech: { dir: [0, 1], trickle: 0.15, base: 1, perTick: 0, max: 1, hp: 3 },
    truth: {
      headline: 'Every screen on this line was honest.',
      body: 'Aiming a filter at the red arrow works when the screen tells the truth. Fixing it before the Booster also kept the Core from ever feeling it.',
    },
  },
  'relay-lie': {
    ...base,
    id: 'relay-lie',
    title: 'Leaning Relay',
    nodes: [intake, { id: 'N1', name: 'Relay', glyph: 'RELAY', J: I, display: SHEAR, port: true, sealed: true }, booster],
    leech: { dir: [0, 1], trickle: 0.15, base: 0.5, perTick: 0.5, max: 2, hp: 3 },
    truth: {
      headline: 'The Relay’s screen was lying.',
      body: 'A Shear Phantom tilted the Relay’s display. Red and cyan were perpendicular all along, which is why the Booster showed them square again. A filter aimed by that screen carved a slice off your own cyan and sent it down the threat channel. Telling the filter to leave cyan alone, correcting the screen, or striking back from the Core all work.',
    },
  },
  'relay-bend': {
    ...base,
    id: 'relay-bend',
    title: 'Leaning Relay',
    nodes: [intake, { id: 'N1', name: 'Relay', glyph: 'RELAY', J: SHEAR, display: I, port: true, sealed: true }, booster],
    leech: { dir: [0, 1], trickle: 0.15, base: 0.5, perTick: 0.5, max: 2, hp: 3 },
    truth: {
      headline: 'The Relay really bent the signal.',
      body: 'Nothing was lying. The Relay physically sheared the red toward the cyan, so they truly overlapped, and that slant carried on into the Booster. Correcting the screen changes nothing here. Telling the filter to leave cyan alone, or striking back from the Core, works.',
    },
  },
};
