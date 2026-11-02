// Referral rules. Lung and breath-rate logic is ported from ST_RESULT in
// firmware/pneumoscreen/pneumoscreen.ino, with the age bands from breath.cpp
// (WHO IMCI fast-breathing thresholds). SpO2 < 90 % (WHO hypoxaemia) is new
// here because the app now has an SpO2 step. Temperature is ambient (AHT10),
// so it is recorded but never used to refer.
import type { LungClass } from './classify';

export const RULES_VERSION = '1.1';

export type AgeBand = 0 | 1 | 2 | 3;
export const AGE_BANDS: ReadonlyArray<{ band: AgeBand; label: string; fastBreathFrom: number }> = [
  { band: 0, label: 'under 2 months', fastBreathFrom: 60 },
  { band: 1, label: '2 to 12 months', fastBreathFrom: 50 },
  { band: 2, label: '1 to 5 years', fastBreathFrom: 40 },
  { band: 3, label: 'over 5 years', fastBreathFrom: 21 },
];
export const SPO2_REFER_BELOW = 90;

export const LUNG_POSITIONS = ['RU', 'LU', 'RL', 'LL'] as const;
export type LungPosition = (typeof LUNG_POSITIONS)[number];

/** Age band at `at` for a child born on `dob` (calendar months, like a clinic card). */
export function ageBand(dob: Date, at: Date = new Date()): AgeBand {
  let months = (at.getFullYear() - dob.getFullYear()) * 12 + (at.getMonth() - dob.getMonth());
  if (at.getDate() < dob.getDate()) months--;
  if (months < 0) throw new Error('date of birth is after the screening date');
  if (months < 2) return 0;
  if (months < 12) return 1;
  if (months < 60) return 2;
  return 3;
}

export interface ScreeningInput {
  ageBand: AgeBand;
  breathBpm?: number | null;
  lung?: Partial<Record<LungPosition, LungClass | null>>;
  spo2?: number | null;
}

export interface ScreeningResult {
  refer: boolean;
  reasons: string[];
  fastBreathing: boolean | null;
  abnormalLung: LungClass | null;
  missing: string[];
  complete: boolean;
  rulesVersion: string;
}

export function evaluate(input: ScreeningInput): ScreeningResult {
  const reasons: string[] = [];
  const missing: string[] = [];
  const band = AGE_BANDS[input.ageBand];

  let fastBreathing: boolean | null = null;
  if (input.breathBpm != null && input.breathBpm > 0) {
    fastBreathing = input.breathBpm >= band.fastBreathFrom;
    if (fastBreathing) reasons.push(`fast breathing: ${input.breathBpm}/min (≥ ${band.fastBreathFrom} for ${band.label})`);
  } else {
    missing.push('breath');
  }

  let abnormalLung: LungClass | null = null;
  for (const pos of LUNG_POSITIONS) {
    const c = input.lung?.[pos];
    if (c == null || c === 'noise') { missing.push(`lung_${pos}`); continue; }
    if (c === 'crackles' || c === 'wheezes') {
      reasons.push(`${c} at ${pos}`);
      if (!abnormalLung) abnormalLung = c;
    }
  }

  if (input.spo2 != null && input.spo2 > 0) {
    if (input.spo2 < SPO2_REFER_BELOW) reasons.push(`low SpO₂: ${input.spo2}% (< ${SPO2_REFER_BELOW}%)`);
  }

  return {
    refer: reasons.length > 0,
    reasons,
    fastBreathing,
    abnormalLung,
    missing,
    complete: missing.length === 0,
    rulesVersion: RULES_VERSION,
  };
}
