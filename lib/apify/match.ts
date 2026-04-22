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
 * Build a realestate.com.au search URL for the Apify actor's startUrl
 * input. Channel selects between sold listings (`/sold/...`) and active
 * for-sale listings (`/buy/...`). Same URL shape in both cases; only the
 * path prefix changes.
 *
 * Pattern: https://www.realestate.com.au/<channel>/property-<type>-in-<suburb>%2c+<state>+<postcode>/list-1
 *
 * The default is sold+house — matches the comparables pass. For the
 * subject property we fire a second run on the buy channel since a
 * subject being pre-purchased is usually a currently-listed sale.
 */
export function buildReaSearchUrl(args: {
  channel: 'sold' | 'buy';
  suburb: string;
  state: string;
  postcode: string;
  propertyType?: 'house' | 'unit' | 'townhouse' | 'any';
}): string {
  const type = args.propertyType ?? 'house';
  const prefix = type === 'any' ? 'in' : `property-${type}-in`;
  const slugSuburb = reaSlug(args.suburb);
  const slugState = reaSlug(args.state);
  return `https://www.realestate.com.au/${args.channel}/${prefix}-${slugSuburb}%2c+${slugState}+${args.postcode}/list-1`;
}

/**
 * Backward-compat wrapper. New code should call buildReaSearchUrl
 * directly with an explicit channel.
 */
export function buildReaSoldUrl(args: {
  suburb: string;
  state: string;
  postcode: string;
  propertyType?: 'house' | 'unit' | 'townhouse' | 'any';
}): string {
  return buildReaSearchUrl({ channel: 'sold', ...args });
}

export function buildReaBuyUrl(args: {
  suburb: string;
  state: string;
  postcode: string;
  propertyType?: 'house' | 'unit' | 'townhouse' | 'any';
}): string {
  return buildReaSearchUrl({ channel: 'buy', ...args });
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

export interface SubjectLike {
  addressKey: string;
  fullAddress: string;
}

/**
 * Given the set of HTAG comparables we already have in the CMA and the
 * raw REA listings the scraper returned, produce a {addressKey → imageUrl}
 * map. Records without a hero image are skipped. Records that don't
 * match any comp are ignored (we only care about photos for the comps
 * we're actually using).
 *
 * If `subject` is supplied, attempt to match it too — subject matching
 * is address-only (the subject is the property being valued, not a sale,
 * so we don't have a salePrice/saleDateIso to fall back on).
 */
export function matchListingsToComps(
  comps: Comparable[],
  listings: ReaScraperListing[],
  subject?: SubjectLike,
): { comps: MatchResult[]; subject?: MatchResult } {
  const out: MatchResult[] = [];
  const used = new Set<number>(); // index into listings[]

  const tryAddressMatch = (
    target: { addressKey: string; fullAddress: string },
  ): MatchResult | undefined => {
    const targetNorm = normaliseAddress(target.fullAddress);
    const targetPostcode = extractPostcode(target.fullAddress);
    for (let i = 0; i < listings.length; i++) {
      if (used.has(i)) continue;
      const l = listings[i];
      if (!l?.address?.streetAddress) continue;
      const streetNorm = normaliseAddress(l.address.streetAddress);
      if (!streetNorm) continue;
      const postcodesMatch =
        !targetPostcode ||
        !l.address.postcode ||
        l.address.postcode === targetPostcode;
      if (!postcodesMatch) continue;
      if (targetNorm.includes(streetNorm) || streetNorm.includes(targetNorm)) {
        const imageUrl = extractHeroImageUrl(l.images);
        if (!imageUrl) continue;
        used.add(i);
        return {
          addressKey: target.addressKey,
          imageUrl,
          matchReason: 'address',
        };
      }
    }
    return undefined;
  };

  // Subject first — we prefer giving the subject any address-matching
  // listing even if that same listing could match a comp (which
  // shouldn't happen in practice but guard against it).
  let subjectMatch: MatchResult | undefined;
  if (subject) {
    subjectMatch = tryAddressMatch(subject);
  }

  for (const comp of comps) {
    const address = tryAddressMatch({
      addressKey: comp.addressKey,
      fullAddress: comp.fullAddress,
    });
    if (address) {
      out.push(address);
      continue;
    }

    // Comp-only fallback: price + date match (handles spelling variants).
    const compDate = comp.saleDateIso?.slice(0, 10);
    let matchedIndex = -1;
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
    if (matchedIndex === -1) continue;
    const imageUrl = extractHeroImageUrl(listings[matchedIndex].images);
    if (!imageUrl) continue;
    used.add(matchedIndex);
    out.push({
      addressKey: comp.addressKey,
      imageUrl,
      matchReason: 'price+date',
    });
  }

  return { comps: out, subject: subjectMatch };
}

function extractPostcode(addr: string | undefined): string | undefined {
  if (!addr) return undefined;
  const m = addr.match(/\b(\d{4})\b\s*$/);
  return m?.[1];
}
