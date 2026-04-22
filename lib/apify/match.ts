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
 * Canonical expansions for the Australian street-type abbreviations we
 * see across HTAG + REA. HTAG tends to return the full form ("Road",
 * "Glade"), REA tends to return abbreviated ("Rd", "Gld") — expanding
 * both to the same token means the containment check in
 * matchListingsToComps treats them as equal.
 *
 * Only unambiguous abbreviations are included. "Cr" is intentionally
 * skipped (could be Crescent or Court depending on who wrote it), as is
 * "Str".
 */
const STREET_TYPE_EXPANSIONS: Record<string, string> = {
  st: 'street',
  rd: 'road',
  ave: 'avenue',
  av: 'avenue',
  cres: 'crescent',
  dr: 'drive',
  drv: 'drive',
  pl: 'place',
  ct: 'court',
  cct: 'circuit',
  pde: 'parade',
  tce: 'terrace',
  ter: 'terrace',
  cl: 'close',
  ln: 'lane',
  bvd: 'boulevard',
  blvd: 'boulevard',
  gr: 'grove',
  grv: 'grove',
  gld: 'glade',
  hwy: 'highway',
  gdn: 'garden',
  gdns: 'gardens',
  hts: 'heights',
  pk: 'park',
  pkwy: 'parkway',
  prom: 'promenade',
  sq: 'square',
  vw: 'view',
};

/**
 * Aggressive address normaliser — strips case and punctuation, collapses
 * whitespace, then expands common Australian street-type abbreviations
 * so "28 Reservoir Rd" and "28 Reservoir Road" normalise identically.
 * "74 Bentwood Terrace" and "74 BENTWOOD TCE" both collapse to the same
 * token sequence.
 */
export function normaliseAddress(raw: string | undefined): string {
  if (!raw) return '';
  const cleaned = raw
    .toLowerCase()
    .replace(/[\.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned
    .split(' ')
    .map((token) => STREET_TYPE_EXPANSIONS[token] ?? token)
    .join(' ');
}

/**
 * Pull the hero facade image out of an REA listing's `images` array.
 * Skips floorplans and videos; prefers the main photo. Still used for
 * the PDF hero + UI thumbnail — the multi-image Vision pass uses
 * extractAllImageUrls instead.
 */
export function extractHeroImageUrl(
  images: ReaScraperListing['images'],
): string | undefined {
  const all = extractAllImageUrls(images);
  // extractAllImageUrls already puts the main photo first when present.
  return all[0];
}

/**
 * Return every non-floorplan / non-video photo URL from an REA
 * listing, main photo first. Capped at MAX_IMAGES_PER_LISTING so a
 * listing with 40 staged photos doesn't blow past Claude's vision
 * token budget. Skips images hosted off the REA CDN as a defensive
 * move against the scraper occasionally returning tracking pixels or
 * partner ads inline.
 */
export const MAX_IMAGES_PER_LISTING = 10;

export function extractAllImageUrls(
  images: ReaScraperListing['images'],
): string[] {
  if (!images || !Array.isArray(images)) return [];
  const candidates = images.filter(
    (i): i is { name?: string; file: string } =>
      typeof i?.file === 'string' &&
      i.file.startsWith('https://i3.au.reastatic.net/') &&
      i.name !== 'floorplan' &&
      i.name !== 'video',
  );
  const mainIdx = candidates.findIndex((i) => i.name === 'main photo');
  const ordered =
    mainIdx > 0
      ? [
          candidates[mainIdx],
          ...candidates.slice(0, mainIdx),
          ...candidates.slice(mainIdx + 1),
        ]
      : candidates;
  // De-dupe URLs (REA occasionally repeats the hero in the strip).
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of ordered) {
    if (seen.has(c.file)) continue;
    seen.add(c.file);
    out.push(c.file);
    if (out.length >= MAX_IMAGES_PER_LISTING) break;
  }
  return out;
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
  /** Hero image — used for PDF thumbnails + UI display. */
  imageUrl: string;
  /**
   * Full set of non-floorplan / non-video photos from the matched
   * listing, hero first. Feeds into the multi-image Claude Vision
   * pass so the model can reason across kitchen + bathroom + backyard
   * rather than just the façade.
   */
  imageUrls: string[];
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
        const imageUrls = extractAllImageUrls(l.images);
        if (imageUrls.length === 0) continue;
        used.add(i);
        return {
          addressKey: target.addressKey,
          imageUrl: imageUrls[0],
          imageUrls,
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
    const imageUrls = extractAllImageUrls(listings[matchedIndex].images);
    if (imageUrls.length === 0) continue;
    used.add(matchedIndex);
    out.push({
      addressKey: comp.addressKey,
      imageUrl: imageUrls[0],
      imageUrls,
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
