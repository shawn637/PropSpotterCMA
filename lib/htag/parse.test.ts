import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PropertyDetails } from '@/lib/types';

import {
  HtagParseError,
  buildMarketContext,
  firstResult,
  mapCycleString,
  parseGeocode,
  parseMarketCycle,
  parseMarketDemand,
  parseMarketGrowthAnnualised,
  parseMarketSummary,
  parsePropertySummary,
  parseSoldSearch,
  resultArray,
} from './parse';

// ---------------------------------------------------------------------------
// Fixtures — shapes taken directly from the HTAG OpenAPI spec examples.
// These match AddressGeocodeRecord, AddressPropertyRecord, PropertySoldRecord,
// MarketSummaryRecord, MarketGrowthAnnualisedRecord, MarketCycleRecord, and
// MarketDemandRecord. If the live API matches its documentation, the parse
// path is proven green here without needing an HTAG API key.
// ---------------------------------------------------------------------------

const geocodeFixture = {
  results: [
    {
      address_key: '413ANSONSTREETORANGENSW2800',
      gnaf_property_pid: 'GANSW711234567',
      legal_parcel_id: '1\\DP123456',
      loc_pid: 'NSW-ORA-ANS',
      lga_pid: 'NSW-ORA',
      sa2_code21: '108041234',
      sa4_name21: 'Central West',
      gcc_name21: 'Rest of NSW',
      mb_category: 'Residential',
      lat: -33.2831,
      lon: 149.1 ,
      address_label: '413 Anson Street, Orange NSW 2800',
      number_first: '413',
      street_name: 'Anson',
      street_type: 'Street',
      locality_name: 'Orange',
      state: 'NSW',
      postcode: '2800',
      score: 0.98,
    },
  ],
  total: 1,
};

const propertySummaryFixture = {
  results: [
    {
      address_key: '413ANSONSTREETORANGENSW2800',
      property_type: 'house',
      beds: 3,
      baths: 2,
      parking: 2,
      lot_size: 650,
      floor_area: 180,
      build_reno_date: '1995-06-01',
      last_updated: '2026-04-01',
    },
  ],
  total: 1,
};

// Live HTAG shape — taken from an actual /v1/property/sold/search response
// for Stanhope Gardens NSW 2768 on 2026-04-22. Note the field names:
// `sold_price` / `sold_date` / `street_address` (NOT the `sale_price` /
// `sale_date` / `address` documented in the OpenAPI spec).
const soldSearchFixture = {
  total: 4,
  results: [
    {
      // Sentinel row #1: null sold_price — should be skipped.
      address_key: '7ROCHDALECIRCUITSTANHOPEGARDENSNSW2768',
      property_type: 'house',
      street_address: '7 Rochdale Circuit',
      suburb: 'Stanhope Gardens',
      state: 'NSW',
      postcode: '2768',
      sold_date: '2026-04-16',
      sold_price: null,
      bedrooms: 5,
      bathrooms: 2,
      car_spaces: 2,
      land_area: 520,
    },
    {
      address_key: '74BENTWOODTERRACESTANHOPEGARDENSNSW2768',
      property_type: 'house',
      street_address: '74 Bentwood Terrace',
      suburb: 'Stanhope Gardens',
      state: 'NSW',
      postcode: '2768',
      sold_date: '2026-04-14',
      sold_price: 1620300,
      bedrooms: 5,
      bathrooms: 3,
      car_spaces: 2,
      land_area: null,
    },
    {
      // Dedup pair part 1.
      address_key: '18SPICEBUSHGLADESTANHOPEGARDENSNSW2768',
      property_type: 'house',
      street_address: '18 SPICEBUSH GLADE',
      suburb: 'Stanhope Gardens',
      state: 'NSW',
      postcode: '2768',
      sold_date: '2026-02-18',
      sold_price: 1432000,
      bedrooms: 4,
      bathrooms: 2,
      car_spaces: 2,
      land_area: 411,
    },
    {
      // Dedup pair part 2 — same physical sale, different address_key
      // (street type spelt as "Gld" instead of "Glade").
      address_key: '18SPICEBUSHGLDSTANHOPEGARDENSNSW2768',
      property_type: 'house',
      street_address: '18 Spicebush Gld',
      suburb: 'Stanhope Gardens',
      state: 'NSW',
      postcode: '2768',
      sold_date: '2026-02-18',
      sold_price: 1432000,
      bedrooms: 4,
      bathrooms: 2,
      car_spaces: 2,
      land_area: 410,
    },
  ],
};

// The shape the OpenAPI spec documents but the live API does NOT return.
// Kept as a test fixture so the parser still works if HTAG ever ships the
// documented field names.
const soldSearchSpecFixture = {
  results: [
    {
      address: '8 Example Street, Orange NSW 2800',
      address_key: '8EXAMPLESTREETORANGENSW2800',
      sale_price: 705000,
      sale_date: '2026-02-14',
      property_type: 'house',
      bedrooms: 3,
      distance_km: 0.4,
    },
  ],
  total: 1,
};

const marketSummaryFixture = {
  results: [
    {
      area_id: 'NSW-ORA-ANS',
      period_end: '2026-03-31',
      property_type: 'house',
      bedrooms: 'All',
      typical_price: 705000,
      rent: 450,
      gross_yield: 0.033,
      sales: 12,
      annual_sales_volume: 143,
      rentals: 8,
      annual_rental_volume: 92,
      estimated_dwellings: 5800,
      adult_population: 12500,
      confidence: 'High',
    },
  ],
  total: 1,
};

const marketGrowthAnnualisedFixture = {
  results: [
    {
      area_id: 'NSW-ORA-ANS',
      period_end: '2026-03-31',
      property_type: 'house',
      price_1y_growth_annualised: 0.063,
      price_3y_growth_annualised: 0.055,
      price_5y_growth_annualised: 0.072,
      price_10y_growth_annualised: 0.061,
      rent_5y_growth_annualised: 0.041,
      yield_5y_growth_annualised: 0.009,
    },
  ],
  total: 1,
};

const marketCycleFixture = {
  results: [
    {
      area_id: 'NSW-ORA-ANS',
      period_end: '2026-03-31',
      property_type: 'house',
      growth_rate_cycle: 'Rising',
      grc_price_index: 62,
      projected_annual_capital_growth_low: 0.04,
      projected_annual_capital_growth_high: 0.07,
    },
  ],
  total: 1,
};

const marketDemandFixture = {
  results: [
    {
      area_id: 'NSW-ORA-ANS',
      period_end: '2026-03-31',
      property_type: 'house',
      dom: 38,
      discounting: 0.031,
      vacancy_rate: 0.015,
      clearance_rate: 0.68,
    },
  ],
  total: 1,
};

// ---------------------------------------------------------------------------
// firstResult / resultArray — the response-unwrap helpers.
// ---------------------------------------------------------------------------

test('firstResult: {results:[obj]} → obj', () => {
  const r = firstResult({ results: [{ a: 1 }] }, '/test');
  assert.deepEqual(r, { a: 1 });
});

test('firstResult: bare array → first obj', () => {
  const r = firstResult([{ a: 1 }, { a: 2 }], '/test');
  assert.deepEqual(r, { a: 1 });
});

test('firstResult: flat single obj → passes through', () => {
  const r = firstResult({ a: 1 }, '/test');
  assert.deepEqual(r, { a: 1 });
});

test('firstResult: {results:[]} throws with endpoint in the message', () => {
  assert.throws(
    () => firstResult({ results: [] }, '/v1/property/summary'),
    /\/v1\/property\/summary.*\{ results: \[\] \}/,
  );
});

test('firstResult: non-object primitive throws', () => {
  assert.throws(() => firstResult('nope', '/test'), HtagParseError);
});

test('resultArray: {results:[...]} → array', () => {
  const r = resultArray({ results: [{ a: 1 }, { a: 2 }] }, '/test');
  assert.deepEqual(r, [{ a: 1 }, { a: 2 }]);
});

test('resultArray: bare array passes through', () => {
  const r = resultArray([{ a: 1 }], '/test');
  assert.deepEqual(r, [{ a: 1 }]);
});

test('resultArray: non-array response throws', () => {
  assert.throws(() => resultArray({ not: 'an array' }, '/test'), HtagParseError);
});

// ---------------------------------------------------------------------------
// parseGeocode — AddressGeocodeRecord
// ---------------------------------------------------------------------------

test('parseGeocode: extracts identity fields from spec fixture', () => {
  const r = parseGeocode(geocodeFixture);
  assert.equal(r.addressKey, '413ANSONSTREETORANGENSW2800');
  assert.equal(r.locPid, 'NSW-ORA-ANS');
  assert.equal(r.suburb, 'Orange');
  assert.equal(r.state, 'NSW');
  assert.equal(r.postcode, '2800');
  assert.equal(r.fullAddress, '413 Anson Street, Orange NSW 2800');
});

test('parseGeocode: synthesises fullAddress from parts when address_label is absent', () => {
  const fixture = {
    results: [
      {
        address_key: 'K',
        loc_pid: 'NSW-X',
        locality_name: 'Orange',
        state: 'NSW',
        postcode: '2800',
        number_first: '42',
        street_name: 'Example',
        street_type: 'Street',
      },
    ],
  };
  const r = parseGeocode(fixture);
  assert.equal(r.fullAddress, '42 Example Street, Orange, NSW 2800');
});

test('parseGeocode: missing loc_pid throws with actionable diagnostic', () => {
  const fixture = {
    results: [
      {
        address_key: 'K',
        locality_name: 'Orange',
        state: 'NSW',
        postcode: '2800',
        address_label: '...',
      },
    ],
  };
  assert.throws(
    () => parseGeocode(fixture),
    /loc_pid.*Got keys: \[address_key, locality_name, state, postcode, address_label\]/,
  );
});

test('parseGeocode: 0 results surfaces a clear empty-batch error', () => {
  assert.throws(
    () => parseGeocode({ results: [], total: 0 }),
    /returned \{ results: \[\] \}/,
  );
});

// ---------------------------------------------------------------------------
// parsePropertySummary — AddressPropertyRecord
// ---------------------------------------------------------------------------

test('parsePropertySummary: extracts all optional physical attributes', () => {
  const r = parsePropertySummary(propertySummaryFixture);
  assert.equal(r.bedrooms, 3);
  assert.equal(r.bathrooms, 2);
  assert.equal(r.carSpaces, 2);
  assert.equal(r.landAreaSqm, 650);
  assert.equal(r.floorAreaSqm, 180);
  assert.equal(r.yearBuilt, 1995);
  assert.equal(r.propertyType, 'House');
});

test('parsePropertySummary: missing attributes → undefined (no throw)', () => {
  const r = parsePropertySummary({
    results: [{ address_key: 'K' }],
  });
  assert.equal(r.bedrooms, undefined);
  assert.equal(r.propertyType, undefined);
});

test('parsePropertySummary: normalises unit/townhouse/apartment variants', () => {
  const cases: Array<[string, PropertyDetails['propertyType']]> = [
    ['unit', 'Unit'],
    ['Apartment', 'Unit'],
    ['townhouse', 'Townhouse'],
    ['Semi-detached', 'Townhouse'],
    ['acreage', 'Other'],
  ];
  for (const [raw, expected] of cases) {
    const r = parsePropertySummary({
      results: [{ address_key: 'K', property_type: raw }],
    });
    assert.equal(r.propertyType, expected, `for input ${raw}`);
  }
});

// ---------------------------------------------------------------------------
// parseSoldSearch — PropertySoldRecord
// ---------------------------------------------------------------------------

test('parseSoldSearch: live HTAG shape (sold_price/sold_date/street_address)', () => {
  const r = parseSoldSearch(soldSearchFixture);
  // 4 raw rows: 1 dropped (null sold_price), 1 deduped (same sale).
  assert.equal(r.length, 2, '4 raw → 1 null + 1 dedup → 2 valid');
  assert.equal(r[0].addressKey, '74BENTWOODTERRACESTANHOPEGARDENSNSW2768');
  assert.equal(
    r[0].fullAddress,
    '74 Bentwood Terrace, Stanhope Gardens, NSW 2768',
  );
  assert.equal(r[0].salePrice, 1620300);
  assert.equal(r[0].saleDateIso, '2026-04-14');
  assert.equal(r[0].bedrooms, 5);
  assert.equal(r[0].propertyType, 'House');
});

test('parseSoldSearch: dedups duplicate sales by (sold_price, sold_date)', () => {
  const r = parseSoldSearch(soldSearchFixture);
  const spicebush = r.filter((c) => c.salePrice === 1432000);
  assert.equal(spicebush.length, 1, '18 Spicebush GLADE/Gld merged into 1 row');
});

test('parseSoldSearch: backward-compat with documented spec field names', () => {
  // If HTAG ever ships the documented sale_price/sale_date/address shape,
  // we still parse it correctly.
  const r = parseSoldSearch(soldSearchSpecFixture);
  assert.equal(r.length, 1);
  assert.equal(r[0].fullAddress, '8 Example Street, Orange NSW 2800');
  assert.equal(r[0].salePrice, 705000);
  assert.equal(r[0].saleDateIso, '2026-02-14');
});

test('parseSoldSearch: empty results returns empty array', () => {
  const r = parseSoldSearch({ results: [], total: 0 });
  assert.deepEqual(r, []);
});

// ---------------------------------------------------------------------------
// parseMarketSummary / Growth / Cycle / Demand
// ---------------------------------------------------------------------------

test('parseMarketSummary: extracts typical_price', () => {
  const r = parseMarketSummary(marketSummaryFixture);
  assert.equal(r.typicalPrice, 705000);
});

test('parseMarketGrowthAnnualised: reads price_5y_growth_annualised', () => {
  const r = parseMarketGrowthAnnualised(marketGrowthAnnualisedFixture);
  assert.equal(r.annualisedGrowth5y, 0.072);
});

test('parseMarketGrowthAnnualised: scales down percentage values (>1 absolute)', () => {
  // HTAG may return "7.2" meaning 7.2% or "0.072" meaning 7.2% — the
  // parser should normalise either to a decimal fraction.
  const fixturePct = {
    results: [{ area_id: 'X', price_5y_growth_annualised: 7.2 }],
    total: 1,
  };
  const r = parseMarketGrowthAnnualised(fixturePct);
  // Floating-point: 7.2 / 100 = 0.07200000000000001. Within 1e-9 tolerance
  // is plenty given we only care to 0.1% in the CMA math anyway.
  assert.ok(
    Math.abs((r.annualisedGrowth5y ?? 0) - 0.072) < 1e-9,
    `expected ~0.072, got ${r.annualisedGrowth5y}`,
  );
});

test('parseMarketGrowthAnnualised: absent field → undefined', () => {
  const r = parseMarketGrowthAnnualised({ results: [{ area_id: 'X' }] });
  assert.equal(r.annualisedGrowth5y, undefined);
});

test('parseMarketCycle: maps Rising → Rising', () => {
  const r = parseMarketCycle(marketCycleFixture);
  assert.equal(r.cycleStage, 'Rising');
  assert.equal(r.cycleRaw, 'Rising');
});

test('parseMarketCycle: unknown cycle string → undefined (caller uses default)', () => {
  const r = parseMarketCycle({
    results: [{ area_id: 'X', growth_rate_cycle: 'Exuberant' }],
  });
  assert.equal(r.cycleStage, undefined);
  assert.equal(r.cycleRaw, 'Exuberant');
});

test('parseMarketDemand: reads dom', () => {
  const r = parseMarketDemand(marketDemandFixture);
  assert.equal(r.typicalDaysOnMarket, 38);
});

// ---------------------------------------------------------------------------
// mapCycleString — liberal matcher for HTAG terminology variants
// ---------------------------------------------------------------------------

test('mapCycleString: Recovery synonyms', () => {
  for (const s of ['Recovery', 'Trough', 'Bottom', 'recover']) {
    assert.equal(mapCycleString(s), 'Recovery', `for ${s}`);
  }
});

test('mapCycleString: Rising synonyms', () => {
  for (const s of ['Rising', 'Expansion', 'Upswing', 'Growth phase']) {
    assert.equal(mapCycleString(s), 'Rising', `for ${s}`);
  }
});

test('mapCycleString: Peaking synonyms (incl. live (+)Peak / (-)Peak)', () => {
  // HTAG decorates cycle strings with directional sign indicators in
  // the live API: '(+)Peak' = approaching peak from below,
  // '(-)Peak' = leaving peak. Both still map to Peaking.
  for (const s of ['Peak', 'Peaking', 'Plateau', '(+)Peak', '(-)Peak']) {
    assert.equal(mapCycleString(s), 'Peaking', `for ${s}`);
  }
});

test('mapCycleString: Correction synonyms', () => {
  for (const s of ['Correction', 'Contraction', 'Declining', 'Downturn', 'Cooling']) {
    assert.equal(mapCycleString(s), 'Correction', `for ${s}`);
  }
});

test('mapCycleString: unknown returns undefined', () => {
  assert.equal(mapCycleString('Interesting'), undefined);
  assert.equal(mapCycleString(''), undefined);
  assert.equal(mapCycleString(undefined), undefined);
});

// ---------------------------------------------------------------------------
// buildMarketContext — merges parts into MarketContext with safe defaults.
// ---------------------------------------------------------------------------

const fakeSubject: PropertyDetails = {
  addressKey: 'K',
  fullAddress: '...',
  suburb: 'Orange',
  state: 'NSW',
  postcode: '2800',
  locPid: 'NSW-ORA-ANS',
  propertyType: 'House',
};

test('buildMarketContext: all parts present → fully live MarketContext', () => {
  const ctx = buildMarketContext({
    subject: fakeSubject,
    parts: {
      typicalPrice: 705000,
      annualisedGrowth5y: 0.072,
      cycleStage: 'Rising',
      typicalDaysOnMarket: 38,
    },
    endpoint: '(merge)',
  });
  assert.equal(ctx.locPid, 'NSW-ORA-ANS');
  assert.equal(ctx.suburb, 'Orange');
  assert.equal(ctx.state, 'NSW');
  assert.equal(ctx.annualisedGrowth5y, 0.072);
  assert.equal(ctx.cycleStage, 'Rising');
  assert.equal(ctx.typicalDaysOnMarket, 38);
  assert.equal(ctx.typicalPrice, 705000);
});

test('buildMarketContext: missing parts fall back to conservative defaults', () => {
  const ctx = buildMarketContext({
    subject: fakeSubject,
    parts: {},
    endpoint: '(merge)',
  });
  assert.equal(ctx.annualisedGrowth5y, 0.04, 'default growth 4%');
  assert.equal(ctx.cycleStage, 'Peaking', 'default cycle Peaking (0% stretch)');
  assert.equal(ctx.typicalDaysOnMarket, 42, 'default DOM 42');
});

// ---------------------------------------------------------------------------
// Integration — the full Orange NSW 2800 flow end-to-end on fixtures.
// ---------------------------------------------------------------------------

test('integration: full live-shape flow produces a coherent subject + market context', () => {
  const geocode = parseGeocode(geocodeFixture);
  const summary = parsePropertySummary(propertySummaryFixture);

  const subject: PropertyDetails = {
    addressKey: geocode.addressKey,
    fullAddress: geocode.fullAddress,
    suburb: geocode.suburb,
    state: geocode.state,
    postcode: geocode.postcode,
    locPid: geocode.locPid,
    bedrooms: summary.bedrooms,
    bathrooms: summary.bathrooms,
    carSpaces: summary.carSpaces,
    landAreaSqm: summary.landAreaSqm,
    yearBuilt: summary.yearBuilt,
    propertyType: summary.propertyType,
  };

  assert.equal(subject.locPid, 'NSW-ORA-ANS');
  assert.equal(subject.bedrooms, 3);
  assert.equal(subject.landAreaSqm, 650);

  const comparables = parseSoldSearch(soldSearchFixture);
  assert.equal(comparables.length, 2);

  const market = buildMarketContext({
    subject,
    parts: {
      ...parseMarketSummary(marketSummaryFixture),
      ...parseMarketGrowthAnnualised(marketGrowthAnnualisedFixture),
      ...parseMarketCycle(marketCycleFixture),
      ...parseMarketDemand(marketDemandFixture),
    },
    endpoint: '(merge)',
  });

  assert.equal(market.cycleStage, 'Rising');
  assert.equal(market.annualisedGrowth5y, 0.072);
  assert.equal(market.typicalDaysOnMarket, 38);
  assert.equal(market.typicalPrice, 705000);
});
