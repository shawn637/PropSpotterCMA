import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  Comparable,
  PropertyDetails,
  MarketContext,
  VisionAttributes,
} from '@/lib/types';

import {
  computeCMA,
  deriveHeuristicAdjustment,
  deriveVisualAdjustment,
  filterComparables,
  isSizeMismatched,
} from './compute';

// ---------------------------------------------------------------------------
// Fixtures: a single-storey subject on 450sqm, ~180sqm floor, plus
// comparables that exercise the filter + adjustment.
// ---------------------------------------------------------------------------

const subject: PropertyDetails = {
  addressKey: 'SUBJECT',
  fullAddress: '51 Kentwell Cres, Stanhope Gardens NSW 2768',
  suburb: 'Stanhope Gardens',
  state: 'NSW',
  postcode: '2768',
  locPid: 'NSW3682',
  landAreaSqm: 450,
  floorAreaSqm: 180,
  bedrooms: 3,
  bathrooms: 2,
  carSpaces: 2,
  yearBuilt: 2005,
  propertyType: 'House',
};

const market: MarketContext = {
  locPid: 'NSW3682',
  suburb: 'Stanhope Gardens',
  state: 'NSW',
  annualisedGrowth5y: 0.07,
  cycleStage: 'Peaking',
  typicalDaysOnMarket: 60,
};

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

function makeComp(overrides: Partial<Comparable>): Comparable {
  return {
    addressKey: 'COMP',
    fullAddress: 'some address',
    salePrice: 1_500_000,
    saleDateIso: daysAgoIso(30),
    landAreaSqm: 450,
    floorAreaSqm: 180,
    bedrooms: 3,
    bathrooms: 2,
    carSpaces: 2,
    propertyType: 'House',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isSizeMismatched
// ---------------------------------------------------------------------------

test('isSizeMismatched: within 50% → not mismatched', () => {
  assert.equal(
    isSizeMismatched(
      subject,
      makeComp({ landAreaSqm: 500, floorAreaSqm: 200 }),
    ),
    false,
  );
});

test('isSizeMismatched: land 2x bigger → mismatched', () => {
  assert.equal(
    isSizeMismatched(subject, makeComp({ landAreaSqm: 1000 })),
    true,
  );
});

test('isSizeMismatched: floor area 2x bigger (double-storey) → mismatched', () => {
  // Classic double-storey-vs-single-storey case: same land, twice the
  // floor area. Should now be excluded rather than averaged in.
  assert.equal(
    isSizeMismatched(subject, makeComp({ floorAreaSqm: 380 })),
    true,
  );
});

test('isSizeMismatched: floor area missing → does not trigger drop', () => {
  // Absence of data isn't proof of mismatch; let the heuristic handle it.
  assert.equal(
    isSizeMismatched(subject, makeComp({ floorAreaSqm: undefined })),
    false,
  );
});

// ---------------------------------------------------------------------------
// deriveHeuristicAdjustment — floor area leg
// ---------------------------------------------------------------------------

test('deriveHeuristicAdjustment: identical comparable → factor 1.0', () => {
  const f = deriveHeuristicAdjustment(subject, makeComp({}));
  assert.ok(Math.abs(f - 1) < 1e-6);
});

test('deriveHeuristicAdjustment: larger floor area → factor < 1 (comp overstates subject)', () => {
  // Subject 180, comp 250 (still within the 1.5x mismatch gate).
  const f = deriveHeuristicAdjustment(
    subject,
    makeComp({ floorAreaSqm: 250 }),
  );
  assert.ok(f < 1, `expected factor < 1, got ${f}`);
});

test('deriveHeuristicAdjustment: smaller floor area → factor > 1 (comp understates subject)', () => {
  const f = deriveHeuristicAdjustment(
    subject,
    makeComp({ floorAreaSqm: 140 }),
  );
  assert.ok(f > 1, `expected factor > 1, got ${f}`);
});

test('deriveHeuristicAdjustment: clamped to [0.75, 1.25]', () => {
  const f = deriveHeuristicAdjustment(
    subject,
    makeComp({
      landAreaSqm: 450, // inside mismatch gate
      floorAreaSqm: 250, // within gate
      bedrooms: 6,
      bathrooms: 4,
      carSpaces: 4,
      yearBuilt: 1950,
    }),
  );
  assert.ok(f >= 0.75 && f <= 1.25, `factor ${f} must be in [0.75, 1.25]`);
});

// ---------------------------------------------------------------------------
// filterComparables — new mismatched-set return shape
// ---------------------------------------------------------------------------

test('filterComparables: splits mismatched into dropped set', () => {
  const now = new Date().toISOString();
  const result = filterComparables(
    [
      makeComp({ addressKey: 'OK', floorAreaSqm: 200 }),
      makeComp({ addressKey: 'DBL_STOREY', floorAreaSqm: 400 }),
      makeComp({ addressKey: 'OK2', floorAreaSqm: 170 }),
    ],
    subject,
    now,
  );
  assert.equal(result.kept.length, 2);
  assert.equal(result.droppedMismatched.length, 1);
  assert.equal(result.droppedMismatched[0].addressKey, 'DBL_STOREY');
});

test('filterComparables: age > 6 months → silently dropped (not in mismatched)', () => {
  const now = new Date().toISOString();
  const result = filterComparables(
    [makeComp({ saleDateIso: daysAgoIso(240) })],
    subject,
    now,
  );
  assert.equal(result.kept.length, 0);
  assert.equal(result.droppedMismatched.length, 0);
});

// ---------------------------------------------------------------------------
// computeCMA — integration
// ---------------------------------------------------------------------------

test('computeCMA: mismatched comps excluded, notes record the exclusion', () => {
  const comparables: Comparable[] = [
    makeComp({ addressKey: 'A', salePrice: 1_500_000, floorAreaSqm: 180 }),
    makeComp({ addressKey: 'B', salePrice: 1_550_000, floorAreaSqm: 190 }),
    makeComp({ addressKey: 'C', salePrice: 1_480_000, floorAreaSqm: 170 }),
    // Double-storey outlier — would swing the median if included.
    makeComp({
      addressKey: 'DBL',
      salePrice: 2_400_000,
      floorAreaSqm: 400,
    }),
  ];
  const cma = computeCMA(subject, comparables, market);
  assert.equal(cma.comparables.length, 3, 'double-storey outlier excluded');
  assert.ok(
    cma.notes.some((n) => n.includes('Excluded 1 comparable')),
    `notes must call out the exclusion; got ${JSON.stringify(cma.notes)}`,
  );
  // Sanity: median should be close to $1.5M, not pulled toward $2.4M.
  assert.ok(
    cma.fairValue < 1_700_000,
    `fairValue ${cma.fairValue} should not be inflated by the excluded double-storey`,
  );
});

// ---------------------------------------------------------------------------
// deriveVisualAdjustment — Claude Vision leg
// ---------------------------------------------------------------------------

function visionAttrs(overrides: Partial<VisionAttributes> = {}): VisionAttributes {
  return {
    storeys: 'single',
    constructionMaterial: 'brick',
    conditionGrade: 'average',
    kitchenCondition: 'average',
    bathroomCondition: 'average',
    landQuality: 'basic',
    backyardSize: 'medium',
    features: [],
    roofType: 'tile',
    notes: '',
    imageUrls: ['https://example.com/img.jpg'],
    ...overrides,
  };
}

test('deriveVisualAdjustment: missing vision attrs on either side → factor 1', () => {
  assert.equal(deriveVisualAdjustment(undefined, visionAttrs()), 1);
  assert.equal(deriveVisualAdjustment(visionAttrs(), undefined), 1);
  assert.equal(deriveVisualAdjustment(undefined, undefined), 1);
});

test('deriveVisualAdjustment: identical attrs → factor 1', () => {
  const f = deriveVisualAdjustment(visionAttrs(), visionAttrs());
  assert.equal(f, 1);
});

test('deriveVisualAdjustment: single-storey subject vs double-storey comp → factor < 1', () => {
  // Comp is structurally better (bigger) → its sale price overstates
  // the subject's value, so the adjustment brings it DOWN.
  const subject = visionAttrs({ storeys: 'single' });
  const comp = visionAttrs({ storeys: 'double' });
  const f = deriveVisualAdjustment(subject, comp);
  assert.ok(f < 1, `expected factor < 1, got ${f}`);
  // Within the ±8% storey cap.
  assert.ok(f >= 0.92);
});

test('deriveVisualAdjustment: renovated subject vs poor comp → factor > 1', () => {
  const subject = visionAttrs({ conditionGrade: 'renovated' });
  const comp = visionAttrs({ conditionGrade: 'poor' });
  const f = deriveVisualAdjustment(subject, comp);
  assert.ok(f > 1, `expected factor > 1, got ${f}`);
});

test('deriveVisualAdjustment: brick subject vs fibro comp → factor > 1', () => {
  const subject = visionAttrs({ constructionMaterial: 'brick' });
  const comp = visionAttrs({ constructionMaterial: 'fibro' });
  const f = deriveVisualAdjustment(subject, comp);
  assert.ok(f > 1, `expected factor > 1, got ${f}`);
});

test('deriveVisualAdjustment: worst-case composite stays clamped to [0.80, 1.20]', () => {
  // Comp has everything subject doesn't: better storey, material,
  // condition, kitchen, bathroom, land, backyard, plus a pool and a
  // view.
  const subject = visionAttrs({
    storeys: 'single',
    constructionMaterial: 'fibro',
    conditionGrade: 'poor',
    kitchenCondition: 'poor',
    bathroomCondition: 'poor',
    landQuality: 'neglected',
    backyardSize: 'none',
    features: ['main_road'],
  });
  const comp = visionAttrs({
    storeys: 'double',
    constructionMaterial: 'brick',
    conditionGrade: 'new',
    kitchenCondition: 'new',
    bathroomCondition: 'new',
    landQuality: 'premium',
    backyardSize: 'large',
    features: ['pool', 'view', 'renovation'],
  });
  const f = deriveVisualAdjustment(subject, comp);
  assert.ok(f >= 0.8 && f <= 1.2, `factor ${f} must be clamped to [0.80, 1.20]`);
  assert.ok(f < 1, 'better comp discounts implied value');
});

test('deriveVisualAdjustment: renovated kitchen subject vs poor kitchen comp → factor > 1', () => {
  const subject = visionAttrs({ kitchenCondition: 'renovated' });
  const comp = visionAttrs({ kitchenCondition: 'poor' });
  const f = deriveVisualAdjustment(subject, comp);
  assert.ok(f > 1, `expected factor > 1, got ${f}`);
});

test('deriveVisualAdjustment: not_visible kitchen on either side → kitchen leg skipped', () => {
  // Kitchen leg should go neutral when we lack the photo; the rest of
  // the visionAttrs defaults are equal so overall factor must be 1.
  const f = deriveVisualAdjustment(
    visionAttrs({ kitchenCondition: 'not_visible' }),
    visionAttrs({ kitchenCondition: 'new' }),
  );
  assert.equal(f, 1);
});

test('deriveVisualAdjustment: subject with pool vs comp without → factor > 1', () => {
  const subject = visionAttrs({ features: ['pool'] });
  const comp = visionAttrs({ features: [] });
  const f = deriveVisualAdjustment(subject, comp);
  assert.ok(f > 1, `expected uplift for subject-only pool, got ${f}`);
});

test('deriveVisualAdjustment: shared pool feature cancels out', () => {
  // Both have a pool; everything else equal. Factor should be 1.
  const f = deriveVisualAdjustment(
    visionAttrs({ features: ['pool'] }),
    visionAttrs({ features: ['pool'] }),
  );
  assert.equal(f, 1);
});

test('deriveVisualAdjustment: subject on a main road takes a drag', () => {
  const subject = visionAttrs({ features: ['main_road'] });
  const comp = visionAttrs({ features: [] });
  const f = deriveVisualAdjustment(subject, comp);
  assert.ok(f < 1, `expected discount for main-road subject, got ${f}`);
});

test('deriveVisualAdjustment: premium landscaped subject vs neglected comp → factor > 1', () => {
  const subject = visionAttrs({ landQuality: 'premium' });
  const comp = visionAttrs({ landQuality: 'neglected' });
  const f = deriveVisualAdjustment(subject, comp);
  assert.ok(f > 1, `expected uplift for better landscaping, got ${f}`);
});

test('deriveVisualAdjustment: unknown storey / material / condition → neutral', () => {
  const f = deriveVisualAdjustment(
    visionAttrs({
      storeys: 'unknown',
      constructionMaterial: 'unknown',
      conditionGrade: 'unknown',
    }),
    visionAttrs({
      storeys: 'unknown',
      constructionMaterial: 'unknown',
      conditionGrade: 'unknown',
    }),
  );
  assert.equal(f, 1);
});

test('deriveHeuristicAdjustment: visual leg multiplies through and respects final clamp', () => {
  const subjectWithVision: PropertyDetails = {
    ...subject,
    visionAttrs: visionAttrs({
      storeys: 'single',
      constructionMaterial: 'brick',
      conditionGrade: 'renovated',
    }),
  };
  const compMatch = makeComp({
    floorAreaSqm: 180,
    visionAttrs: visionAttrs({
      storeys: 'double',
      constructionMaterial: 'fibro',
      conditionGrade: 'poor',
    }),
  });
  const f = deriveHeuristicAdjustment(subjectWithVision, compMatch);
  // Subject meaningfully better than comp on 3 visual axes, so factor
  // should be > 1 (uplift implied from the cheaper comp's sale price).
  assert.ok(f > 1, `expected uplift, got ${f}`);
  // And still within the widened [0.7, 1.3] total clamp.
  assert.ok(f <= 1.3);
});

test('computeCMA: returns zeros + notes when fewer than 3 comps survive filter', () => {
  const cma = computeCMA(
    subject,
    [
      // All mismatched.
      makeComp({ addressKey: 'A', floorAreaSqm: 400 }),
      makeComp({ addressKey: 'B', floorAreaSqm: 50 }),
    ],
    market,
  );
  assert.equal(cma.fairValue, 0);
  assert.equal(cma.comparables.length, 0);
  assert.ok(cma.notes.some((n) => n.includes('minimum')));
});
