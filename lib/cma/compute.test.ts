import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Comparable, PropertyDetails, MarketContext } from '@/lib/types';

import {
  computeCMA,
  deriveHeuristicAdjustment,
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
