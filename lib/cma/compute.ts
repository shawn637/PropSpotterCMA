import type {
  Comparable,
  ComparableWithDerived,
  CMAResult,
  MarketContext,
  PropertyDetails,
} from '@/lib/types';

const INDEXING_CAP_MONTHS = 12;
const MAX_COMPARABLE_AGE_MONTHS = 6;
const MIN_COMPARABLES = 3;

export function monthsBetween(fromIso: string, toIso: string): number {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  const msPerMonth = (365.25 / 12) * 24 * 60 * 60 * 1000;
  return Math.max(0, (to - from) / msPerMonth);
}

export function indexSalePrice(
  salePrice: number,
  monthsSinceSale: number,
  annualGrowthRate: number,
): number {
  const cappedMonths = Math.min(monthsSinceSale, INDEXING_CAP_MONTHS);
  const factor = 1 + annualGrowthRate * (cappedMonths / 12);
  return salePrice * factor;
}

/**
 * Similarity adjustment fallback when HTAG's structural adjustment isn't
 * supplied. Nudges comparable sales up or down based on coarse feature
 * differences vs the subject.
 */
export function deriveHeuristicAdjustment(
  subject: PropertyDetails,
  comp: Comparable,
): number {
  let factor = 1.0;

  if (subject.landAreaSqm && comp.landAreaSqm) {
    const ratio = subject.landAreaSqm / comp.landAreaSqm;
    const landDelta = (ratio - 1) * 0.2;
    factor *= 1 + clamp(landDelta, -0.1, 0.1);
  }

  if (subject.bedrooms != null && comp.bedrooms != null) {
    factor *= 1 + clamp((subject.bedrooms - comp.bedrooms) * 0.03, -0.09, 0.09);
  }

  if (subject.bathrooms != null && comp.bathrooms != null) {
    factor *= 1 + clamp((subject.bathrooms - comp.bathrooms) * 0.02, -0.06, 0.06);
  }

  if (subject.carSpaces != null && comp.carSpaces != null) {
    factor *= 1 + clamp((subject.carSpaces - comp.carSpaces) * 0.01, -0.03, 0.03);
  }

  if (subject.yearBuilt && comp.yearBuilt) {
    const ageDelta = (subject.yearBuilt - comp.yearBuilt) / 100;
    factor *= 1 + clamp(ageDelta, -0.05, 0.05);
  }

  return clamp(factor, 0.8, 1.2);
}

export function deriveFlags(
  subject: PropertyDetails,
  comp: Comparable,
  monthsSinceSale: number,
): string[] {
  const flags: string[] = [];

  if (monthsSinceSale > 4) flags.push('older sale');
  if (comp.distanceKm != null && comp.distanceKm > 1.5) flags.push('distant');
  if (
    subject.landAreaSqm &&
    comp.landAreaSqm &&
    Math.abs(comp.landAreaSqm / subject.landAreaSqm - 1) > 0.3
  ) {
    flags.push('land size variance');
  }
  if (
    subject.bedrooms != null &&
    comp.bedrooms != null &&
    Math.abs(comp.bedrooms - subject.bedrooms) >= 2
  ) {
    flags.push('config variance');
  }
  return flags;
}

export function filterComparables(
  comparables: Comparable[],
  subject: PropertyDetails,
  nowIso: string,
): Comparable[] {
  return comparables.filter((c) => {
    const months = monthsBetween(c.saleDateIso, nowIso);
    if (months > MAX_COMPARABLE_AGE_MONTHS) return false;
    if (
      c.propertyType &&
      subject.propertyType &&
      c.propertyType !== subject.propertyType
    ) {
      return false;
    }
    return true;
  });
}

export function computeCMA(
  subject: PropertyDetails,
  comparables: Comparable[],
  market: MarketContext,
  nowIso: string = new Date().toISOString(),
): CMAResult {
  const filtered = filterComparables(comparables, subject, nowIso);
  const notes: string[] = [];

  if (filtered.length < MIN_COMPARABLES) {
    notes.push(
      `Only ${filtered.length} comparable(s) within ${MAX_COMPARABLE_AGE_MONTHS} months; minimum ${MIN_COMPARABLES} required.`,
    );
    return {
      fairValue: 0,
      fairValueLow: 0,
      fairValueHigh: 0,
      dispersion: 0,
      comparables: [],
      notes,
    };
  }

  const derived: ComparableWithDerived[] = filtered.map((c) => {
    const monthsSinceSale = monthsBetween(c.saleDateIso, nowIso);
    const indexedSalePrice = indexSalePrice(
      c.salePrice,
      monthsSinceSale,
      market.annualisedGrowth5y,
    );

    const adjustmentSource: 'htag' | 'heuristic' =
      c.htagAdjustmentFactor != null ? 'htag' : 'heuristic';
    const adjustmentFactor =
      c.htagAdjustmentFactor != null
        ? c.htagAdjustmentFactor
        : deriveHeuristicAdjustment(subject, c);

    const impliedSubjectValue = indexedSalePrice * adjustmentFactor;

    return {
      ...c,
      monthsSinceSale,
      indexedSalePrice,
      adjustmentFactor,
      adjustmentSource,
      impliedSubjectValue,
      flags: deriveFlags(subject, c, monthsSinceSale),
    };
  });

  const implied = derived.map((d) => d.impliedSubjectValue);
  const fairValue = percentile(implied, 50);
  const fairValueLow = percentile(implied, 25);
  const fairValueHigh = percentile(implied, 75);

  const mean = implied.reduce((a, b) => a + b, 0) / implied.length;
  const variance =
    implied.reduce((a, b) => a + (b - mean) ** 2, 0) / implied.length;
  const stdDev = Math.sqrt(variance);
  const dispersion = mean > 0 ? stdDev / mean : 0;

  if (derived.length < 6) {
    notes.push(`Only ${derived.length} usable comparables — result is indicative.`);
  }
  if (dispersion > 0.12) {
    notes.push('Comparable spread is wider than ideal — treat fair value as a range, not a point.');
  }
  if (derived.some((d) => d.adjustmentSource === 'heuristic')) {
    notes.push('Some comparables use a heuristic similarity adjustment rather than an HTAG-provided factor.');
  }

  return {
    fairValue: round(fairValue, 100),
    fairValueLow: round(fairValueLow, 100),
    fairValueHigh: round(fairValueHigh, 100),
    dispersion,
    comparables: derived,
    notes,
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, to: number): number {
  if (to === 0) return value;
  return Math.round(value / to) * to;
}
