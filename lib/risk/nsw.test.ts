import { test } from 'node:test';
import assert from 'node:assert/strict';

import { _internals } from './nsw';

const { interpretBushfireCategory, interpretFloodZone, hazardRank } = _internals;

// ---------------------------------------------------------------------------
// interpretBushfireCategory — NSW BPLM category mapping
// ---------------------------------------------------------------------------

test('interpretBushfireCategory: Category 1 → high', () => {
  const r = interpretBushfireCategory({ Category: 'Category 1' });
  assert.deepEqual(r, {
    level: 'high',
    zone: 'Bush Fire Prone Category 1',
  });
});

test('interpretBushfireCategory: Category 2 → moderate', () => {
  const r = interpretBushfireCategory({ CATEGORY: 'CAT 2' });
  assert.equal(r?.level, 'moderate');
});

test('interpretBushfireCategory: Category 3 → low', () => {
  const r = interpretBushfireCategory({ category: 'category 3' });
  assert.equal(r?.level, 'low');
});

test('interpretBushfireCategory: Buffer → low', () => {
  const r = interpretBushfireCategory({ CATEGORY: 'Vegetation Buffer' });
  assert.equal(r?.level, 'low');
});

test('interpretBushfireCategory: numeric "1" is treated as Cat 1', () => {
  const r = interpretBushfireCategory({ Category: 1 });
  assert.equal(r?.level, 'high');
});

test('interpretBushfireCategory: unrecognised category → moderate fallback', () => {
  const r = interpretBushfireCategory({ Category: 'Custom Class X' });
  assert.equal(r?.level, 'moderate');
  assert.match(r?.zone ?? '', /Custom Class X/);
});

test('interpretBushfireCategory: no category field → null', () => {
  assert.equal(interpretBushfireCategory({}), null);
  assert.equal(interpretBushfireCategory({ OBJECTID: 1 }), null);
});

// ---------------------------------------------------------------------------
// interpretFloodZone — NSW flood planning area mapping
// ---------------------------------------------------------------------------

test('interpretFloodZone: Floodway → extreme', () => {
  const r = interpretFloodZone({ Flood_Type: 'Floodway' });
  assert.equal(r?.level, 'extreme');
});

test('interpretFloodZone: 1% AEP / high hazard → high', () => {
  const r = interpretFloodZone({ Flood_Type: 'High Hazard' });
  assert.equal(r?.level, 'high');
  const r2 = interpretFloodZone({ FLOOD_TYPE: '1% AEP Design' });
  assert.equal(r2?.level, 'high');
});

test('interpretFloodZone: Flood Planning Area → moderate', () => {
  const r = interpretFloodZone({ flood_type: 'Flood Planning Area' });
  assert.equal(r?.level, 'moderate');
});

test('interpretFloodZone: Flood fringe → moderate', () => {
  const r = interpretFloodZone({ Classification: 'Flood Fringe' });
  assert.equal(r?.level, 'moderate');
});

test('interpretFloodZone: unrecognised → moderate fallback (still inside FPA)', () => {
  const r = interpretFloodZone({ Type: 'Custom FPA Class' });
  assert.equal(r?.level, 'moderate');
});

test('interpretFloodZone: no classification field → null', () => {
  assert.equal(interpretFloodZone({}), null);
});

// ---------------------------------------------------------------------------
// hazardRank — sort ordering
// ---------------------------------------------------------------------------

test('hazardRank: extreme > high > moderate > low > none > unknown', () => {
  assert.ok(hazardRank('extreme') > hazardRank('high'));
  assert.ok(hazardRank('high') > hazardRank('moderate'));
  assert.ok(hazardRank('moderate') > hazardRank('low'));
  assert.ok(hazardRank('low') > hazardRank('none'));
  assert.ok(hazardRank('none') > hazardRank('unknown'));
});
