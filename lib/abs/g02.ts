/**
 * ABS 2021 Census G02 "Selected Medians and Averages" at SA1.
 * Same query pattern as G37 — services1 host, layer 5 for SA1.
 *
 *   https://services1.arcgis.com/v8Kimc579yljmjSP/ArcGIS/rest/
 *   services/ABS_2021_Census_G02_Beta/FeatureServer/5/query
 *
 * Surfaces six fields: median age, median personal / household income
 * weekly, median rent weekly, median mortgage monthly, average
 * household size. Additional G02 columns exist (age-specific medians,
 * etc.) but aren't useful for valuation / investment thesis work.
 */

import type { G02Demographics } from '@/lib/types';

const TIMEOUT_MS = 5_000;

/**
 * Candidate FeatureServer URLs to try in priority order. The G02
 * service's SA1 layer number isn't documented in ABS's public atlas,
 * and our first guess (layer 5, matching G37) returned "Invalid URL"
 * on the live service — meaning that layer doesn't exist on G02.
 *
 * We try each in sequence until one responds without an ArcGIS error
 * envelope. The hit is logged so we can freeze to the winning URL
 * once we've confirmed it in production. Set G02_BASE_URL env to
 * override entirely.
 */
const G02_CANDIDATE_URLS = [
  // services1 host, G02_Beta service, common layer numbers (G37 is at
  // layer 5 but G02 has fewer layers; try the lower ids too).
  'https://services1.arcgis.com/v8Kimc579yljmjSP/ArcGIS/rest/services/ABS_2021_Census_G02_Beta/FeatureServer/3/query',
  'https://services1.arcgis.com/v8Kimc579yljmjSP/ArcGIS/rest/services/ABS_2021_Census_G02_Beta/FeatureServer/4/query',
  'https://services1.arcgis.com/v8Kimc579yljmjSP/ArcGIS/rest/services/ABS_2021_Census_G02_Beta/FeatureServer/0/query',
  'https://services1.arcgis.com/v8Kimc579yljmjSP/ArcGIS/rest/services/ABS_2021_Census_G02_Beta/FeatureServer/1/query',
  'https://services1.arcgis.com/v8Kimc579yljmjSP/ArcGIS/rest/services/ABS_2021_Census_G02_Beta/FeatureServer/2/query',
  // services1 host without _Beta suffix
  'https://services1.arcgis.com/v8Kimc579yljmjSP/ArcGIS/rest/services/ABS_2021_Census_G02/FeatureServer/3/query',
  // services-ap1 host (same as SEIFA's host, for services the ABS
  // team migrated there)
  'https://services-ap1.arcgis.com/ypkPEy1AmwPKGNNv/arcgis/rest/services/ABS_2021_Census_G02_SA1/FeatureServer/0/query',
];

function candidateUrls(): string[] {
  const override = process.env.G02_BASE_URL;
  if (override) return [override];
  return G02_CANDIDATE_URLS;
}

export interface G02FetchResult {
  demographics: G02Demographics | null;
  error?: string;
}

export async function fetchG02ByPoint(
  latitude: number,
  longitude: number,
): Promise<G02FetchResult> {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return { demographics: null, error: 'invalid lat/lng' };
  }

  const geometry = JSON.stringify({
    x: longitude,
    y: latitude,
    spatialReference: { wkid: 4326 },
  });
  const params = new URLSearchParams({
    where: '1=1',
    geometry,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    returnGeometry: 'false',
    f: 'json',
  });
  const query = params.toString();

  // Try each candidate URL in priority order. First non-error
  // response wins. Each attempt is logged so the operator can see
  // which layer id the live service actually uses for SA1.
  const attempts: Array<{ url: string; error: string }> = [];
  for (const base of candidateUrls()) {
    const url = `${base}?${query}`;
    const res = await tryOne(url, latitude, longitude);
    if (res.ok) {
      logG02({
        lat: latitude,
        lng: longitude,
        status: 200,
        ms: res.ms,
        sa1: res.demographics?.sa1Code,
        hhdIncome: res.demographics?.medianHouseholdIncomeWeekly,
        rent: res.demographics?.medianRentWeekly,
        url: base,
        attemptsCount: attempts.length + 1,
      });
      return { demographics: res.demographics };
    }
    attempts.push({ url: base, error: res.error });
  }

  const combinedError = `G02: all ${attempts.length} candidate URLs failed. Latest: ${attempts[attempts.length - 1]?.error ?? 'unknown'}`;
  logG02({
    lat: latitude,
    lng: longitude,
    status: 0,
    ms: 0,
    error: combinedError,
    attempts,
  });
  return { demographics: null, error: combinedError };
}

/**
 * Single-candidate fetch + parse. Returns {ok:true, demographics}
 * only when the service answered 200 with parseable content; any
 * ArcGIS error envelope, non-2xx, or parse exception is surfaced as
 * {ok:false, error} so the outer loop can advance to the next
 * candidate.
 */
async function tryOne(
  url: string,
  latitude: number,
  longitude: number,
): Promise<
  | { ok: true; demographics: G02Demographics | null; ms: number }
  | { ok: false; error: string; ms: number }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    const ms = Date.now() - startedAt;
    if (!res.ok) {
      return { ok: false, error: `upstream ${res.status}`, ms };
    }
    const json = (await res.json()) as unknown;
    try {
      const demographics = parseG02Response(json);
      return { ok: true, demographics, ms };
    } catch (parseErr) {
      const reason =
        parseErr instanceof Error ? parseErr.message : String(parseErr);
      return { ok: false, error: reason, ms };
    }
  } catch (err) {
    const aborted =
      err instanceof Error &&
      (err.name === 'AbortError' || err.message.includes('aborted'));
    const reason = aborted
      ? `timed out after ${TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    return { ok: false, error: reason, ms: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

export class G02ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'G02ParseError';
  }
}

export function parseG02Response(response: unknown): G02Demographics | null {
  if (!isObject(response)) {
    throw new G02ParseError('G02 response is not an object');
  }
  if (isObject(response.error)) {
    const msg =
      pickString(response.error, 'message') ??
      `HTTP layer error (${pickNumber(response.error, 'code') ?? 'unknown'})`;
    throw new G02ParseError(`G02 error: ${msg}`);
  }
  const features = Array.isArray(response.features) ? response.features : null;
  if (!features || features.length === 0) return null;

  const feature = features[0];
  if (!isObject(feature) || !isObject(feature.attributes)) {
    throw new G02ParseError('G02 feature has no attributes object');
  }
  const attrs = feature.attributes;

  const sa1Code = pickString(
    attrs,
    // PascalCase (documented)
    'SA1_CODE_2021',
    'SA1_CODE21',
    'SA1_CODE',
    'SA1_MAINCODE_2021',
    'SA1_MAIN_2021',
    // lowercase (observed live on SEIFA; G02 likely follows same rule)
    'sa1_code_2021',
    'sa1_code21',
    'sa1_code',
    'sa1_maincode_2021',
    'sa1_main_2021',
  );
  if (!sa1Code) {
    throw new G02ParseError(
      `G02 attributes missing SA1 code; keys=[${Object.keys(attrs).slice(0, 30).join(', ')}]`,
    );
  }

  // Each field's variant list covers the common ABS shorthand forms,
  // both PascalCase and lowercase. Missing fields stay undefined —
  // G02 has patchy coverage on some low-population SA1s so missing
  // is normal.
  const medianAge = pickNumber(
    attrs,
    'Median_age_persons',
    'MEDIAN_AGE_PERSONS',
    'Median_Age_Persons',
    'median_age_persons',
  );
  const medianHouseholdIncomeWeekly = pickNumber(
    attrs,
    'Median_tot_hhd_inc_weekly',
    'Median_hhd_inc_wk',
    'Median_Tot_HHD_Inc_Weekly',
    'MEDIAN_HHD_INC_WEEKLY',
    'median_tot_hhd_inc_weekly',
    'median_hhd_inc_wk',
  );
  const medianPersonalIncomeWeekly = pickNumber(
    attrs,
    'Median_tot_prsnl_inc_weekly',
    'Median_prsnl_inc_wk',
    'Median_Tot_Prsnl_Inc_Weekly',
    'MEDIAN_PERSONAL_INC_WEEKLY',
    'median_tot_prsnl_inc_weekly',
    'median_prsnl_inc_wk',
  );
  const medianRentWeekly = pickNumber(
    attrs,
    'Median_rent_weekly',
    'Median_rent_wk',
    'Median_Rent_Weekly',
    'MEDIAN_RENT_WEEKLY',
    'median_rent_weekly',
    'median_rent_wk',
  );
  const medianMortgageMonthly = pickNumber(
    attrs,
    'Median_mortgage_repay_monthly',
    'Median_mortg_mthly',
    'Median_Mortgage_Repay_Monthly',
    'MEDIAN_MORTGAGE_MONTHLY',
    'median_mortgage_repay_monthly',
    'median_mortg_mthly',
  );
  const averageHouseholdSize = pickNumber(
    attrs,
    'Average_household_size',
    'Avg_hhd_size',
    'Average_Household_Size',
    'AVERAGE_HOUSEHOLD_SIZE',
    'average_household_size',
    'avg_hhd_size',
  );

  // Empty SA1s: everything nullish → skip the card rather than
  // render a row of em-dashes.
  if (
    medianAge == null &&
    medianHouseholdIncomeWeekly == null &&
    medianRentWeekly == null &&
    medianMortgageMonthly == null &&
    averageHouseholdSize == null &&
    medianPersonalIncomeWeekly == null
  ) {
    return null;
  }

  return {
    sa1Code,
    medianAge,
    medianHouseholdIncomeWeekly,
    medianPersonalIncomeWeekly,
    medianRentWeekly,
    medianMortgageMonthly,
    averageHouseholdSize,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pickString(
  obj: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
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
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function firstFeatureAttributeKeys(json: unknown): string[] {
  if (
    isObject(json) &&
    Array.isArray((json as { features?: unknown }).features) &&
    ((json as { features: Array<{ attributes?: object }> }).features[0]
      ?.attributes)
  ) {
    return Object.keys(
      (json as { features: Array<{ attributes: object }> }).features[0]
        .attributes,
    ).slice(0, 20);
  }
  return [];
}

function logG02(info: {
  lat: number;
  lng: number;
  status: number;
  ms: number;
  sa1?: string;
  hhdIncome?: number;
  rent?: number;
  error?: string;
  firstFeatureKeys?: string[];
  url?: string;
  attemptsCount?: number;
  attempts?: Array<{ url: string; error: string }>;
}): void {
  console.log(JSON.stringify({ tag: 'abs-g02', ...info }));
}
