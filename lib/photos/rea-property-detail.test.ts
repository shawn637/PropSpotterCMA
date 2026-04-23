import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractReaImageUrls,
  parseStreetParts,
} from './rea-property-detail';

// ---------------------------------------------------------------------------
// parseStreetParts — slug builder feed
// ---------------------------------------------------------------------------

test('parseStreetParts: simple street form', () => {
  const r = parseStreetParts('12 Kent Avenue, Orange NSW 2800');
  assert.deepEqual(r, {
    streetNumber: '12',
    streetName: 'Kent',
    streetType: 'Avenue',
  });
});

test('parseStreetParts: multi-word street name', () => {
  const r = parseStreetParts('5 Old Mill Road, Bowral NSW 2576');
  assert.deepEqual(r, {
    streetNumber: '5',
    streetName: 'Old Mill',
    streetType: 'Road',
  });
});

test('parseStreetParts: alphanumeric street number', () => {
  const r = parseStreetParts('12a Kent Avenue, Orange NSW 2800');
  assert.deepEqual(r, {
    streetNumber: '12a',
    streetName: 'Kent',
    streetType: 'Avenue',
  });
});

test('parseStreetParts: unit prefix slash form', () => {
  const r = parseStreetParts('4/12 Kent Avenue, Orange NSW 2800');
  assert.deepEqual(r, {
    unit: '4',
    streetNumber: '12',
    streetName: 'Kent',
    streetType: 'Avenue',
  });
});

test('parseStreetParts: "Unit 4 / 12" prefix form', () => {
  const r = parseStreetParts('Unit 4 / 12 Kent Avenue, Orange NSW 2800');
  assert.deepEqual(r, {
    unit: '4',
    streetNumber: '12',
    streetName: 'Kent',
    streetType: 'Avenue',
  });
});

test('parseStreetParts: malformed input returns null rather than throwing', () => {
  assert.equal(parseStreetParts(''), null);
  assert.equal(parseStreetParts('Just A Suburb'), null);
  assert.equal(parseStreetParts('No street type'), null);
});

// ---------------------------------------------------------------------------
// extractReaImageUrls — HTML scraping
// ---------------------------------------------------------------------------

test('extractReaImageUrls: pulls OG meta image URL', () => {
  const html = `<html><head>
    <meta property="og:image" content="https://i3.au.reastatic.net/abc/123/hero.jpg">
    </head></html>`;
  assert.deepEqual(extractReaImageUrls(html), [
    'https://i3.au.reastatic.net/abc/123/hero.jpg',
  ]);
});

test('extractReaImageUrls: deduplicates across resized variants', () => {
  // REA serves the same image at multiple resolutions; the URL paths
  // differ only by a /<width>x<height>/ segment. Strip the size and
  // dedup so we don't end up shipping the same hero shot to Vision
  // three times.
  const html = `
    <img src="https://i3.au.reastatic.net/x/400x300/hero.jpg">
    <img src="https://i3.au.reastatic.net/x/800x600/hero.jpg">
    <img src="https://i3.au.reastatic.net/x/1200x900/hero.jpg">
  `;
  assert.deepEqual(extractReaImageUrls(html), [
    'https://i3.au.reastatic.net/x/hero.jpg',
  ]);
});

test('extractReaImageUrls: collects multiple distinct images, hero first', () => {
  const html = `
    <meta property="og:image" content="https://i3.au.reastatic.net/p/hero.jpg">
    <img src="https://i3.au.reastatic.net/p/kitchen.jpg">
    <img src="https://i3.au.reastatic.net/p/bath.jpg">
  `;
  assert.deepEqual(extractReaImageUrls(html), [
    'https://i3.au.reastatic.net/p/hero.jpg',
    'https://i3.au.reastatic.net/p/kitchen.jpg',
    'https://i3.au.reastatic.net/p/bath.jpg',
  ]);
});

test('extractReaImageUrls: ignores non-REA-CDN images', () => {
  const html = `
    <img src="https://random-cdn.com/p/x.jpg">
    <img src="https://i3.au.reastatic.net/p/yes.jpg">
    <img src="https://tracking-pixel.example/t.gif">
  `;
  assert.deepEqual(extractReaImageUrls(html), [
    'https://i3.au.reastatic.net/p/yes.jpg',
  ]);
});

test('extractReaImageUrls: empty / no-match HTML returns []', () => {
  assert.deepEqual(extractReaImageUrls(''), []);
  assert.deepEqual(extractReaImageUrls('<html>no images</html>'), []);
});
