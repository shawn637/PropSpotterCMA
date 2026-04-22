import { NextResponse } from 'next/server';
import { z } from 'zod';

import { computeCMA } from '@/lib/cma/compute';
import { computeMaxPrice } from '@/lib/cma/maxprice';
import {
  getComparables,
  getMarketContext,
  getSubjectProperty,
  isMockMode,
} from '@/lib/htag/client';
import {
  assessVendorMotivation,
  generateNarrative,
} from '@/lib/llm/vendor-motivation';
import type { FullValuationResult } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 30;

const RequestSchema = z.object({
  address: z.string().min(8).max(300),
  listingDescription: z.string().max(5000).optional(),
  actualDaysOnMarket: z.number().int().positive().optional(),
});

export async function POST(req: Request) {
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

    const vendorAssessment = await assessVendorMotivation(listingDescription);

    const maxPrice = computeMaxPrice({
      fairValue: cma.fairValue,
      cycleStage: market.cycleStage,
      vendorMotivation: vendorAssessment.motivation,
      actualDaysOnMarket,
      typicalDaysOnMarket: market.typicalDaysOnMarket,
    });

    const narrative = await generateNarrative({
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

    return NextResponse.json(payload);
  } catch (err) {
    console.error('CMA route failed:', err);
    const message = err instanceof Error ? err.message : 'CMA generation failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
