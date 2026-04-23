/**
 * Pure parsers for the ABS 2021 Census G37 (Tenure and Landlord Type)
 * FeatureServer response at SA1 (Statistical Area Level 1) granularity.
 * No I/O — exercised by lib/abs/parse.test.ts against fixtures from
 * the live ArcGIS response.
 *
 * Service reference:
 *   https://services1.arcgis.com/v8Kimc579yljmjSP/ArcGIS/rest/services/
 *   ABS_2021_Census_G37_Beta/FeatureServer/5/query
 *
 * The ABS G37 table carries per-tenure dwelling counts (owned outright,
 * owned with mortgage, rented by landlord type, plus a residual of
 * "other / not stated"). We surface three headline percentages:
 *   - ownerOccupierPct  = (owned_outright + owned_mortgage) / total
 *   - privateRentalPct  = (agent + person_not_in_household + other) / total
 *   - publicHousingPct  = (state_auth + community_housing) / total
 *
 * These don't sum to 100: "not stated" / "other tenure" / "rent-free"
 * live in the residual `otherPct`. The UI surfaces all four.
 */

import type { TenureProfile } from '@/lib/types';

export class AbsParseError extends Error {
  constructor(message: string, readonly endpoint: string) {
    super(message);
    this.name = 'AbsParseError';
  }
}

/**
 * Parse the ArcGIS response envelope. Errors:
 *   - API error in `error.message` → throw
 *   - empty `features[]` → return null (no SA1 matched; caller degrades)
 *   - missing headline fields → throw (schema drift — surface it loudly)
 */
export function parseG37SA1Response(
  response: unknown,
  endpoint = '/G37/FeatureServer/5/query',
): TenureProfile | null {
  if (!isObject(response)) {
    throw new AbsParseError(
      `ABS ${endpoint} response is not an object`,
      endpoint,
    );
  }
  if (isObject(response.error)) {
    const msg =
      pickString(response.error, 'message') ??
      `HTTP layer error (${pickNumber(response.error, 'code') ?? 'unknown'})`;
    throw new AbsParseError(`ABS ${endpoint} error: ${msg}`, endpoint);
  }
  const features = Array.isArray(response.features) ? response.features : null;
  if (!features || features.length === 0) return null;

  const feature = features[0];
  if (!isObject(feature) || !isObject(feature.attributes)) {
    throw new AbsParseError(
      `ABS ${endpoint} feature has no attributes object`,
      endpoint,
    );
  }
  const attrs = feature.attributes;

  // Tolerant field lookups. ABS beta FeatureServers can present the
  // same logical field under several naming conventions (full 2021
  // suffix vs abbreviated, snake_case vs UPPER_CASE, etc.) — every
  // variant we've seen or suspect is listed so a minor schema drift
  // doesn't silently break the tenure card. The matcher returns the
  // first field with a value and ignores the rest.
  const sa1Code = pickString(
    attrs,
    'SA1_CODE_2021',
    'SA1_CODE21',
    'SA1_CODE_21',
    'SA1_MAINCODE_2021',
    'SA1_MAIN_2021',
    'SA1_CODE',
  );
  const totalDwellings = pickNumber(attrs, 'Tot_Total', 'TOTAL_TOTAL', 'Total_Total');
  if (!sa1Code) {
    throw new AbsParseError(
      `ABS ${endpoint} attributes missing SA1 code; keys=[${Object.keys(attrs).slice(0, 30).join(', ')}]`,
      endpoint,
    );
  }
  if (totalDwellings == null || totalDwellings <= 0) {
    // Zero-total SA1s exist (unpopulated industrial areas). Return null
    // rather than throw — the caller degrades gracefully.
    return null;
  }

  // Each count field lists its suspected variants in priority order.
  // The first non-null hit wins. Missing fields default to 0 so the
  // parse proceeds even on partially-populated records.
  const ownedOutright =
    pickNumber(attrs, 'O_OR_Total', 'OWNED_OUTRIGHT_TOTAL', 'O_OR_T') ?? 0;
  const ownedMortgage =
    pickNumber(
      attrs,
      'O_MTG_Total',
      'OWNED_WITH_MORTGAGE_TOTAL',
      'O_W_M_L_Total',
      'O_W_M_L_T',
    ) ?? 0;
  const rentedAgent =
    pickNumber(attrs, 'R_RE_Agt_Total', 'RENTED_REA_TOTAL', 'R_Ag_T', 'R_Ag_Total') ?? 0;
  const rentedPersonNotHh =
    pickNumber(
      attrs,
      'R_Pers_not_in_s_h_Total',
      'R_PERS_NOT_IN_HH_TOTAL',
      'R_Pers_Total',
    ) ?? 0;
  const rentedOtherLandlord =
    pickNumber(
      attrs,
      'R_Oth_landlord_type_Total',
      'R_OTH_LANDLORD_TOTAL',
      'R_Oth_Total',
    ) ?? 0;
  const rentedStateAuth =
    pickNumber(
      attrs,
      'R_ST_h_auth_Total',
      'R_St_or_Ter_hou_auth_T',
      'R_St_or_Ter_hou_auth_Total',
      'R_STATE_HOUSING_TOTAL',
    ) ?? 0;
  const rentedCommunity =
    pickNumber(
      attrs,
      'R_Com_Hp_Total',
      'R_Com_ed_tr_hou_pr_T',
      'R_Com_ed_tr_hou_pr_Total',
      'R_COMMUNITY_HOUSING_TOTAL',
    ) ?? 0;

  const ownerOccupier = ownedOutright + ownedMortgage;
  const privateRental = rentedAgent + rentedPersonNotHh + rentedOtherLandlord;
  const publicHousing = rentedStateAuth + rentedCommunity;
  const classified = ownerOccupier + privateRental + publicHousing;
  const other = Math.max(0, totalDwellings - classified);

  const pct = (n: number): number =>
    Math.round((n / totalDwellings) * 1000) / 10; // one decimal place

  return {
    sa1Code,
    totalDwellings,
    ownerOccupierPct: pct(ownerOccupier),
    privateRentalPct: pct(privateRental),
    publicHousingPct: pct(publicHousing),
    otherPct: pct(other),
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
