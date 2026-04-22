import type {
  Comparable,
  MarketContext,
  PropertyDetails,
} from '@/lib/types';
import {
  MOCK_COMPARABLES,
  MOCK_MARKET,
  MOCK_SUBJECT,
} from '@/lib/htag/mock';

export function isMockMode(): boolean {
  return (process.env.MOCK_DATA ?? 'true').toLowerCase() !== 'false';
}

class HtagError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'HtagError';
  }
}

function baseUrl(): string {
  return process.env.HTAG_API_BASE_URL ?? 'https://api.prod.htagai.com';
}

function authHeaders(): Record<string, string> {
  const key = process.env.HTAG_API_KEY;
  if (!key) throw new HtagError('HTAG_API_KEY is not set but MOCK_DATA=false');
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

async function htagFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const url = `${baseUrl()}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers ?? {}) },
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HtagError(
      `HTAG ${init.method ?? 'GET'} ${path} failed: ${res.status} ${res.statusText} ${body}`.trim(),
      res.status,
    );
  }
  return (await res.json()) as T;
}

export async function getSubjectProperty(
  address: string,
): Promise<PropertyDetails> {
  if (isMockMode()) {
    return { ...MOCK_SUBJECT, fullAddress: address || MOCK_SUBJECT.fullAddress };
  }

  // TODO(htag-live): confirm standardise endpoint path and response fields.
  // The live schema may use e.g. `address_id` / `pid` instead of
  // `address_key` / `loc_pid`, and nested objects under a `result` key.
  const standardised = await htagFetch<{
    address_key: string;
    formatted_address: string;
    suburb: string;
    state: string;
    postcode: string;
    loc_pid: string;
  }>(`/v1/address/standardise`, {
    method: 'POST',
    body: JSON.stringify({ address }),
  });

  // TODO(htag-live): confirm property summary endpoint + field names.
  const summary = await htagFetch<{
    land_area_sqm?: number;
    bedrooms?: number;
    bathrooms?: number;
    car_spaces?: number;
    year_built?: number;
    property_type?: string;
  }>(`/v1/property/${encodeURIComponent(standardised.address_key)}/summary`);

  return {
    addressKey: standardised.address_key,
    fullAddress: standardised.formatted_address,
    suburb: standardised.suburb,
    state: standardised.state,
    postcode: standardised.postcode,
    locPid: standardised.loc_pid,
    landAreaSqm: summary.land_area_sqm,
    bedrooms: summary.bedrooms,
    bathrooms: summary.bathrooms,
    carSpaces: summary.car_spaces,
    yearBuilt: summary.year_built,
    propertyType: normalisePropertyType(summary.property_type),
  };
}

export async function getComparables(
  subject: PropertyDetails,
): Promise<Comparable[]> {
  if (isMockMode()) return MOCK_COMPARABLES;

  // TODO(htag-live): confirm the sold-search endpoint path, request body
  // shape (radius / months / property_type), and results field name.
  const body = {
    address_key: subject.addressKey,
    loc_pid: subject.locPid,
    radius_km: 2,
    months_back: 6,
    property_type: subject.propertyType ?? 'House',
    limit: 12,
  };

  const response = await htagFetch<{
    results: Array<{
      address_key: string;
      formatted_address: string;
      sale_price: number;
      sale_date: string;
      land_area_sqm?: number;
      bedrooms?: number;
      bathrooms?: number;
      car_spaces?: number;
      distance_km?: number;
      adjustment_factor?: number;
      property_type?: string;
    }>;
  }>(`/v1/property/sold/search`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  return response.results.map((r) => ({
    addressKey: r.address_key,
    fullAddress: r.formatted_address,
    salePrice: r.sale_price,
    saleDateIso: r.sale_date,
    landAreaSqm: r.land_area_sqm,
    bedrooms: r.bedrooms,
    bathrooms: r.bathrooms,
    carSpaces: r.car_spaces,
    distanceKm: r.distance_km,
    htagAdjustmentFactor: r.adjustment_factor,
    propertyType: normalisePropertyType(r.property_type),
  }));
}

export async function getMarketContext(
  subject: PropertyDetails,
): Promise<MarketContext> {
  if (isMockMode()) return MOCK_MARKET;

  // TODO(htag-live): confirm whether the market endpoints accept loc_pid as
  // a query param or a body field, and confirm response field names. Calls
  // are run in parallel; each expected to return the single field noted.
  const locPid = subject.locPid;
  const query = `?loc_pid=${encodeURIComponent(locPid)}`;

  const [growth, cycle, demand, summary] = await Promise.all([
    htagFetch<{ annualised_5y: number }>(`/v1/markets/growth/annualised${query}`),
    htagFetch<{ phase: string }>(`/v1/markets/cycle${query}`),
    htagFetch<{ days_on_market: number }>(`/v1/markets/demand${query}`),
    htagFetch<{ typical_price?: number; median_sale_price?: number }>(
      `/v1/markets/summary${query}`,
    ),
  ]);

  return {
    locPid,
    suburb: subject.suburb,
    state: subject.state,
    annualisedGrowth5y: growth.annualised_5y,
    cycleStage: normaliseCycleStage(cycle.phase),
    typicalDaysOnMarket: demand.days_on_market,
    typicalPrice: summary.typical_price,
    medianSalePrice: summary.median_sale_price,
  };
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
