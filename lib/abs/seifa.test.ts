import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SeifaParseError, parseSeifaResponse } from './seifa';

const validFeature = {
  features: [
    {
      attributes: {
        SA1_CODE_2021: '21501138622',
        IRSD_Score: 982,
        IRSD_Decile_Aust: 5,
        IRSAD_Score: 1020,
        IRSAD_Decile_Aust: 7,
        IER_Score: 995,
        IER_Decile_Aust: 6,
        IEO_Score: 1060,
        IEO_Decile_Aust: 8,
      },
    },
  ],
};

test('parseSeifaResponse: populated SA1 → full profile with deciles', () => {
  const p = parseSeifaResponse(validFeature);
  assert.ok(p);
  assert.equal(p!.sa1Code, '21501138622');
  assert.equal(p!.irsd.score, 982);
  assert.equal(p!.irsd.decileAus, 5);
  assert.equal(p!.irsad.decileAus, 7);
  assert.equal(p!.ier.decileAus, 6);
  assert.equal(p!.ieo.decileAus, 8);
});

test('parseSeifaResponse: tolerates alternate field-name conventions', () => {
  const uppercase = {
    features: [
      {
        attributes: {
          SA1_CODE21: '21501138622',
          IRSD_SCORE: 982,
          IRSD_DECILE_AUS: 5,
          IRSAD_SCORE: 1020,
          IRSAD_DECILE_AUS: 7,
          IER_SCORE: 995,
          IER_DECILE_AUS: 6,
          IEO_SCORE: 1060,
          IEO_DECILE_AUS: 8,
        },
      },
    ],
  };
  const p = parseSeifaResponse(uppercase);
  assert.ok(p);
  assert.equal(p!.irsd.score, 982);
  assert.equal(p!.irsad.decileAus, 7);
});

test('parseSeifaResponse: all-zero scores → null (unpopulated SA1)', () => {
  const empty = {
    features: [
      {
        attributes: {
          SA1_CODE_2021: '90000000001',
          IRSD_Score: 0,
          IRSD_Decile_Aust: 0,
          IRSAD_Score: 0,
          IRSAD_Decile_Aust: 0,
          IER_Score: 0,
          IER_Decile_Aust: 0,
          IEO_Score: 0,
          IEO_Decile_Aust: 0,
        },
      },
    ],
  };
  assert.equal(parseSeifaResponse(empty), null);
});

test('parseSeifaResponse: empty features[] → null', () => {
  assert.equal(parseSeifaResponse({ features: [] }), null);
});

test('parseSeifaResponse: ArcGIS error envelope → throws', () => {
  assert.throws(
    () => parseSeifaResponse({ error: { code: 400, message: 'Bad geometry' } }),
    SeifaParseError,
  );
});

test('parseSeifaResponse: missing SA1 code → throws with key list', () => {
  const response = {
    features: [
      {
        attributes: { IRSD_Score: 982, IRSD_Decile_Aust: 5 },
      },
    ],
  };
  assert.throws(
    () => parseSeifaResponse(response),
    (err: unknown) =>
      err instanceof SeifaParseError &&
      err.message.includes('SA1') &&
      err.message.includes('IRSD_Score'),
  );
});

test('parseSeifaResponse: missing decile defaults to 0', () => {
  const response = {
    features: [
      {
        attributes: {
          SA1_CODE_2021: '21501138622',
          IRSD_Score: 982,
          // no IRSD_Decile_Aust
          IRSAD_Score: 1020,
          IRSAD_Decile_Aust: 7,
          IER_Score: 0,
          IEO_Score: 0,
        },
      },
    ],
  };
  const p = parseSeifaResponse(response);
  assert.ok(p);
  assert.equal(p!.irsd.score, 982);
  assert.equal(p!.irsd.decileAus, 0); // missing = 0, UI should handle
});
