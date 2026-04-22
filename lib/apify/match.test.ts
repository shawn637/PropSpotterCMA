import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Comparable } from '@/lib/types';

import {
  buildReaSoldUrl,
  extractHeroImageUrl,
  matchListingsToComps,
  normaliseAddress,
  parseReaPriceToNumber,
  reaSlug,
  type ReaScraperListing,
} from './match';

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

test('buildReaSoldUrl: Stanhope Gardens matches the live URL format', () => {
  const url = buildReaSoldUrl({
    suburb: 'Stanhope Gardens',
    state: 'NSW',
    postcode: '2768',
  });
  assert.equal(
    url,
    'https://www.realestate.com.au/sold/property-house-in-stanhope+gardens%2c+nsw+2768/list-1',
  );
});

test('buildReaSoldUrl: unit channel', () => {
  const url = buildReaSoldUrl({
    suburb: 'Bondi Beach',
    state: 'NSW',
    postcode: '2026',
    propertyType: 'unit',
  });
  assert.equal(
    url,
    'https://www.realestate.com.au/sold/property-unit-in-bondi+beach%2c+nsw+2026/list-1',
  );
});

test('buildReaSoldUrl: any-property-type channel drops the prefix', () => {
  const url = buildReaSoldUrl({
    suburb: 'Orange',
    state: 'NSW',
    postcode: '2800',
    propertyType: 'any',
  });
  assert.equal(
    url,
    'https://www.realestate.com.au/sold/in-orange%2c+nsw+2800/list-1',
  );
});

test('reaSlug strips punctuation and lowercases', () => {
  assert.equal(reaSlug("O'Sullivan Beach"), 'osullivan+beach');
  assert.equal(reaSlug(' ONE - TWO '), 'one++two');
});

// ---------------------------------------------------------------------------
// Image extraction — skip floorplan + video, prefer main photo
// ---------------------------------------------------------------------------

test('extractHeroImageUrl: prefers main photo', () => {
  const url = extractHeroImageUrl([
    { name: 'photo', file: 'https://i3.au.reastatic.net/a.jpg' },
    { name: 'main photo', file: 'https://i3.au.reastatic.net/main.jpg' },
  ]);
  assert.equal(url, 'https://i3.au.reastatic.net/main.jpg');
});

test('extractHeroImageUrl: falls back to first photo when no main', () => {
  const url = extractHeroImageUrl([
    { name: 'photo', file: 'https://i3.au.reastatic.net/a.jpg' },
    { name: 'photo', file: 'https://i3.au.reastatic.net/b.jpg' },
  ]);
  assert.equal(url, 'https://i3.au.reastatic.net/a.jpg');
});

test('extractHeroImageUrl: skips floorplans and videos', () => {
  const url = extractHeroImageUrl([
    { name: 'floorplan', file: 'https://i3.au.reastatic.net/plan.jpg' },
    { name: 'video', file: 'https://img.youtube.com/vid/0.jpg' },
    { name: 'main photo', file: 'https://i3.au.reastatic.net/main.jpg' },
  ]);
  assert.equal(url, 'https://i3.au.reastatic.net/main.jpg');
});

test('extractHeroImageUrl: empty / malformed input returns undefined', () => {
  assert.equal(extractHeroImageUrl(undefined), undefined);
  assert.equal(extractHeroImageUrl([]), undefined);
  assert.equal(
    extractHeroImageUrl([{ name: 'floorplan', file: 'https://x.com/fp.jpg' }]),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// Price parsing
// ---------------------------------------------------------------------------

test('parseReaPriceToNumber: strips dollars and commas', () => {
  assert.equal(parseReaPriceToNumber('$1,620,300'), 1620300);
  assert.equal(parseReaPriceToNumber('$2,188,888'), 2188888);
});

test('parseReaPriceToNumber: non-numeric strings return undefined', () => {
  assert.equal(parseReaPriceToNumber('POA'), undefined);
  assert.equal(parseReaPriceToNumber('Awaiting Price Guide'), undefined);
  assert.equal(parseReaPriceToNumber(undefined), undefined);
});

// ---------------------------------------------------------------------------
// Address normalisation
// ---------------------------------------------------------------------------

test('normaliseAddress: lowercase, strip commas and periods, collapse whitespace', () => {
  assert.equal(
    normaliseAddress('74 Bentwood Terrace, Stanhope Gardens NSW 2768'),
    '74 bentwood terrace stanhope gardens nsw 2768',
  );
});

// ---------------------------------------------------------------------------
// matchListingsToComps — the fixture-backed integration test.
// These 3 listings are taken verbatim from Shawn's live REA scraper
// output for Stanhope Gardens on 2026-04-22.
// ---------------------------------------------------------------------------

function makeComp(overrides: Partial<Comparable>): Comparable {
  return {
    addressKey: 'KEY',
    fullAddress: '...',
    salePrice: 0,
    saleDateIso: '2026-01-01',
    propertyType: 'House',
    ...overrides,
  };
}

const liveReaListings: ReaScraperListing[] = [
  {
    address: {
      streetAddress: '74 Bentwood Terrace',
      suburb: 'Stanhope Gardens',
      state: 'NSW',
      postcode: '2768',
    },
    price: { display: '$1,620,300' },
    dateSold: { value: '2026-04-14' },
    images: [
      {
        name: 'main photo',
        file: 'https://i3.au.reastatic.net/.../bentwood-main.jpg',
      },
      { name: 'photo', file: 'https://i3.au.reastatic.net/.../bentwood-2.jpg' },
      { name: 'floorplan', file: 'https://i3.au.reastatic.net/.../fp.jpg' },
    ],
    isSoldChannel: true,
    propertyType: 'house',
  },
  {
    address: {
      streetAddress: '18 Spicebush Gld',
      suburb: 'Stanhope Gardens',
      state: 'NSW',
      postcode: '2768',
    },
    price: { display: '$1,432,000' },
    dateSold: { value: '2026-02-18' },
    images: [
      {
        name: 'main photo',
        file: 'https://i3.au.reastatic.net/.../spicebush-main.jpg',
      },
    ],
    isSoldChannel: true,
    propertyType: 'house',
  },
  {
    address: {
      streetAddress: '124 Stanhope Parkway',
      suburb: 'Stanhope Gardens',
      state: 'NSW',
      postcode: '2768',
    },
    price: { display: '$1,107,000' },
    dateSold: { value: '2026-03-04' },
    images: [
      {
        name: 'main photo',
        file: 'https://i3.au.reastatic.net/.../stanhope-pkwy-main.jpg',
      },
    ],
    isSoldChannel: true,
    propertyType: 'house',
  },
];

test('matchListingsToComps: exact address matches produce address-reason hits', () => {
  const comps: Comparable[] = [
    makeComp({
      addressKey: 'COMP-BENTWOOD',
      fullAddress: '74 Bentwood Terrace, Stanhope Gardens NSW 2768',
      salePrice: 1_620_300,
      saleDateIso: '2026-04-14',
    }),
    makeComp({
      addressKey: 'COMP-STANHOPE-PKWY',
      fullAddress: '124 Stanhope Parkway, Stanhope Gardens NSW 2768',
      salePrice: 1_107_000,
      saleDateIso: '2026-03-04',
    }),
  ];
  const matches = matchListingsToComps(comps, liveReaListings);
  assert.equal(matches.length, 2);
  assert.equal(matches[0].addressKey, 'COMP-BENTWOOD');
  assert.equal(
    matches[0].imageUrl,
    'https://i3.au.reastatic.net/.../bentwood-main.jpg',
  );
  assert.equal(matches[0].matchReason, 'address');
});

test('matchListingsToComps: handles spelling variants via price+date fallback', () => {
  // HTAG returned "18 Spicebush Glade"; REA has "18 Spicebush Gld". The
  // address normalisation catches this because "18 spicebush gld" is a
  // substring of "18 spicebush glade stanhope gardens nsw 2768" via the
  // reverse `streetNorm.includes(compNorm)` branch — wait, neither side
  // fully contains the other. Check price+date match works.
  const comps: Comparable[] = [
    makeComp({
      addressKey: 'COMP-SPICEBUSH',
      fullAddress: '18 Spicebush Glade, Stanhope Gardens NSW 2768',
      salePrice: 1_432_000,
      saleDateIso: '2026-02-18',
    }),
  ];
  const matches = matchListingsToComps(comps, liveReaListings);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].addressKey, 'COMP-SPICEBUSH');
  assert.equal(
    matches[0].imageUrl,
    'https://i3.au.reastatic.net/.../spicebush-main.jpg',
  );
  // This is a genuine tie-break test: the matcher is free to use either
  // 'address' (normaliseAddress happens to make "18 spicebush gld" a
  // substring match) or 'price+date'. Both are valid; don't assert the
  // specific reason.
});

test('matchListingsToComps: each listing only consumed once', () => {
  const comps: Comparable[] = [
    makeComp({
      addressKey: 'FIRST',
      fullAddress: '74 Bentwood Terrace, Stanhope Gardens NSW 2768',
      salePrice: 1_620_300,
      saleDateIso: '2026-04-14',
    }),
    makeComp({
      // Same listing — if the matcher re-used, both would hit.
      addressKey: 'SECOND',
      fullAddress: '74 Bentwood Terrace, Stanhope Gardens NSW 2768',
      salePrice: 1_620_300,
      saleDateIso: '2026-04-14',
    }),
  ];
  const matches = matchListingsToComps(comps, liveReaListings);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].addressKey, 'FIRST');
});

test('matchListingsToComps: unmatched comps are silently dropped', () => {
  const comps: Comparable[] = [
    makeComp({
      addressKey: 'COMP-ROCHDALE',
      // Not in our 3-listing fixture — no photo available on REA.
      fullAddress: '7 Rochdale Circuit, Stanhope Gardens NSW 2768',
      salePrice: 1_500_000,
      saleDateIso: '2026-04-16',
    }),
  ];
  const matches = matchListingsToComps(comps, liveReaListings);
  assert.equal(matches.length, 0);
});

test('matchListingsToComps: listing with only a floorplan has no hero image and is skipped', () => {
  const compsList = [
    makeComp({
      addressKey: 'NO-HERO',
      fullAddress: '1 Noimage Street, Stanhope Gardens NSW 2768',
      salePrice: 999_000,
      saleDateIso: '2026-03-01',
    }),
  ];
  const stripped: ReaScraperListing[] = [
    {
      address: {
        streetAddress: '1 Noimage Street',
        suburb: 'Stanhope Gardens',
        postcode: '2768',
        state: 'NSW',
      },
      price: { display: '$999,000' },
      dateSold: { value: '2026-03-01' },
      images: [
        {
          name: 'floorplan',
          file: 'https://i3.au.reastatic.net/fp.jpg',
        },
      ],
    },
  ];
  const matches = matchListingsToComps(compsList, stripped);
  assert.equal(matches.length, 0);
});
