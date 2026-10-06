import './styles.css';
import { LEVELS, type LevelId, type NodeIndex } from './levels.ts';
import { type Vec2, fmt, fmtV, mul, norm, T, inv } from './math.ts';
import {
  type Action, type CoreReading, type Outcome, type State, type Tag, COST, act, advance, classifyThreat, componentAt,
  createState, describeVerdict, forecast, purity, readoutFor, validate,
} from './sim.ts';
import { type Anim, type Frame, type Slot, type ViewState, chamberAt, dragToAim, draw, hitTest, layout } from './render.ts';

// ---------------------------------------------------------------- session + telemetry
type ClockMode = 'turn' | 'real';
interface Settings { clock: ClockMode; predict: boolean; warmup: boolean }
interface Encounter { level: LevelId; label: string }
interface AttemptLog {
  level: LevelId; label: string; attempt: number; clock: ClockMode;
  startedAt: string; durationMs: number; firstActionMs: number | null;
  outcome: 'won' | 'lost' | 'abandoned'; endTick: number; coreHp: number; purity: number;
  spent: { bw: number; heat: number; actions: number }; frozenMs: number;
  actions: { tick: number; ms: number; kind: string; node?: number; detail?: string }[];
  predictions: { tick: number; ms: number; answer: Outcome | 'unsure'; truth: Outcome; correct: boolean | null }[];
}

const sessionId = Math.random().toString(36).slice(2, 10);
const settings: Settings = { clock: 'turn', predict: true, warmup: true };
let encounters: Encounter[] = [];
let encIndex = 0;
const logs: AttemptLog[] = [];

// ---------------------------------------------------------------- game state
let state: State = createState(LEVELS.warmup);
let log: AttemptLog | null = null;
let attemptStart = 0;
let physicsDirty = false;
let duePredictions: { due: number; answer: Outcome | 'unsure'; truth: Outcome }[] = [];
type Tool = 'pulse' | 'spare' | 'honest' | 'scan' | null;
let tool: Tool = null;
let clockAcc = 0;
let lastFrame = performance.now();
let frozen = false;
let freeze = 100;
let frozenMs = 0;
const TICK_MS = 4000;
let modalOpen = false;
let ledgerItems: { tick: number; text: string; tone: string }[] = [];

const view: ViewState = {
  selected: 1, hover: null, drag: null, anims: [], debug: false,
  targetable: (i) => {
    if (!tool) return false;
    const def = state.level.nodes[i];
    if (tool === 'scan') return def.id !== 'N0';
    return def.port;
  },
};
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------- DOM
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('board');
const ctx = canvas.getContext('2d')!;
let frame: Frame = { w: 0, h: 0, chambers: [], hits: [] };

const TOOLS: { id: Exclude<Tool, null> | 'strike'; key: string; name: string; cost: string; desc: string }[] = [
  { id: 'pulse', key: '1', name: 'Projection Pulse', cost: `${COST.pulse.bw} BW`, desc: 'Install a filter. Click an arrow (or drag) to aim at what it should remove.' },
  { id: 'spare', key: '2', name: 'Dual Align · Spare', cost: `${COST.alignSpare.bw} BW`, desc: 'Tell this node’s filter to leave one component completely untouched. Click that arrow.' },
  { id: 'honest', key: '3', name: 'Dual Align · Honest', cost: `${COST.alignHonest.bw} BW`, desc: 'Make this node’s filter use the true geometry. Needs a scan of that node first.' },
  { id: 'scan', key: '4', name: 'Shear Scan', cost: `${COST.scan.heat} Heat`, desc: 'Learn whether a node’s screen lies or the node bends the signal. Result next tick.' },
  { id: 'strike', key: '5', name: 'Backprop Strike', cost: `${COST.strike.bw} BW · ${COST.strike.heat} Heat`, desc: 'Send a correction backward from the Core’s threat readout to whatever upstream feeds it.' },
];

function buildTools() {
  const box = $('tools');
  box.innerHTML = '';
  for (const t of TOOLS) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'tool'; b.id = `tool-${t.id}`;
    b.innerHTML = `<span class="tool-name"><span class="key">${t.key}</span>${t.name}</span><span class="tool-cost">${t.cost}</span><span class="tool-desc">${t.desc}</span>`;
    b.addEventListener('click', () => chooseTool(t.id));
    box.appendChild(b);
  }
}

function chooseTool(id: Exclude<Tool, null> | 'strike') {
  if (state.status !== 'playing' || modalOpen) return;
  if (id === 'strike') {
    tool = null;
    doAction({ kind: 'strike' });
    return;
  }
  tool = tool === id ? null : id;
  syncUI();
}

// ---------------------------------------------------------------- actions
function actionDetail(a: Action): string {
  switch (a.kind) {
    case 'pulse': return `aim ${fmtV(a.aim)}`;
    case 'alignSpare': return `spare ${a.tag}`;
    default: return '';
  }
}

function doAction(a: Action) {
  const err = act(state, a);
  if (err) { toast(err, 'bad'); return; }
  const ms = performance.now() - attemptStart;
  if (log) {
    if (log.firstActionMs === null) log.firstActionMs = Math.round(ms);
    log.actions.push({ tick: state.tick, ms: Math.round(ms), kind: a.kind, node: 'node' in a ? a.node : undefined, detail: actionDetail(a) || undefined });
  }
  if (a.kind !== 'scan') physicsDirty = true;
  const name = (i: NodeIndex) => state.level.nodes[i].name;
  const msg: Record<Action['kind'], string> = {
    pulse: 'node' in a ? `Filter installed at ${name(a.node as NodeIndex)}. It acts on packets from the next tick.` : '',
    clear: 'node' in a ? `Filter removed from ${name(a.node as NodeIndex)}.` : '',
    alignHonest: 'node' in a ? `${name(a.node as NodeIndex)} now builds readouts from its true geometry.` : '',
    alignSpare: a.kind === 'alignSpare' ? `${name(a.node)}’s filter will leave ${a.tag === 'friendly' ? 'cyan' : 'red'} untouched.` : '',
    scan: 'node' in a ? `Scanning ${name(a.node as NodeIndex)}. Result arrives next tick.` : '',
    strike: 'Backprop Strike queued. It fires backward from the Core on the next tick.',
  };
  ledger(msg[a.kind], a.kind === 'strike' ? 'back' : 'info');
  tool = null;
  syncUI();
}

function requestAdvance() {
  if (state.status !== 'playing' || modalOpen) return;
  if (settings.predict && physicsDirty) {
    openPrediction();
    return;
  }
  doAdvance();
}

function doAdvance() {
  const prevOuts = state.nodes.map((n) => n.out);
  advance(state);
  physicsDirty = false;
  clockAcc = 0;
  if (frozen) toggleFreeze(false);
  freeze = Math.min(100, freeze + 5);
  const now = performance.now();
  if (!reduceMotion) {
    const dots: Extract<Anim, { kind: 'flow' }>['dots'] = [];
    prevOuts.forEach((p, i) => {
      if (!p) return;
      const tags = p.comps.filter((c) => norm(c.v) > 0.05).map((c) => c.tag);
      if (tags.length) dots.push({ from: i as Slot, to: (i + 1) as Slot, tags });
    });
    view.anims.push({ kind: 'flow', start: now, dur: 520, dots });
  }
  for (const e of state.events) {
    switch (e.type) {
      case 'core': coreLedger(e.reading); break;
      case 'saturated': ledger(`${state.level.nodes[e.node].name} saturated: everything passing was scaled down, cyan included.`, 'bad'); break;
      case 'broken': ledger(`${state.level.nodes[e.node].name} burned out from saturation.`, 'bad'); break;
      case 'scan': {
        const v = describeVerdict(e.verdict);
        ledger(`Scan of ${state.level.nodes[e.node].name}: ${v.label}. ${v.detail}`, 'info');
        if (!reduceMotion) view.anims.push({ kind: 'scan', start: now, dur: 700, node: e.node });
        break;
      }
      case 'ripple':
        ledger(`Strike rippled back: Leech −${fmt(e.leechDamage)}${e.friendlyDamage > 0.005 ? `, your cyan source −${fmt(e.friendlyDamage)}` : ''}.`, 'back');
        view.anims.push({ kind: 'ripple', start: now, dur: reduceMotion ? 1 : 1500, steps: e.steps, leech: e.leechDamage, friendly: e.friendlyDamage });
        break;
      case 'leechDead': ledger('The Leech is gone. Anything it already sent is still in the pipe.', 'good'); break;
      case 'overheat': ledger('Overheated. Scans and strikes are locked for 3 ticks.', 'bad'); break;
      case 'end': break;
    }
  }
  // resolve predictions that are due
  duePredictions = duePredictions.filter((p) => {
    if (state.tick < p.due) return true;
    if (p.answer !== 'unsure') {
      const ok = p.answer === p.truth;
      toast(`Prediction from t${p.due - 3}: ${ok ? 'right' : 'missed'}. It was “${OUTCOME[p.truth].title}”.`, ok ? 'good' : 'bad');
    }
    return false;
  });
  syncUI();
  if (state.status !== 'playing') setTimeout(showResult, reduceMotion ? 100 : 900);
}

function coreLedger(r: CoreReading) {
  const o = classifyThreat(state.level, r.threat, r.supply);
  const src = (() => {
    if (o !== 'up' && o !== 'down') return '';
    const red = r.comps.find((c) => c.tag === 'hostile');
    const cyan = r.comps.find((c) => c.tag === 'friendly');
    const redPart = red ? Math.abs(red.v[1]) : 0;
    const cyanPart = cyan ? Math.abs(cyan.v[1]) : 0;
    return cyanPart > redPart ? ' Source: your own cyan, bent into the threat channel.' : ' Source: red.';
  })();
  const text = {
    clean: `Core clean. Supply ${fmt(r.supply)}, threat ${fmt(r.threat)}.`,
    starved: `Core starved: supply ${fmt(r.supply)} is below ${state.level.core.need}.`,
    up: `Core hit: threat ${fmt(r.threat)}, −${fmt(r.damage)} integrity.${src}`,
    down: `Core hit by an inverted threat (${fmt(r.threat)}), −${fmt(r.damage)} integrity.${src}`,
  }[o];
  ledger(text, o === 'clean' ? 'good' : 'bad');
}

function ledger(text: string, tone: string) {
  ledgerItems.unshift({ tick: state.tick, text, tone });
  ledgerItems = ledgerItems.slice(0, 60);
}

// ---------------------------------------------------------------- freeze / clock
function toggleFreeze(on = !frozen) {
  if (settings.clock !== 'real' || state.status !== 'playing') return;
  if (on && freeze <= 0) { toast('No Freeze charge left. It recharges 5 per tick.', 'bad'); return; }
  frozen = on;
  syncUI();
}

function loop(now: number) {
  const dt = Math.min(100, now - lastFrame);
  lastFrame = now;
  if (settings.clock === 'real' && state.status === 'playing' && !modalOpen && $('overlay').hidden) {
    if (frozen) {
      freeze = Math.max(0, freeze - (25 * dt) / 1000);
      frozenMs += dt;
      if (freeze <= 0) toggleFreeze(false);
      updateResources();
    } else {
      clockAcc += dt;
      if (clockAcc >= TICK_MS) requestAdvance();
    }
    $('clock-ring').style.setProperty('--p', String(Math.min(1, clockAcc / TICK_MS)));
  }
  render(now);
  requestAnimationFrame(loop);
}

function render(now: number) {
  const w = canvas.parentElement!.clientWidth;
  const { h } = layout(w);
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.height = `${h}px`;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  frame = draw(ctx, w, state, view, now);
}

// ---------------------------------------------------------------- pointer
function pointerPos(e: PointerEvent): [number, number] {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

canvas.addEventListener('pointermove', (e) => {
  const [x, y] = pointerPos(e);
  if (view.drag) { view.drag.to = [x, y]; return; }
  const h = tool === 'pulse' || tool === 'spare' ? hitTest(frame, x, y) : null;
  view.hover = h && view.targetable(h.node) ? { node: h.node, tag: h.tag, layer: h.layer } : null;
  canvas.style.cursor = view.hover || (tool && chamberAt(frame, x, y) !== null) ? 'pointer' : 'default';
});

canvas.addEventListener('pointerdown', (e) => {
  if (state.status !== 'playing' || modalOpen) return;
  const [x, y] = pointerPos(e);
  const slot = chamberAt(frame, x, y);
  if (tool === 'pulse' || tool === 'spare') {
    const h = hitTest(frame, x, y);
    if (h && view.targetable(h.node)) {
      if (tool === 'pulse') doAction({ kind: 'pulse', node: h.node, aim: h.vec });
      else doAction({ kind: 'alignSpare', node: h.node, tag: h.tag, dir: componentAt(state, h.node, h.tag) ?? h.vec });
      return;
    }
    if (tool === 'pulse' && slot !== null && slot !== 3 && view.targetable(slot as NodeIndex)) {
      view.drag = { node: slot as NodeIndex, from: [x, y], to: [x, y] };
      canvas.setPointerCapture(e.pointerId);
      return;
    }
  }
  if ((tool === 'honest' || tool === 'scan') && slot !== null && slot !== 3) {
    if (view.targetable(slot as NodeIndex)) {
      doAction(tool === 'honest' ? { kind: 'alignHonest', node: slot as NodeIndex } : { kind: 'scan', node: slot as NodeIndex });
      return;
    }
  }
  if (slot !== null) { view.selected = slot; syncUI(); }
});

canvas.addEventListener('pointerup', () => {
  const d = view.drag;
  view.drag = null;
  if (!d) return;
  const dx = d.to[0] - d.from[0], dy = d.to[1] - d.from[1];
  if (Math.hypot(dx, dy) < 14) { view.selected = d.node; syncUI(); return; }
  doAction({ kind: 'pulse', node: d.node, aim: dragToAim(state, d.node, dx, dy) });
});

window.addEventListener('keydown', (e) => {
  if (!$('overlay').hidden && !modalOpen) return;
  if (modalOpen) {
    const map: Record<string, Outcome> = { '1': 'clean', '2': 'up', '3': 'down', '4': 'starved' };
    if (map[e.key]) answerPrediction(map[e.key]);
    return;
  }
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  const t = TOOLS.find((k) => k.key === e.key);
  if (t) { chooseTool(t.id); e.preventDefault(); return; }
  if (e.key === 'Escape') { tool = null; view.drag = null; syncUI(); }
  if ((e.key === ' ' || e.key === 'Enter') && settings.clock === 'turn') { e.preventDefault(); requestAdvance(); }
  if ((e.key === 'f' || e.key === 'F') && settings.clock === 'real') toggleFreeze();
  if (e.key === 'd' || e.key === 'D') { view.debug = !view.debug; syncUI(); }
});

$('advance').addEventListener('click', () => requestAdvance());
$('freeze').addEventListener('click', () => toggleFreeze());

// ---------------------------------------------------------------- UI sync
const HINTS: Record<Exclude<Tool, null>, string> = {
  pulse: '<strong>Projection Pulse:</strong> click a red or cyan arrow at the Relay or Booster to aim the filter at it, or drag inside the chamber to aim anywhere. <kbd>Esc</kbd> cancels.',
  spare: '<strong>Spare:</strong> click the arrow this node’s filter must never touch.',
  honest: '<strong>Honest alignment:</strong> click a node you have already scanned.',
  scan: '<strong>Shear Scan:</strong> click the Relay or the Booster.',
};

function idleHint(): string {
  if (state.status !== 'playing') return 'Encounter over.';
  if (settings.clock === 'turn') return 'Watch the arrows, pick a tool, then advance the clock. Your changes act on packets as they pass. <kbd>D</kbd> toggles the debug view.';
  return 'The clock runs on its own. Freeze it to think (it drains). <kbd>D</kbd> toggles the debug view.';
}

function syncUI() {
  $('hint').innerHTML = tool ? HINTS[tool] : idleHint();
  for (const t of TOOLS) {
    const b = $<HTMLButtonElement>(`tool-${t.id}`);
    b.setAttribute('aria-pressed', String(tool === t.id));
    const probe: Action | null = t.id === 'strike' ? { kind: 'strike' } : null;
    const cost = COST[t.id === 'spare' ? 'alignSpare' : t.id === 'honest' ? 'alignHonest' : t.id];
    const affordable = state.bw >= cost.bw && (cost.heat === 0 || state.overheat === 0);
    b.disabled = state.status !== 'playing' || !affordable || (probe ? validate(state, probe) !== null : false);
    b.title = !affordable ? (state.overheat > 0 && cost.heat > 0 ? 'Overheated' : 'Not enough bandwidth') : '';
  }
  $('tick-label').textContent = `t${state.tick}`;
  $('clock-mode').textContent = settings.clock === 'turn' ? 'Turn-based' : frozen ? 'Frozen' : 'Real-time · 4 s';
  if (settings.clock === 'turn') $('clock-ring').style.setProperty('--p', '0');
  const hpFrac = Math.max(0, state.core.hp) / state.level.core.hp;
  const hp = $('hp-fill');
  hp.style.width = `${hpFrac * 100}%`;
  hp.classList.toggle('warn', hpFrac < 0.6 && hpFrac >= 0.3);
  hp.classList.toggle('crit', hpFrac < 0.3);
  $('hp-num').textContent = fmt(Math.max(0, state.core.hp), 1);
  const last = state.core.last;
  const SUPMAX = 3;
  $('supply-fill').style.width = `${last ? Math.min(1, Math.max(0, last.supply) / SUPMAX) * 100 : 0}%`;
  $('supply-mark').style.left = `${(state.level.core.need / SUPMAX) * 100}%`;
  $('supply-num').textContent = last ? fmt(last.supply) : '—';
  const TMAX = 6;
  const th = last ? Math.max(-TMAX, Math.min(TMAX, last.threat)) : 0;
  const tf = $('threat-fill');
  tf.style.left = th >= 0 ? '50%' : `${50 + (th / TMAX) * 50}%`;
  tf.style.width = `${(Math.abs(th) / TMAX) * 50}%`;
  const safe = document.querySelector<HTMLElement>('.threat-safe')!;
  safe.style.left = `${50 - (state.level.core.safe / TMAX) * 50}%`;
  safe.style.width = `${(state.level.core.safe / TMAX) * 100}%`;
  $('threat-num').textContent = last ? `${last.threat < 0 ? '−' : ''}${fmt(Math.abs(last.threat))}${last.threat < -state.level.core.safe ? ' inv' : ''}` : '—';
  const pips = $('pips');
  pips.innerHTML = Array.from({ length: state.level.core.hold }, (_, k) => `<span class="pip${k < state.core.streak ? ' on' : ''}"></span>`).join('');
  pips.setAttribute('aria-label', `${state.core.streak} of ${state.level.core.hold}`);
  updateResources();
  $('advance').hidden = settings.clock !== 'turn';
  $('freeze').hidden = settings.clock !== 'real';
  $('freeze').setAttribute('aria-pressed', String(frozen));
  $('freeze-row').hidden = settings.clock !== 'real';
  renderInspector();
  $('ledger').innerHTML = ledgerItems.map((l) => `<li><span class="t">t${l.tick}</span><span class="${l.tone}">${l.text}</span></li>`).join('');
}

function updateResources() {
  const r = state.level.resources;
  $('bw-fill').style.width = `${(state.bw / r.bwCap) * 100}%`;
  $('bw-num').textContent = String(state.bw);
  $('heat-fill').style.width = `${Math.min(100, state.heat)}%`;
  $('heat-num').textContent = state.overheat > 0 ? `HOT ${state.overheat}` : String(Math.round(state.heat));
  $('freeze-fill').style.width = `${freeze}%`;
  $('freeze-num').textContent = String(Math.round(freeze));
}

const tagChip = (t: Tag) => `<span class="chip ${t === 'friendly' ? 'friendly' : 'hostile'}">${t === 'friendly' ? 'cyan' : 'red'}</span>`;
const angleOnScreen = (s: State, i: NodeIndex, v: Vec2) => {
  const d = mul(s.level.nodes[i].display, v);
  return `${Math.round((Math.atan2(d[1], d[0]) * 180) / Math.PI)}°`;
};
const mat = (M: readonly number[]) => `[${fmt(M[0])} ${fmt(M[1])}; ${fmt(M[2])} ${fmt(M[3])}]`;

function renderInspector() {
  const box = $('inspector');
  const sel = view.selected;
  if (sel === null) { box.innerHTML = '<p class="label">Click a node to inspect it.</p>'; return; }
  if (sel === 3) {
    const last = state.core.last;
    const c = state.level.core;
    box.innerHTML = `<dl class="kv">
      <dt>Node</dt><dd>Core</dd>
      <dt>Needs</dt><dd>Supply ≥ ${c.need} (how far right the arrow reaches)</dd>
      <dt>Hurt by</dt><dd>Anything up or down beyond ${c.safe}, whatever its colour</dd>
      <dt>Win</dt><dd>${c.hold} clean ticks in a row</dd>
      <dt>Arriving</dt><dd>${last ? `supply ${fmt(last.supply)}, threat ${fmt(last.threat)}` : 'nothing yet'}</dd>
    </dl>${view.debug && last ? `<div class="debug">y = ${fmtV(last.y)}\n${last.comps.map((k) => `${k.tag.padEnd(8)} ${fmtV(k.v)}`).join('\n')}</div>` : ''}`;
    return;
  }
  const i = sel as NodeIndex;
  const def = state.level.nodes[i];
  const ns = state.nodes[i];
  const verdict = ns.scan ? describeVerdict(ns.scan.verdict) : null;
  const align = ns.align.mode === 'none' ? '<span class="chip muted">trusts its screen</span>'
    : ns.align.mode === 'honest' ? '<span class="chip metric">honest geometry</span>'
    : `<span class="chip readout">spare</span> ${tagChip(ns.align.tag)}`;
  const filter = ns.filter
    ? `<span class="chip readout">strip</span> aimed ${angleOnScreen(state, i, ns.filter.aim)} on screen`
    : '<span class="chip muted">none</span>';
  const comps = (ns.out?.comps ?? []).map((c) => `${tagChip(c.tag)} ${fmt(norm(mul(def.display, c.v)))} at ${angleOnScreen(state, i, c.v)}`).join('<br>') || '—';
  const debug = view.debug ? `<div class="debug">J (true transform)   ${mat(def.J)}
D (screen ← truth)   ${mat(def.display)}
believed metric DᵀD  ${mat(mulT(def.display))}
${(ns.preComps).map((k) => `in  ${k.tag.padEnd(8)} ${fmtV(k.v)}`).join('\n')}
${(ns.out?.comps ?? []).map((k) => `out ${k.tag.padEnd(8)} ${fmtV(k.v)}`).join('\n')}${ns.filter ? `
filter aim u (true)  ${fmtV(ns.filter.aim)}
readout r (true)     ${fmtV(readoutFor(state, i, ns.filter.aim))}
readout on screen    ${fmtV(mul(T(inv(def.display)), readoutFor(state, i, ns.filter.aim)))}` : ''}</div>` : '';
  box.innerHTML = `<dl class="kv">
    <dt>Node</dt><dd>${def.id} · ${def.name}</dd>
    <dt>Transform</dt><dd>${def.sealed ? 'Sealed (unknown)' : def.glyph}</dd>
    <dt>Screen</dt><dd>${verdict ? `<span class="chip metric">${verdict.label}</span><br><span class="label" style="text-transform:none;letter-spacing:0">${verdict.detail}</span>` : 'Unverified'}</dd>
    <dt>Showing</dt><dd>${comps}</dd>
    <dt>Filter</dt><dd>${filter}</dd>
    <dt>Readout</dt><dd>${def.port ? align : '—'}</dd>
    ${def.cap !== undefined ? `<dt>Capacity</dt><dd>${def.cap} · ${ns.sat ? '<span class="chip hostile">saturated</span>' : 'ok'}</dd>` : ''}
  </dl>${ns.filter ? '<button class="small-btn" id="clear-filter" type="button">Remove filter (free)</button>' : ''}${debug}`;
  document.getElementById('clear-filter')?.addEventListener('click', () => doAction({ kind: 'clear', node: i }));
}
const mulT = (D: readonly [number, number, number, number]) => {
  const t = T(D);
  return [t[0] * D[0] + t[1] * D[2], t[0] * D[1] + t[1] * D[3], t[2] * D[0] + t[3] * D[2], t[2] * D[1] + t[3] * D[3]];
};

let toastTimer = 0;
function toast(text: string, tone: '' | 'good' | 'bad' = '') {
  const t = $('toast');
  t.textContent = text;
  t.className = `toast show ${tone}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.className = 'toast'), 3600);
}

// ---------------------------------------------------------------- overlays
function sheet(html: string) {
  $('sheet').innerHTML = html;
  $('overlay').hidden = false;
  ($('sheet').querySelector('button.primary') as HTMLElement | null)?.focus();
}
function closeSheet() { $('overlay').hidden = true; modalOpen = false; }

const OUTCOME: Record<Outcome, { glyph: string; title: string; sub: string }> = {
  clean: { glyph: '→', title: 'Clean', sub: 'Cyan arrives flat. No red, no threat.' },
  up: { glyph: '↑', title: 'Threat', sub: 'Something arrives pointing up.' },
  down: { glyph: '↓', title: 'Inverted threat', sub: 'Something arrives pointing down.' },
  starved: { glyph: '⇢', title: 'Starved', sub: 'No threat, but too little cyan.' },
};

let pendingTruth: Outcome = 'clean';
let predictionOpenedAt = 0;
function openPrediction() {
  const f = forecast(state, 3);
  pendingTruth = f ? classifyThreat(state.level, f.threat, f.supply) : 'clean';
  modalOpen = true;
  predictionOpenedAt = performance.now();
  sheet(`<span class="eyebrow">Before the clock moves</span>
    <h2>If you change nothing else, what reaches the Core 3 ticks from now?</h2>
    <div class="predict">${(Object.keys(OUTCOME) as Outcome[]).map((k, n) => `<button type="button" data-o="${k}"><span class="glyph">${OUTCOME[k].glyph}</span><strong>${n + 1}. ${OUTCOME[k].title}</strong><span class="sub">${OUTCOME[k].sub}</span></button>`).join('')}</div>
    <div class="actions"><button class="linkish" type="button" data-o="unsure">Not sure, skip</button></div>`);
  $('sheet').querySelectorAll<HTMLButtonElement>('[data-o]').forEach((b) => b.addEventListener('click', () => answerPrediction(b.dataset.o as Outcome | 'unsure')));
  ($('sheet').querySelector('.predict button') as HTMLElement).focus();
}

function answerPrediction(answer: Outcome | 'unsure') {
  if (!modalOpen) return;
  const ms = Math.round(performance.now() - predictionOpenedAt);
  log?.predictions.push({ tick: state.tick, ms, answer, truth: pendingTruth, correct: answer === 'unsure' ? null : answer === pendingTruth });
  duePredictions.push({ due: state.tick + 3, answer, truth: pendingTruth });
  closeSheet();
  doAdvance();
}

function showIntro() {
  sheet(`<span class="eyebrow">Chainwarden Protocol · playtest build</span>
    <h1>Twin Relay</h1>
    <p>Signals flow left to right through a short line of rooms. Your job is to keep the <strong style="color:var(--friendly)">cyan</strong> signal reaching the Core while stopping the <strong style="color:var(--hostile)">red</strong> parasite riding along with it.</p>
    <p>You can’t shoot the red. You install things in the rooms and watch what they do as packets pass through. Screens are your only window, and they aren’t always right.</p>
    <div class="legend">
      <span class="swatch" style="background:var(--friendly)"></span><span>Cyan: your signal. The Core needs it pointing right.</span>
      <span class="swatch" style="background:var(--hostile)"></span><span>Red: the parasite. Anything pointing up or down hurts the Core.</span>
      <span class="swatch" style="background:var(--readout)"></span><span>Lilac lines: what a filter actually reads.</span>
      <span class="swatch" style="background:var(--adjoint)"></span><span>Magenta: corrections travelling backward.</span>
    </div>
    <div class="options">
      <label class="option"><input type="radio" name="clock" id="clock-turn" value="turn" checked> <span><strong>Turn-based clock</strong> (recommended). Time moves when you press Advance.</span></label>
      <label class="option"><input type="radio" name="clock" id="clock-real" value="real"> <span><strong>Real-time clock</strong>. A tick every 4 seconds, with a little Freeze to think.</span></label>
      <label class="option"><input type="checkbox" id="opt-predict" checked> <span>Ask me to predict the outcome after each change (helps the playtest)</span></label>
      <label class="option"><input type="checkbox" id="opt-warmup" checked> <span>Start with a short calibration run</span></label>
    </div>
    <div class="actions"><button class="primary" type="button" id="begin">Begin shift</button></div>`);
  $('begin').addEventListener('click', () => {
    settings.clock = ($<HTMLInputElement>('clock-real').checked ? 'real' : 'turn');
    settings.predict = $<HTMLInputElement>('opt-predict').checked;
    settings.warmup = $<HTMLInputElement>('opt-warmup').checked;
    const twins: LevelId[] = Math.random() < 0.5 ? ['relay-lie', 'relay-bend'] : ['relay-bend', 'relay-lie'];
    encounters = [
      ...(settings.warmup ? [{ level: 'warmup' as LevelId, label: 'Calibration Line' }] : []),
      { level: twins[0], label: 'Relay A' },
      { level: twins[1], label: 'Relay B' },
    ];
    encIndex = 0;
    showBriefing();
  });
}

function showBriefing() {
  const enc = encounters[encIndex];
  const isWarm = enc.level === 'warmup';
  sheet(`<span class="eyebrow">Encounter ${encIndex + 1} of ${encounters.length}</span>
    <h1>${enc.label}</h1>
    ${isWarm
      ? `<p>A plain line with honest screens. A faint red trickle has been riding it for a while; next tick it wakes up. Try aiming a <strong>Projection Pulse</strong> at the red in the Relay, then advance and watch the change travel.</p>`
      : `<p>Same line, new trouble. The Relay is sealed: you can’t see what it does inside. The red trickle is about to wake and grow. The Booster triples anything pointing up or down.</p>`}
    <p>Win by delivering <strong>${LEVELS[enc.level].core.hold} clean ticks in a row</strong> to the Core. Lose if Core integrity hits zero.</p>
    <div class="actions"><button class="primary" type="button" id="start">Start</button></div>`);
  $('start').addEventListener('click', () => { closeSheet(); startEncounter(); });
}

function startEncounter(retry = false) {
  const enc = encounters[encIndex];
  state = createState(LEVELS[enc.level]);
  const attempt = logs.filter((l) => l.level === enc.level).length + 1;
  log = {
    level: enc.level, label: enc.label, attempt, clock: settings.clock, startedAt: new Date().toISOString(),
    durationMs: 0, firstActionMs: null, outcome: 'abandoned', endTick: 0, coreHp: state.core.hp, purity: 0,
    spent: { ...state.spent }, frozenMs: 0, actions: [], predictions: [],
  };
  logs.push(log);
  attemptStart = performance.now();
  physicsDirty = false; duePredictions = []; tool = null; frozen = false; freeze = 100; frozenMs = 0; clockAcc = 0;
  view.selected = 1; view.anims = []; view.drag = null; view.hover = null;
  ledgerItems = [];
  ledger(retry ? 'Retrying from the top.' : 'Line live. The pipeline is already carrying traffic.', 'info');
  $('encounter-name').textContent = `${enc.label}${encIndex >= 0 ? ` · ${encIndex + 1}/${encounters.length}` : ''}`;
  syncUI();
}

function rank(s: State): string {
  if (s.status !== 'won') return '—';
  const p = purity(s);
  if (s.core.hp >= s.level.core.hp - 1e-6 && p >= 0.98 && s.spent.heat === 0) return 'S';
  if (s.core.hp >= 9 && p >= 0.95) return 'A';
  if (s.core.hp >= 5) return 'B';
  return 'C';
}

function showResult() {
  if (!log) return;
  const enc = encounters[encIndex];
  const p = purity(state);
  Object.assign(log, {
    outcome: state.status === 'won' ? 'won' : 'lost', endTick: state.tick, coreHp: +state.core.hp.toFixed(2),
    purity: +p.toFixed(3), spent: { ...state.spent }, durationMs: Math.round(performance.now() - attemptStart), frozenMs: Math.round(frozenMs),
  });
  const truth = LEVELS[enc.level].truth;
  const last = encIndex === encounters.length - 1;
  const won = state.status === 'won';
  sheet(`<span class="eyebrow">${enc.label} · ${won ? 'Line held' : 'Line lost'}</span>
    <div class="result-head">${won ? `<span class="rank" aria-label="Rank">${rank(state)}</span>` : ''}<h2>${state.endReason}</h2></div>
    <div class="stats">
      <div class="stat"><span class="label">Core integrity</span><span class="v">${fmt(Math.max(0, state.core.hp), 1)} / ${state.level.core.hp}</span></div>
      <div class="stat"><span class="label">Cyan purity</span><span class="v">${Math.round(p * 100)}%</span></div>
      <div class="stat"><span class="label">Ticks</span><span class="v">${state.tick}</span></div>
      <div class="stat"><span class="label">Bandwidth spent</span><span class="v">${state.spent.bw}</span></div>
      <div class="stat"><span class="label">Heat spent</span><span class="v">${state.spent.heat}</span></div>
      <div class="stat"><span class="label">Actions</span><span class="v">${state.spent.actions}</span></div>
    </div>
    <div class="truth"><span class="eyebrow">What was really happening</span><strong>${truth.headline}</strong><p>${truth.body}</p></div>
    <div class="actions">
      <button class="ghost" type="button" id="retry">Retry this line</button>
      <button class="primary" type="button" id="next">${last ? 'See session summary' : 'Next line'}</button>
    </div>`);
  $('retry').addEventListener('click', () => { closeSheet(); startEncounter(true); });
  $('next').addEventListener('click', () => {
    if (last) { showSummary(); return; }
    encIndex += 1;
    showBriefing();
  });
}

function showSummary() {
  const preds = logs.flatMap((l) => l.predictions).filter((p) => p.correct !== null);
  const acc = preds.length ? Math.round((preds.filter((p) => p.correct).length / preds.length) * 100) : null;
  const rows = logs.map((l) => `<tr><td>${l.label}</td><td class="n">${l.attempt}</td><td>${l.outcome}</td><td class="n">${l.endTick}</td><td class="n">${fmt(Math.max(0, l.coreHp), 1)}</td><td class="n">${l.spent.bw}/${l.spent.heat}</td><td class="n">${l.predictions.filter((p) => p.correct).length}/${l.predictions.filter((p) => p.correct !== null).length}</td></tr>`).join('');
  const payload = JSON.stringify({
    sessionId, build: 'twin-relay-0.1', settings,
    order: encounters.map((e) => ({ label: e.label, level: e.level })),
    predictionAccuracy: acc, attempts: logs,
  }, null, 2);
  sheet(`<span class="eyebrow">Session ${sessionId}</span>
    <h1>Shift complete</h1>
    <p>${acc === null ? 'No predictions recorded.' : `You predicted the Core correctly <strong>${acc}%</strong> of the time (${preds.length} predictions).`} Relay A and Relay B looked the same from the outside. One had a lying screen, the other really bent the signal.</p>
    <div class="table-wrap"><table class="summary-table"><thead><tr><th>Line</th><th>Try</th><th>Result</th><th>Ticks</th><th>Core</th><th>BW/Heat</th><th>Predictions</th></tr></thead><tbody>${rows}</tbody></table></div>
    <label class="label" for="session-log">Session log (for the playtest)</label>
    <textarea class="log" id="session-log" readonly>${payload.replace(/</g, '&lt;')}</textarea>
    <div class="actions">
      <button class="ghost" type="button" id="again">Play again</button>
      <button class="primary" type="button" id="copy">Copy log</button>
    </div>`);
  $('copy').addEventListener('click', () => {
    const ta = $<HTMLTextAreaElement>('session-log');
    navigator.clipboard?.writeText(payload).then(
      () => toast('Session log copied.', 'good'),
      () => { ta.focus(); ta.select(); toast('Copy was blocked. The log is selected: press Ctrl+C or ⌘C.'); },
    ) ?? (ta.select(), toast('The log is selected: press Ctrl+C or ⌘C.'));
  });
  $('again').addEventListener('click', showIntro);
}

// ---------------------------------------------------------------- boot
buildTools();
syncUI();
showIntro();
requestAnimationFrame((t) => { lastFrame = t; loop(t); });
document.fonts?.ready.then(() => render(performance.now()));
