/**
 * Pure helpers for matching HTAG comparables to realestate.com.au sold
 * listings returned by the Apify scraper. No I/O — exercised by
 * lib/apify/match.test.ts against fixtures from live scraper output.
 *
 * Matching strategy (first hit wins, in order):
 *   1. Normalised street address + postcode match.
 *   2. (salePrice, saleDateIso) exact match — handles REA/HTAG spelling
 *      variants of the same property (e.g. "Spicebush Glade" vs
 *      "Spicebush Gld" for the same sale).
 *
 * Anything that doesn't match falls through to manual URL paste in the UI.
 */

import type { Comparable } from '@/lib/types';

export interface ReaScraperListing {
  address: {
    streetAddress: string;
    suburb?: string;
    postcode: string;
    state?: string;
  };
  price?: { display?: string };
  dateSold?: { value?: string };
  images?: Array<{ name?: string; file?: string }>;
  isSoldChannel?: boolean;
  propertyType?: string;
}

/**
 * Build the realestate.com.au sold-search URL for a given suburb. This
 * is the `startUrl` we feed to the Apify actor.
 *
 * Pattern: https://www.realestate.com.au/sold/property-house-in-<suburb>%2c+<state>+<postcode>/list-1
 *
 * We default to the `property-house-in-` slot because our mock/subject
 * default is 'House'. For unit or townhouse subjects the caller can
 * pass propertyType.
 */
export function buildReaSoldUrl(args: {
  suburb: string;
  state: string;
  postcode: string;
  propertyType?: 'house' | 'unit' | 'townhouse' | 'any';
}): string {
  const type = args.propertyType ?? 'house';
  const prefix = type === 'any' ? 'in' : `property-${type}-in`;
  const slugSuburb = reaSlug(args.suburb);
  const slugState = reaSlug(args.state);
  // REA uses "%2c+" as the literal separator between suburb and state.
  return `https://www.realestate.com.au/sold/${prefix}-${slugSuburb}%2c+${slugState}+${args.postcode}/list-1`;
}

export function reaSlug(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '+')
    .replace(/[^a-z0-9+]/g, '');
}

/**
 * Aggressive address normaliser — strips unit prefixes, case, punctuation,
 * and collapses whitespace. "74 Bentwood Terrace" and "74 BENTWOOD TCE"
 * both end up similar enough to containment-check.
 */
export function normaliseAddress(raw: string | undefined): string {
  if (!raw) return '';
  return raw
    .toLowerCase()
    .replace(/[\.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pull the hero facade image out of an REA listing's `images` array.
 * Skips floorplans and videos; prefers the main photo.
 */
export function extractHeroImageUrl(
  images: ReaScraperListing['images'],
): string | undefined {
  if (!images || !Array.isArray(images)) return undefined;
  const candidates = images.filter(
    (i) =>
      typeof i?.file === 'string' &&
      i.file.startsWith('https://i3.au.reastatic.net/') &&
      i.name !== 'floorplan' &&
      i.name !== 'video',
  );
  const main = candidates.find((i) => i.name === 'main photo');
  if (main?.file) return main.file;
  return candidates[0]?.file;
}

export function parseReaPriceToNumber(display: string | undefined): number | undefined {
  if (!display) return undefined;
  const digits = display.replace(/[^0-9]/g, '');
  if (!digits) return undefined;
  const n = Number.parseInt(digits, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export interface MatchResult {
  addressKey: string;
  imageUrl: string;
  matchReason: 'address' | 'price+date';
}

/**
 * Given the set of HTAG comparables we already have in the CMA and the
 * raw REA listings the scraper returned, produce a {addressKey → imageUrl}
 * map. Records without a hero image are skipped. Records that don't
 * match any comp are ignored (we only care about photos for the comps
 * we're actually using).
 */
export function matchListingsToComps(
  comps: Comparable[],
  listings: ReaScraperListing[],
): MatchResult[] {
  const out: MatchResult[] = [];
  const used = new Set<number>(); // index into listings[]

  for (const comp of comps) {
    const compNorm = normaliseAddress(comp.fullAddress);
    const compPostcode = extractPostcode(comp.fullAddress);

    // 1. Address + postcode match.
    let matchedIndex = -1;
    for (let i = 0; i < listings.length; i++) {
      if (used.has(i)) continue;
      const l = listings[i];
      if (!l?.address?.streetAddress) continue;
      const streetNorm = normaliseAddress(l.address.streetAddress);
      if (!streetNorm) continue;
      const postcodesMatch =
        !compPostcode ||
        !l.address.postcode ||
        l.address.postcode === compPostcode;
      if (!postcodesMatch) continue;
      if (compNorm.includes(streetNorm) || streetNorm.includes(compNorm)) {
        matchedIndex = i;
        break;
      }
    }

    if (matchedIndex === -1) {
      // 2. Fallback: price + date match.
      const compDate = comp.saleDateIso?.slice(0, 10);
      for (let i = 0; i < listings.length; i++) {
        if (used.has(i)) continue;
        const l = listings[i];
        const lPrice = parseReaPriceToNumber(l?.price?.display);
        const lDate = l?.dateSold?.value?.slice(0, 10);
        if (!lPrice || !lDate) continue;
        if (lPrice === comp.salePrice && lDate === compDate) {
          matchedIndex = i;
          break;
        }
      }
    }

    if (matchedIndex === -1) continue;
    const listing = listings[matchedIndex];
    const imageUrl = extractHeroImageUrl(listing.images);
    if (!imageUrl) continue;
    used.add(matchedIndex);
    out.push({
      addressKey: comp.addressKey,
      imageUrl,
      matchReason:
        compNorm.includes(normaliseAddress(listing.address.streetAddress))
          ? 'address'
          : 'price+date',
    });
  }

  return out;
}

function extractPostcode(addr: string | undefined): string | undefined {
  if (!addr) return undefined;
  const m = addr.match(/\b(\d{4})\b\s*$/);
  return m?.[1];
}
