/**
 * Thin client for the ABS 2021 Census G37 FeatureServer. No auth
 * required — it's a public ArcGIS endpoint. Given a WGS84 lat/lng we
 * issue a point-in-polygon spatial query against layer 5 (SA1) and
 * return the tenure-share profile.
 *
 * Design notes:
 *   - Fails soft. Every return path hands the caller a usable result
 *     (TenureProfile | null) plus an optional error string, so the
 *     /api/cma route can surface the ABS leg without blowing up the
 *     whole valuation when the FeatureServer is slow, throttled, or
 *     offline.
 *   - 5 s timeout. The service usually responds in ~200-500 ms; a
 *     hang past 5 s is a clearer signal of ABS trouble than waiting
 *     longer.
 *   - Static until the next Census (2026). No need to cache across
 *     valuations within a deployment, but we do skip the fetch
 *     entirely when MOCK_DATA=true since there's no paired mock
 *     subject lat/lng either.
 */

import { parseG37SA1Response } from '@/lib/abs/parse';
import type { TenureProfile } from '@/lib/types';

const BASE_URL =
  'https://services1.arcgis.com/v8Kimc579yljmjSP/ArcGIS/rest/services/ABS_2021_Census_G37_Beta/FeatureServer/5/query';

const TIMEOUT_MS = 5_000;

export interface TenureFetchResult {
  profile: TenureProfile | null;
  error?: string;
}

/**
 * Fetch the G37 SA1 tenure profile for a subject's lat/lng. Returns
 * `{ profile: null }` when the ABS service returns no features
 * (unpopulated SA1, offshore, etc.) or when anything goes wrong —
 * the `error` field tells the caller WHY.
 */
export async function fetchTenureByPoint(
  latitude: number,
  longitude: number,
): Promise<TenureFetchResult> {
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
  // outFields=* rather than a specific field list. The G37 beta layer
  // uses slightly different field names than the reference doc — e.g.
  // SA1_CODE21 vs SA1_CODE_2021, counts may be UPPERCASE — and asking
  // for a non-existent field yields "Cannot perform query. Invalid
  // query parameters." across every request. Requesting `*` is
  // documented as supported and the parser copes with field-name
  // variants via multi-name aliases.
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
      logAbs({
        lat: latitude,
        lng: longitude,
        status: res.status,
        ms: Date.now() - startedAt,
        error: `upstream ${res.status}`,
      });
      return {
        profile: null,
        error: `ABS G37 upstream ${res.status} ${res.statusText}`,
      };
    }
    const json = (await res.json()) as unknown;
    try {
      const profile = parseG37SA1Response(json);
      logAbs({
        lat: latitude,
        lng: longitude,
        status: res.status,
        ms: Date.now() - startedAt,
        sa1: profile?.sa1Code,
        totalDwellings: profile?.totalDwellings,
      });
      return { profile };
    } catch (parseErr) {
      // Separate branch so we can show the first available field
      // names from the response — critical when schema drifts and
      // the lookup aliases need another variant.
      const reason =
        parseErr instanceof Error ? parseErr.message : String(parseErr);
      const firstFeatureKeys =
        Array.isArray((json as { features?: unknown }).features) &&
        ((json as { features?: Array<{ attributes?: object }> }).features![0]
          ?.attributes)
          ? Object.keys(
              (json as { features: Array<{ attributes: object }> })
                .features[0].attributes,
            ).slice(0, 20)
          : [];
      logAbs({
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
    logAbs({
      lat: latitude,
      lng: longitude,
      status: -1, // network-layer failure, distinct from ArcGIS 200+error
      ms: Date.now() - startedAt,
      error: reason,
    });
    return { profile: null, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

function logAbs(info: {
  lat: number;
  lng: number;
  status: number;
  ms: number;
  sa1?: string;
  totalDwellings?: number;
  error?: string;
  firstFeatureKeys?: string[];
}): void {
  console.log(JSON.stringify({ tag: 'abs-g37', ...info }));
}
