import { NextResponse } from 'next/server';
import { z } from 'zod';

import { ApifyError, startRun } from '@/lib/apify/client';
import { buildReaSoldUrl } from '@/lib/apify/match';
import { clientKey, rateLimit } from '@/lib/ratelimit';

export const runtime = 'nodejs';
export const maxDuration = 15;

/**
 * Kick off an Apify scrape of realestate.com.au sold listings for the
 * subject's suburb. Returns immediately with the runId; the client
 * polls /api/photos/poll to pick up results when the scrape finishes.
 *
 * Cost note: one Apify run per call. At ~$0.01–$0.05 per run with
 * `maxPagesToScrape: 1` this is the cheapest way to get photos for a
 * whole comp set in one shot. Already behind the password middleware
 * and the per-IP rate limiter.
 */
const StartRequest = z.object({
  suburb: z.string().min(1).max(80),
  state: z.string().min(2).max(8),
  postcode: z.string().regex(/^\d{4}$/),
  propertyType: z.enum(['house', 'unit', 'townhouse', 'any']).default('house'),
  maxPagesToScrape: z.number().int().min(1).max(3).default(1),
});

export async function POST(req: Request) {
  const rl = rateLimit(`photos-start:${clientKey(req)}`);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests.' },
      { status: 429 },
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

  const parsed = StartRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request.', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { suburb, state, postcode, propertyType, maxPagesToScrape } =
    parsed.data;

  const startUrl = buildReaSoldUrl({ suburb, state, postcode, propertyType });

  try {
    const result = await startRun({ maxPagesToScrape, startUrl });
    // Structured log: grep '"tag":"apify-start"' in Vercel Logs.
    console.log(
      JSON.stringify({
        tag: 'apify-start',
        suburb,
        state,
        postcode,
        propertyType,
        startUrl,
        runId: result.runId,
        datasetId: result.datasetId,
        status: result.status,
      }),
    );
    return NextResponse.json({
      runId: result.runId,
      datasetId: result.datasetId,
      status: result.status,
      startUrl,
    });
  } catch (err) {
    if (err instanceof ApifyError) {
      return NextResponse.json(
        {
          error: err.message,
          endpoint: err.endpoint,
          upstreamStatus: err.status,
        },
        { status: 502 },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
