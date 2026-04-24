import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * Discovery + live-probe endpoint for state hazard / risk overlay
 * services. I can't reach external ArcGIS endpoints from my dev
 * sandbox, which means every URL I encode in a provider
 * (lib/risk/nsw.ts etc.) is an educated guess until verified live.
 * This route is how we verify — the operator (Shawn) hits it once,
 * the response lists real service names and layer IDs, and I pin
 * the provider to the correct URLs in a follow-up commit.
 *
 * Two modes:
 *
 *   GET /api/risk-debug?state=nsw&pattern=bushfire
 *     → crawls NSW ArcGIS host roots + folders, returns every
 *       service whose name matches "bushfire" (case-insensitive).
 *       For each match, additionally fetches the service's
 *       metadata to list its layers so we know the right
 *       layer id up front instead of guessing.
 *
 *   GET /api/risk-debug?url=<full arcgis query URL>&lat=X&lng=Y
 *     → probes a specific query URL with a sample point and
 *       returns the raw response so we can inspect feature
 *       shape + attribute field names.
 *
 * Not rate-limited — operator diagnostics only; still behind the
 * APP_PASSWORD middleware gate.
 */

const FETCH_TIMEOUT_MS = 10_000;

// Candidate host roots to crawl per state. These are the URLs where
// each state's public-facing spatial services live. Adding a new
// state to ?state= means adding its host list here.
const STATE_HOSTS: Record<string, string[]> = {
  nsw: [
    'https://portal.spatial.nsw.gov.au/server/rest/services',
    'https://mapprod1.environment.nsw.gov.au/arcgis/rest/services',
    'https://mapprod2.environment.nsw.gov.au/arcgis/rest/services',
    'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services',
    'https://maps.six.nsw.gov.au/arcgis/rest/services',
    'https://common.mapservices.nsw.gov.au/arcgis/rest/services',
  ],
  vic: [
    'https://services.land.vic.gov.au/catalogue/publicproxy/guest/dv_geoserver/rest/services',
    'https://mapshare.vic.gov.au/arcgis/rest/services',
  ],
  qld: [
    'https://spatial-gis.information.qld.gov.au/arcgis/rest/services',
    'https://qldglobe.information.qld.gov.au/arcgis/rest/services',
  ],
  tas: [
    'https://services.thelist.tas.gov.au/arcgis/rest/services',
    'https://maps.thelist.tas.gov.au/arcgis/rest/services',
  ],
};

interface DiscoverHit {
  host: string;
  serviceName: string;
  serviceType: string;
  serviceUrl: string;
  layers?: Array<{ id: number; name: string; type: string }>;
  layersError?: string;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const probeUrl = url.searchParams.get('url');
  if (probeUrl) {
    const lat = Number(url.searchParams.get('lat'));
    const lng = Number(url.searchParams.get('lng'));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return NextResponse.json(
        { error: 'url probe mode requires numeric lat and lng params' },
        { status: 400 },
      );
    }
    return NextResponse.json(await probeQueryUrl(probeUrl, lat, lng));
  }

  const state = (url.searchParams.get('state') ?? '').toLowerCase();
  const pattern = url.searchParams.get('pattern') ?? '';
  if (!state || !pattern) {
    return NextResponse.json(
      {
        error:
          'Supply ?state=<nsw|vic|qld|tas>&pattern=<regex> to discover, or ?url=<full>&lat=X&lng=Y to probe.',
        supportedStates: Object.keys(STATE_HOSTS),
      },
      { status: 400 },
    );
  }
  const hosts = STATE_HOSTS[state];
  if (!hosts) {
    return NextResponse.json(
      {
        error: `No host list registered for state ${state}. Add to STATE_HOSTS in /api/risk-debug/route.ts.`,
        supportedStates: Object.keys(STATE_HOSTS),
      },
      { status: 400 },
    );
  }

  return NextResponse.json(await discover(state, hosts, pattern));
}

async function discover(
  state: string,
  hosts: string[],
  pattern: string,
): Promise<{
  state: string;
  pattern: string;
  hits: DiscoverHit[];
  errors: Array<{ host: string; error: string }>;
}> {
  const re = new RegExp(pattern, 'i');
  const hits: DiscoverHit[] = [];
  const errors: Array<{ host: string; error: string }> = [];

  // Crawl each host's catalog (root + any folders one level deep).
  for (const host of hosts) {
    try {
      const rootJson = await fetchJson(host);
      if (!rootJson) continue;
      const rootServices = servicesFromCatalog(host, host, rootJson, re);
      hits.push(...rootServices);
      const folders: string[] = Array.isArray(rootJson.folders)
        ? (rootJson.folders as unknown[]).filter(
            (f): f is string => typeof f === 'string',
          )
        : [];
      for (const folder of folders) {
        const folderUrl = `${host}/${folder}`;
        const folderJson = await fetchJson(folderUrl);
        if (!folderJson) continue;
        hits.push(...servicesFromCatalog(host, folderUrl, folderJson, re));
      }
    } catch (err) {
      errors.push({
        host,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // For each matched service, fetch its metadata to list layer ids +
  // names. Doing this inline so the operator gets the full answer —
  // service name PLUS which layer id to query — in a single round
  // trip.
  await Promise.all(
    hits.map(async (hit) => {
      try {
        const meta = await fetchJson(hit.serviceUrl);
        if (!meta) {
          hit.layersError = 'metadata fetch returned null';
          return;
        }
        const layers = Array.isArray(meta.layers) ? meta.layers : [];
        hit.layers = layers
          .map((l) => {
            if (!l || typeof l !== 'object') return null;
            const raw = l as Record<string, unknown>;
            const id = raw.id;
            const name = raw.name;
            const type = raw.type;
            if (
              typeof id !== 'number' ||
              typeof name !== 'string' ||
              typeof type !== 'string'
            )
              return null;
            return { id, name, type };
          })
          .filter(
            (l): l is { id: number; name: string; type: string } => l !== null,
          );
      } catch (err) {
        hit.layersError = err instanceof Error ? err.message : String(err);
      }
    }),
  );

  return { state, pattern, hits, errors };
}

function servicesFromCatalog(
  host: string,
  catalogUrl: string,
  json: Record<string, unknown>,
  re: RegExp,
): DiscoverHit[] {
  const services = Array.isArray(json.services) ? json.services : [];
  const out: DiscoverHit[] = [];
  for (const svc of services) {
    if (!svc || typeof svc !== 'object') continue;
    const raw = svc as Record<string, unknown>;
    const name = raw.name;
    const type = raw.type;
    if (typeof name !== 'string' || typeof type !== 'string') continue;
    if (!re.test(name)) continue;
    const stripped = stripFolderPrefix(name, catalogUrl, host);
    out.push({
      host,
      serviceName: name,
      serviceType: type,
      serviceUrl: `${catalogUrl}/${stripped}/${type}`,
    });
  }
  return out;
}

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

async function probeQueryUrl(
  queryUrl: string,
  lat: number,
  lng: number,
): Promise<unknown> {
  const geometry = JSON.stringify({
    x: lng,
    y: lat,
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
  const full = `${queryUrl}?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(full, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { rawTextPreview: text.slice(0, 500) };
    }
    return { status: res.status, url: full, response: parsed };
  } catch (err) {
    return {
      status: 0,
      url: full,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}?f=json`, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
