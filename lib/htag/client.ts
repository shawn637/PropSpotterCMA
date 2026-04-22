import type {
  Comparable,
  MarketContext,
  PropertyDetails,
} from '@/lib/types';
import { PROFILES, pickProfile, profileByLocPid } from '@/lib/htag/mock';
import {
  HtagParseError,
  buildMarketContext,
  parseGeocode,
  parseMarketCycle,
  parseMarketDemand,
  parseMarketGrowthAnnualised,
  parseMarketSummary,
  parsePropertySummary,
  parseSoldSearch,
} from '@/lib/htag/parse';

export function isMockMode(): boolean {
  return (process.env.MOCK_DATA ?? 'true').toLowerCase() !== 'false';
}

export class HtagError extends Error {
  constructor(
    message: string,
    readonly endpoint: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'HtagError';
  }
}

function baseUrl(): string {
  // HTAG production base per the official OpenAPI spec. The old default
  // was a guess (api.prod.htagai.com) that happened to resolve.
  return process.env.HTAG_API_BASE_URL ?? 'https://api.htagai.com';
}

function timeoutMillis(): number {
  const raw = process.env.HTAG_TIMEOUT_MS;
  if (!raw) return 10_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10_000;
}

function authHeaders(): Record<string, string> {
  const key = process.env.HTAG_API_KEY;
  if (!key) {
    throw new HtagError(
      'HTAG_API_KEY is not set but MOCK_DATA=false',
      '(config)',
    );
  }
  // HTAG spec: ApiKeyAuth via x-api-key header only. No bearer token.
  return {
    'x-api-key': key,
    Accept: 'application/json',
  };
}

/**
 * Low-level HTAG fetch: auth headers, abort-controller timeout, clear
 * error surfacing with endpoint context, and a structured log line on
 * every call. Exported so the debug route can hit endpoints without the
 * parse layer.
 */
export async function rawHtagFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const method = init.method ?? 'GET';
  const url = `${baseUrl()}${path}`;
  const startedAt = Date.now();
  const timeoutMs = timeoutMillis();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const extraHeaders: Record<string, string> = {};
  if (method !== 'GET' && init.body) {
    extraHeaders['Content-Type'] = 'application/json';
  }

  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { ...authHeaders(), ...extraHeaders, ...(init.headers ?? {}) },
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    const aborted =
      err instanceof Error &&
      (err.name === 'AbortError' || err.message.includes('aborted'));
    const reason = aborted ? `timed out after ${timeoutMs}ms` : String(err);
    logHtag({ method, path, status: 0, ms: elapsed, keys: [], error: reason });
    throw new HtagError(
      `HTAG ${method} ${path} ${aborted ? reason : `network error: ${reason}`}`,
      path,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const elapsed = Date.now() - startedAt;
    logHtag({
      method,
      path,
      status: res.status,
      ms: elapsed,
      keys: [],
      error: body.slice(0, 200),
    });
    throw new HtagError(
      `HTAG ${method} ${path} failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`,
      path,
      res.status,
    );
  }

  const json = (await res.json()) as T;
  const elapsed = Date.now() - startedAt;
  logHtag({
    method,
    path,
    status: res.status,
    ms: elapsed,
    keys: topLevelKeys(json),
  });
  return json;
}

/**
 * Resolve address identity + physical attributes.
 *
 * HTAG splits this into two calls:
 *   GET /v1/address/geocode?address=…         → canonical identity + loc_pid
 *   GET /v1/property/summary?address_key=…    → physical attributes (optional)
 *
 * If the property summary 404s (not every HTAG address has attributes),
 * we still return a usable PropertyDetails from geocode alone; the CMA
 * math falls back to heuristic similarity adjustments without bedrooms
 * / land size.
 */
export async function getSubjectProperty(
  address: string,
): Promise<PropertyDetails> {
  if (isMockMode()) {
    const profile = pickProfile(address);
    return {
      ...profile.subject,
      fullAddress: address || profile.subject.fullAddress,
    };
  }

  const geocodePath = `/v1/address/geocode?address=${encodeURIComponent(address)}`;
  const geocodeResponse = await rawHtagFetch<unknown>(geocodePath);
  const geocode = rewrapParseError(() =>
    parseGeocode(geocodeResponse, geocodePath),
  );

  const summaryPath = `/v1/property/summary?address_key=${encodeURIComponent(geocode.addressKey)}`;
  let summary;
  try {
    const summaryResponse = await rawHtagFetch<unknown>(summaryPath);
    summary = parsePropertySummary(summaryResponse, summaryPath);
  } catch (err) {
    // 404 is acceptable: HTAG has the address but no attribute record.
    // Anything else (500, parse error, etc.) should still surface.
    if (err instanceof HtagError && err.status === 404) {
      summary = {};
    } else if (err instanceof HtagParseError) {
      throw new HtagError(err.message, err.endpoint);
    } else {
      throw err;
    }
  }

  return {
    addressKey: geocode.addressKey,
    fullAddress: geocode.fullAddress,
    suburb: geocode.suburb,
    state: geocode.state,
    postcode: geocode.postcode,
    locPid: geocode.locPid,
    bedrooms: summary.bedrooms,
    bathrooms: summary.bathrooms,
    carSpaces: summary.carSpaces,
    landAreaSqm: summary.landAreaSqm,
    yearBuilt: summary.yearBuilt,
    propertyType: summary.propertyType,
  };
}

export async function getComparables(
  subject: PropertyDetails,
): Promise<Comparable[]> {
  if (isMockMode()) {
    return (profileByLocPid(subject.locPid) ?? PROFILES.baulkham).comparables;
  }

  // GET /v1/property/sold/search with query params. Restrict to the
  // subject's suburb (proximity=sameSuburb) rather than radius-only so
  // we don't pull sales from a neighbouring locality with a different
  // market profile. saleFromDate is 6 months back.
  const propertyType = (subject.propertyType ?? 'house').toLowerCase();
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6);
  const params = new URLSearchParams({
    address_key: subject.addressKey,
    proximity: 'sameSuburb',
    propertyType,
    saleFromDate: sixMonthsAgo.toISOString().slice(0, 10),
    limit: '12',
  });
  const path = `/v1/property/sold/search?${params.toString()}`;
  const response = await rawHtagFetch<unknown>(path);
  return rewrapParseError(() => parseSoldSearch(response, path));
}

export async function getMarketContext(
  subject: PropertyDetails,
): Promise<MarketContext> {
  if (isMockMode()) {
    return (profileByLocPid(subject.locPid) ?? PROFILES.baulkham).market;
  }

  // All four market endpoints require level + area_id (as an array,
  // though we only ever ask for one). We slice by property_type=house
  // to stay consistent with the subject default; unit/townhouse subjects
  // will need a separate pass if we ever wire them up.
  const params = new URLSearchParams({
    level: 'suburb',
    area_id: subject.locPid,
    property_type: (subject.propertyType ?? 'house').toLowerCase(),
  });
  const summaryPath = `/v1/markets/summary?${params.toString()}`;
  const growthPath = `/v1/markets/growth/annualised?${params.toString()}`;
  const cyclePath = `/v1/markets/cycle?${params.toString()}`;
  const demandPath = `/v1/markets/demand?${params.toString()}`;

  const [summary, growth, cycle, demand] = await Promise.all([
    rawHtagFetch<unknown>(summaryPath),
    rawHtagFetch<unknown>(growthPath),
    rawHtagFetch<unknown>(cyclePath),
    rawHtagFetch<unknown>(demandPath),
  ]);

  return rewrapParseError(() =>
    buildMarketContext({
      subject,
      parts: {
        ...parseMarketSummary(summary, summaryPath),
        ...parseMarketGrowthAnnualised(growth, growthPath),
        ...parseMarketCycle(cycle, cyclePath),
        ...parseMarketDemand(demand, demandPath),
      },
      endpoint: '/v1/markets/*',
    }),
  );
}

function rewrapParseError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof HtagParseError) {
      throw new HtagError(err.message, err.endpoint);
    }
    throw err;
  }
}

function logHtag(info: {
  method: string;
  path: string;
  status: number;
  ms: number;
  keys: string[];
  error?: string;
}): void {
  console.log(JSON.stringify({ tag: 'htag', ...info }));
}

function topLevelKeys(value: unknown): string[] {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return Object.keys(value).slice(0, 20);
  }
  return [];
}
