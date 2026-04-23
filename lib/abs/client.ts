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
  const params = new URLSearchParams({
    where: '1=1',
    geometry,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: [
      'SA1_CODE_2021',
      'Tot_Total',
      'O_OR_Total',
      'O_MTG_Total',
      'R_RE_Agt_Total',
      'R_Pers_not_in_s_h_Total',
      'R_Oth_landlord_type_Total',
      'R_ST_h_auth_Total',
      'R_Com_Hp_Total',
    ].join(','),
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
      status: 0,
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
}): void {
  console.log(JSON.stringify({ tag: 'abs-g37', ...info }));
}
