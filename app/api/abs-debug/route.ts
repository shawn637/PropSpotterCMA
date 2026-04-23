import { NextResponse } from 'next/server';

import { fetchTenureByPoint } from '@/lib/abs/client';
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

  const result = await fetchTenureByPoint(latitude, longitude);
  return NextResponse.json({
    input: { address, lat: latitude, lng: longitude },
    source,
    profile: result.profile,
    error: result.error,
  });
}
