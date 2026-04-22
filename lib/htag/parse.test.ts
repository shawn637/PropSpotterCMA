import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSubjectProperty,
  HtagParseError,
  parseAustralianAddress,
  parseStandardiseResult,
  pickNumber,
  pickString,
  unwrapBatchResult,
} from './parse';

// ---------------------------------------------------------------------------
// unwrapBatchResult: batch endpoints can return several shapes.
// ---------------------------------------------------------------------------

test('unwrapBatchResult: bare array -> first element', () => {
  const r = unwrapBatchResult([{ a: 1 }, { a: 2 }], '/test');
  assert.deepEqual(r, { a: 1 });
});

test('unwrapBatchResult: {results: [...]} -> first element', () => {
  const r = unwrapBatchResult({ results: [{ a: 1 }] }, '/test');
  assert.deepEqual(r, { a: 1 });
});

test('unwrapBatchResult: {addresses: [...]} -> first element', () => {
  const r = unwrapBatchResult({ addresses: [{ a: 1 }] }, '/test');
  assert.deepEqual(r, { a: 1 });
});

test('unwrapBatchResult: flat single object passes through', () => {
  const r = unwrapBatchResult({ address_key: 'x' }, '/test');
  assert.deepEqual(r, { address_key: 'x' });
});

test('unwrapBatchResult: empty array throws', () => {
  assert.throws(() => unwrapBatchResult([], '/test'), HtagParseError);
});

test('unwrapBatchResult: primitive throws', () => {
  assert.throws(() => unwrapBatchResult('nope' as unknown, '/test'), HtagParseError);
});

// ---------------------------------------------------------------------------
// pickString / pickNumber: multi-name field lookup.
// ---------------------------------------------------------------------------

test('pickString returns first present non-empty string', () => {
  assert.equal(pickString({ a: '', b: 'yes', c: 'no' }, 'a', 'b', 'c'), 'yes');
});

test('pickString returns undefined when none present', () => {
  assert.equal(pickString({ a: 1, b: null }, 'a', 'b'), undefined);
});

test('pickNumber returns first finite number', () => {
  assert.equal(pickNumber({ a: NaN, b: 42 }, 'a', 'b'), 42);
});

// ---------------------------------------------------------------------------
// parseAustralianAddress: regex-driven fallback.
// ---------------------------------------------------------------------------

test('parseAustralianAddress: full canonical format', () => {
  const r = parseAustralianAddress('413 Anson Street, Orange, NSW 2800');
  assert.deepEqual(r, { suburb: 'Orange', state: 'NSW', postcode: '2800' });
});

test('parseAustralianAddress: multi-word suburb + lowercase state', () => {
  const r = parseAustralianAddress(
    '42 Example Street, Baulkham Hills, nsw 2153',
  );
  assert.deepEqual(r, {
    suburb: 'Baulkham Hills',
    state: 'NSW',
    postcode: '2153',
  });
});

test('parseAustralianAddress: unit + VIC', () => {
  const r = parseAustralianAddress('12/15 Demo Road, South Yarra, VIC 3141');
  assert.equal(r.suburb, 'South Yarra');
  assert.equal(r.state, 'VIC');
  assert.equal(r.postcode, '3141');
});

test('parseAustralianAddress: non-canonical returns empty object', () => {
  assert.deepEqual(parseAustralianAddress('just a sentence'), {});
});

test('parseAustralianAddress: undefined input is safe', () => {
  assert.deepEqual(parseAustralianAddress(undefined), {});
});

// ---------------------------------------------------------------------------
// parseStandardiseResult: actual HTAG shape we hit on 2026-04-22, plus
// a couple of hypothetical variants.
// ---------------------------------------------------------------------------

test('parseStandardiseResult: actual HTAG live shape', () => {
  // This is the shape we saw come back from HTAG for Shawn's Orange NSW
  // address. Keys: [input_address, address_key, standardised_address, error].
  const raw = {
    input_address: '413 Anson Street, Orange, NSW 2800',
    address_key: 'NSW-ORA-ANS-413',
    standardised_address: '413 Anson Street, Orange, NSW 2800',
    error: null,
  };
  const r = parseStandardiseResult(raw);
  assert.equal(r.addressKey, 'NSW-ORA-ANS-413');
  assert.equal(r.fullAddress, '413 Anson Street, Orange, NSW 2800');
  // standardise doesn't include these on this variant.
  assert.equal(r.suburb, undefined);
  assert.equal(r.state, undefined);
  assert.equal(r.postcode, undefined);
  assert.equal(r.locPid, undefined);
});

test('parseStandardiseResult: alt shape with formatted_address + loc_pid', () => {
  const raw = {
    address_key: 'K1',
    formatted_address: '42 Example St, Baulkham Hills, NSW 2153',
    suburb: 'Baulkham Hills',
    state: 'NSW',
    postcode: '2153',
    loc_pid: 'NSW231',
  };
  const r = parseStandardiseResult(raw);
  assert.equal(r.addressKey, 'K1');
  assert.equal(r.fullAddress, '42 Example St, Baulkham Hills, NSW 2153');
  assert.equal(r.suburb, 'Baulkham Hills');
  assert.equal(r.locPid, 'NSW231');
});

test('parseStandardiseResult: propagates HTAG error field', () => {
  assert.throws(
    () =>
      parseStandardiseResult({
        input_address: 'garbage',
        address_key: 'x',
        standardised_address: 'garbage',
        error: 'address not found',
      }),
    /address not found/,
  );
});

test('parseStandardiseResult: missing address_key throws with visible keys', () => {
  assert.throws(
    () => parseStandardiseResult({ standardised_address: '...' }),
    /address_key.*keys: \[standardised_address\]/,
  );
});

// ---------------------------------------------------------------------------
// buildSubjectProperty: merges standardise + summary + parsed-address
// fallback into a PropertyDetails.
// ---------------------------------------------------------------------------

test('buildSubjectProperty: fills suburb/state/postcode from parsed address when neither standardise nor summary has them', () => {
  const standardise = parseStandardiseResult({
    input_address: '413 Anson Street, Orange, NSW 2800',
    address_key: 'NSW-ORA-ANS-413',
    standardised_address: '413 Anson Street, Orange, NSW 2800',
    error: null,
  });
  const summary = {
    land_area_sqm: 710,
    bedrooms: 3,
    bathrooms: 1,
    car_spaces: 2,
    year_built: 1962,
    property_type: 'House',
    loc_pid: 'NSW-ORA',
  };
  const subject = buildSubjectProperty({
    standardise,
    summary,
    endpoint: '/v1/property/NSW-ORA-ANS-413/summary',
  });
  assert.equal(subject.suburb, 'Orange');
  assert.equal(subject.state, 'NSW');
  assert.equal(subject.postcode, '2800');
  assert.equal(subject.locPid, 'NSW-ORA');
  assert.equal(subject.landAreaSqm, 710);
  assert.equal(subject.bedrooms, 3);
  assert.equal(subject.propertyType, 'House');
});

test('buildSubjectProperty: prefers structured summary fields over parsed address', () => {
  const standardise = parseStandardiseResult({
    input_address: '42 Demo, Somewhere, NSW 2000',
    address_key: 'K',
    standardised_address: '42 Demo, Somewhere, NSW 2000',
    error: null,
  });
  // Summary says Sydney, address says Somewhere — summary wins.
  const summary = {
    suburb: 'Sydney',
    state: 'NSW',
    postcode: '2000',
    loc_pid: 'NSW-SYD',
  };
  const subject = buildSubjectProperty({
    standardise,
    summary,
    endpoint: '/v1/property/K/summary',
  });
  assert.equal(subject.suburb, 'Sydney');
});

test('buildSubjectProperty: tolerates alternate loc_pid field names', () => {
  const standardise = parseStandardiseResult({
    input_address: '1 Test, Orange, NSW 2800',
    address_key: 'K',
    standardised_address: '1 Test, Orange, NSW 2800',
    error: null,
  });
  const summary = { locality_id: 'NSW-ORA-ALT' };
  const subject = buildSubjectProperty({
    standardise,
    summary,
    endpoint: '/v1/property/K/summary',
  });
  assert.equal(subject.locPid, 'NSW-ORA-ALT');
});

test('buildSubjectProperty: throws with actionable diagnostic when locPid is unresolvable', () => {
  const standardise = parseStandardiseResult({
    input_address: 'not an address',
    address_key: 'K',
    standardised_address: 'not an address',
    error: null,
  });
  assert.throws(
    () =>
      buildSubjectProperty({
        standardise,
        summary: {},
        endpoint: '/v1/property/K/summary',
      }),
    /suburb, state, postcode, locPid/,
  );
});
