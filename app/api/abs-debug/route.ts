import { NextResponse } from 'next/server';

import { fetchTenureByPoint } from '@/lib/abs/client';
import { fetchG02ByPoint } from '@/lib/abs/g02';
import { fetchSeifaByPoint } from '@/lib/abs/seifa';
import { nominatimGeocode } from '@/lib/geocode/nominatim';

export const runtime = 'nodejs';
export const maxDuration = 15;

/**
 * Diagnostic route for the ABS G37 SA1 tenure leg. Verifies end-to-end
 * that:
 *   1. We can geocode an address (either directly via ?lat=&lng= or
 *      via Nominatim fallback when only ?address= is supplied).
 *   2. The ArcGIS FeatureServer responds with a feature for that
 *      point.
 *   3. Our parser extracts a sensible TenureProfile.
 *
 * Usage:
 *   GET /api/abs-debug?address=12+Kent+Av,+Orange+NSW+2800
 *   GET /api/abs-debug?lat=-33.283&lng=149.099
 *
 * Response:
 *   {
 *     input: { address?, lat, lng },
 *     source: 'direct' | 'nominatim',
 *     profile: TenureProfile | null,
 *     error?: string
 *   }
 *
 * Not rate-limited — this is for operator diagnostics only. No auth
 * change needed; the route is still behind the APP_PASSWORD middleware
 * gate like everything else.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const address = url.searchParams.get('address') ?? undefined;
  const latParam = url.searchParams.get('lat');
  const lngParam = url.searchParams.get('lng');
  const discover = url.searchParams.get('discover');

  // ?discover=<regex> mode: skip the spatial query entirely and
  // list any ABS ArcGIS services whose name matches the pattern,
  // across both known ABS publishing hosts. This is the fastest
  // way to find the exact service URL when the candidate probe
  // comes up empty — the alternative is the operator clicking
  // through ArcGIS REST endpoint trees manually.
  if (discover) {
    return NextResponse.json(await discoverAbsServices(discover));
  }

  let latitude: number | undefined;
  let longitude: number | undefined;
  let source: 'direct' | 'nominatim' = 'direct';

  if (latParam && lngParam) {
    latitude = Number(latParam);
    longitude = Number(lngParam);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return NextResponse.json(
        { error: 'lat and lng must be numeric' },
        { status: 400 },
      );
    }
  } else if (address) {
    const hit = await nominatimGeocode(address);
    if (!hit) {
      return NextResponse.json(
        {
          input: { address },
          source: 'nominatim',
          error: 'Nominatim returned no match for the address.',
        },
        { status: 502 },
      );
    }
    latitude = hit.latitude;
    longitude = hit.longitude;
    source = 'nominatim';
  } else {
    return NextResponse.json(
      { error: 'Supply either ?address= or ?lat=&lng=' },
      { status: 400 },
    );
  }

  // Fire all three ABS legs in parallel and hand the operator a
  // single blob to eyeball. Makes schema-drift diagnosis one request
  // instead of three.
  const [tenure, seifa, g02] = await Promise.all([
    fetchTenureByPoint(latitude, longitude),
    fetchSeifaByPoint(latitude, longitude),
    fetchG02ByPoint(latitude, longitude),
  ]);
  return NextResponse.json({
    input: { address, lat: latitude, lng: longitude },
    source,
    tenure: {
      profile: tenure.profile,
      error: tenure.error,
    },
    seifa: {
      profile: seifa.profile,
      error: seifa.error,
    },
    g02: {
      demographics: g02.demographics,
      error: g02.error,
    },
  });
}

interface DiscoverHit {
  host: string;
  name: string;
  type: string;
  url: string;
}

/**
 * Crawl the ABS ArcGIS service catalogs on both known hosts and
 * return the subset of service names matching the supplied case-
 * insensitive pattern. Recursively checks folders too because some
 * ABS services are grouped under folders like "Census2021".
 *
 * Pattern is treated as a substring match (not a full regex) so
 * `?discover=g02` matches "ABS_2021_Census_G02_Beta".
 */
async function discoverAbsServices(pattern: string): Promise<{
  pattern: string;
  matches: DiscoverHit[];
  errors: Array<{ host: string; error: string }>;
}> {
  const hosts = [
    'https://services1.arcgis.com/v8Kimc579yljmjSP/arcgis/rest/services',
    'https://services-ap1.arcgis.com/ypkPEy1AmwPKGNNv/arcgis/rest/services',
  ];
  const matches: DiscoverHit[] = [];
  const errors: Array<{ host: string; error: string }> = [];
  const re = new RegExp(pattern, 'i');

  for (const host of hosts) {
    try {
      const rootJson = await fetchCatalog(host);
      if (!rootJson) continue;
      // Services directly under the host root.
      collectMatches(host, host, rootJson, re, matches);
      // Plus services inside any folders.
      const folders: string[] = Array.isArray(rootJson.folders)
        ? (rootJson.folders as unknown[]).filter(
            (f): f is string => typeof f === 'string',
          )
        : [];
      for (const folder of folders) {
        const folderUrl = `${host}/${folder}`;
        const folderJson = await fetchCatalog(folderUrl);
        if (!folderJson) continue;
        collectMatches(host, folderUrl, folderJson, re, matches);
      }
    } catch (err) {
      errors.push({
        host,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { pattern, matches, errors };
}

async function fetchCatalog(url: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${url}?f=json`, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, unknown>;
    return json;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function collectMatches(
  host: string,
  catalogUrl: string,
  json: Record<string, unknown>,
  pattern: RegExp,
  out: DiscoverHit[],
): void {
  const services = Array.isArray(json.services) ? json.services : [];
  for (const svc of services) {
    if (!svc || typeof svc !== 'object') continue;
    const name = (svc as Record<string, unknown>).name;
    const type = (svc as Record<string, unknown>).type;
    if (typeof name !== 'string' || typeof type !== 'string') continue;
    if (pattern.test(name)) {
      out.push({
        host,
        name,
        type,
        url: `${catalogUrl}/${stripFolderPrefix(name, catalogUrl, host)}/${type}`,
      });
    }
  }
}

/**
 * ArcGIS occasionally returns service names prefixed with the folder
 * name (e.g. "Census2021/ABS_2021_Census_G02"), which we need to
 * strip to form the correct REST URL — the folder path is already
 * in catalogUrl.
 */
function stripFolderPrefix(
  name: string,
  catalogUrl: string,
  host: string,
): string {
  if (catalogUrl === host) return name;
  const folderPart = catalogUrl.slice(host.length + 1);
  const prefix = `${folderPart}/`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}
