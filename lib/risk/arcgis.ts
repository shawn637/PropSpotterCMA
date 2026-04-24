/**
 * Shared ArcGIS spatial-query helper for risk / hazard overlay
 * providers. Every state's hazard data is published as a
 * FeatureServer or MapServer layer on some state-run ArcGIS
 * instance; the query shape is identical except for the base URL
 * and field naming. This module owns fetch + error handling; the
 * per-state providers own URL lists and field-parser logic.
 *
 * Fails soft. Every return path hands the caller a usable result —
 * the outer CMA pipeline never aborts because a state hazard server
 * was slow or schema-drifted.
 */

const DEFAULT_TIMEOUT_MS = 6_000;

export interface ArcGisFeature {
  attributes: Record<string, unknown>;
}

export interface ArcGisQueryResult {
  features: ArcGisFeature[];
  /** First feature's attribute keys (up to 30), captured for
   *  schema-drift diagnostics. Populated even on parser success so
   *  the log line is always useful. */
  firstFeatureKeys: string[];
  /** Error surfaces here when the query couldn't produce features.
   *  Distinct from `features.length === 0` which is a clean "no
   *  hazard layer intersects this point". */
  error?: string;
  /** Milliseconds for the fetch + parse, for the operator log line. */
  ms: number;
}

/**
 * Run a point-in-polygon spatial query against an ArcGIS
 * Feature/MapServer layer. Returns the features array (empty array
 * means no intersection with this point, which is valid data), plus
 * any error we encountered.
 *
 * `baseUrl` should point at the layer's `/query` endpoint, e.g.
 *   https://.../Planning_Portal_Hazards/MapServer/0/query
 */
export async function queryFeatureAtPoint(args: {
  baseUrl: string;
  latitude: number;
  longitude: number;
  outFields?: string;
  timeoutMs?: number;
}): Promise<ArcGisQueryResult> {
  const {
    baseUrl,
    latitude,
    longitude,
    outFields = '*',
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = args;

  const startedAt = Date.now();
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
    outFields,
    returnGeometry: 'false',
    f: 'json',
  });
  const url = `${baseUrl}?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      return {
        features: [],
        firstFeatureKeys: [],
        error: `upstream ${res.status} ${res.statusText}`,
        ms: Date.now() - startedAt,
      };
    }
    const json = (await res.json()) as unknown;
    if (!isObject(json)) {
      return {
        features: [],
        firstFeatureKeys: [],
        error: 'response is not an object',
        ms: Date.now() - startedAt,
      };
    }
    if (isObject(json.error)) {
      const msg = pickString(json.error, 'message') ?? 'ArcGIS error';
      return {
        features: [],
        firstFeatureKeys: [],
        error: msg,
        ms: Date.now() - startedAt,
      };
    }
    const features = Array.isArray(json.features)
      ? (json.features as unknown[]).filter(isFeature)
      : [];
    const firstFeatureKeys =
      features.length > 0 ? Object.keys(features[0].attributes).slice(0, 30) : [];
    return {
      features,
      firstFeatureKeys,
      ms: Date.now() - startedAt,
    };
  } catch (err) {
    const aborted =
      err instanceof Error &&
      (err.name === 'AbortError' || err.message.includes('aborted'));
    const reason = aborted
      ? `timed out after ${timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    return {
      features: [],
      firstFeatureKeys: [],
      error: reason,
      ms: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try a list of candidate ArcGIS URLs in order until one returns
 * features (or at least a non-error response). Useful when we don't
 * know which URL variant the live service actually uses — same
 * pattern we use for G02. The first non-error result wins; if every
 * candidate errors, returns the last result with its error attached.
 */
export async function queryWithCandidates(args: {
  urls: string[];
  latitude: number;
  longitude: number;
  outFields?: string;
  timeoutMs?: number;
}): Promise<ArcGisQueryResult & { urlUsed?: string; attempts: number }> {
  let last: ArcGisQueryResult | null = null;
  let attempts = 0;
  for (const url of args.urls) {
    attempts++;
    const res = await queryFeatureAtPoint({
      baseUrl: url,
      latitude: args.latitude,
      longitude: args.longitude,
      outFields: args.outFields,
      timeoutMs: args.timeoutMs,
    });
    // A clean result (no error) — whether it has features or not,
    // the URL is valid. Use this one.
    if (!res.error) {
      return { ...res, urlUsed: url, attempts };
    }
    last = res;
  }
  return {
    ...(last ?? {
      features: [],
      firstFeatureKeys: [],
      error: 'no candidate URLs supplied',
      ms: 0,
    }),
    attempts,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFeature(v: unknown): v is ArcGisFeature {
  return isObject(v) && isObject((v as Record<string, unknown>).attributes);
}

function pickString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  if (typeof v === 'string' && v.length > 0) return v;
  return undefined;
}
