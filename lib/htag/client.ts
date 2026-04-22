import type {
  Comparable,
  MarketContext,
  PropertyDetails,
} from '@/lib/types';
import { PROFILES, pickProfile, profileByLocPid } from '@/lib/htag/mock';

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
  return process.env.HTAG_API_BASE_URL ?? 'https://api.prod.htagai.com';
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
  // TODO(htag-live): HTAG's docs describe one auth header but we send both
  // variants here until the live API confirms which one is correct. Remove
  // the unused header once verified.
  return {
    'X-API-Key': key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

/**
 * Low-level HTAG fetch: auth headers, error surfacing with endpoint
 * context, and a structured log line on every call when live. Exported so
 * the debug route can hit endpoints without the normalization layer.
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

  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { ...authHeaders(), ...(init.headers ?? {}) },
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

  // HTAG's standardise endpoint is a batch: the request takes an
  // `addresses` array and the response is also array-shaped. We still
  // only ever send one address at a time, so we unwrap results[0].
  const standardisePath = '/v1/address/standardise';
  const standardiseResponse = await rawHtagFetch<Record<string, unknown>>(
    standardisePath,
    { method: 'POST', body: JSON.stringify({ addresses: [address] }) },
  );
  const standardised = unwrapBatchResult(standardiseResponse, standardisePath);

  const addressKey = requireString(standardised, 'address_key', standardisePath);
  const fullAddress = requireString(standardised, 'formatted_address', standardisePath);
  const suburb = requireString(standardised, 'suburb', standardisePath);
  const state = requireString(standardised, 'state', standardisePath);
  const postcode = requireString(standardised, 'postcode', standardisePath);
  const locPid = requireString(standardised, 'loc_pid', standardisePath);

  // TODO(htag-live): confirm property summary endpoint + field names.
  const summaryPath = `/v1/property/${encodeURIComponent(addressKey)}/summary`;
  const summary = await rawHtagFetch<Record<string, unknown>>(summaryPath);

  return {
    addressKey,
    fullAddress,
    suburb,
    state,
    postcode,
    locPid,
    landAreaSqm: optionalNumber(summary, 'land_area_sqm'),
    bedrooms: optionalNumber(summary, 'bedrooms'),
    bathrooms: optionalNumber(summary, 'bathrooms'),
    carSpaces: optionalNumber(summary, 'car_spaces'),
    yearBuilt: optionalNumber(summary, 'year_built'),
    propertyType: normalisePropertyType(optionalString(summary, 'property_type')),
  };
}

export async function getComparables(
  subject: PropertyDetails,
): Promise<Comparable[]> {
  if (isMockMode()) {
    return (profileByLocPid(subject.locPid) ?? PROFILES.baulkham).comparables;
  }

  // TODO(htag-live): confirm the sold-search endpoint path, request body
  // shape (radius / months / property_type), and results field name.
  const path = '/v1/property/sold/search';
  const body = {
    address_key: subject.addressKey,
    loc_pid: subject.locPid,
    radius_km: 2,
    months_back: 6,
    property_type: subject.propertyType ?? 'House',
    limit: 12,
  };

  const response = await rawHtagFetch<Record<string, unknown>>(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const results = response.results;
  if (!Array.isArray(results)) {
    throw new HtagError(
      `HTAG ${path} response missing 'results' array. Got keys: [${topLevelKeys(
        response,
      ).join(', ')}]`,
      path,
    );
  }

  return results.map((raw, idx) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new HtagError(
        `HTAG ${path} results[${idx}] is not an object.`,
        path,
      );
    }
    const r = raw as Record<string, unknown>;
    return {
      addressKey: requireString(r, 'address_key', `${path} results[${idx}]`),
      fullAddress: requireString(r, 'formatted_address', `${path} results[${idx}]`),
      salePrice: requireNumber(r, 'sale_price', `${path} results[${idx}]`),
      saleDateIso: requireString(r, 'sale_date', `${path} results[${idx}]`),
      landAreaSqm: optionalNumber(r, 'land_area_sqm'),
      bedrooms: optionalNumber(r, 'bedrooms'),
      bathrooms: optionalNumber(r, 'bathrooms'),
      carSpaces: optionalNumber(r, 'car_spaces'),
      distanceKm: optionalNumber(r, 'distance_km'),
      htagAdjustmentFactor: optionalNumber(r, 'adjustment_factor'),
      propertyType: normalisePropertyType(optionalString(r, 'property_type')),
    };
  });
}

export async function getMarketContext(
  subject: PropertyDetails,
): Promise<MarketContext> {
  if (isMockMode()) {
    return (profileByLocPid(subject.locPid) ?? PROFILES.baulkham).market;
  }

  // TODO(htag-live): confirm whether the market endpoints accept loc_pid as
  // a query param or a body field, and confirm response field names. Calls
  // are run in parallel; each expected to return the single field noted.
  const locPid = subject.locPid;
  const query = `?loc_pid=${encodeURIComponent(locPid)}`;
  const growthPath = `/v1/markets/growth/annualised${query}`;
  const cyclePath = `/v1/markets/cycle${query}`;
  const demandPath = `/v1/markets/demand${query}`;
  const summaryPath = `/v1/markets/summary${query}`;

  const [growth, cycle, demand, summary] = await Promise.all([
    rawHtagFetch<Record<string, unknown>>(growthPath),
    rawHtagFetch<Record<string, unknown>>(cyclePath),
    rawHtagFetch<Record<string, unknown>>(demandPath),
    rawHtagFetch<Record<string, unknown>>(summaryPath),
  ]);

  return {
    locPid,
    suburb: subject.suburb,
    state: subject.state,
    annualisedGrowth5y: requireNumber(growth, 'annualised_5y', growthPath),
    cycleStage: normaliseCycleStage(requireString(cycle, 'phase', cyclePath)),
    typicalDaysOnMarket: requireNumber(demand, 'days_on_market', demandPath),
    typicalPrice: optionalNumber(summary, 'typical_price'),
    medianSalePrice: optionalNumber(summary, 'median_sale_price'),
  };
}

function logHtag(info: {
  method: string;
  path: string;
  status: number;
  ms: number;
  keys: string[];
  error?: string;
}): void {
  // Structured JSON line — easy to parse in Vercel log search.
  // Doesn't log body content (PII/data sensitivity); only top-level keys
  // so you can spot field-name mismatches.
  console.log(
    JSON.stringify({
      tag: 'htag',
      ...info,
    }),
  );
}

function topLevelKeys(value: unknown): string[] {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return Object.keys(value).slice(0, 20);
  }
  return [];
}

/**
 * HTAG's batch-shaped endpoints (e.g. standardise) return either a bare
 * array or an object wrapping an array under `results`/`data`/`addresses`.
 * We send a single-element request every time, so unwrap to the first
 * element. If no array wrapping is found we return the raw object, so
 * a flat single-result response still works.
 */
function unwrapBatchResult(
  response: unknown,
  endpoint: string,
): Record<string, unknown> {
  if (Array.isArray(response)) {
    if (response.length === 0) {
      throw new HtagError(
        `HTAG ${endpoint} returned an empty array.`,
        endpoint,
      );
    }
    const first = response[0];
    if (typeof first === 'object' && first !== null) {
      return first as Record<string, unknown>;
    }
    throw new HtagError(
      `HTAG ${endpoint} array element is not an object.`,
      endpoint,
    );
  }
  if (typeof response === 'object' && response !== null) {
    const obj = response as Record<string, unknown>;
    for (const key of ['results', 'data', 'addresses']) {
      const inner = obj[key];
      if (Array.isArray(inner) && inner.length > 0) {
        const first = inner[0];
        if (typeof first === 'object' && first !== null) {
          return first as Record<string, unknown>;
        }
      }
    }
    return obj;
  }
  throw new HtagError(
    `HTAG ${endpoint} response is not an object or array.`,
    endpoint,
  );
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  endpoint: string,
): string {
  const v = obj[key];
  if (typeof v !== 'string' || !v) {
    throw new HtagError(
      `HTAG ${endpoint} response missing required string field '${key}'. Got keys: [${topLevelKeys(
        obj,
      ).join(', ')}]`,
      endpoint,
    );
  }
  return v;
}

function requireNumber(
  obj: Record<string, unknown>,
  key: string,
  endpoint: string,
): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new HtagError(
      `HTAG ${endpoint} response missing required number field '${key}'. Got keys: [${topLevelKeys(
        obj,
      ).join(', ')}]`,
      endpoint,
    );
  }
  return v;
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  return typeof v === 'string' && v ? v : undefined;
}

function optionalNumber(
  obj: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function normalisePropertyType(
  raw: string | undefined,
): PropertyDetails['propertyType'] {
  if (!raw) return undefined;
  const s = raw.toLowerCase();
  if (s.includes('house')) return 'House';
  if (s.includes('unit') || s.includes('apartment')) return 'Unit';
  if (s.includes('town')) return 'Townhouse';
  return 'Other';
}

function normaliseCycleStage(raw: string): MarketContext['cycleStage'] {
  const s = (raw ?? '').toLowerCase();
  if (s.startsWith('recov')) return 'Recovery';
  if (s.startsWith('ris')) return 'Rising';
  if (s.startsWith('peak')) return 'Peaking';
  if (s.startsWith('corr')) return 'Correction';
  return 'Rising';
}
