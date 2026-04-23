/**
 * Pure parse helpers for HTAG responses. No I/O, no SDK calls — everything
 * in this file is deterministic given its input. Exercised by
 * lib/htag/parse.test.ts against fixtures taken directly from the HTAG
 * OpenAPI spec, so if the live API matches its documented shape the parse
 * path is green before we ever deploy.
 *
 * The relevant HTAG endpoints we consume:
 *   GET  /v1/address/geocode                      → AddressGeocodeResponse
 *   GET  /v1/property/summary?address_key=…       → AddressPropertyResponse
 *   GET  /v1/property/sold/search?…               → PropertySoldSearchResponse
 *   GET  /v1/markets/summary?level=&area_id=…     → MarketSummaryResponse
 *   GET  /v1/markets/growth/annualised?…          → MarketGrowthAnnualisedResponse
 *   GET  /v1/markets/cycle?…                      → MarketCycleResponse
 *   GET  /v1/markets/demand?…                     → MarketDemandResponse
 *
 * Every HTAG response wraps its payload as { results: [...], total: N };
 * most of our endpoints only ever return one element, so the helpers
 * unwrap to results[0] for us.
 */

import type {
  Comparable,
  CycleStage,
  MarketContext,
  PropertyDetails,
} from '@/lib/types';

export class HtagParseError extends Error {
  constructor(message: string, readonly endpoint: string) {
    super(message);
    this.name = 'HtagParseError';
  }
}

export function firstResult(
  response: unknown,
  endpoint: string,
): Record<string, unknown> {
  if (Array.isArray(response)) {
    if (response.length === 0) {
      throw new HtagParseError(`HTAG ${endpoint} returned an empty array.`, endpoint);
    }
    const first = response[0];
    if (!isObject(first)) {
      throw new HtagParseError(
        `HTAG ${endpoint} array element is not an object.`,
        endpoint,
      );
    }
    return first;
  }
  if (!isObject(response)) {
    throw new HtagParseError(
      `HTAG ${endpoint} response is not an object.`,
      endpoint,
    );
  }
  const results = response.results;
  if (Array.isArray(results)) {
    if (results.length === 0) {
      throw new HtagParseError(
        `HTAG ${endpoint} returned { results: [] }.`,
        endpoint,
      );
    }
    const first = results[0];
    if (!isObject(first)) {
      throw new HtagParseError(
        `HTAG ${endpoint} results[0] is not an object.`,
        endpoint,
      );
    }
    return first;
  }
  // Fall back to treating the response itself as the flat record — useful
  // for the debug endpoint and for hypothetical non-wrapped shapes.
  return response;
}

export function resultArray(
  response: unknown,
  endpoint: string,
): Record<string, unknown>[] {
  if (Array.isArray(response)) {
    return response.filter(isObject) as Record<string, unknown>[];
  }
  if (isObject(response) && Array.isArray(response.results)) {
    return (response.results as unknown[]).filter(isObject) as Record<
      string,
      unknown
    >[];
  }
  throw new HtagParseError(
    `HTAG ${endpoint} response is not an array or { results: [...] }.`,
    endpoint,
  );
}

/**
 * Parse AddressGeocodeRecord into our PropertyDetails subject fields.
 * We use this endpoint instead of /address/standardise because geocode
 * returns loc_pid + locality_name + state + postcode in a single call
 * (standardise returns the component address parts but NOT loc_pid).
 */
export interface GeocodeParsed {
  addressKey: string;
  locPid: string;
  suburb: string;
  state: string;
  postcode: string;
  fullAddress: string;
  /** WGS84 decimal degrees. Optional — HTAG's geocode endpoint may or
   *  may not include them depending on the address record. */
  latitude?: number;
  longitude?: number;
}

export function parseGeocode(
  response: unknown,
  endpoint = '/v1/address/geocode',
): GeocodeParsed {
  const row = firstResult(response, endpoint);
  const addressKey = requireString(row, 'address_key', endpoint);
  const locPid = requireString(row, 'loc_pid', endpoint);
  const locality = requireString(row, 'locality_name', endpoint);
  const state = requireString(row, 'state', endpoint);
  const postcode = requireString(row, 'postcode', endpoint);
  const addressLabel = pickString(row, 'address_label');
  const fullAddress =
    addressLabel ?? buildCanonicalAddress(row, locality, state, postcode);
  // Accept several coordinate spellings — HTAG's docs say `latitude`/
  // `longitude` but a couple of live responses have been seen with
  // `lat`/`lng` or `lat`/`lon`. Nested `geometry.coordinates` is the
  // GeoJSON convention and is worth trying as a last resort.
  let latitude = pickNumber(row, 'latitude', 'lat', 'y');
  let longitude = pickNumber(row, 'longitude', 'lng', 'lon', 'x');
  if ((latitude == null || longitude == null) && isObject(row.geometry)) {
    const coords = (row.geometry as Record<string, unknown>).coordinates;
    if (Array.isArray(coords) && coords.length >= 2) {
      // GeoJSON is [lng, lat]
      const [lng, lat] = coords;
      if (typeof lat === 'number' && Number.isFinite(lat)) latitude = lat;
      if (typeof lng === 'number' && Number.isFinite(lng)) longitude = lng;
    }
  }
  return {
    addressKey,
    locPid,
    suburb: locality,
    state,
    postcode,
    fullAddress,
    latitude,
    longitude,
  };
}

/**
 * Parse AddressPropertyRecord. All physical attribute fields are optional
 * on the HTAG spec, so the subject is usable even if the summary endpoint
 * 404s for a given address_key.
 */
export interface PropertySummaryParsed {
  bedrooms?: number;
  bathrooms?: number;
  carSpaces?: number;
  landAreaSqm?: number;
  floorAreaSqm?: number;
  yearBuilt?: number;
  propertyType?: PropertyDetails['propertyType'];
}

export function parsePropertySummary(
  response: unknown,
  endpoint = '/v1/property/summary',
): PropertySummaryParsed {
  const row = firstResult(response, endpoint);
  const buildDate = pickString(row, 'build_reno_date');
  const yearFromBuildDate = buildDate
    ? Number.parseInt(buildDate.slice(0, 4), 10)
    : NaN;
  return {
    bedrooms: pickInteger(row, 'beds'),
    bathrooms: pickInteger(row, 'baths'),
    carSpaces: pickInteger(row, 'parking'),
    landAreaSqm: pickNumber(row, 'lot_size'),
    floorAreaSqm: pickNumber(row, 'floor_area'),
    yearBuilt: Number.isFinite(yearFromBuildDate) ? yearFromBuildDate : undefined,
    propertyType: normalisePropertyType(pickString(row, 'property_type')),
  };
}

/**
 * Parse PropertySoldSearchResponse rows into our Comparable shape.
 *
 * Field-name reality check: HTAG's published OpenAPI spec calls the
 * fields `sale_price`, `sale_date`, and `address`. The live API actually
 * returns `sold_price`, `sold_date`, and `street_address` (verified
 * against /v1/property/sold/search responses for Stanhope Gardens NSW
 * 2768 on 2026-04-22). We accept both — live names first.
 *
 * Dedup: HTAG occasionally returns the same physical sale twice with
 * different address_keys — typically a street-type spelling variant
 * ("18 Spicebush GLADE" vs "18 Spicebush Gld"). Two genuinely distinct
 * properties selling for the exact same dollar amount on the exact same
 * day is statistically vanishingly rare, so we dedup by
 * (sold_price, sold_date) and keep the first occurrence.
 *
 * HTAG does NOT return a per-comp adjustment_factor here — that's a
 * separate (paid, Restricted-tier) endpoint. Comparables fall through
 * to the heuristic similarity adjustment in lib/cma/compute.ts.
 */
export function parseSoldSearch(
  response: unknown,
  endpoint = '/v1/property/sold/search',
): Comparable[] {
  const rows = resultArray(response, endpoint);
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    const addressKey = pickString(row, 'address_key');
    const salePrice = pickNumber(row, 'sold_price', 'sale_price');
    const saleDate = pickString(row, 'sold_date', 'sale_date');
    const fullAddress =
      buildSoldFullAddress(row) ?? pickString(row, 'address');
    if (!addressKey || !fullAddress || salePrice == null || !saleDate) {
      return [];
    }
    const dedupKey = `${salePrice}|${saleDate}`;
    if (seen.has(dedupKey)) return [];
    seen.add(dedupKey);
    return [
      {
        addressKey,
        fullAddress,
        salePrice,
        saleDateIso: saleDate,
        landAreaSqm: pickNumber(row, 'land_area'),
        floorAreaSqm: pickNumber(row, 'floor_area'),
        bedrooms: pickInteger(row, 'bedrooms'),
        bathrooms: pickInteger(row, 'bathrooms'),
        carSpaces: pickInteger(row, 'car_spaces'),
        distanceKm: pickNumber(row, 'distance_km'),
        propertyType: normalisePropertyType(pickString(row, 'property_type')),
      } satisfies Comparable,
    ];
  });
}

function buildSoldFullAddress(
  row: Record<string, unknown>,
): string | undefined {
  const street = pickString(row, 'street_address', 'address');
  if (!street) return undefined;
  const cleaned = street.trim().replace(/\s+/g, ' ');
  const suburb = pickString(row, 'suburb');
  const state = pickString(row, 'state');
  const postcode = pickString(row, 'postcode');
  const stateAndPost = [state, postcode].filter(Boolean).join(' ');
  const tail = [suburb, stateAndPost].filter(Boolean).join(', ');
  // Only append suburb/state/postcode if the street string doesn't
  // already include them (some HTAG responses send a fully-formatted
  // address in `address`, others send only the street part in
  // `street_address`).
  if (tail && !cleaned.toLowerCase().includes((suburb ?? '').toLowerCase())) {
    return `${cleaned}, ${tail}`;
  }
  return cleaned;
}

/**
 * Parsed market context, populated one field at a time from the four
 * market endpoints. Everything is optional up front; the client caller
 * merges them and fills in sensible defaults for anything HTAG didn't
 * return.
 */
export interface MarketContextParts {
  typicalPrice?: number;
  medianSalePrice?: number;
  annualisedGrowth5y?: number;
  cycleStage?: CycleStage;
  cycleRaw?: string;
  typicalDaysOnMarket?: number;
}

export function parseMarketSummary(
  response: unknown,
  endpoint = '/v1/markets/summary',
): Pick<MarketContextParts, 'typicalPrice' | 'medianSalePrice'> {
  const row = firstResult(response, endpoint);
  return {
    typicalPrice: pickNumber(row, 'typical_price'),
    // HTAG spec doesn't name a separate median_sale_price field on this
    // endpoint, but some deployments expose it. Optional either way.
    medianSalePrice: pickNumber(row, 'median_sale_price'),
  };
}

export function parseMarketGrowthAnnualised(
  response: unknown,
  endpoint = '/v1/markets/growth/annualised',
): Pick<MarketContextParts, 'annualisedGrowth5y'> {
  const row = firstResult(response, endpoint);
  const raw = pickNumber(row, 'price_5y_growth_annualised');
  if (raw == null) return { annualisedGrowth5y: undefined };
  // HTAG may return either a decimal fraction (0.072) or a percentage
  // (7.2). Anything with absolute value > 1 is treated as a percent and
  // scaled down. Real growth rates are never > 100% p.a., so this is
  // safe.
  const annualised = Math.abs(raw) > 1 ? raw / 100 : raw;
  return { annualisedGrowth5y: annualised };
}

export function parseMarketCycle(
  response: unknown,
  endpoint = '/v1/markets/cycle',
): Pick<MarketContextParts, 'cycleStage' | 'cycleRaw'> {
  const row = firstResult(response, endpoint);
  const raw = pickString(row, 'growth_rate_cycle');
  return { cycleStage: mapCycleString(raw), cycleRaw: raw };
}

export function parseMarketDemand(
  response: unknown,
  endpoint = '/v1/markets/demand',
): Pick<MarketContextParts, 'typicalDaysOnMarket'> {
  const row = firstResult(response, endpoint);
  return { typicalDaysOnMarket: pickNumber(row, 'dom') };
}

/**
 * Merge the four parsed market-endpoint parts into the MarketContext the
 * rest of the app expects. Missing values get conservative defaults:
 * - annualisedGrowth5y → 0.04 (4%, a cautious national baseline)
 * - cycleStage        → 'Peaking' (0% cycle stretch — don't lean in)
 * - typicalDaysOnMarket → 42 (generic Australian median)
 *
 * These are only used if HTAG actually returned null for that field;
 * normally every market call succeeds and we use the live value.
 */
export function buildMarketContext(args: {
  parts: MarketContextParts;
  subject: PropertyDetails;
  endpoint: string;
}): MarketContext {
  const { parts, subject } = args;
  return {
    locPid: subject.locPid,
    suburb: subject.suburb,
    state: subject.state,
    annualisedGrowth5y: parts.annualisedGrowth5y ?? 0.04,
    cycleStage: parts.cycleStage ?? 'Peaking',
    typicalDaysOnMarket: parts.typicalDaysOnMarket ?? 42,
    typicalPrice: parts.typicalPrice,
    medianSalePrice: parts.medianSalePrice,
  };
}

/**
 * Map HTAG's growth_rate_cycle string to our internal CycleStage. HTAG
 * doesn't enumerate the values in the spec — we've seen terminology
 * variants in the wild, so match loosely. Unknown inputs fall back to
 * 'Peaking' (0% cycle stretch — conservative).
 */
export function mapCycleString(raw: string | undefined): CycleStage | undefined {
  if (!raw) return undefined;
  const s = raw.toLowerCase();
  if (/recov|trough|bottom/.test(s)) return 'Recovery';
  if (/ris|expan|upswing|growth/.test(s)) return 'Rising';
  if (/peak|plateau/.test(s)) return 'Peaking';
  if (/corr|contr|declin|downturn|cooling/.test(s)) return 'Correction';
  return undefined;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  endpoint: string,
): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new HtagParseError(
      `HTAG ${endpoint} response missing required string field '${key}'. Got keys: [${Object.keys(
        obj,
      ).join(', ')}]`,
      endpoint,
    );
  }
  return v;
}

function pickString(
  obj: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function pickNumber(
  obj: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

function pickInteger(
  obj: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  const n = pickNumber(obj, ...keys);
  return n != null ? Math.round(n) : undefined;
}

function normalisePropertyType(
  raw: string | undefined,
): PropertyDetails['propertyType'] {
  if (!raw) return undefined;
  const s = raw.toLowerCase();
  // Order matters: "townhouse" contains "house", so town/semi must be
  // matched first.
  if (s.includes('town') || s.includes('semi')) return 'Townhouse';
  if (s.includes('unit') || s.includes('apartment')) return 'Unit';
  if (s.includes('house')) return 'House';
  return 'Other';
}

function buildCanonicalAddress(
  row: Record<string, unknown>,
  locality: string,
  state: string,
  postcode: string,
): string {
  const num = pickString(row, 'number_first', 'number_last');
  const streetName = pickString(row, 'street_name');
  const streetType = pickString(row, 'street_type');
  const street = [streetName, streetType].filter(Boolean).join(' ');
  const head = [num, street].filter(Boolean).join(' ');
  return [head, locality, `${state} ${postcode}`].filter(Boolean).join(', ');
}
