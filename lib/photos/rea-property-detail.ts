/**
 * Tier-2 subject-photo fallback: when the suburb-wide REA scrape
 * doesn't surface the subject (off-market, sold long ago, sitting on
 * page 11+), we hit REA's permanent property-detail page directly and
 * scrape image URLs out of the HTML response. No Apify dependency —
 * just a plain fetch + a regex against REA's image CDN.
 *
 * "Flaky" by design: REA changes its HTML occasionally, may bot-block
 * a particular Vercel egress IP, and there's no guaranteed slug
 * pattern. Every failure mode returns null cleanly and is logged so
 * we can see in the deployment when this leg degrades — the upstream
 * caller decides whether to surface "subject photos unavailable" to
 * the user or paper over it some other way.
 */

const TIMEOUT_MS = 8_000;
const MAX_IMAGES = 10;
// Realistic browser UA — REA aggressively rejects naive curl-style
// requests. This isn't anti-detection, it's just being a polite client.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

export interface ReaDetailResult {
  imageUrls: string[];
  attemptedUrls: string[];
  resolvedUrl?: string;
  error?: string;
}

/**
 * Best-effort subject photo lookup from REA's permanent property
 * detail page. Tries a handful of plausible URL slug variants
 * because REA's exact format isn't deterministic from address parts
 * alone (street-type expansion, unit prefixes, hyphenation all
 * vary). First URL that comes back with parseable images wins.
 */
export async function fetchSubjectImagesFromRea(args: {
  fullAddress: string;
  suburb: string;
  state: string;
  postcode: string;
}): Promise<ReaDetailResult> {
  const candidates = candidateSlugUrls(args);
  const attempted: string[] = [];

  for (const url of candidates) {
    attempted.push(url);
    try {
      const html = await fetchHtml(url);
      if (!html) continue;
      const images = extractReaImageUrls(html);
      if (images.length > 0) {
        logReaDetail({
          status: 'hit',
          url,
          imageCount: images.length,
        });
        return { imageUrls: images, attemptedUrls: attempted, resolvedUrl: url };
      }
      logReaDetail({
        status: 'no-images-in-html',
        url,
        htmlBytes: html.length,
      });
    } catch (err) {
      logReaDetail({
        status: 'fetch-error',
        url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    imageUrls: [],
    attemptedUrls: attempted,
    error: `No REA property-detail variant returned images (tried ${attempted.length})`,
  };
}

/**
 * Build the candidate URLs we'll try in order. REA's property URL
 * format is roughly
 *   https://www.realestate.com.au/property/<address-slug>
 * where the slug is the address parts joined with hyphens, lowercased.
 * Street-type variants (avenue vs ave, road vs rd) and the optional
 * unit prefix mean we can't be sure of the exact slug in advance, so
 * we generate a small set of plausible candidates and try them in turn.
 */
function candidateSlugUrls(args: {
  fullAddress: string;
  suburb: string;
  state: string;
  postcode: string;
}): string[] {
  const parsed = parseStreetParts(args.fullAddress);
  if (!parsed) return [];

  const suburbSlug = slugify(args.suburb);
  const stateSlug = args.state.toLowerCase();
  const postcode = args.postcode;
  // Two slugs per street type — full ("avenue") and abbreviated
  // ("ave") — cover the most common REA URL forms.
  const expanded = STREET_TYPE_LONG[parsed.streetType.toLowerCase()];
  const abbreviated = STREET_TYPE_SHORT[parsed.streetType.toLowerCase()];

  const variants = new Set<string>();
  const numberPart = parsed.unit
    ? `${slugify(parsed.unit)}-${slugify(parsed.streetNumber)}`
    : slugify(parsed.streetNumber);
  const baseStreet = slugify(parsed.streetName);
  const streetTypes = new Set<string>([
    slugify(parsed.streetType),
    expanded ? slugify(expanded) : '',
    abbreviated ? slugify(abbreviated) : '',
  ].filter(Boolean));

  for (const stType of streetTypes) {
    const slug = `${numberPart}-${baseStreet}-${stType}-${suburbSlug}-${stateSlug}-${postcode}`;
    variants.add(slug);
  }

  return [...variants].map(
    (slug) => `https://www.realestate.com.au/property/${slug}`,
  );
}

/**
 * Parse "12 Kent Avenue, Orange NSW 2800" into its components. Returns
 * null when the format is too irregular to reason about. Supports the
 * common Australian forms:
 *   "12 Kent Avenue, Orange NSW 2800"
 *   "Unit 4 / 12 Kent Avenue, Orange NSW 2800"
 *   "4/12 Kent Avenue, Orange NSW 2800"
 */
export function parseStreetParts(fullAddress: string): {
  unit?: string;
  streetNumber: string;
  streetName: string;
  streetType: string;
} | null {
  // Strip suburb / state / postcode tail.
  const head = fullAddress.split(',')[0]?.trim();
  if (!head) return null;

  // Unit prefix variants: "Unit 4/12", "U4/12", "4/12".
  const unitMatch = head.match(
    /^(?:unit\s+|u\s*)?(\d+[a-z]?)\s*\/\s*(\d+[a-z]?)\s+(.+)$/i,
  );
  if (unitMatch) {
    const [, unit, streetNumber, rest] = unitMatch;
    const streetParts = rest.trim().split(/\s+/);
    if (streetParts.length < 2) return null;
    const streetType = streetParts[streetParts.length - 1];
    const streetName = streetParts.slice(0, -1).join(' ');
    return { unit, streetNumber, streetName, streetType };
  }

  const plainMatch = head.match(/^(\d+[a-z]?)\s+(.+)$/i);
  if (!plainMatch) return null;
  const [, streetNumber, rest] = plainMatch;
  const streetParts = rest.trim().split(/\s+/);
  if (streetParts.length < 2) return null;
  const streetType = streetParts[streetParts.length - 1];
  const streetName = streetParts.slice(0, -1).join(' ');
  return { streetNumber, streetName, streetType };
}

const STREET_TYPE_LONG: Record<string, string> = {
  st: 'street',
  rd: 'road',
  ave: 'avenue',
  av: 'avenue',
  cres: 'crescent',
  dr: 'drive',
  pl: 'place',
  ct: 'court',
  cct: 'circuit',
  pde: 'parade',
  tce: 'terrace',
  cl: 'close',
  ln: 'lane',
  bvd: 'boulevard',
  blvd: 'boulevard',
  gr: 'grove',
  gld: 'glade',
  hwy: 'highway',
  pkwy: 'parkway',
};

const STREET_TYPE_SHORT: Record<string, string> = {
  street: 'st',
  road: 'rd',
  avenue: 'ave',
  crescent: 'cres',
  drive: 'dr',
  place: 'pl',
  court: 'ct',
  circuit: 'cct',
  parade: 'pde',
  terrace: 'tce',
  close: 'cl',
  lane: 'ln',
  boulevard: 'bvd',
  grove: 'gr',
  glade: 'gld',
  highway: 'hwy',
  parkway: 'pkwy',
};

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function fetchHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-AU,en;q=0.9',
      },
    });
    if (!res.ok) return null;
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!ct.includes('html')) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull every realestate.com.au CDN image URL out of an HTML blob.
 * Catches both the OG meta tag, embedded JSON gallery payloads, and
 * raw <img src> attributes — they all reference i3.au.reastatic.net.
 * Returns deduplicated URLs preserving discovery order so the OG /
 * hero photo (typically first in the source) wins the hero slot.
 */
export function extractReaImageUrls(html: string): string[] {
  // Match REA CDN image URLs. JPEG variants typical; we accept any
  // path under i3.au.reastatic.net and bound it at quote / whitespace.
  const re = /https:\/\/i3\.au\.reastatic\.net\/[^\s"'\\]+\.(?:jpe?g|png|webp)/gi;
  const matches = html.match(re) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of matches) {
    // Strip query params + sizing suffixes so we dedup across different
    // resolutions of the same image. REA serves the same hero in
    // /400x300/, /800x600/, etc. — keep the largest plausible version
    // by stripping the size segment.
    const normalised = raw.replace(/\/\d+x\d+\//g, '/');
    if (seen.has(normalised)) continue;
    seen.add(normalised);
    out.push(normalised);
    if (out.length >= MAX_IMAGES) break;
  }
  return out;
}

function logReaDetail(info: {
  status: string;
  url: string;
  imageCount?: number;
  htmlBytes?: number;
  error?: string;
}): void {
  console.log(JSON.stringify({ tag: 'rea-detail', ...info }));
}
