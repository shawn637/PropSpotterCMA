import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AbsParseError, parseG37SA1Response } from './parse';

// Representative SA1 response shape. Counts are from a real-ish
// suburban Blacktown SA1 — 140 dwellings total, roughly 57% owner
// occupied, 28% private rental, 10% public housing, 5% other.
const blacktownSA1 = {
  features: [
    {
      attributes: {
        SA1_CODE_2021: '21501138622',
        Tot_Total: 140,
        O_OR_Total: 50,
        O_MTG_Total: 30,
        R_RE_Agt_Total: 30,
        R_Pers_not_in_s_h_Total: 6,
        R_Oth_landlord_type_Total: 4,
        R_ST_h_auth_Total: 10,
        R_Com_Hp_Total: 4,
      },
    },
  ],
};

test('parseG37SA1Response: headline percentages match the tenure counts', () => {
  const p = parseG37SA1Response(blacktownSA1);
  assert.ok(p, 'should parse a populated SA1');
  assert.equal(p!.sa1Code, '21501138622');
  assert.equal(p!.totalDwellings, 140);
  // (50 + 30) / 140 = 57.14... → 57.1
  assert.equal(p!.ownerOccupierPct, 57.1);
  // (30 + 6 + 4) / 140 = 28.57... → 28.6
  assert.equal(p!.privateRentalPct, 28.6);
  // (10 + 4) / 140 = 10.0
  assert.equal(p!.publicHousingPct, 10);
  // Residual captures what's left (not stated, rent-free, etc.)
  assert.ok(p!.otherPct >= 0 && p!.otherPct <= 10);
});

test('parseG37SA1Response: headline percentages never exceed 100 combined', () => {
  const p = parseG37SA1Response(blacktownSA1)!;
  const sum = p.ownerOccupierPct + p.privateRentalPct + p.publicHousingPct + p.otherPct;
  // Allow ±0.3 for rounding at one decimal place across four buckets.
  assert.ok(Math.abs(sum - 100) < 0.5, `sum ${sum} should be ~100`);
});

test('parseG37SA1Response: empty features[] → null (unpopulated SA1)', () => {
  assert.equal(parseG37SA1Response({ features: [] }), null);
});

test('parseG37SA1Response: zero-dwelling SA1 → null (industrial / offshore)', () => {
  const response = {
    features: [
      {
        attributes: {
          SA1_CODE_2021: '90000000001',
          Tot_Total: 0,
          O_OR_Total: 0,
          O_MTG_Total: 0,
          R_RE_Agt_Total: 0,
          R_ST_h_auth_Total: 0,
          R_Com_Hp_Total: 0,
        },
      },
    ],
  };
  assert.equal(parseG37SA1Response(response), null);
});

test('parseG37SA1Response: ArcGIS error envelope → throws', () => {
  const response = {
    error: { code: 400, message: 'Invalid geometry' },
  };
  assert.throws(() => parseG37SA1Response(response), AbsParseError);
});

test('parseG37SA1Response: missing SA1_CODE_2021 → throws with key list', () => {
  const response = {
    features: [
      {
        attributes: { Tot_Total: 100, O_OR_Total: 50 },
      },
    ],
  };
  assert.throws(
    () => parseG37SA1Response(response),
    (err: unknown) =>
      err instanceof AbsParseError &&
      err.message.includes('SA1_CODE_2021') &&
      err.message.includes('Tot_Total'),
  );
});

test('parseG37SA1Response: missing rental/public fields default to 0', () => {
  const response = {
    features: [
      {
        attributes: {
          SA1_CODE_2021: '21501138623',
          Tot_Total: 100,
          O_OR_Total: 60,
          O_MTG_Total: 30,
          // no rented fields at all
        },
      },
    ],
  };
  const p = parseG37SA1Response(response)!;
  assert.equal(p.ownerOccupierPct, 90);
  assert.equal(p.privateRentalPct, 0);
  assert.equal(p.publicHousingPct, 0);
  assert.equal(p.otherPct, 10);
});

test('parseG37SA1Response: string-typed numeric fields coerced', () => {
  // ArcGIS occasionally returns numeric-looking strings. Tolerate it.
  const response = {
    features: [
      {
        attributes: {
          SA1_CODE_2021: '21501138624',
          Tot_Total: '100',
          O_OR_Total: '50',
          O_MTG_Total: '30',
          R_RE_Agt_Total: '15',
          R_ST_h_auth_Total: '5',
        },
      },
    ],
  };
  const p = parseG37SA1Response(response)!;
  assert.equal(p.totalDwellings, 100);
  assert.equal(p.ownerOccupierPct, 80);
  assert.equal(p.privateRentalPct, 15);
  assert.equal(p.publicHousingPct, 5);
});
