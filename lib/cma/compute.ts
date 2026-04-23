import type {
  BackyardSize,
  Comparable,
  ComparableWithDerived,
  CMAResult,
  ConditionGrade,
  ConstructionMaterial,
  LandQuality,
  MarketContext,
  PropertyDetails,
  RoomCondition,
  StoreyCount,
  TenureProfile,
  VisionAttributes,
  VisualFeature,
} from '@/lib/types';

const INDEXING_CAP_MONTHS = 12;
const MAX_COMPARABLE_AGE_MONTHS = 6;
const MIN_COMPARABLES = 3;

// Hard drop thresholds — a comparable outside these size bands vs the
// subject is so structurally different (usually a single-storey vs
// double-storey build, or a townhouse sitting in a house dataset) that
// including it distorts the median. 50% tolerance in either direction.
const SIZE_MISMATCH_UPPER = 1.5;
const SIZE_MISMATCH_LOWER = 1 / SIZE_MISMATCH_UPPER;

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

  // Floor area is the strongest proxy for storey count and overall
  // liveable size. A double-storey house on a 450sqm block typically
  // has 1.5-2x the floor area of a single-storey house on the same
  // block, so this adjustment is where "storey mismatch" effectively
  // gets priced in.
  if (subject.floorAreaSqm && comp.floorAreaSqm) {
    const ratio = subject.floorAreaSqm / comp.floorAreaSqm;
    const floorDelta = (ratio - 1) * 0.4;
    factor *= 1 + clamp(floorDelta, -0.15, 0.15);
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

  // Visual / façade adjustment — only when both sides have vision attrs.
  // Captures storey mismatch, construction material, and condition
  // differences that HTAG's structural fields never expose.
  factor *= deriveVisualAdjustment(subject.visionAttrs, comp.visionAttrs);

  // Neighbourhood tenure adjustment — SA1-level public-housing share
  // and owner-occupancy rate. Compensates for comps drawn from a
  // materially different tenure mix than the subject's pocket (e.g.
  // subject in a high-PH pocket, comp pulled from a low-PH pocket
  // nearby — the comp's sale price overstates what the subject
  // should realistically trade for).
  factor *= deriveTenureAdjustment(subject.tenureProfile, comp.tenureProfile);

  return clamp(factor, 0.7, 1.3);
}

/**
 * Adjustment factor driven by the DELTA between subject's and comp's
 * SA1 tenure profile. Returns a multiplier in [0.88, 1.12]:
 *   factor > 1  → comp sits in a higher-public-housing / lower-owner-
 *                 occupancy pocket than subject, so the comp's sale
 *                 price understates what the subject should trade for
 *                 (uplift).
 *   factor < 1  → comp sits in a materially nicer pocket than subject
 *                 (less PH, more OO), so its sale overstates the
 *                 subject's value (discount).
 *
 * Weights calibrated against Australian valuer practice:
 *   - Public-housing delta: 0.4% per percentage-point, capped at ±8%.
 *     Example: subject in a 15% PH pocket, comp in a 2% PH pocket
 *     (13pp delta) → comp's sale is priced ~5% above what the subject
 *     should be; we discount subject's implied value by ~5%.
 *   - Owner-occupancy delta: 0.1% per percentage-point, capped at ±3%.
 *     Stability signal — high owner-occupancy reads as family-
 *     dominated and typically commands a slight premium.
 *
 * Returns 1.0 when either side is missing a tenure profile, so comps
 * without coords from HTAG no-op cleanly.
 */
export function deriveTenureAdjustment(
  subject: TenureProfile | undefined,
  comp: TenureProfile | undefined,
): number {
  if (!subject || !comp) return 1;
  // Same SA1 → factor exactly 1 (shortcut + avoids floating drift).
  if (subject.sa1Code === comp.sa1Code) return 1;

  // Public-housing delta. comp.ph - subject.ph > 0 means comp is in
  // a higher-PH pocket (worse area) → subject is nicer by comparison
  // → uplift subject relative to comp's sale.
  const phDelta = comp.publicHousingPct - subject.publicHousingPct;
  const phFactor = 1 + clamp(phDelta * 0.004, -0.08, 0.08);

  // Owner-occupancy delta. subject.oo - comp.oo > 0 means subject is
  // in a more owner-occupied (more stable) pocket → uplift subject.
  const ooDelta = subject.ownerOccupierPct - comp.ownerOccupierPct;
  const ooFactor = 1 + clamp(ooDelta * 0.001, -0.03, 0.03);

  return clamp(phFactor * ooFactor, 0.88, 1.12);
}

/**
 * Pure visual adjustment derived from a pair of Claude-Vision-extracted
 * VisionAttributes. Returns a multiplier in [0.80, 1.20]:
 *   factor > 1  → comparable is structurally WORSE than subject (its
 *                 sale price understates the subject's value; uplift)
 *   factor < 1  → comparable is structurally BETTER than subject
 *                 (its sale price overstates the subject's value; discount)
 *
 * Returns 1.0 if either side is missing, so unseen properties are not
 * penalised.
 *
 * The Vision pass sees kitchen + bathroom + backyard + façade, not just
 * the street shot, so the signal here is materially richer than a
 * façade-only classifier. Weights below reflect Australian market
 * price sensitivity — kitchen and bathroom condition are the biggest
 * interior drivers, followed by overall condition, then landscaping,
 * with individual feature tags (pool/view/main road) stacking on top.
 */
export function deriveVisualAdjustment(
  subjectAttrs: VisionAttributes | undefined,
  compAttrs: VisionAttributes | undefined,
): number {
  if (!subjectAttrs || !compAttrs) return 1;
  let factor = 1;

  // Storeys: single vs double has a meaningful price delta — though
  // floor-area tends to price most of it already, the visual signal
  // still helps when floor area is missing on either side.
  const storeyDelta =
    storeyOrdinal(subjectAttrs.storeys) - storeyOrdinal(compAttrs.storeys);
  if (storeyDelta !== 0) {
    factor *= 1 + clamp(storeyDelta * 0.06, -0.07, 0.07);
  }

  // Construction material: brick is the Australian benchmark; fibro
  // and weatherboard trade at a discount for post-1980s stock. Lighter
  // weight than before — material rarely moves price by more than a
  // few percent once condition is accounted for.
  const matDelta =
    materialScore(subjectAttrs.constructionMaterial) -
    materialScore(compAttrs.constructionMaterial);
  if (matDelta !== 0) {
    factor *= 1 + clamp(matDelta * 0.02, -0.04, 0.04);
  }

  // Overall condition grade (synthesised across all photos). Ranges
  // from poor (-2) to new (+2).
  const condDelta =
    conditionScore(subjectAttrs.conditionGrade) -
    conditionScore(compAttrs.conditionGrade);
  if (condDelta !== 0) {
    factor *= 1 + clamp(condDelta * 0.025, -0.06, 0.06);
  }

  // Kitchen condition: biggest single interior driver. A renovated
  // kitchen vs a dated one is commonly ±5-8% on its own in Australian
  // suburban markets. Weighted the heaviest of the room-specific
  // fields. 'not_visible' on either side → skip this leg (neutral).
  const kitchenDelta = roomConditionScoreDelta(
    subjectAttrs.kitchenCondition,
    compAttrs.kitchenCondition,
  );
  if (kitchenDelta != null) {
    factor *= 1 + clamp(kitchenDelta * 0.025, -0.06, 0.06);
  }

  // Bathroom condition: second-largest interior driver, roughly half
  // the weight of kitchen.
  const bathroomDelta = roomConditionScoreDelta(
    subjectAttrs.bathroomCondition,
    compAttrs.bathroomCondition,
  );
  if (bathroomDelta != null) {
    factor *= 1 + clamp(bathroomDelta * 0.015, -0.04, 0.04);
  }

  // Landscaping / land quality. A premium, landscaped block vs a
  // neglected yard is meaningful but not as much as interior condition.
  const landDelta =
    landQualityScore(subjectAttrs.landQuality) -
    landQualityScore(compAttrs.landQuality);
  if (landDelta !== 0) {
    factor *= 1 + clamp(landDelta * 0.015, -0.04, 0.04);
  }

  // Backyard size. Mostly captured by land area elsewhere but the
  // signal helps when land area is missing or when land size doesn't
  // reflect usable yard (e.g. battle-axe blocks).
  const backyardDelta =
    backyardScore(subjectAttrs.backyardSize) -
    backyardScore(compAttrs.backyardSize);
  if (backyardDelta !== 0) {
    factor *= 1 + clamp(backyardDelta * 0.015, -0.03, 0.03);
  }

  // Feature stack — each feature contributes a small multiplicative
  // bump or drag. Asymmetry between subject and comp is what matters:
  // if subject has a pool and comp doesn't, subject's implied value
  // should be higher than comp's sale suggests.
  factor *= featureAsymmetryFactor(subjectAttrs.features, compAttrs.features);

  return clamp(factor, 0.8, 1.2);
}

function storeyOrdinal(s: StoreyCount): number {
  switch (s) {
    case 'single':
      return 1;
    case 'double':
      return 2;
    case 'multi':
      return 3;
    default:
      return 0; // unknown — neutral
  }
}

function materialScore(m: ConstructionMaterial): number {
  switch (m) {
    case 'brick':
    case 'render':
      return 1;
    case 'mixed':
      return 0;
    case 'weatherboard':
      return -0.5;
    case 'fibro':
      return -1;
    default:
      return 0; // unknown — neutral
  }
}

function conditionScore(c: ConditionGrade): number {
  switch (c) {
    case 'new':
      return 2;
    case 'renovated':
      return 1;
    case 'average':
      return 0;
    case 'poor':
      return -2;
    default:
      return 0; // unknown — neutral
  }
}

/**
 * Room-level condition delta. Returns null when either side is
 * 'not_visible' or 'unknown' — signals "no reliable signal" and the
 * caller should skip that leg entirely rather than pretend both sides
 * are 'average'.
 */
function roomConditionScoreDelta(
  subject: RoomCondition,
  comp: RoomCondition,
): number | null {
  if (
    subject === 'not_visible' ||
    comp === 'not_visible' ||
    subject === 'unknown' ||
    comp === 'unknown'
  ) {
    return null;
  }
  return conditionScore(subject) - conditionScore(comp);
}

function landQualityScore(q: LandQuality): number {
  switch (q) {
    case 'premium':
      return 2;
    case 'landscaped':
      return 1;
    case 'basic':
      return 0;
    case 'neglected':
      return -2;
    default:
      return 0;
  }
}

function backyardScore(b: BackyardSize): number {
  switch (b) {
    case 'large':
      return 2;
    case 'medium':
      return 1;
    case 'small':
      return 0;
    case 'none':
      return -1;
    default:
      return 0;
  }
}

/**
 * Each feature carries a small multiplicative bump (positive) or drag
 * (negative). The factor applied is the NET difference between subject
 * and comp feature sets: if both have a pool it cancels out; if only
 * the subject has a pool, the subject's implied value gets uplift
 * relative to the comp's sale price.
 */
const FEATURE_WEIGHTS: Record<VisualFeature, number> = {
  pool: 0.025,
  view: 0.03,
  renovation: 0.02,
  modern_kitchen: 0.015,
  modern_bathroom: 0.01,
  outdoor_entertaining: 0.01,
  fireplace: 0.005,
  solar: 0.005,
  air_conditioning: 0.005,
  granny_flat: 0.02,
  corner_block: 0.005,
  main_road: -0.03,
  near_powerlines: -0.02,
  mature_trees: 0.005,
};

function featureAsymmetryFactor(
  subjectFeatures: VisualFeature[],
  compFeatures: VisualFeature[],
): number {
  const subj = new Set(subjectFeatures);
  const comp = new Set(compFeatures);
  let delta = 0;
  // Features present only on subject → uplift subject.
  for (const f of subj) {
    if (!comp.has(f)) delta += FEATURE_WEIGHTS[f] ?? 0;
  }
  // Features present only on comp → discount subject (comp's sale
  // price carried a premium that subject doesn't match).
  for (const f of comp) {
    if (!subj.has(f)) delta -= FEATURE_WEIGHTS[f] ?? 0;
  }
  // Cap the feature stack so pool + view + renovation don't compound
  // beyond ±6%.
  return 1 + clamp(delta, -0.06, 0.06);
}

/**
 * Returns true if the comparable's land OR floor area is >50% different
 * from the subject — an obvious structural mismatch (double-storey vs
 * single-storey, or a tiny townhouse lumped in with standalone houses).
 * If either dimension is missing on either side we do NOT drop — the
 * heuristic adjustment handles the partial-info case.
 */
export function isSizeMismatched(
  subject: PropertyDetails,
  comp: Comparable,
): boolean {
  if (subject.landAreaSqm && comp.landAreaSqm) {
    const ratio = comp.landAreaSqm / subject.landAreaSqm;
    if (ratio > SIZE_MISMATCH_UPPER || ratio < SIZE_MISMATCH_LOWER) return true;
  }
  if (subject.floorAreaSqm && comp.floorAreaSqm) {
    const ratio = comp.floorAreaSqm / subject.floorAreaSqm;
    if (ratio > SIZE_MISMATCH_UPPER || ratio < SIZE_MISMATCH_LOWER) return true;
  }
  return false;
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
    subject.floorAreaSqm &&
    comp.floorAreaSqm &&
    Math.abs(comp.floorAreaSqm / subject.floorAreaSqm - 1) > 0.3
  ) {
    flags.push('floor area variance');
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
): { kept: Comparable[]; droppedMismatched: Comparable[] } {
  const kept: Comparable[] = [];
  const droppedMismatched: Comparable[] = [];
  for (const c of comparables) {
    const months = monthsBetween(c.saleDateIso, nowIso);
    if (months > MAX_COMPARABLE_AGE_MONTHS) continue;
    if (
      c.propertyType &&
      subject.propertyType &&
      c.propertyType !== subject.propertyType
    ) {
      continue;
    }
    if (isSizeMismatched(subject, c)) {
      droppedMismatched.push(c);
      continue;
    }
    kept.push(c);
  }
  return { kept, droppedMismatched };
}

export function computeCMA(
  subject: PropertyDetails,
  comparables: Comparable[],
  market: MarketContext,
  nowIso: string = new Date().toISOString(),
): CMAResult {
  const { kept, droppedMismatched } = filterComparables(
    comparables,
    subject,
    nowIso,
  );
  const notes: string[] = [];

  if (droppedMismatched.length > 0) {
    notes.push(
      `Excluded ${droppedMismatched.length} comparable(s) with land or floor area more than 50% different from the subject (likely single-vs-double-storey mismatch).`,
    );
  }

  if (kept.length < MIN_COMPARABLES) {
    notes.push(
      `Only ${kept.length} comparable(s) within ${MAX_COMPARABLE_AGE_MONTHS} months after size filtering; minimum ${MIN_COMPARABLES} required.`,
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

  const derived: ComparableWithDerived[] = kept.map((c) => {
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
