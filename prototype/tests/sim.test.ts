import { describe, expect, it } from 'vitest';
import { LEVELS } from '../src/levels.ts';
import { type Mat2, type Vec2, T, dot, inv, mul, near } from '../src/math.ts';
import { SCENARIOS, run, trace } from '../src/scenarios.ts';
import { act, advance, classifyThreat, componentAt, createState, forecast, readoutFor, readoutToDisplay } from '../src/sim.ts';

const byName = (prefix: string) => {
  const sc = SCENARIOS.find((s) => s.name.startsWith(prefix));
  if (!sc) throw new Error(`no scenario ${prefix}`);
  return sc;
};
const coreReadings = (prefix: string) =>
  trace(byName(prefix)).log.flat().flatMap((e) => (e.type === 'core' ? [e.reading] : []));

describe('Leaning Relay (display lie)', () => {
  it('loses with no action, saturating the Booster from wave 3', () => {
    const r = coreReadings('No action');
    expect(r.map((x) => +x.threat.toFixed(2))).toEqual([0.45, 0.45, 0.45, 3, 4.5, 5.69, 5.69]);
    expect(run(byName('No action')).status).toBe('lost');
  });

  it('naive pulse strips red but pushes cyan into the threat channel, inverted', () => {
    const s = createState(LEVELS['relay-lie']);
    act(s, { kind: 'pulse', node: 1, aim: componentAt(s, 1, 'hostile')! });
    advance(s);
    const cyan = s.nodes[1].out!.comps.find((c) => c.tag === 'friendly')!.v;
    const red = s.nodes[1].out!.comps.find((c) => c.tag === 'hostile')!.v;
    expect(cyan[0]).toBeCloseTo(2); expect(cyan[1]).toBeCloseTo(-1);
    expect(Math.hypot(...red)).toBeCloseTo(0);
    const final = run(byName('FAIL: naive pulse at N1'));
    expect(final.status).toBe('lost');
    expect(final.core.history.at(-1)!.threat).toBeCloseTo(-3);
  });

  it.each(['A:', 'B:', 'C:', 'D:'])('solution %s wins', (p) => {
    expect(run(byName(p)).status).toBe('won');
  });

  it('A, B and C keep full Core integrity; D wins but strains the Booster', () => {
    for (const p of ['A:', 'B:', 'C:']) expect(run(byName(p)).core.hp).toBeCloseTo(12);
    const d = run(byName('D:'));
    expect(d.core.hp).toBeCloseTo(12);
    expect(d.nodes[2].integrity).toBe(4);
    expect(d.core.history.at(-1)!.supply).toBeCloseTo(1.897, 2);
  });

  it('a strike through a saturated Booster is deafened and nicks the friendly source', () => {
    const { log } = trace(byName('FAIL: late strike'));
    const ripple = log.flat().find((e) => e.type === 'ripple');
    expect(ripple && ripple.type === 'ripple' && ripple.leechDamage).toBeCloseTo(0.285, 2);
    expect(ripple && ripple.type === 'ripple' && ripple.friendlyDamage).toBeCloseTo(0.285, 2);
    expect(run(byName('FAIL: late strike')).status).toBe('lost');
  });

  it('a strike through your own strip filter is blocked by the filter’s transpose', () => {
    const { log } = trace(byName('FAIL: strike through your own'));
    const ripple = log.flat().find((e) => e.type === 'ripple');
    expect(ripple && ripple.type === 'ripple' && ripple.leechDamage).toBeCloseTo(0);
  });

  it('a strike back through the naive filter is redirected onto the friendly source', () => {
    const { log } = trace(byName('FAIL: strike back through a miscalibrated'));
    const ripple = log.flat().find((e) => e.type === 'ripple');
    expect(ripple && ripple.type === 'ripple' && ripple.leechDamage).toBeCloseTo(0);
    expect(ripple && ripple.type === 'ripple' && ripple.friendlyDamage).toBeCloseTo(1.5);
    expect(run(byName('FAIL: strike back through a miscalibrated')).status).toBe('lost');
  });

  it('recovers when the player spares cyan after the failure', () => {
    const s = run(byName('RECOVERY'));
    expect(s.status).toBe('won');
    expect(s.core.hp).toBeCloseTo(4.5);
  });

  it('scan reports a coordinate distortion at N1 and signal deformation at the Booster', () => {
    const s = createState(LEVELS['relay-lie']);
    act(s, { kind: 'scan', node: 1 });
    act(s, { kind: 'scan', node: 2 });
    advance(s);
    expect(s.nodes[1].scan?.verdict).toBe('coordinate');
    expect(s.nodes[2].scan?.verdict).toBe('signal');
  });
});

describe('Leaning Relay twin (physical shear)', () => {
  it('honest alignment changes nothing because the screen was not lying', () => {
    expect(run(byName('TWIN FAIL: scan')).status).toBe('lost');
  });
  it('spare and strike both win', () => {
    expect(run(byName('TWIN: spare')).status).toBe('won');
    expect(run(byName('TWIN: Backprop')).status).toBe('won');
  });
  it('at N1 the twins look identical on screen', () => {
    const a = createState(LEVELS['relay-lie']);
    const b = createState(LEVELS['relay-bend']);
    for (const tag of ['friendly', 'hostile'] as const) {
      const da = mul(LEVELS['relay-lie'].nodes[1].display, componentAt(a, 1, tag)!);
      const db = mul(LEVELS['relay-bend'].nodes[1].display, componentAt(b, 1, tag)!);
      expect(da[0]).toBeCloseTo(db[0]); expect(da[1]).toBeCloseTo(db[1]);
    }
  });
});

describe('mathematical invariants', () => {
  const A: Mat2 = [1, 1, 0, 1];
  it('readouts keep their meaning under a coordinate change only with the inverse transpose', () => {
    const x: Vec2 = [0.7, -1.3]; const r: Vec2 = [2, 0.5];
    expect(dot(mul(T(inv(A)), r), mul(A, x))).toBeCloseTo(dot(r, x));
    expect(near(dot(mul(A, r), mul(A, x)), dot(r, x))).toBe(false);
  });
  it('rotation treats arrows and readouts alike', () => {
    const R: Mat2 = [0, -1, 1, 0];
    expect(T(inv(R)).map((n) => n + 0)).toEqual([...R]);
  });
  it('the honest readout at the lying Relay is drawn parallel to cyan, not perpendicular to the aim', () => {
    const s = createState(LEVELS['relay-lie']);
    act(s, { kind: 'scan', node: 1 }); advance(s);
    act(s, { kind: 'alignHonest', node: 1 });
    const r = readoutToDisplay(s, 1, readoutFor(s, 1, [0, 1]));
    expect(r[0]).toBeCloseTo(0); // level lines horizontal on screen, like cyan
  });
  it('strike damage equals the finite-difference sensitivity of the Core threat to the Leech', () => {
    // Unsaturated chain: d threat / d strength = r · J2 J1 d.
    for (const id of ['relay-lie', 'relay-bend'] as const) {
      const L = LEVELS[id];
      const fd = dot(L.core.threat, mul(L.nodes[2].J, mul(L.nodes[1].J, L.leech.dir)));
      const s = createState(L);
      act(s, { kind: 'strike' }); advance(s);
      const ripple = s.events.find((e) => e.type === 'ripple');
      expect(ripple && ripple.type === 'ripple' && ripple.leechDamage).toBeCloseTo(Math.abs(fd));
    }
  });
});

describe('prediction support', () => {
  it('forecast matches what actually happens if the player does nothing else', () => {
    const s = createState(LEVELS['relay-lie']);
    act(s, { kind: 'pulse', node: 1, aim: componentAt(s, 1, 'hostile')! });
    const f = forecast(s, 3)!;
    for (let k = 0; k < 3; k++) advance(s);
    expect(f.threat).toBeCloseTo(s.core.last!.threat);
    expect(classifyThreat(s.level, f.threat, f.supply)).toBe('down');
  });
});
