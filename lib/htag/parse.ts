/**
 * Pure parse helpers for HTAG responses. No I/O, no SDK calls — everything
 * in this file is deterministic given its input. This is what lib/htag/
 * client.test.ts exercises against known fixture shapes.
 *
 * We keep this separate from client.ts because:
 *  1. Running `node --test` on a file that imports Next.js / @react-pdf
 *     would drag in a huge dependency tree.
 *  2. The iteration story for Phase 3 is "HTAG returns a shape we didn't
 *     anticipate" -- that's a pure-data problem and belongs in pure code.
 */

import type { PropertyDetails } from '@/lib/types';

export class HtagParseError extends Error {
  constructor(message: string, readonly endpoint: string) {
    super(message);
    this.name = 'HtagParseError';
  }
}

/**
 * HTAG batch endpoints return either a bare array, an object wrapping
 * an array under `results` / `data` / `addresses`, or a flat single
 * object. This normalises all three to a flat record.
 */
export function unwrapBatchResult(
  response: unknown,
  endpoint: string,
): Record<string, unknown> {
  if (Array.isArray(response)) {
    if (response.length === 0) {
      throw new HtagParseError(
        `HTAG ${endpoint} returned an empty array.`,
        endpoint,
      );
    }
    const first = response[0];
    if (typeof first === 'object' && first !== null) {
      return first as Record<string, unknown>;
    }
    throw new HtagParseError(
      `HTAG ${endpoint} array element is not an object.`,
      endpoint,
    );
  }
  if (typeof response === 'object' && response !== null) {
    const obj = response as Record<string, unknown>;
    for (const key of ['results', 'data', 'addresses']) {
      const inner = obj[key];
      if (Array.isArray(inner) && inner.length > 0) {
        const first = inner[0];
        if (typeof first === 'object' && first !== null) {
          return first as Record<string, unknown>;
        }
      }
    }
    return obj;
  }
  throw new HtagParseError(
    `HTAG ${endpoint} response is not an object or array.`,
    endpoint,
  );
}

/**
 * Try a list of candidate key names; return the first one that has a
 * non-empty string value. Used so we can tolerate HTAG field-name
 * differences without hand-editing every time.
 */
export function pickString(
  obj: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

export function pickNumber(
  obj: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

/**
 * Parse an Australian property address in canonical form
 *   "<street>, <suburb>, <STATE> <4-digit postcode>"
 * into the suburb/state/postcode components. Returns undefineds if the
 * pattern doesn't match — caller should fall back to other sources.
 */
export function parseAustralianAddress(addr: string | undefined): {
  suburb?: string;
  state?: string;
  postcode?: string;
} {
  if (!addr) return {};
  // Match the tail: ", suburb, STATE postcode" allowing trailing whitespace.
  const m = addr.match(
    /,\s*([^,]+?)\s*,\s*(ACT|NSW|NT|QLD|SA|TAS|VIC|WA)\s+(\d{4})\s*$/i,
  );
  if (!m) return {};
  return {
    suburb: m[1].trim(),
    state: m[2].toUpperCase(),
    postcode: m[3],
  };
}

const STANDARDISED_ADDRESS_KEYS = [
  'standardised_address',
  'standardized_address',
  'formatted_address',
];
const ADDRESS_KEY_KEYS = ['address_key', 'addressKey', 'address_id'];
const LOC_PID_KEYS = [
  'loc_pid',
  'locPid',
  'locality_pid',
  'locality_id',
  'loc_id',
  'suburb_pid',
];
const SUBURB_KEYS = ['suburb', 'locality', 'suburb_name', 'localityName'];
const STATE_KEYS = ['state', 'state_code', 'stateCode'];
const POSTCODE_KEYS = ['postcode', 'postal_code', 'postalCode'];
const PROPERTY_TYPE_KEYS = ['property_type', 'propertyType', 'dwelling_type'];

/**
 * Parse the flattened standardise response into the fields we care about.
 * Throws HtagParseError (with endpoint context) if the essentials are
 * missing. suburb/state/postcode/locPid may all be absent at this stage;
 * callers should merge the summary response in afterwards.
 */
export interface StandardiseParsed {
  addressKey: string;
  fullAddress: string;
  suburb?: string;
  state?: string;
  postcode?: string;
  locPid?: string;
  error?: string;
}

export function parseStandardiseResult(
  raw: Record<string, unknown>,
  endpoint = '/v1/address/standardise',
): StandardiseParsed {
  const errVal = raw.error;
  const error =
    typeof errVal === 'string' && errVal.length > 0 ? errVal : undefined;
  if (error) {
    throw new HtagParseError(
      `HTAG ${endpoint} returned error for address: ${error}`,
      endpoint,
    );
  }

  const addressKey = pickString(raw, ...ADDRESS_KEY_KEYS);
  if (!addressKey) {
    throw new HtagParseError(
      `HTAG ${endpoint} missing address_key. Got keys: [${Object.keys(raw).join(', ')}]`,
      endpoint,
    );
  }

  const fullAddress =
    pickString(raw, ...STANDARDISED_ADDRESS_KEYS, 'input_address') ?? '';
  if (!fullAddress) {
    throw new HtagParseError(
      `HTAG ${endpoint} missing a standardised address string. Got keys: [${Object.keys(raw).join(', ')}]`,
      endpoint,
    );
  }

  // Top-level fields if HTAG ever includes them; otherwise null and we
  // let the caller try the summary response + parsed address string.
  const suburb = pickString(raw, ...SUBURB_KEYS);
  const state = pickString(raw, ...STATE_KEYS);
  const postcode = pickString(raw, ...POSTCODE_KEYS);
  const locPid = pickString(raw, ...LOC_PID_KEYS);

  return { addressKey, fullAddress, suburb, state, postcode, locPid };
}

/**
 * Merge three sources of suburb/state/postcode/locPid, preferring
 * structured fields (standardise response or summary response) over a
 * parsed address string. Returns a fully-populated PropertyDetails or
 * throws if the essentials can't be resolved.
 */
export function buildSubjectProperty(args: {
  standardise: StandardiseParsed;
  summary: Record<string, unknown>;
  endpoint: string;
}): PropertyDetails {
  const { standardise, summary, endpoint } = args;
  const parsedFromAddress = parseAustralianAddress(standardise.fullAddress);

  const suburb =
    standardise.suburb ??
    pickString(summary, ...SUBURB_KEYS) ??
    parsedFromAddress.suburb;
  const state =
    standardise.state ??
    pickString(summary, ...STATE_KEYS) ??
    parsedFromAddress.state;
  const postcode =
    standardise.postcode ??
    pickString(summary, ...POSTCODE_KEYS) ??
    parsedFromAddress.postcode;
  const locPid =
    standardise.locPid ?? pickString(summary, ...LOC_PID_KEYS);

  const missing: string[] = [];
  if (!suburb) missing.push('suburb');
  if (!state) missing.push('state');
  if (!postcode) missing.push('postcode');
  if (!locPid) missing.push('locPid');
  if (missing.length > 0) {
    throw new HtagParseError(
      `Unable to resolve ${missing.join(
        ', ',
      )} from standardise + summary responses. ` +
        `Standardise keys: [${Object.keys(standardise).join(', ')}]. ` +
        `Summary keys: [${Object.keys(summary).join(', ')}]. ` +
        `Parsed address gave: ${JSON.stringify(parsedFromAddress)}.`,
      endpoint,
    );
  }

  return {
    addressKey: standardise.addressKey,
    fullAddress: standardise.fullAddress,
    suburb: suburb!,
    state: state!,
    postcode: postcode!,
    locPid: locPid!,
    landAreaSqm: pickNumber(summary, 'land_area_sqm', 'landAreaSqm', 'land_size'),
    bedrooms: pickNumber(summary, 'bedrooms', 'beds', 'bed'),
    bathrooms: pickNumber(summary, 'bathrooms', 'baths', 'bath'),
    carSpaces: pickNumber(summary, 'car_spaces', 'carSpaces', 'parking'),
    yearBuilt: pickNumber(summary, 'year_built', 'yearBuilt', 'built_year'),
    propertyType: normalisePropertyType(pickString(summary, ...PROPERTY_TYPE_KEYS)),
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
