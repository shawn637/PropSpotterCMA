/**
 * ABS 2021 SEIFA (Socio-Economic Indexes for Areas) at SA1.
 * Separate ArcGIS service from G37 — note the services-ap1 subdomain
 * (not services1) and the single layer at /0 (not /5) because this
 * service is already partitioned to SA1 by name.
 *
 * Service URL:
 *   https://services-ap1.arcgis.com/ypkPEy1AmwPKGNNv/arcgis/rest/
 *   services/ABS_Socio_Economic_Indexes_for_Areas_SEIFA_by_2021_SA1/
 *   FeatureServer/0/query
 *
 * Same fail-soft, fail-fast pattern as lib/abs/client.ts. Every
 * return path hands the caller a usable shape (profile | null) plus
 * an optional error string.
 */

import type { SeifaProfile } from '@/lib/types';

const BASE_URL =
  'https://services-ap1.arcgis.com/ypkPEy1AmwPKGNNv/arcgis/rest/services/ABS_Socio_Economic_Indexes_for_Areas_SEIFA_by_2021_SA1/FeatureServer/0/query';

const TIMEOUT_MS = 5_000;

export interface SeifaFetchResult {
  profile: SeifaProfile | null;
  error?: string;
}

export async function fetchSeifaByPoint(
  latitude: number,
  longitude: number,
): Promise<SeifaFetchResult> {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return { profile: null, error: 'invalid lat/lng' };
  }

  const geometry = JSON.stringify({
    x: longitude,
    y: latitude,
    spatialReference: { wkid: 4326 },
  });
  // outFields=* — field naming on ABS beta services drifts and
  // specific-field requests that reference an unknown column get
  // "Cannot perform query. Invalid query parameters." (same failure
  // mode we hit on G37 before switching to *).
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
  const url = `${BASE_URL}?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      logSeifa({
        lat: latitude,
        lng: longitude,
        status: res.status,
        ms: Date.now() - startedAt,
        error: `upstream ${res.status}`,
      });
      return {
        profile: null,
        error: `ABS SEIFA upstream ${res.status} ${res.statusText}`,
      };
    }
    const json = (await res.json()) as unknown;
    try {
      const profile = parseSeifaResponse(json);
      logSeifa({
        lat: latitude,
        lng: longitude,
        status: res.status,
        ms: Date.now() - startedAt,
        sa1: profile?.sa1Code,
        irsdDecile: profile?.irsd.decileAus,
        irsadDecile: profile?.irsad.decileAus,
      });
      return { profile };
    } catch (parseErr) {
      const reason =
        parseErr instanceof Error ? parseErr.message : String(parseErr);
      const firstFeatureKeys = firstFeatureAttributeKeys(json);
      logSeifa({
        lat: latitude,
        lng: longitude,
        status: res.status,
        ms: Date.now() - startedAt,
        error: reason,
        firstFeatureKeys,
      });
      return { profile: null, error: reason };
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
    logSeifa({
      lat: latitude,
      lng: longitude,
      status: -1,
      ms: Date.now() - startedAt,
      error: reason,
    });
    return { profile: null, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

export class SeifaParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeifaParseError';
  }
}

/**
 * Parse the SEIFA FeatureServer response into a SeifaProfile. Tolerant
 * to multiple field-name conventions — the ABS beta services have
 * shipped the same logical column under several spellings
 * (IRSD_Score vs IRSD, IRSAD_Decile_Aust vs IRSAD_DECILE). Every
 * variant we've seen or suspect is listed so minor schema drift
 * doesn't break the card.
 */
export function parseSeifaResponse(response: unknown): SeifaProfile | null {
  if (!isObject(response)) {
    throw new SeifaParseError('SEIFA response is not an object');
  }
  if (isObject(response.error)) {
    const msg =
      pickString(response.error, 'message') ??
      `HTTP layer error (${pickNumber(response.error, 'code') ?? 'unknown'})`;
    throw new SeifaParseError(`SEIFA error: ${msg}`);
  }
  const features = Array.isArray(response.features) ? response.features : null;
  if (!features || features.length === 0) return null;

  const feature = features[0];
  if (!isObject(feature) || !isObject(feature.attributes)) {
    throw new SeifaParseError('SEIFA feature has no attributes object');
  }
  const attrs = feature.attributes;

  const sa1Code = pickString(
    attrs,
    'SA1_CODE_2021',
    'SA1_CODE21',
    'SA1_CODE',
    'SA1_MAINCODE_2021',
    'SA1_MAIN_2021',
  );
  if (!sa1Code) {
    throw new SeifaParseError(
      `SEIFA attributes missing SA1 code; keys=[${Object.keys(attrs).slice(0, 30).join(', ')}]`,
    );
  }

  const index = (prefix: string) => ({
    score:
      pickNumber(
        attrs,
        `${prefix}_Score`,
        `${prefix}_SCORE`,
        `${prefix}Score`,
        prefix,
      ) ?? 0,
    decileAus:
      pickNumber(
        attrs,
        `${prefix}_Decile_Aust`,
        `${prefix}_DECILE_AUS`,
        `${prefix}_Decile_AUST`,
        `${prefix}_Decile`,
        `${prefix}_DECILE`,
      ) ?? 0,
  });

  const irsd = index('IRSD');
  const irsad = index('IRSAD');
  const ier = index('IER');
  const ieo = index('IEO');

  // An unpopulated SA1 can return all zeros; treat that as "no profile"
  // rather than mis-render an IRSD decile of 0 (which isn't a real
  // decile — valid deciles are 1-10).
  if (
    irsd.score === 0 &&
    irsad.score === 0 &&
    ier.score === 0 &&
    ieo.score === 0
  ) {
    return null;
  }

  return { sa1Code, irsd, irsad, ier, ieo };
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

function logSeifa(info: {
  lat: number;
  lng: number;
  status: number;
  ms: number;
  sa1?: string;
  irsdDecile?: number;
  irsadDecile?: number;
  error?: string;
  firstFeatureKeys?: string[];
}): void {
  console.log(JSON.stringify({ tag: 'abs-seifa', ...info }));
}
