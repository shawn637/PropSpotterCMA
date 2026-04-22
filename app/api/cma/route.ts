import { NextResponse } from 'next/server';
import { z } from 'zod';

import { computeCMA } from '@/lib/cma/compute';
import { computeMaxPrice } from '@/lib/cma/maxprice';
import {
  HtagError,
  getComparables,
  getMarketContext,
  getSubjectProperty,
  isMockMode,
} from '@/lib/htag/client';
import {
  assessVendorMotivation,
  generateNarrative,
  type TokenUsage,
} from '@/lib/llm/vendor-motivation';
import { clientKey, rateLimit } from '@/lib/ratelimit';
import type { FullValuationResult } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 30;

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
    const subject = await getSubjectProperty(address);
    const [comparables, market] = await Promise.all([
      getComparables(subject),
      getMarketContext(subject),
    ]);

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

    const { text: narrative, tokenUsage: narrativeUsage } =
      await generateNarrative({
        subject,
        market,
        cma,
        vendorAssessment,
        maxPrice,
        actualDaysOnMarket,
      });

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
    };

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
}): void {
  console.log(JSON.stringify({ tag: 'valuation', ...info }));
}
