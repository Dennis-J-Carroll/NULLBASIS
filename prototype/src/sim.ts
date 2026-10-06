// Deterministic simulation of a 4-stage relay chain: Intake → N1 → N2 → Core.
// Pure data in, pure data out (states are plain objects; `advance` mutates the state it is given,
// so callers that need a counterfactual clone first with `cloneState`).
//
// Pipeline: on tick t, Intake holds wave t, N1 holds wave t-1, N2 holds wave t-2, the Core receives wave t-3.
// Play starts at tick 0 with the pipeline already primed (waves -2..0 in place).
// Actions taken while viewing tick t take effect when tick t+1 is processed.
import {
  type Mat2, type Vec2, I2, T, add, clipJacobian, cross, dot, fmt, fmtV, inv, isOrthogonal, mul, mulM, norm, normalize,
  perp, scale, stripMatrix, sum,
} from './math.ts';
import type { LevelDef, NodeIndex } from './levels.ts';

export type Tag = 'friendly' | 'hostile';
export interface Comp { tag: Tag; v: Vec2 }
export interface Packet { wave: number; comps: Comp[] }

/** SPARE stores the tag; the spared direction is read from what enters the filter (dir is the fallback). */
export type Align = { mode: 'none' } | { mode: 'honest' } | { mode: 'spare'; tag: Tag; dir: Vec2 };
export type Verdict = 'coordinate' | 'signal' | 'both' | 'clean' | 'inconclusive';
export interface ScanResult { verdict: Verdict; tick: number }

export interface NodeState {
  filter: { aim: Vec2 } | null;
  align: Align;
  integrity: number;
  scan: ScanResult | null;
  /** Components arriving at the filter on the current tick (after J and the clip). */
  preComps: Comp[];
  /** Output of the node on the current tick (true coordinates). */
  out: Packet | null;
  /** J·input before the clip; used for backward strikes. */
  pre: Vec2 | null;
  sat: boolean;
  /** Filter matrix used on the current tick (identity when none). */
  P: Mat2;
}

export interface CoreReading {
  tick: number;
  wave: number;
  y: Vec2;
  comps: Comp[];
  supply: number;
  /** Signed threat reading. Negative = inverted. */
  threat: number;
  damage: number;
  clean: boolean;
}

export type Action =
  | { kind: 'pulse'; node: NodeIndex; aim: Vec2 }
  | { kind: 'clear'; node: NodeIndex }
  | { kind: 'alignHonest'; node: NodeIndex }
  | { kind: 'alignSpare'; node: NodeIndex; tag: Tag; dir: Vec2 }
  | { kind: 'scan'; node: NodeIndex }
  | { kind: 'strike' };

export type ActionKind = Action['kind'];

export interface RippleStep { at: 'core' | NodeIndex; g: Vec2 }

export type SimEvent =
  | { type: 'ripple'; steps: RippleStep[]; leechDamage: number; friendlyDamage: number }
  | { type: 'scan'; node: NodeIndex; verdict: Verdict }
  | { type: 'saturated'; node: NodeIndex }
  | { type: 'broken'; node: NodeIndex }
  | { type: 'leechDead' }
  | { type: 'core'; reading: CoreReading }
  | { type: 'overheat' }
  | { type: 'end'; status: 'won' | 'lost'; reason: string };

export interface State {
  level: LevelDef;
  tick: number;
  nodes: [NodeState, NodeState, NodeState];
  core: { hp: number; streak: number; last: CoreReading | null; history: CoreReading[] };
  friendly: { hp: number; scale: number };
  leech: { hp: number; alive: boolean };
  bw: number;
  heat: number;
  /** Ticks of Overheat remaining (Perceive verbs locked). */
  overheat: number;
  pending: { scans: NodeIndex[]; strike: boolean };
  status: 'playing' | 'won' | 'lost';
  endReason: string;
  spent: { bw: number; heat: number; actions: number };
  events: SimEvent[];
}

export const COST = {
  pulse: { bw: 2, heat: 0 },
  clear: { bw: 0, heat: 0 },
  alignHonest: { bw: 2, heat: 0 },
  alignSpare: { bw: 3, heat: 0 },
  scan: { bw: 0, heat: 25 },
  strike: { bw: 5, heat: 15 },
} as const satisfies Record<ActionKind, { bw: number; heat: number }>;

const HEAT_CAP = 100;
const OVERHEAT_TICKS = 3;

export const leechStrength = (level: LevelDef, wave: number): number =>
  wave <= 0 ? level.leech.trickle : Math.min(level.leech.max, level.leech.base + level.leech.perTick * wave);

export const cloneState = (s: State): State => structuredClone(s);

function emit(s: State, wave: number): Packet {
  const { friendly, leech } = s.level;
  const comps: Comp[] = [{ tag: 'friendly', v: scale(friendly.dir, friendly.mag * s.friendly.scale) }];
  if (s.leech.alive) comps.push({ tag: 'hostile', v: scale(leech.dir, leechStrength(s.level, wave)) });
  return { wave, comps };
}

export function createState(level: LevelDef): State {
  const node = (i: NodeIndex): NodeState => ({
    filter: null, align: { mode: 'none' }, integrity: level.nodes[i].integrity ?? Infinity, scan: null,
    preComps: [], out: null, pre: null, sat: false, P: I2,
  });
  const s: State = {
    level, tick: 0, nodes: [node(0), node(1), node(2)],
    core: { hp: level.core.hp, streak: 0, last: null, history: [] },
    friendly: { hp: level.friendly.hp, scale: 1 },
    leech: { hp: level.leech.hp, alive: true },
    bw: level.resources.bw, heat: 0, overheat: 0,
    pending: { scans: [], strike: false },
    status: 'playing', endReason: '',
    spent: { bw: 0, heat: 0, actions: 0 },
    events: [],
  };
  // The network is already running when the player arrives: prime the pipeline with waves -2 and -1.
  s.tick = -2;
  s.nodes[0].out = emit(s, -2);
  advance(s, true);
  advance(s, true);
  Object.assign(s, { bw: level.resources.bw, heat: 0, events: [] });
  return s;
}

/** The readout a filter at this node will use for a given aim. */
export function readoutFor(s: State, i: NodeIndex, aim: Vec2): Vec2 {
  const align = s.nodes[i].align;
  if (align.mode === 'honest') return aim; // true metric is the identity
  if (align.mode === 'spare') return perp(componentAt(s, i, align.tag) ? normalize(componentAt(s, i, align.tag)!) : align.dir);
  const D = s.level.nodes[i].display;
  return mul(mulM(T(D), D), aim); // instruments treat the screen as Euclidean
}

export function filterMatrix(s: State, i: NodeIndex): Mat2 | null {
  const f = s.nodes[i].filter;
  return f ? stripMatrix(f.aim, readoutFor(s, i, f.aim)) : null;
}

/** A component as it enters the node's filter (what aiming and sparing refer to). */
export function componentAt(s: State, i: NodeIndex, tag: Tag): Vec2 | null {
  const c = s.nodes[i].preComps.find((k) => k.tag === tag);
  return c && norm(c.v) > 1e-6 ? c.v : null;
}
/** A component as it leaves the node. */
export function outputAt(s: State, i: NodeIndex, tag: Tag): Vec2 | null {
  const c = s.nodes[i].out?.comps.find((k) => k.tag === tag);
  return c && norm(c.v) > 1e-6 ? c.v : null;
}

/** Returns a reason string when the action is not allowed right now, or null when it is. */
export function validate(s: State, a: Action): string | null {
  if (s.status !== 'playing') return 'The encounter is over.';
  const cost = COST[a.kind];
  if (s.bw < cost.bw) return `Needs ${cost.bw} bandwidth (you have ${s.bw}).`;
  if (cost.heat > 0) {
    if (s.overheat > 0) return `Overheated: diagnostics are locked for ${s.overheat} more tick${s.overheat > 1 ? 's' : ''}.`;
  }
  if ('node' in a) {
    const def = s.level.nodes[a.node];
    if (!def.port && a.kind !== 'scan') return `${def.name} has no output port.`;
  }
  switch (a.kind) {
    case 'pulse': {
      if (norm(a.aim) < 1e-9) return 'Pick a direction to aim at.';
      if (!stripMatrix(normalize(a.aim), readoutFor(s, a.node, normalize(a.aim))))
        return 'That aim runs along the direction you told this node to spare, so the filter would remove nothing.';
      return null;
    }
    case 'clear':
      return s.nodes[a.node].filter ? null : 'There is no filter here to remove.';
    case 'alignHonest': {
      const scan = s.nodes[a.node].scan;
      if (!scan || scan.verdict === 'inconclusive') return 'Honest alignment needs this node’s true geometry. Scan it first.';
      if (s.nodes[a.node].align.mode === 'honest') return 'This node is already honestly aligned.';
      return null;
    }
    case 'alignSpare':
      if (norm(a.dir) < 1e-9) return 'Pick a visible component to spare.';
      return null;
    case 'scan':
      if (s.level.nodes[a.node].id === 'N0') return 'The Intake is a trusted reference; there is nothing to scan.';
      if (s.pending.scans.includes(a.node)) return 'A scan is already running on this node.';
      return null;
    case 'strike':
      return s.pending.strike ? 'A strike is already queued for this tick.' : null;
  }
}

/** Apply a player action. It takes effect when the next tick is processed. Returns an error string or null. */
export function act(s: State, a: Action): string | null {
  const err = validate(s, a);
  if (err) return err;
  const cost = COST[a.kind];
  s.bw -= cost.bw;
  s.heat += cost.heat;
  s.spent.bw += cost.bw;
  s.spent.heat += cost.heat;
  s.spent.actions += 1;
  switch (a.kind) {
    case 'pulse': s.nodes[a.node].filter = { aim: normalize(a.aim) }; break;
    case 'clear': s.nodes[a.node].filter = null; break;
    case 'alignHonest': s.nodes[a.node].align = { mode: 'honest' }; break;
    case 'alignSpare': s.nodes[a.node].align = { mode: 'spare', tag: a.tag, dir: normalize(a.dir) }; break;
    case 'scan': s.pending.scans.push(a.node); break;
    case 'strike': s.pending.strike = true; break;
  }
  if (s.heat >= HEAT_CAP) {
    s.overheat = OVERHEAT_TICKS;
    s.events.push({ type: 'overheat' });
  }
  return null;
}

function processNode(s: State, i: NodeIndex, input: Packet | null): void {
  const def = s.level.nodes[i];
  const ns = s.nodes[i];
  if (!input) {
    ns.P = filterMatrix(s, i) ?? I2;
    ns.out = null; ns.pre = null; ns.sat = false; ns.preComps = [];
    return;
  }
  if (ns.integrity <= 0) {
    ns.preComps = input.comps.map((c) => ({ tag: c.tag, v: [0, 0] }));
    ns.P = I2;
    ns.out = { wave: input.wave, comps: ns.preComps };
    ns.pre = [0, 0]; ns.sat = false;
    return;
  }
  let comps = input.comps.map((c) => ({ tag: c.tag, v: mul(def.J, c.v) }));
  const pre = sum(comps.map((c) => c.v));
  let sat = false;
  if (def.cap !== undefined && norm(pre) > def.cap) {
    const k = def.cap / norm(pre);
    comps = comps.map((c) => ({ tag: c.tag, v: scale(c.v, k) }));
    sat = true;
  }
  ns.preComps = comps;
  ns.P = filterMatrix(s, i) ?? I2;
  comps = comps.map((c) => ({ tag: c.tag, v: mul(ns.P, c.v) }));
  ns.out = { wave: input.wave, comps };
  ns.pre = pre;
  ns.sat = sat;
}

/** Backward pass from the Core's threat readout through N2 and N1 to the Intake emitters. */
function resolveStrike(s: State): void {
  let g = s.level.core.threat;
  const steps: RippleStep[] = [{ at: 'core', g }];
  for (const i of [2, 1] as const) {
    const ns = s.nodes[i];
    const def = s.level.nodes[i];
    g = mul(T(ns.P), g);
    if (ns.sat && ns.pre && def.cap !== undefined) g = mul(clipJacobian(ns.pre, def.cap), g);
    if (ns.integrity <= 0) g = [0, 0];
    g = mul(T(def.J), g);
    steps.push({ at: i, g });
  }
  steps.push({ at: 0, g });
  const leechDamage = s.leech.alive ? Math.abs(dot(g, s.level.leech.dir)) : 0;
  const friendlyDamage = Math.abs(dot(g, s.level.friendly.dir));
  s.events.push({ type: 'ripple', steps, leechDamage, friendlyDamage });
  if (s.leech.alive) {
    s.leech.hp -= leechDamage;
    if (s.leech.hp <= 1e-9) {
      s.leech.hp = 0;
      s.leech.alive = false;
      s.events.push({ type: 'leechDead' });
    }
  }
  s.friendly.hp = Math.max(0, s.friendly.hp - friendlyDamage);
  s.friendly.scale = s.friendly.hp / s.level.friendly.hp;
}

function resolveScan(s: State, i: NodeIndex, input: Packet | null): void {
  const def = s.level.nodes[i];
  const vs = (input?.comps ?? []).map((c) => c.v).filter((v) => norm(v) > 0.05);
  const rank2 = vs.some((a) => vs.some((b) => Math.abs(cross(normalize(a), normalize(b))) > 0.05));
  let verdict: Verdict;
  if (!rank2) verdict = 'inconclusive';
  else {
    const lie = !isOrthogonal(def.display);
    const bend = !isOrthogonal(def.J);
    verdict = lie && bend ? 'both' : lie ? 'coordinate' : bend ? 'signal' : 'clean';
  }
  s.nodes[i].scan = { verdict, tick: s.tick };
  s.events.push({ type: 'scan', node: i, verdict });
}

export function classifyThreat(level: LevelDef, threat: number, supply: number): Outcome {
  if (threat > level.core.safe + 1e-9) return 'up';
  if (threat < -level.core.safe - 1e-9) return 'down';
  if (supply < level.core.need - 1e-9) return 'starved';
  return 'clean';
}
export type Outcome = 'clean' | 'up' | 'down' | 'starved';

/** Advance one tick. Set `force` to keep simulating after the encounter has ended (used for forecasts). */
export function advance(s: State, force = false): State {
  if (s.status !== 'playing' && !force) return s;
  s.events = [];
  const prev = s.nodes.map((n) => n.out) as [Packet | null, Packet | null, Packet | null];
  s.tick += 1;

  processNode(s, 1, prev[0]);
  processNode(s, 2, prev[1]);
  for (const i of [1, 2] as const) {
    const ns = s.nodes[i];
    if (ns.sat && Number.isFinite(ns.integrity)) {
      ns.integrity -= 1;
      s.events.push({ type: ns.integrity <= 0 ? 'broken' : 'saturated', node: i });
    }
  }
  if (s.pending.strike) resolveStrike(s);
  for (const i of s.pending.scans) resolveScan(s, i, prev[i - 1]);
  s.pending = { scans: [], strike: false };
  s.nodes[0].out = emit(s, s.tick);

  const arriving = prev[2];
  if (arriving) {
    const { core } = s.level;
    const y = sum(arriving.comps.map((c) => c.v));
    const supply = dot(core.supply, y);
    const threat = dot(core.threat, y);
    const damage = Math.max(0, Math.abs(threat) - core.safe);
    const clean = supply >= core.need - 1e-9 && Math.abs(threat) <= core.safe + 1e-9;
    const reading: CoreReading = { tick: s.tick, wave: arriving.wave, y, comps: arriving.comps, supply, threat, damage, clean };
    s.core.hp -= damage;
    s.core.streak = clean ? s.core.streak + 1 : 0;
    s.core.last = reading;
    s.core.history.push(reading);
    s.events.push({ type: 'core', reading });
  } else {
    s.core.last = null;
  }

  s.bw = Math.min(s.level.resources.bwCap, s.bw + s.level.resources.bwRegen);
  s.heat = Math.max(0, s.heat - s.level.resources.heatDecay);
  if (s.overheat > 0) {
    s.overheat -= 1;
    if (s.overheat === 0) s.heat = Math.min(s.heat, 60);
  }

  if (s.status === 'playing') {
    let end: { status: 'won' | 'lost'; reason: string } | null = null;
    if (s.core.hp <= 1e-9) end = { status: 'lost', reason: 'The Core’s integrity reached zero.' };
    else if (s.core.streak >= s.level.core.hold) end = { status: 'won', reason: `The Core held clean for ${s.level.core.hold} ticks in a row.` };
    else if (s.tick >= s.level.maxTicks) end = { status: 'lost', reason: 'The network never stabilised before the shift ended.' };
    if (end) {
      s.status = end.status;
      s.endReason = end.reason;
      s.events.push({ type: 'end', ...end });
    }
  }
  return s;
}

/** What the Core will receive `horizon` ticks from now if the player does nothing else. */
export function forecast(s: State, horizon = 3): CoreReading | null {
  const c = cloneState(s);
  for (let k = 0; k < horizon; k++) advance(c, true);
  return c.core.last;
}

/** The friendly-only Core vector with no threats and no interventions (reference for Purity). */
export function idealCore(level: LevelDef): Vec2 {
  let v = scale(level.friendly.dir, level.friendly.mag);
  for (const n of level.nodes.slice(1)) v = mul(n.J, v);
  return v;
}

export function purity(s: State): number {
  const ref = idealCore(s.level);
  const h = s.core.history;
  if (!h.length) return 0;
  const vals = h.map((r) => {
    const friendlyAtCore = sum(r.comps.filter((c) => c.tag === 'friendly').map((c) => c.v));
    return Math.max(0, 1 - norm(add(friendlyAtCore, scale(ref, -1))) / norm(ref));
  });
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** Display-space transform helpers for the view layer. */
export const toDisplay = (s: State, i: NodeIndex, v: Vec2): Vec2 => mul(s.level.nodes[i].display, v);
export const fromDisplay = (s: State, i: NodeIndex, v: Vec2): Vec2 => mul(inv(s.level.nodes[i].display), v);
/** Readouts are covectors: they transform with the inverse transpose. */
export const readoutToDisplay = (s: State, i: NodeIndex, r: Vec2): Vec2 => mul(T(inv(s.level.nodes[i].display)), r);

export function describeVerdict(v: Verdict): { label: string; detail: string } {
  switch (v) {
    case 'coordinate': return { label: 'Coordinate distortion', detail: 'This node’s screen is warped. The signals passing through are intact.' };
    case 'signal': return { label: 'Signal deformation', detail: 'This node really reshapes the signals passing through it. Its screen is honest.' };
    case 'both': return { label: 'Distortion and deformation', detail: 'The screen is warped and the node also reshapes signals.' };
    case 'clean': return { label: 'Clean', detail: 'Honest screen, shape-preserving node.' };
    case 'inconclusive': return { label: 'Inconclusive', detail: 'A scan needs two different signals passing at once. Only one was present.' };
  }
}

export const debugLine = (r: CoreReading): string =>
  `t${r.tick} core=${fmtV(r.y)} supply=${fmt(r.supply)} threat=${fmt(r.threat)} dmg=${fmt(r.damage)}`;
