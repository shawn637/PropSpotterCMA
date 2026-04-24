import { NextResponse } from 'next/server';
import { z } from 'zod';

import { fetchTenureByPoint } from '@/lib/abs/client';
import { fetchG02ByPoint } from '@/lib/abs/g02';
import { fetchSeifaByPoint } from '@/lib/abs/seifa';
import { computeCMA } from '@/lib/cma/compute';
import { computeMaxPrice } from '@/lib/cma/maxprice';
import { nominatimGeocode } from '@/lib/geocode/nominatim';
import {
  HtagError,
  getComparables,
  getMarketContext,
  getSubjectProperty,
  isMockMode,
} from '@/lib/htag/client';
import {
  assessVendorMotivation,
  fallbackNarrative,
  type TokenUsage,
} from '@/lib/llm/vendor-motivation';
import { clientKey, rateLimit } from '@/lib/ratelimit';
import type {
  FullValuationResult,
  G02Demographics,
  SeifaProfile,
  TenureProfile,
} from '@/lib/types';

export const runtime = 'nodejs';
// 60 s defensive margin. The narrative LLM call has been moved to
// /api/narrative (fired from the client) so the steady-state /api/cma
// payload is now HTAG subject + HTAG comps + HTAG market + ABS subject
// + N-parallel ABS comps + vendor classification LLM — typically
// 10-15 s. Keeping 60 s here protects against a slow HTAG tier or a
// large ABS batch.
export const maxDuration = 60;

const RequestSchema = z.object({
  address: z.string().min(8).max(300),
  listingDescription: z.string().max(5000).optional(),
  actualDaysOnMarket: z.number().int().positive().optional(),
});

export async function POST(req: Request) {
  const rl = rateLimit(`cma:${clientKey(req)}`);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please wait a minute and try again.' },
      {
        status: 429,
        headers: rateLimitHeaders(rl),
      },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'Request body must be JSON.' },
      { status: 400 },
    );
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'Invalid request.',
        details: parsed.error.flatten(),
      },
      { status: 400 },
    );
  }

  const { address, listingDescription, actualDaysOnMarket } = parsed.data;

  try {
    let subjectRaw = await getSubjectProperty(address);

    // HTAG's geocode doesn't always return lat/lng depending on the
    // address record. Without coords, we can't do the point-in-SA1
    // query. Fall back to OpenStreetMap Nominatim for one shot; it's
    // the cheapest way to rescue the tenure enrichment when HTAG
    // comes up short. The fallback is silent (returns null on any
    // error) and only runs in the one-call case here, comfortably
    // inside Nominatim's 1-req/sec policy.
    if (subjectRaw.latitude == null || subjectRaw.longitude == null) {
      const fallback = await nominatimGeocode(subjectRaw.fullAddress);
      if (fallback) {
        console.log(
          JSON.stringify({
            tag: 'geocode-fallback',
            reason: 'htag-missing-coords',
            source: 'nominatim',
            address: subjectRaw.suburb + ', ' + subjectRaw.postcode,
            lat: fallback.latitude,
            lng: fallback.longitude,
          }),
        );
        subjectRaw = {
          ...subjectRaw,
          latitude: fallback.latitude,
          longitude: fallback.longitude,
        };
      } else {
        console.log(
          JSON.stringify({
            tag: 'geocode-fallback',
            reason: 'nominatim-failed',
            address: subjectRaw.suburb + ', ' + subjectRaw.postcode,
          }),
        );
      }
    }

    // Fire HTAG comparables + market AND the ABS G37 tenure query for
    // the subject in parallel. The ABS leg is wrapped so it can never
    // reject the whole valuation — a 5 s timeout on the ArcGIS fetch
    // plus a .catch boundary here means a slow ABS response is
    // capped at 5 s of added wall time and always yields null rather
    // than a thrown error.
    // The three ABS legs (G37 tenure, SEIFA, G02) share the same
    // lat/lng input and all fire in parallel with HTAG. None is on
    // the valuation critical path — each is independently wrapped so
    // one ABS service being slow, throttled, or schema-drifted can't
    // break the overall CMA response.
    const hasCoords =
      subjectRaw.latitude != null && subjectRaw.longitude != null;
    if (!hasCoords) {
      console.log(
        JSON.stringify({
          tag: 'abs-skip',
          reason: 'subject-missing-coords',
        }),
      );
    }
    const subjectTenurePromise: Promise<TenureProfile | null> = hasCoords
      ? fetchTenureByPoint(subjectRaw.latitude!, subjectRaw.longitude!).then(
          (r) => r.profile,
        )
      : Promise.resolve(null);
    const subjectSeifaPromise: Promise<SeifaProfile | null> = hasCoords
      ? fetchSeifaByPoint(subjectRaw.latitude!, subjectRaw.longitude!).then(
          (r) => r.profile,
        )
      : Promise.resolve(null);
    const subjectG02Promise: Promise<G02Demographics | null> = hasCoords
      ? fetchG02ByPoint(subjectRaw.latitude!, subjectRaw.longitude!).then(
          (r) => r.demographics,
        )
      : Promise.resolve(null);

    const [comparablesRaw, market, subjectTenure, subjectSeifa, subjectG02] =
      await Promise.all([
        getComparables(subjectRaw),
        getMarketContext(subjectRaw),
        subjectTenurePromise.catch(() => null),
        subjectSeifaPromise.catch(() => null),
        subjectG02Promise.catch(() => null),
      ]);
    const subject: typeof subjectRaw = {
      ...subjectRaw,
      tenureProfile: subjectTenure ?? undefined,
    };

    // Per-comp tenure: fire ABS in parallel for every comp that
    // carries lat/lng. Comps without coords get no tenure (the
    // deriveTenureAdjustment leg no-ops for those). Comps in the
    // same SA1 as the subject will get factor 1.0 anyway, which is
    // the common case for sold-search results restricted to
    // proximity=sameSuburb.
    const compTenureResults = await Promise.all(
      comparablesRaw.map(async (c) => {
        if (c.latitude == null || c.longitude == null) return null;
        try {
          const r = await fetchTenureByPoint(c.latitude, c.longitude);
          return r.profile;
        } catch {
          return null;
        }
      }),
    );
    const comparables = comparablesRaw.map((c, i) => ({
      ...c,
      tenureProfile: compTenureResults[i] ?? undefined,
    }));

    const cma = computeCMA(subject, comparables, market);

    if (cma.comparables.length < 3) {
      return NextResponse.json(
        {
          error:
            'Not enough recent comparable sales to produce a defensible CMA.',
          notes: cma.notes,
        },
        { status: 422 },
      );
    }

    const { assessment: vendorAssessment, tokenUsage: vendorUsage } =
      await assessVendorMotivation(listingDescription);

    const maxPrice = computeMaxPrice({
      fairValue: cma.fairValue,
      cycleStage: market.cycleStage,
      vendorMotivation: vendorAssessment.motivation,
      actualDaysOnMarket,
      typicalDaysOnMarket: market.typicalDaysOnMarket,
    });

    // Ship a synchronous fallback narrative in this response so the
    // client has something to render immediately. The LLM-backed
    // version runs separately via /api/narrative once the page is on
    // screen — that keeps /api/cma well under Vercel's function
    // budget (we were hitting 30 s timeouts running the narrative
    // LLM inline here with the expanded prompt + per-comp ABS legs
    // stacking). The client's existing mount + post-Vision regen
    // effects upgrade the prose automatically.
    const narrative = fallbackNarrative({
      subject,
      market,
      cma,
      vendorAssessment,
      maxPrice,
      actualDaysOnMarket,
    });
    const narrativeUsage: TokenUsage | undefined = undefined;

    const payload: FullValuationResult = {
      subject,
      market,
      cma,
      vendorAssessment,
      maxPrice,
      narrative,
      generatedAtIso: new Date().toISOString(),
      dataSource: isMockMode() ? 'mock' : 'live',
      requestedAddress: address,
      actualDaysOnMarket,
      tenureProfile: subjectTenure ?? undefined,
      seifaProfile: subjectSeifa ?? undefined,
      demographics: subjectG02 ?? undefined,
    };

    // How many comps had their per-SA1 tenure resolved, plus the
    // range of PH shares we saw. Useful for spotting when HTAG stops
    // returning coords on the sold-search side and the per-comp
    // tenure leg silently degrades.
    const compsWithTenure = comparables.filter((c) => !!c.tenureProfile);
    const compPhShares = compsWithTenure.map(
      (c) => c.tenureProfile!.publicHousingPct,
    );

    logValuation({
      dataSource: payload.dataSource,
      suburb: subject.suburb,
      state: subject.state,
      locPid: subject.locPid,
      cycleStage: market.cycleStage,
      fairValue: cma.fairValue,
      dispersion: Number(cma.dispersion.toFixed(3)),
      comparablesUsed: cma.comparables.length,
      vendor: {
        motivation: vendorAssessment.motivation,
        source: vendorAssessment.source,
        confidence: Number(vendorAssessment.confidence.toFixed(2)),
      },
      numbers: {
        opening: maxPrice.openingOffer,
        target: maxPrice.targetPrice,
        walkAway: maxPrice.walkAwayMax,
      },
      llmTokens: sumTokens(vendorUsage, narrativeUsage),
      actualDaysOnMarket,
      tenure: subjectTenure
        ? {
            sa1: subjectTenure.sa1Code,
            ownerOccupier: subjectTenure.ownerOccupierPct,
            privateRental: subjectTenure.privateRentalPct,
            publicHousing: subjectTenure.publicHousingPct,
          }
        : null,
      seifa: subjectSeifa
        ? {
            irsdDecile: subjectSeifa.irsd.decileAus,
            irsadDecile: subjectSeifa.irsad.decileAus,
            ierDecile: subjectSeifa.ier.decileAus,
            ieoDecile: subjectSeifa.ieo.decileAus,
          }
        : null,
      demographics: subjectG02
        ? {
            medianHhdInc: subjectG02.medianHouseholdIncomeWeekly,
            medianRent: subjectG02.medianRentWeekly,
            medianMortgage: subjectG02.medianMortgageMonthly,
          }
        : null,
      compsTenureCoverage: {
        total: comparables.length,
        resolved: compsWithTenure.length,
        phMin: compPhShares.length > 0 ? Math.min(...compPhShares) : null,
        phMax: compPhShares.length > 0 ? Math.max(...compPhShares) : null,
      },
    });

    return NextResponse.json(payload, { headers: rateLimitHeaders(rl) });
  } catch (err) {
    console.error('CMA route failed:', err);
    if (err instanceof HtagError) {
      // Upstream data provider failed. Surface the endpoint so the issue
      // is actionable (maps 1:1 to a TODO(htag-live) marker in the
      // client). Use /api/htag-debug to probe the endpoint directly.
      return NextResponse.json(
        {
          error: `HTAG upstream failed at ${err.endpoint}: ${err.message}`,
          endpoint: err.endpoint,
          upstreamStatus: err.status,
        },
        { status: 502 },
      );
    }
    const message = err instanceof Error ? err.message : 'CMA generation failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function rateLimitHeaders(rl: {
  limit: number;
  remaining: number;
  resetAt: number;
}): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(rl.limit),
    'X-RateLimit-Remaining': String(rl.remaining),
    'X-RateLimit-Reset': String(Math.ceil(rl.resetAt / 1000)),
  };
}

function sumTokens(
  a: TokenUsage | undefined,
  b: TokenUsage | undefined,
): TokenUsage {
  return {
    input: (a?.input ?? 0) + (b?.input ?? 0),
    output: (a?.output ?? 0) + (b?.output ?? 0),
  };
}

/**
 * Structured JSON log line per completed valuation. No PII — full
 * address is omitted intentionally. Fields are the ones useful for
 * usage monitoring and cost tracking. `grep '"tag":"valuation"'` in
 * Vercel Logs to filter.
 */
function logValuation(info: {
  dataSource: 'mock' | 'live';
  suburb: string;
  state: string;
  locPid: string;
  cycleStage: string;
  fairValue: number;
  dispersion: number;
  comparablesUsed: number;
  vendor: { motivation: string; source: 'llm' | 'fallback'; confidence: number };
  numbers: { opening: number; target: number; walkAway: number };
  llmTokens: TokenUsage;
  actualDaysOnMarket?: number;
  tenure: {
    sa1: string;
    ownerOccupier: number;
    privateRental: number;
    publicHousing: number;
  } | null;
  seifa: {
    irsdDecile: number;
    irsadDecile: number;
    ierDecile: number;
    ieoDecile: number;
  } | null;
  demographics: {
    medianHhdInc?: number;
    medianRent?: number;
    medianMortgage?: number;
  } | null;
  compsTenureCoverage: {
    total: number;
    resolved: number;
    phMin: number | null;
    phMax: number | null;
  };
}): void {
  console.log(JSON.stringify({ tag: 'valuation', ...info }));
}
