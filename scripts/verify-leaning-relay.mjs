// Headless check of the worked encounter "Leaning Relay" (docs/DESIGN.md §10–12).
// Deterministic, no dependencies:  node scripts/verify-leaning-relay.mjs
// Every number quoted in the design doc for this encounter comes from this file.

const v = (x, y) => [x, y];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const scale = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const norm = (a) => Math.hypot(a[0], a[1]);
const mul = (M, a) => [M[0][0] * a[0] + M[0][1] * a[1], M[1][0] * a[0] + M[1][1] * a[1]];
const T = (M) => [[M[0][0], M[1][0]], [M[0][1], M[1][1]]];
const inv = (M) => {
  const d = M[0][0] * M[1][1] - M[0][1] * M[1][0];
  return [[M[1][1] / d, -M[0][1] / d], [-M[1][0] / d, M[0][0] / d]];
};
const mm = (A, B) => [
  [A[0][0] * B[0][0] + A[0][1] * B[1][0], A[0][0] * B[0][1] + A[0][1] * B[1][1]],
  [A[1][0] * B[0][0] + A[1][1] * B[1][0], A[1][0] * B[0][1] + A[1][1] * B[1][1]],
];
const I = [[1, 0], [0, 1]];
const f2 = (a) => `(${a.map((n) => (Math.abs(n) < 1e-9 ? 0 : n).toFixed(2)).join(', ')})`;

// ---- Encounter constants -------------------------------------------------
const SHEAR = [[1, 1], [0, 1]]; // display map at N1 (x' = A x)
const BOOST = [[1, 0], [0, 3]]; // N2 physical Jacobian
const CAP = 6; // N2 saturation radius
const F = v(2, 0); // friendly emission, constant
const H_DIR = v(0, 1); // Leech emission direction
const leech = (w) => Math.min(2, 1 + 0.5 * w); // strength of wave w
const SUPPLY = v(1, 0); // Core supply readout (covector)
const THREAT = v(0, 1); // Core threat readout (covector)
const NEED = 1.8, SAFE = 0.5, CORE_HP = 12, HOLD = 6;

const clip = (x) => (norm(x) > CAP ? { y: scale(x, CAP / norm(x)), sat: true } : { y: x, sat: false });
// Jacobian of the radial clip at pre-clip point x (symmetric).
const clipJac = (x) => {
  const n = norm(x);
  if (n <= CAP) return I;
  const u = scale(x, 1 / n), k = CAP / n;
  return [[k * (1 - u[0] * u[0]), -k * u[0] * u[1]], [-k * u[0] * u[1], k * (1 - u[1] * u[1])]];
};

// Projection Pulse (STRIP): remove the amount the readout r detects, along aim u.
const strip = (x, u, r) => sub(x, scale(u, dot(r, x) / dot(r, u)));
// Readout built from an aim through metric G (the "flat" map u -> G u).
const flat = (G, u) => mul(G, u);

// Metrics expressed in TRUE coordinates.
const G_TRUE = I;
const G_SCREEN_N1 = mm(T(SHEAR), SHEAR); // what a naive Euclidean-on-screen sensor believes

// ---- Pipeline sim ----------------------------------------------------------
// Wave w is emitted at tick w, sits at N1 on tick w+1, N2 on w+2, Core on w+3.
function run(name, { physicalShear = false, n1 = null, n1Seq = null, n2 = null, n1Clamp = null, strikeAt = null, ticks = 14 }) {
  let hp = CORE_HP, n2hp = 8, leechHp = 3, leechDeadAt = Infinity, streak = 0, friendlyHit = 0;
  const log = [];
  const waveAt = (w, stage) => {
    // returns { x, sat, pre } at stage 1 (N1 out) or 2 (N2 out)
    const c = w >= leechDeadAt ? 0 : leech(w);
    const fScale = Math.max(0, 1 - friendlyHit / 3);
    let x = add(scale(F, fScale), scale(H_DIR, c));
    if (physicalShear) x = mul(SHEAR, x);
    if (n1Seq) {
      const active = n1Seq.filter((s) => w + 1 >= s.from).pop();
      if (active) x = active.f.apply(x);
    } else if (n1 && w + 1 >= n1.from) x = n1.apply(x);
    if (n1Clamp && w + 1 >= n1Clamp.from && norm(x) > n1Clamp.cap) x = scale(x, n1Clamp.cap / norm(x));
    if (stage === 1) return { x };
    const pre = mul(BOOST, x);
    const { y, sat } = clip(pre);
    let out = y;
    if (n2 && w + 2 >= n2.from) out = n2.apply(out);
    return { x: out, sat, pre };
  };
  for (let t = 0; t < ticks; t++) {
    if (strikeAt === t) {
      // Backprop Strike from Core with threat readout; backward through N2 (clip then boost) and N1.
      const inN2 = t - 2 >= 0 ? waveAt(t - 2, 2) : null;
      let g = THREAT;
      if (inN2) g = mul(clipJac(inN2.pre), g);
      g = mul(T(BOOST), g);
      if (physicalShear) g = mul(T(SHEAR), g);
      const leechDmg = Math.abs(dot(g, H_DIR)), friendDmg = Math.abs(dot(g, [1, 0]));
      leechHp -= leechDmg;
      friendlyHit += friendDmg;
      if (leechHp <= 1e-9) leechDeadAt = t;
      log.push(`  t${t}: STRIKE g@Intake=${f2(g)} leech -${leechDmg.toFixed(2)} (hp ${Math.max(0, leechHp).toFixed(2)}), friendly -${friendDmg.toFixed(2)}`);
    }
    const w = t - 3;
    if (w < 0) continue;
    const n2s = waveAt(w, 2);
    if (n2s.sat) n2hp -= 1;
    const y = n2s.x, sup = dot(SUPPLY, y), thr = Math.abs(dot(THREAT, y));
    const dmg = Math.max(0, thr - SAFE);
    hp -= dmg;
    const clean = sup >= NEED && thr <= SAFE;
    streak = clean ? streak + 1 : 0;
    log.push(`  t${t}: core=${f2(y)} supply=${sup.toFixed(2)} threat=${thr.toFixed(2)} dmg=${dmg.toFixed(2)} hp=${hp.toFixed(2)}${n2s.sat ? ' [N2 SATURATED]' : ''}${clean ? ` clean#${streak}` : ''}`);
    if (hp <= 0) { log.push(`  => LOSS at t${t}`); break; }
    if (streak >= HOLD) { log.push(`  => WIN at t${t} (core hp ${hp.toFixed(2)}, N2 hp ${n2hp})`); break; }
  }
  console.log(`\n## ${name}\n${log.join('\n')}`);
}

const pulse = (G, aim) => ({ from: 1, apply: (x) => strip(x, aim, flat(G, aim)) });
// Naive pulse at N1: player aims at the hostile arrow as DISPLAYED, h' = A h = (1,1) on screen;
// the sensor turns that aim into a readout with the screen's Euclidean metric.
const naive = { from: 1, apply: (x) => strip(x, H_DIR, flat(G_SCREEN_N1, H_DIR)) };
// Spare: readout chosen to annihilate the friendly component (metric-free), aim at hostile.
const spare = (aim, keep) => ({ from: 1, apply: (x) => strip(x, aim, v(-keep[1], keep[0])) });

console.log('# Leaning Relay — verification');
console.log(`screen metric at N1 (true coords) = ${JSON.stringify(G_SCREEN_N1)}`);
console.log(`friendly'·hostile' on screen = ${dot(mul(SHEAR, F), mul(SHEAR, H_DIR))}, true = ${dot(F, H_DIR)}`);

run('S0 no action', {});
run('FAIL naive pulse at N1 (screen metric)', { n1: naive });
run('A  scan -> Dual Align HONEST -> pulse at N1', { n1: pulse(G_TRUE, H_DIR) });
run('B  Dual Align SPARE(friendly) -> pulse at N1', { n1: spare(H_DIR, F) });
run('C  Backprop Strike from Core at t1', { strikeAt: 1 });
run('C+ Backprop Strike at t1 + cheap N2 pulse at t1', { strikeAt: 1, n2: { from: 1, apply: (x) => strip(x, H_DIR, H_DIR) } });
run('D  downstream pulse at N2 output (honest frame)', { n2: { from: 1, apply: (x) => strip(x, H_DIR, H_DIR) } });
run('FAIL late Backprop Strike at t4 (through saturated N2)', { strikeAt: 4 });
// Recovery: naive pulse at t1, replaced by a SPARE pulse at t2 (filters replace each other).
run('RECOVERY naive@t1, then SPARE@t3 after seeing Core damage', {
  n1Seq: [{ from: 1, f: naive }, { from: 3, f: spare(H_DIR, F) }],
});
run('FAIL Norm Clamp at N1, cap 2.2', { n1Clamp: { from: 1, cap: 2.2 } });

console.log('\n# Twin: Leaning Relay II (PHYSICAL shear, honest display)');
const Fp = mul(SHEAR, F), Hp = mul(SHEAR, H_DIR);
run('II naive pulse (= HONEST, display is already honest)', { physicalShear: true, n1: { from: 1, apply: (x) => strip(x, Hp, Hp) } });
run('II SPARE(friendly) pulse', { physicalShear: true, n1: spare(Hp, Fp) });

// Duality sanity checks used in §6/§7.
const A = SHEAR, x = v(0.7, -1.3), r = v(2, 0.5);
console.log('\n# Duality checks');
console.log(`readout(x) original=${dot(r, x).toFixed(4)}  vector-rule both (Ar)(Ax)=${dot(mul(A, r), mul(A, x)).toFixed(4)}  inverse-transpose (A^-T r)(Ax)=${dot(mul(T(inv(A)), r), mul(A, x)).toFixed(4)}`);
const R = [[0, -1], [1, 0]];
console.log(`rotation: R^-T == R ? ${JSON.stringify(T(inv(R)).map((row) => row.map((n) => n + 0)))} vs ${JSON.stringify(R)}`);
