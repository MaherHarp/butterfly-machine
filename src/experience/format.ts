import type { FirstDifference } from '../sim/replay';
import { EV_BIRTH, EV_CATCH, EV_DEATH, EV_GRAZERS_LOST, EV_HUNTERS_LOST, EV_LINEAGE_LOST, EV_STRUCTURE, EV_TOUCH } from '../sim/events';
import type { Outcome } from '../sim/metrics';

export function pct(v: number): string {
  const p = Math.max(0, v) * 100;
  if (p === 0) return '0.000%';
  if (p < 0.1) return `${p.toFixed(3)}%`;
  if (p < 1) return `${p.toFixed(2)}%`;
  return `${p.toFixed(1)}%`;
}

export function px(v: number): string {
  const a = Math.abs(v);
  return a < 0.1 ? a.toFixed(3) : a.toFixed(2);
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function signedSeconds(seconds: number): string {
  return `+${seconds.toFixed(1)} s`;
}

export function thousands(n: number): string {
  return n.toLocaleString('en-US');
}

export const OUTCOME_LABEL: Record<Outcome, string> = {
  collapsed: 'collapsed',
  dominated: 'taken by one lineage',
  unhunted: 'hunters gone',
  diverse: 'diverse',
  stable: 'stable',
};

export const OUTCOME_DESCRIPTION: Record<Outcome, string> = {
  collapsed: 'Fewer than six grazers remain.',
  dominated: 'One lineage holds at least 75% of all grazers.',
  unhunted: 'Every hunter has died; the grazers live unchecked.',
  diverse: 'At least 2.6 effective lineages coexist (inverse Simpson index).',
  stable: 'A steady world with a few lineages.',
};

export const OUTCOME_COLOR: Record<Outcome, [number, number, number]> = {
  collapsed: [0.5, 0.54, 0.62],
  dominated: [0.92, 0.55, 0.82],
  unhunted: [1.0, 0.68, 0.36],
  diverse: [0.42, 0.92, 0.8],
  stable: [0.58, 0.74, 1.0],
};

export function cssColor(c: [number, number, number]): string {
  return `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`;
}

function ms(v: number): string {
  const a = Math.abs(v);
  if (a < 1) return a.toFixed(2);
  if (a < 10) return a.toFixed(1);
  return a.toFixed(0);
}

/** One sentence describing the first point at which two futures disagreed. */
export function describeFirstDifference(r: FirstDifference, nameX: string, nameY: string): string {
  const e = r.event;
  if (!e) return 'Their histories differ.';
  const here = r.inWorld === 0 ? nameX : nameY;
  const there = r.inWorld === 0 ? nameY : nameX;
  const d = r.otherDelayMs;
  const when = d !== null ? `<em>${ms(d)} ms</em> earlier in World ${here}` : null;
  switch (e.type) {
    case EV_TOUCH:
      return when
        ? `Two organisms touched ${when}.`
        : `Two organisms touched in World ${here}. In World ${there}, they passed without meeting.`;
    case EV_CATCH:
      return when
        ? `A hunter caught its prey ${when}.`
        : `In World ${here}, a hunter caught its prey. In World ${there}, it escaped.`;
    case EV_BIRTH:
      return when ? `An organism divided ${when}.` : `An organism divided in World ${here}, but not in World ${there}.`;
    case EV_DEATH:
      return when ? `An organism died ${when}.` : `An organism died in World ${here}. In World ${there}, it lived on.`;
    case EV_STRUCTURE:
      return when ? `A structure grew ${when}.` : `A structure grew in World ${here}, but not in World ${there}.`;
    case EV_LINEAGE_LOST:
      return `A lineage vanished from World ${here}.`;
    case EV_HUNTERS_LOST:
      return `The last hunter of World ${here} died.`;
    case EV_GRAZERS_LOST:
      return `World ${here} lost its last grazer.`;
    default:
      return 'Their histories differ.';
  }
}
