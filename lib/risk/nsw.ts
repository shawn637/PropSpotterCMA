/**
 * NSW hazard / risk overlay provider. Queries NSW's public ArcGIS
 * services for flood + bushfire intersections with the subject's
 * lat/lng. Returns a HazardLayerResult per layer with level, zone,
 * and attribution so the UI + narrative can surface state-specific
 * detail.
 *
 * NSW publishes hazard data across multiple endpoints and the
 * authoritative URLs drift occasionally (service redeploys,
 * endpoint renames). Each layer has a candidate-URL list; the
 * ArcGIS helper picks the first that responds without error.
 *
 * Logging: tag:"risk-nsw" per layer. Includes urlUsed when a
 * candidate hit, firstFeatureKeys when the parse fell through.
 */

import { queryWithCandidates } from '@/lib/risk/arcgis';
import type { HazardLayerResult, HazardLevel } from '@/lib/types';

// Bushfire-Prone Land candidate endpoints. NSW RFS publishes via
// NSW Planning Portal's hazards services.
const BUSHFIRE_CANDIDATES = [
  'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/ePlanning/Planning_Portal_Hazards/MapServer/229/query',
  'https://mapprod1.environment.nsw.gov.au/arcgis/rest/services/ePlanning/Planning_Portal_Hazards/MapServer/229/query',
  'https://portal.spatial.nsw.gov.au/server/rest/services/NSW_BushFire_Prone_Land/FeatureServer/0/query',
  'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/Planning_Portal_Hazards/MapServer/0/query',
];

// Flood Planning Area candidate endpoints.
const FLOOD_CANDIDATES = [
  'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/ePlanning/Planning_Portal_Hazards/MapServer/230/query',
  'https://mapprod1.environment.nsw.gov.au/arcgis/rest/services/ePlanning/Planning_Portal_Hazards/MapServer/230/query',
  'https://portal.spatial.nsw.gov.au/server/rest/services/NSW_FloodPlain/FeatureServer/0/query',
];

const ATTRIBUTION_BUSHFIRE = {
  publisher: 'NSW Rural Fire Service / NSW Planning Portal',
  dataset: 'Bush Fire Prone Land',
  url: 'https://www.planningportal.nsw.gov.au/',
};

const ATTRIBUTION_FLOOD = {
  publisher: 'NSW Department of Planning / NSW Spatial Services',
  dataset: 'Flood Planning Area',
  url: 'https://www.planningportal.nsw.gov.au/',
};

export async function fetchNswRiskProfile(
  latitude: number,
  longitude: number,
): Promise<{ bushfire: HazardLayerResult; flood: HazardLayerResult }> {
  const [bushfire, flood] = await Promise.all([
    fetchBushfire(latitude, longitude),
    fetchFlood(latitude, longitude),
  ]);
  return { bushfire, flood };
}

async function fetchBushfire(
  latitude: number,
  longitude: number,
): Promise<HazardLayerResult> {
  const res = await queryWithCandidates({
    urls: BUSHFIRE_CANDIDATES,
    latitude,
    longitude,
  });
  logRisk({
    layer: 'bushfire',
    status: res.error ? 'error' : 'ok',
    features: res.features.length,
    firstFeatureKeys: res.firstFeatureKeys,
    urlUsed: res.urlUsed,
    attempts: res.attempts,
    error: res.error,
    ms: res.ms,
  });
  if (res.error) {
    return {
      level: 'unknown',
      attribution: ATTRIBUTION_BUSHFIRE,
      error: `All ${res.attempts} NSW bushfire endpoints failed: ${res.error}`,
    };
  }
  if (res.features.length === 0) {
    // Point is not inside any bushfire-prone polygon.
    return { level: 'none', attribution: ATTRIBUTION_BUSHFIRE };
  }
  // Pick the highest-severity category if multiple layers intersect.
  const categories = res.features
    .map((f) => interpretBushfireCategory(f.attributes))
    .filter((c): c is { level: HazardLevel; zone: string } => c !== null);
  if (categories.length === 0) {
    // Intersected but we couldn't interpret the category — rare,
    // but at least flag that the point IS inside some bushfire
    // polygon.
    return {
      level: 'moderate',
      zone: 'Bush Fire Prone Land (category not parsed)',
      attribution: ATTRIBUTION_BUSHFIRE,
    };
  }
  const top = categories.sort(
    (a, b) => hazardRank(b.level) - hazardRank(a.level),
  )[0];
  return {
    level: top.level,
    zone: top.zone,
    attribution: ATTRIBUTION_BUSHFIRE,
  };
}

async function fetchFlood(
  latitude: number,
  longitude: number,
): Promise<HazardLayerResult> {
  const res = await queryWithCandidates({
    urls: FLOOD_CANDIDATES,
    latitude,
    longitude,
  });
  logRisk({
    layer: 'flood',
    status: res.error ? 'error' : 'ok',
    features: res.features.length,
    firstFeatureKeys: res.firstFeatureKeys,
    urlUsed: res.urlUsed,
    attempts: res.attempts,
    error: res.error,
    ms: res.ms,
  });
  if (res.error) {
    return {
      level: 'unknown',
      attribution: ATTRIBUTION_FLOOD,
      error: `All ${res.attempts} NSW flood endpoints failed: ${res.error}`,
    };
  }
  if (res.features.length === 0) {
    return { level: 'none', attribution: ATTRIBUTION_FLOOD };
  }
  const zones = res.features
    .map((f) => interpretFloodZone(f.attributes))
    .filter((z): z is { level: HazardLevel; zone: string } => z !== null);
  if (zones.length === 0) {
    return {
      level: 'moderate',
      zone: 'Flood Planning Area (type not parsed)',
      attribution: ATTRIBUTION_FLOOD,
    };
  }
  const top = zones.sort((a, b) => hazardRank(b.level) - hazardRank(a.level))[0];
  return {
    level: top.level,
    zone: top.zone,
    attribution: ATTRIBUTION_FLOOD,
  };
}

/**
 * Interpret a NSW BPLM feature's attributes into a level + zone
 * string. Categories on the NSW BPLM layer are 1, 2, 3 + "Buffer",
 * where 1 = highest risk (forest/grassland with minimal defensible
 * space). Field names vary across publishing instances so we
 * accept several common spellings.
 */
function interpretBushfireCategory(
  attrs: Record<string, unknown>,
): { level: HazardLevel; zone: string } | null {
  const raw = pickString(attrs, 'CATEGORY', 'Category', 'category', 'BFPL_CAT', 'bfpl_cat', 'CAT_NAME', 'cat_name', 'Vegetation', 'VEGETATION', 'TYPE');
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (s.includes('category 1') || s === '1' || s.includes('cat 1')) {
    return { level: 'high', zone: 'Bush Fire Prone Category 1' };
  }
  if (s.includes('category 2') || s === '2' || s.includes('cat 2')) {
    return { level: 'moderate', zone: 'Bush Fire Prone Category 2' };
  }
  if (s.includes('category 3') || s === '3' || s.includes('cat 3')) {
    return { level: 'low', zone: 'Bush Fire Prone Category 3' };
  }
  if (s.includes('buffer')) {
    return { level: 'low', zone: 'Bush Fire Prone Buffer' };
  }
  // Raw category text is something we don't recognise — still a hit,
  // conservatively moderate.
  return { level: 'moderate', zone: `Bush Fire Prone: ${raw}` };
}

function interpretFloodZone(
  attrs: Record<string, unknown>,
): { level: HazardLevel; zone: string } | null {
  const raw = pickString(attrs, 'Flood_Type', 'FLOOD_TYPE', 'flood_type', 'Classification', 'CLASSIFICATION', 'Type', 'TYPE', 'Layer');
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (s.includes('floodway') || s.includes('floodwater')) {
    return { level: 'extreme', zone: `Flood ${raw}` };
  }
  if (s.includes('high hazard') || s.includes('1%')) {
    return { level: 'high', zone: `Flood ${raw}` };
  }
  if (s.includes('flood planning') || s.includes('fpa')) {
    return { level: 'moderate', zone: `Flood ${raw}` };
  }
  if (s.includes('flood prone') || s.includes('flood fringe')) {
    return { level: 'moderate', zone: `Flood ${raw}` };
  }
  return { level: 'moderate', zone: `Flood Planning Area: ${raw}` };
}

function hazardRank(level: HazardLevel): number {
  switch (level) {
    case 'extreme':
      return 5;
    case 'high':
      return 4;
    case 'moderate':
      return 3;
    case 'low':
      return 2;
    case 'none':
      return 1;
    default:
      return 0;
  }
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

function logRisk(info: {
  layer: string;
  status: 'ok' | 'error';
  features: number;
  firstFeatureKeys?: string[];
  urlUsed?: string;
  attempts?: number;
  error?: string;
  ms: number;
}): void {
  console.log(JSON.stringify({ tag: 'risk-nsw', ...info }));
}

// Exported for direct unit testing of the pure interpreters.
export const _internals = {
  interpretBushfireCategory,
  interpretFloodZone,
  hazardRank,
};
