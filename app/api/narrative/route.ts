import { NextResponse } from 'next/server';

import { generateNarrative } from '@/lib/llm/vendor-motivation';
import { clientKey, rateLimit } from '@/lib/ratelimit';
import type { FullValuationResult } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * Regenerate the CMA narrative based on the client's CURRENT state
 * (post-exclusion, post-Vision). The initial narrative emitted by
 * /api/cma reflects the server-side snapshot only — it doesn't know
 * which comps the user has since excluded or what Claude Vision
 * found. Calling this route after those steps lets us refresh the
 * prose so the numbers and visual callouts it cites actually match
 * what the user is looking at.
 *
 * Input: the full FullValuationResult the client is displaying (the
 * same shape that /api/pdf accepts). Output: `{ narrative: string }`.
 */
export async function POST(req: Request) {
  const rl = rateLimit(`narrative:${clientKey(req)}`);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please wait a minute and try again.' },
      { status: 429 },
    );
  }

  let data: FullValuationResult;
  try {
    data = (await req.json()) as FullValuationResult;
  } catch {
    return NextResponse.json(
      { error: 'Request body must be JSON.' },
      { status: 400 },
    );
  }

  if (!data?.subject?.fullAddress || !data?.maxPrice || !data?.cma) {
    return NextResponse.json(
      { error: 'Valuation payload is incomplete.' },
      { status: 400 },
    );
  }

  try {
    const { text, tokenUsage } = await generateNarrative({
      subject: data.subject,
      market: data.market,
      cma: data.cma,
      vendorAssessment: data.vendorAssessment,
      maxPrice: data.maxPrice,
      actualDaysOnMarket: data.actualDaysOnMarket,
    });

    console.log(
      JSON.stringify({
        tag: 'narrative',
        subject: data.subject.addressKey,
        comps: data.cma.comparables.length,
        subjectHasVision: !!data.subject.visionAttrs,
        compsWithVision: data.cma.comparables.filter((c) => !!c.visionAttrs)
          .length,
        tokens: tokenUsage,
      }),
    );

    return NextResponse.json({ narrative: text });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
