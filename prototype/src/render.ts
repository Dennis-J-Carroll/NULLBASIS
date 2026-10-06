// Canvas renderer. Reads simulation state; never mutates it.
// Each node chamber is drawn in that node's DISPLAY coordinates on a square lattice, so a lying
// display looks exactly like an honest one until the player finds the inconsistency.
import { type Vec2, inv, mul, norm, perp, normalize } from './math.ts';
import type { NodeIndex } from './levels.ts';
import { type RippleStep, type State, type Tag, readoutFor, readoutToDisplay, toDisplay } from './sim.ts';

export type Slot = NodeIndex | 3; // 3 = Core
export interface Chamber { cx: number; cy: number; r: number }
export interface ArrowHit { node: NodeIndex; tag: Tag; layer: 'in' | 'out'; a: [number, number]; b: [number, number]; vec: Vec2 }
export interface Frame { w: number; h: number; chambers: Chamber[]; hits: ArrowHit[] }

export type Anim =
  | { kind: 'flow'; start: number; dur: number; dots: { from: Slot; to: Slot; tags: Tag[] }[] }
  | { kind: 'ripple'; start: number; dur: number; steps: RippleStep[]; leech: number; friendly: number }
  | { kind: 'scan'; start: number; dur: number; node: NodeIndex };

export interface ViewState {
  selected: Slot | null;
  hover: { node: NodeIndex; tag: Tag; layer: 'in' | 'out' } | null;
  targetable: (i: NodeIndex) => boolean;
  drag: { node: NodeIndex; from: [number, number]; to: [number, number] } | null;
  anims: Anim[];
  debug: boolean;
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const C = () => ({
  ink0: css('--ink-0'), ink1: css('--ink-1'), ink2: css('--ink-2'), line: css('--line'), text: css('--text'), muted: css('--muted'),
  friendly: css('--friendly'), hostile: css('--hostile'), adjoint: css('--adjoint'), metric: css('--metric'),
  readout: css('--readout'), good: css('--good'),
});
const DATA = "'Martian Mono', ui-monospace, monospace";
const BODY = "'Atkinson Hyperlegible', system-ui, sans-serif";

/** Vector length on screen: compressive so a ×3 booster stays on the board, direction exact. */
export const screenLen = (r: number, m: number) => (m < 1e-6 ? 0 : Math.max(0.24 * r, 0.9 * r * (1 - Math.exp(-m / 1.7))));
const toScreen = (r: number, d: Vec2): [number, number] => {
  const m = norm(d);
  if (m < 1e-6) return [0, 0];
  const L = screenLen(r, m);
  return [(d[0] / m) * L, (-d[1] / m) * L];
};

export function layout(w: number): { h: number; chambers: Chamber[] } {
  if (w < 560) {
    const r = Math.min(w * 0.21, 120);
    const h = Math.round(4 * r + 190);
    const xs = [w * 0.27, w * 0.73];
    const ys = [r + 40, h - r - 60];
    return { h, chambers: [{ cx: xs[0], cy: ys[0], r }, { cx: xs[1], cy: ys[0], r }, { cx: xs[1], cy: ys[1], r }, { cx: xs[0], cy: ys[1], r }] };
  }
  const r = Math.min(w / 4 * 0.42, 124);
  const h = Math.round(2 * r + 140);
  const cy = r + 44;
  return { h, chambers: [0, 1, 2, 3].map((i) => ({ cx: w * (0.125 + 0.25 * i), cy, r })) };
}

function arrow(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, color: string, width: number, opts: { dash?: number[]; alpha?: number; head?: boolean } = {}) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (len < 1) return;
  ctx.save();
  ctx.globalAlpha = opts.alpha ?? 1;
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round';
  ctx.setLineDash(opts.dash ?? []);
  const ux = (x1 - x0) / len, uy = (y1 - y0) / len;
  const hs = Math.min(9 + width, len * 0.5);
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1 - ux * hs * 0.6, y1 - uy * hs * 0.6); ctx.stroke();
  if (opts.head !== false) {
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - ux * hs - uy * hs * 0.5, y1 - uy * hs + ux * hs * 0.5);
    ctx.lineTo(x1 - ux * hs + uy * hs * 0.5, y1 - uy * hs - ux * hs * 0.5);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

function edgePoints(a: Chamber, b: Chamber, offset = 0): [[number, number], [number, number]] {
  const dx = b.cx - a.cx, dy = b.cy - a.cy, d = Math.hypot(dx, dy);
  const ux = dx / d, uy = dy / d, nx = -uy * offset, ny = ux * offset;
  return [[a.cx + ux * (a.r + 6) + nx, a.cy + uy * (a.r + 6) + ny], [b.cx - ux * (b.r + 6) + nx, b.cy - uy * (b.r + 6) + ny]];
}

export function draw(ctx: CanvasRenderingContext2D, w: number, s: State, view: ViewState, now: number): Frame {
  const col = C();
  const { h, chambers } = layout(w);
  const hits: ArrowHit[] = [];
  ctx.clearRect(0, 0, w, h);

  // ---- rails ----
  for (let i = 0; i < 3; i++) {
    const [p, q] = edgePoints(chambers[i], chambers[i + 1]);
    ctx.save();
    ctx.strokeStyle = col.line; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(...p); ctx.lineTo(...q); ctx.stroke();
    // forward chevrons
    const n = 3;
    ctx.strokeStyle = col.muted; ctx.lineWidth = 1.5;
    const ang = Math.atan2(q[1] - p[1], q[0] - p[0]);
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1);
      const x = p[0] + (q[0] - p[0]) * t, y = p[1] + (q[1] - p[1]) * t;
      ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
      ctx.beginPath(); ctx.moveTo(-4, -5); ctx.lineTo(2, 0); ctx.lineTo(-4, 5); ctx.stroke();
      ctx.restore();
    }
    // adjoint rail
    const [pa, qa] = edgePoints(chambers[i], chambers[i + 1], 12);
    ctx.strokeStyle = col.adjoint; ctx.globalAlpha = 0.28; ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
    ctx.beginPath(); ctx.moveTo(...pa); ctx.lineTo(...qa); ctx.stroke();
    ctx.restore();
  }

  // ---- chambers ----
  for (let i = 0; i < 4; i++) drawChamber(ctx, s, view, col, chambers[i], i as Slot, hits);

  // ---- pending markers ----
  for (const i of s.pending.scans) {
    const c = chambers[i];
    ringDash(ctx, c, col.metric, now);
  }
  if (s.pending.strike) ringDash(ctx, chambers[3], col.adjoint, now);

  // ---- drag preview ----
  if (view.drag) {
    const c = chambers[view.drag.node];
    arrow(ctx, c.cx, c.cy, c.cx + (view.drag.to[0] - view.drag.from[0]), c.cy + (view.drag.to[1] - view.drag.from[1]), col.text, 2, { dash: [6, 4] });
  }

  // ---- animations ----
  view.anims = view.anims.filter((a) => now - a.start < a.dur + (a.kind === 'ripple' ? 2200 : 0));
  for (const a of view.anims) {
    const t = Math.min(1, Math.max(0, (now - a.start) / a.dur));
    if (a.kind === 'flow') {
      for (const d of a.dots) {
        const [p, q] = edgePoints(chambers[d.from], chambers[d.to]);
        const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        const x = p[0] + (q[0] - p[0]) * e, y = p[1] + (q[1] - p[1]) * e;
        d.tags.forEach((tag, k) => {
          ctx.beginPath(); ctx.fillStyle = tag === 'friendly' ? col.friendly : col.hostile;
          ctx.globalAlpha = 1 - Math.max(0, (t - 0.85) / 0.15);
          ctx.arc(x + (k - (d.tags.length - 1) / 2) * 9, y, 4, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1;
        });
      }
    } else if (a.kind === 'scan') {
      const c = chambers[a.node];
      ctx.save(); ctx.strokeStyle = col.metric; ctx.globalAlpha = 1 - t; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(c.cx, c.cy, c.r * (0.3 + 0.9 * t), 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    } else {
      drawRipple(ctx, chambers, a, now, col);
    }
  }
  return { w, h, chambers, hits };
}

function ringDash(ctx: CanvasRenderingContext2D, c: Chamber, color: string, now: number) {
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash([6, 6]); ctx.lineDashOffset = -now / 60;
  ctx.beginPath(); ctx.arc(c.cx, c.cy, c.r + 9, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
}

function drawRipple(ctx: CanvasRenderingContext2D, ch: Chamber[], a: Extract<Anim, { kind: 'ripple' }>, now: number, col: ReturnType<typeof C>) {
  // Path: Core (3) → N2 → N1 → Intake (0), along the adjoint rails.
  const order: Slot[] = [3, 2, 1, 0];
  const t = Math.min(1, (now - a.start) / a.dur);
  const seg = t * 3;
  const k = Math.min(2, Math.floor(seg));
  const f = seg - k;
  const [p, q] = edgePoints(ch[order[k + 1]], ch[order[k]], 12);
  // edgePoints runs a→b; we travel from b back to a
  const x = q[0] + (p[0] - q[0]) * f, y = q[1] + (p[1] - q[1]) * f;
  ctx.save();
  if (t < 1) {
    ctx.strokeStyle = col.adjoint; ctx.lineWidth = 2.5;
    for (let r = 0; r < 3; r++) {
      ctx.globalAlpha = 0.9 - r * 0.28;
      ctx.beginPath(); ctx.arc(x, y, 6 + r * 5 * (1 - f * 0.5), 0, Math.PI * 2); ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = col.adjoint; ctx.font = `600 11px ${DATA}`; ctx.textAlign = 'center';
  // label each node once the ripple has passed it: ripple strength there
  const labels: { slot: Slot; text: string; at: number }[] = [
    { slot: 3, text: `reads |${norm(a.steps[0].g).toFixed(1)}|`, at: 0 },
    { slot: 2, text: `ripple ${norm(a.steps[1].g).toFixed(2)}`, at: 1 / 3 },
    { slot: 1, text: `ripple ${norm(a.steps[2].g).toFixed(2)}`, at: 2 / 3 },
    { slot: 0, text: `Leech −${a.leech.toFixed(2)}${a.friendly > 0.005 ? ` · cyan −${a.friendly.toFixed(2)}` : ''}`, at: 1 },
  ];
  for (const l of labels) {
    if (t + 1e-6 < l.at) continue;
    const c = ch[l.slot];
    ctx.fillText(l.text, c.cx, c.cy + c.r - 12);
  }
  ctx.restore();
}

function drawChamber(ctx: CanvasRenderingContext2D, s: State, view: ViewState, col: ReturnType<typeof C>, c: Chamber, slot: Slot, hits: ArrowHit[]) {
  const { cx, cy, r } = c;
  const isCore = slot === 3;
  const def = isCore ? null : s.level.nodes[slot];
  const ns = isCore ? null : s.nodes[slot];
  const selected = view.selected === slot;
  const targetable = !isCore && view.targetable(slot as NodeIndex);

  // body
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = col.ink1; ctx.fill();
  ctx.clip();
  // lattice: always drawn square — screens never admit to lying
  ctx.strokeStyle = col.line; ctx.lineWidth = 1;
  const step = r / 4;
  for (let k = -4; k <= 4; k++) {
    ctx.globalAlpha = k === 0 ? 0.9 : 0.45;
    ctx.beginPath(); ctx.moveTo(cx + k * step, cy - r); ctx.lineTo(cx + k * step, cy + r); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - r, cy + k * step); ctx.lineTo(cx + r, cy + k * step); ctx.stroke();
  }
  ctx.globalAlpha = 1;

  if (!isCore && ns && def) {
    const i = slot as NodeIndex;
    // scan reveals
    if (ns.scan && (ns.scan.verdict === 'coordinate' || ns.scan.verdict === 'both')) {
      // the true unit circle, as this screen draws it
      ctx.strokeStyle = col.metric; ctx.lineWidth = 2; ctx.setLineDash([]);
      ctx.beginPath();
      for (let k = 0; k <= 64; k++) {
        const a = (k / 64) * Math.PI * 2;
        const d = toDisplay(s, i, [Math.cos(a), Math.sin(a)]);
        const x = cx + d[0] * r * 0.42, y = cy - d[1] * r * 0.42;
        k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([3, 4]); ctx.globalAlpha = 0.6;
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.42, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    if (ns.scan && (ns.scan.verdict === 'signal' || ns.scan.verdict === 'both')) {
      ctx.strokeStyle = col.metric; ctx.globalAlpha = 0.22; ctx.lineWidth = 1;
      for (let k = -2 * r; k < 2 * r; k += 9) {
        ctx.beginPath(); ctx.moveTo(cx + k, cy + r); ctx.lineTo(cx + k + r * 0.6, cy + r * 0.72); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    // saturation cap ring
    if (def.cap !== undefined) {
      ctx.strokeStyle = ns.sat ? col.hostile : col.muted; ctx.lineWidth = ns.sat ? 2 : 1; ctx.setLineDash([2, 4]);
      ctx.beginPath(); ctx.arc(cx, cy, screenLen(r, def.cap), 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    }
    // filter: grating (what it reads) + aim arrow (where it removes)
    if (ns.filter && def.port) {
      const rd = normalize(readoutToDisplay(s, i, readoutFor(s, i, ns.filter.aim)));
      const lineDir = perp(rd);
      ctx.strokeStyle = col.readout; ctx.lineWidth = 1.4; ctx.globalAlpha = 0.55;
      for (let k = -3; k <= 3; k++) {
        const ox = rd[0] * k * r * 0.24, oy = -rd[1] * k * r * 0.24;
        ctx.beginPath();
        ctx.moveTo(cx + ox - lineDir[0] * r * 1.2, cy + oy + lineDir[1] * r * 1.2);
        ctx.lineTo(cx + ox + lineDir[0] * r * 1.2, cy + oy - lineDir[1] * r * 1.2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      const ad = normalize(toDisplay(s, i, ns.filter.aim));
      arrow(ctx, cx, cy, cx + ad[0] * r * 0.92, cy - ad[1] * r * 0.92, col.text, 1.6, { dash: [5, 4], alpha: 0.85 });
    }
    // incoming components (faint) when a filter changed them
    const showIn = !!ns.filter && def.port;
    if (showIn) {
      for (const comp of ns.preComps) {
        const d = toDisplay(s, i, comp.v);
        const [dx, dy] = toScreen(r, d);
        if (Math.hypot(dx, dy) < 1) continue;
        const color = comp.tag === 'friendly' ? col.friendly : col.hostile;
        const hov = view.hover?.node === i && view.hover.tag === comp.tag && view.hover.layer === 'in';
        arrow(ctx, cx, cy, cx + dx, cy + dy, color, hov ? 3.5 : 2, { dash: [4, 4], alpha: hov ? 0.9 : 0.4 });
        hits.push({ node: i, tag: comp.tag, layer: 'in', a: [cx, cy], b: [cx + dx, cy + dy], vec: comp.v });
      }
    }
    // outgoing components
    for (const comp of ns.out?.comps ?? []) {
      const d = toDisplay(s, i, comp.v);
      const [dx, dy] = toScreen(r, d);
      if (Math.hypot(dx, dy) < 1) continue;
      const color = comp.tag === 'friendly' ? col.friendly : col.hostile;
      const hov = view.hover?.node === i && view.hover.tag === comp.tag && view.hover.layer === 'out';
      arrow(ctx, cx, cy, cx + dx, cy + dy, color, hov ? 5 : 3.2);
      ctx.fillStyle = color; ctx.font = `400 10px ${DATA}`; ctx.textAlign = 'center';
      const m = norm(d);
      ctx.fillText(m.toFixed(m < 1 ? 2 : 1), cx + dx * 1.12 + (dx >= 0 ? 6 : -6), cy + dy * 1.12 + (dy > 0 ? 10 : -4));
      if (!showIn) hits.push({ node: i, tag: comp.tag, layer: 'out', a: [cx, cy], b: [cx + dx, cy + dy], vec: componentPre(s, i, comp.tag) ?? comp.v });
    }
  } else {
    // Core: threat readout drawn as a grating (it reads up/down), arriving components on top
    ctx.strokeStyle = col.hostile; ctx.globalAlpha = 0.18; ctx.lineWidth = 1;
    for (let k = -3; k <= 3; k++) { ctx.beginPath(); ctx.moveTo(cx - r, cy + k * r * 0.24); ctx.lineTo(cx + r, cy + k * r * 0.24); ctx.stroke(); }
    ctx.globalAlpha = 1;
    const last = s.core.last;
    if (last) {
      for (const comp of last.comps) {
        const [dx, dy] = toScreen(r, comp.v);
        arrow(ctx, cx, cy, cx + dx, cy + dy, comp.tag === 'friendly' ? col.friendly : col.hostile, 2, { alpha: 0.5 });
      }
      const [dx, dy] = toScreen(r, last.y);
      arrow(ctx, cx, cy, cx + dx, cy + dy, last.clean ? col.good : col.hostile, 3.5);
    }
  }
  ctx.restore();

  // rim
  ctx.save();
  ctx.lineWidth = selected ? 2.5 : 1.5;
  ctx.strokeStyle = selected ? col.metric : targetable ? col.text : col.line;
  if (targetable && !selected) ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
  if (def?.port) { // output port notch
    ctx.fillStyle = col.metric;
    ctx.beginPath(); ctx.arc(cx + r, cy, 4, 0, Math.PI * 2); ctx.fill();
  }

  // labels
  ctx.textAlign = 'center';
  ctx.fillStyle = col.text; ctx.font = `700 13px ${BODY}`;
  const title = isCore ? 'CORE' : `${def!.id} · ${def!.name.toUpperCase()}`;
  ctx.fillText(title, cx, cy - r - 12);
  ctx.font = `400 10px ${DATA}`; ctx.fillStyle = col.muted;
  const sub = isCore ? 'reads ↑↓ as threat' : def!.sealed ? 'SEALED · inside unknown' : def!.glyph;
  ctx.fillText(sub, cx, cy + r + 18);
  let badgeY = cy + r + 26;
  if (!isCore && ns && Number.isFinite(ns.integrity) && def!.integrity) {
    ctx.fillStyle = ns.integrity <= 3 ? col.hostile : col.muted;
    ctx.fillText(`integrity ${Math.max(0, ns.integrity)}/${def!.integrity}`, cx, cy + r + 31);
    badgeY += 13;
  }
  if (!isCore && ns) {
    const badges: [string, string][] = [];
    if (ns.filter) badges.push(['FILTER', col.readout]);
    if (ns.align.mode === 'honest') badges.push(['HONEST', col.metric]);
    if (ns.align.mode === 'spare') badges.push([`SPARE ${ns.align.tag === 'friendly' ? 'CYAN' : 'RED'}`, ns.align.tag === 'friendly' ? col.friendly : col.hostile]);
    if (ns.scan) badges.push([ns.scan.verdict === 'coordinate' ? 'SCREEN LIES' : ns.scan.verdict === 'signal' ? 'BENDS SIGNAL' : ns.scan.verdict === 'clean' ? 'CLEAN' : ns.scan.verdict === 'both' ? 'LIES + BENDS' : 'SCAN ?', col.metric]);
    if (ns.sat) badges.push(['SATURATED', col.hostile]);
    ctx.font = `600 9.5px ${DATA}`;
    // Wrap badges into rows no wider than the chamber's slot so they never run off the board.
    const maxW = 2 * r + 24;
    const rows: { items: [string, string, number][]; width: number }[] = [];
    for (const [t, color] of badges) {
      const bw = ctx.measureText(t).width + 12;
      const row = rows[rows.length - 1];
      if (row && row.width + 4 + bw <= maxW) { row.items.push([t, color, bw]); row.width += 4 + bw; }
      else rows.push({ items: [[t, color, bw]], width: bw });
    }
    rows.forEach((row, ri) => {
      let x = cx - row.width / 2;
      const y = badgeY + ri * 19;
      for (const [t, color, bw] of row.items) {
        ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1;
        roundRect(ctx, x, y, bw, 15, 7); ctx.stroke();
        ctx.textAlign = 'left'; ctx.fillText(t, x + 6, y + 11);
        x += bw + 4;
      }
    });
  }
  ctx.restore();
}

function componentPre(s: State, i: NodeIndex, tag: Tag): Vec2 | null {
  const c = s.nodes[i].preComps.find((k) => k.tag === tag);
  return c && norm(c.v) > 1e-6 ? c.v : null;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

/** Screen drag vector (canvas px, y down) → aim in TRUE coordinates at node i. */
export function dragToAim(s: State, i: NodeIndex, dx: number, dy: number): Vec2 {
  return mul(inv(s.level.nodes[i].display), [dx, -dy]);
}

export function hitTest(frame: Frame, x: number, y: number): ArrowHit | null {
  let best: ArrowHit | null = null, bd = 12;
  for (const h of frame.hits) {
    const [ax, ay] = h.a, [bx, by] = h.b;
    const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
    const t = Math.max(0.25, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / L2));
    const d = Math.hypot(ax + vx * t - x, ay + vy * t - y);
    if (d < bd) { bd = d; best = h; }
  }
  return best;
}

export function chamberAt(frame: Frame, x: number, y: number): Slot | null {
  for (let i = 0; i < frame.chambers.length; i++) {
    const c = frame.chambers[i];
    if (Math.hypot(x - c.cx, y - c.cy) <= c.r + 4) return i as Slot;
  }
  return null;
}
