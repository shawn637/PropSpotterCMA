import { test } from 'node:test';
import assert from 'node:assert/strict';

import { G02ParseError, parseG02Response } from './g02';

test('parseG02Response: populated SA1 → all medians surfaced', () => {
  const response = {
    features: [
      {
        attributes: {
          SA1_CODE_2021: '21501138622',
          Median_age_persons: 38,
          Median_tot_hhd_inc_weekly: 1850,
          Median_tot_prsnl_inc_weekly: 920,
          Median_rent_weekly: 520,
          Median_mortgage_repay_monthly: 2400,
          Average_household_size: 2.7,
        },
      },
    ],
  };
  const d = parseG02Response(response);
  assert.ok(d);
  assert.equal(d!.sa1Code, '21501138622');
  assert.equal(d!.medianAge, 38);
  assert.equal(d!.medianHouseholdIncomeWeekly, 1850);
  assert.equal(d!.medianPersonalIncomeWeekly, 920);
  assert.equal(d!.medianRentWeekly, 520);
  assert.equal(d!.medianMortgageMonthly, 2400);
  assert.equal(d!.averageHouseholdSize, 2.7);
});

test('parseG02Response: accepts shorthand field naming', () => {
  const response = {
    features: [
      {
        attributes: {
          SA1_CODE_2021: '21501138622',
          Median_hhd_inc_wk: 1850,
          Median_rent_wk: 520,
          Median_mortg_mthly: 2400,
          Avg_hhd_size: 2.7,
        },
      },
    ],
  };
  const d = parseG02Response(response);
  assert.ok(d);
  assert.equal(d!.medianHouseholdIncomeWeekly, 1850);
  assert.equal(d!.medianRentWeekly, 520);
  assert.equal(d!.medianMortgageMonthly, 2400);
  assert.equal(d!.averageHouseholdSize, 2.7);
});

test('parseG02Response: partial data still returns a profile', () => {
  const response = {
    features: [
      {
        attributes: {
          SA1_CODE_2021: '21501138622',
          Median_tot_hhd_inc_weekly: 1850,
          // only income present — every other field missing
        },
      },
    ],
  };
  const d = parseG02Response(response);
  assert.ok(d);
  assert.equal(d!.medianHouseholdIncomeWeekly, 1850);
  assert.equal(d!.medianRentWeekly, undefined);
  assert.equal(d!.medianMortgageMonthly, undefined);
});

test('parseG02Response: all fields missing → null (empty SA1)', () => {
  const response = {
    features: [{ attributes: { SA1_CODE_2021: '90000000001' } }],
  };
  assert.equal(parseG02Response(response), null);
});

test('parseG02Response: empty features[] → null', () => {
  assert.equal(parseG02Response({ features: [] }), null);
});

test('parseG02Response: ArcGIS error envelope → throws', () => {
  assert.throws(
    () => parseG02Response({ error: { code: 400, message: 'Bad request' } }),
    G02ParseError,
  );
});

test('parseG02Response: missing SA1 code → throws with key list', () => {
  const response = {
    features: [
      {
        attributes: { Median_tot_hhd_inc_weekly: 1850 },
      },
    ],
  };
  assert.throws(
    () => parseG02Response(response),
    (err: unknown) =>
      err instanceof G02ParseError && err.message.includes('SA1'),
  );
});

test('parseG02Response: numeric-string fields coerced', () => {
  const response = {
    features: [
      {
        attributes: {
          SA1_CODE_2021: '21501138622',
          Median_tot_hhd_inc_weekly: '1850',
          Median_rent_weekly: '520',
        },
      },
    ],
  };
  const d = parseG02Response(response);
  assert.ok(d);
  assert.equal(d!.medianHouseholdIncomeWeekly, 1850);
  assert.equal(d!.medianRentWeekly, 520);
});
