/**
 * OpenStreetMap Nominatim geocoder, used as a fallback when HTAG's
 * geocode response doesn't carry lat/lng for a given address. Public
 * service, no auth.
 *
 * Terms-of-use compliance:
 *   - 1 request per second hard cap → we're well under that (one
 *     call per CMA, only when HTAG didn't already give us coords).
 *   - Required User-Agent identifying the application.
 *   - No bulk/heavy traffic — our use case is narrow.
 *
 * Reference: https://operations.osmfoundation.org/policies/nominatim/
 */

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const TIMEOUT_MS = 5_000;
// Nominatim requires a contact-able User-Agent.
const USER_AGENT =
  'PropSpotterCMA/1.0 (+https://propspotter.com.au; advisory@propspotter.com.au)';

export interface NominatimResult {
  latitude: number;
  longitude: number;
  displayName: string;
}

/**
 * Resolve a full Australian address string to lat/lng. Returns null
 * when the service is down, rate-limited, times out, or can't match
 * the address — the caller degrades rather than failing the whole
 * valuation.
 */
export async function nominatimGeocode(
  address: string,
): Promise<NominatimResult | null> {
  if (!address || address.trim().length < 6) return null;

  const params = new URLSearchParams({
    q: address.trim(),
    format: 'json',
    limit: '1',
    countrycodes: 'au',
    addressdetails: '0',
  });
  const url = `${NOMINATIM_URL}?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      logNominatim({
        status: res.status,
        ms: Date.now() - startedAt,
        error: `upstream ${res.status}`,
      });
      return null;
    }
    const json = (await res.json()) as unknown;
    if (!Array.isArray(json) || json.length === 0) {
      logNominatim({
        status: res.status,
        ms: Date.now() - startedAt,
        error: 'no match',
      });
      return null;
    }
    const first = json[0] as Record<string, unknown>;
    const lat = Number(first.lat);
    const lng = Number(first.lon);
    const displayName =
      typeof first.display_name === 'string' ? first.display_name : address;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      logNominatim({
        status: res.status,
        ms: Date.now() - startedAt,
        error: 'non-numeric lat/lng',
      });
      return null;
    }
    logNominatim({
      status: res.status,
      ms: Date.now() - startedAt,
      lat,
      lng,
    });
    return { latitude: lat, longitude: lng, displayName };
  } catch (err) {
    const aborted =
      err instanceof Error &&
      (err.name === 'AbortError' || err.message.includes('aborted'));
    const reason = aborted
      ? `timed out after ${TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    logNominatim({ status: 0, ms: Date.now() - startedAt, error: reason });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function logNominatim(info: {
  status: number;
  ms: number;
  lat?: number;
  lng?: number;
  error?: string;
}): void {
  console.log(JSON.stringify({ tag: 'nominatim', ...info }));
}
