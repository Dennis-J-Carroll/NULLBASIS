// 2D linear algebra. Everything in the simulation is stored in TRUE coordinates.
export type Vec2 = readonly [number, number];
/** Row-major 2×2: [a, b, c, d] = [[a, b], [c, d]]. */
export type Mat2 = readonly [number, number, number, number];

export const I2: Mat2 = [1, 0, 0, 1];
export const ZERO: Vec2 = [0, 0];

export const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
export const scale = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
export const dot = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
export const cross = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0];
export const norm = (a: Vec2): number => Math.hypot(a[0], a[1]);
export const normalize = (a: Vec2): Vec2 => {
  const n = norm(a);
  return n < 1e-12 ? ZERO : [a[0] / n, a[1] / n];
};
/** Rotate +90°. perp(d) is the readout whose level lines run parallel to d. */
export const perp = (a: Vec2): Vec2 => [-a[1], a[0]];
export const sum = (vs: readonly Vec2[]): Vec2 => vs.reduce<Vec2>((acc, v) => add(acc, v), ZERO);

export const mul = (M: Mat2, v: Vec2): Vec2 => [M[0] * v[0] + M[1] * v[1], M[2] * v[0] + M[3] * v[1]];
export const mulM = (A: Mat2, B: Mat2): Mat2 => [
  A[0] * B[0] + A[1] * B[2],
  A[0] * B[1] + A[1] * B[3],
  A[2] * B[0] + A[3] * B[2],
  A[2] * B[1] + A[3] * B[3],
];
export const T = (M: Mat2): Mat2 => [M[0], M[2], M[1], M[3]];
export const det = (M: Mat2): number => M[0] * M[3] - M[1] * M[2];
export const inv = (M: Mat2): Mat2 => {
  const d = det(M);
  return [M[3] / d, -M[1] / d, -M[2] / d, M[0] / d];
};
/** I − u rᵀ / (r·u): removes what readout r detects, along u. Null when r·u ≈ 0. */
export const stripMatrix = (u: Vec2, r: Vec2): Mat2 | null => {
  const d = dot(r, u);
  if (Math.abs(d) < 1e-9) return null;
  return [1 - (u[0] * r[0]) / d, -(u[0] * r[1]) / d, -(u[1] * r[0]) / d, 1 - (u[1] * r[1]) / d];
};
/** Jacobian of the radial clip x ↦ x·cap/‖x‖ at a point x with ‖x‖ > cap. Symmetric. */
export const clipJacobian = (x: Vec2, cap: number): Mat2 => {
  const n = norm(x);
  const k = cap / n;
  const u = scale(x, 1 / n);
  return [k * (1 - u[0] * u[0]), -k * u[0] * u[1], -k * u[0] * u[1], k * (1 - u[1] * u[1])];
};
export const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;
export const isOrthogonal = (M: Mat2, eps = 1e-9): boolean => {
  const G = mulM(T(M), M);
  return near(G[0], 1, eps) && near(G[1], 0, eps) && near(G[2], 0, eps) && near(G[3], 1, eps);
};
export const fmt = (n: number, d = 2): string => (Math.abs(n) < 0.005 ? 0 : n).toFixed(d);
export const fmtV = (v: Vec2, d = 2): string => `(${fmt(v[0], d)}, ${fmt(v[1], d)})`;
