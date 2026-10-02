/**
 * Shareable minds. A link carries the seed, the visitor's change, the step
 * of each generation's fork and the mind's place in the tree — everything
 * needed to rebuild that one mind exactly, and nothing else.
 *
 *   #f=<seed>_<originStep>_<neuron>_<ms>_<key>_<step>_<levelStep>…
 *
 * All integers, base-36.
 */
export interface ShareSpec {
  seed: number;
  originStep: number;
  neuron: number;
  ms: number;
  key: number;
  step: number;
  levelSteps: number[];
}

export function encodeShare(s: ShareSpec): string {
  const i = (n: number) => Math.round(n).toString(36);
  return [i(s.seed), i(s.originStep), i(s.neuron), i(s.ms), i(s.key), i(s.step), ...s.levelSteps.map(i)].join('_');
}

export function decodeShare(hash: string): ShareSpec | null {
  const m = /f=([0-9a-z_]+)/i.exec(hash);
  if (!m) return null;
  const p = m[1].split('_');
  if (p.length < 7) return null;
  const int = (s: string) => (/^[0-9a-z]+$/i.test(s) ? parseInt(s, 36) : NaN);
  const [seed, originStep, neuron, ms, key, step] = p.slice(0, 6).map(int);
  const levelSteps = p.slice(6).map(int);
  const all = [seed, originStep, neuron, ms, key, step, ...levelSteps];
  if (!all.every(Number.isFinite) || key < 2 || ms < 1 || ms > 10) return null;
  const depth = 31 - Math.clz32(key);
  if (levelSteps.length < depth) return null;
  return { seed, originStep, neuron, ms, key, step, levelSteps };
}
