/**
 * Shareable futures. A link carries the seed, the visitor's touch, the step
 * of each generation's split and the world's place in the tree — everything
 * needed to rebuild that one universe exactly, and nothing else.
 *
 *   #f=<seed>_<originStep>_<agentId>_<dx>_<dy>_<key>_<step>_<levelStep>…
 *
 * Integers are base-36; the touch offsets keep full float precision.
 */
export interface ShareSpec {
  seed: number;
  originStep: number;
  id: number;
  dx: number;
  dy: number;
  key: number;
  step: number;
  levelSteps: number[];
}

export function encodeShare(s: ShareSpec): string {
  const i = (n: number) => Math.round(n).toString(36);
  return [i(s.seed), i(s.originStep), i(s.id), String(s.dx), String(s.dy), i(s.key), i(s.step), ...s.levelSteps.map(i)].join('_');
}

export function decodeShare(hash: string): ShareSpec | null {
  const m = /f=([0-9a-z._\-+]+)/i.exec(hash);
  if (!m) return null;
  const p = m[1].split('_');
  if (p.length < 8) return null;
  const int = (s: string) => (/^[0-9a-z]+$/i.test(s) ? parseInt(s, 36) : NaN);
  const seed = int(p[0]);
  const originStep = int(p[1]);
  const id = int(p[2]);
  const dx = Number(p[3]);
  const dy = Number(p[4]);
  const key = int(p[5]);
  const step = int(p[6]);
  const levelSteps = p.slice(7).map(int);
  const all = [seed, originStep, id, dx, dy, key, step, ...levelSteps];
  if (!all.every(Number.isFinite) || key < 2) return null;
  const depth = 31 - Math.clz32(key);
  if (levelSteps.length < depth) return null;
  return { seed, originStep, id, dx, dy, key, step, levelSteps };
}
