import { NextResponse } from 'next/server';
import { z } from 'zod';

import { ApifyError, startRun } from '@/lib/apify/client';
import { buildReaSearchUrl } from '@/lib/apify/match';
import { clientKey, rateLimit } from '@/lib/ratelimit';

export const runtime = 'nodejs';
export const maxDuration = 15;

/**
 * Kick off TWO Apify scrapes in parallel: one against the REA sold
 * channel (for comp photos) and one against the buy channel (for the
 * subject's photos, since a pre-purchase CMA usually targets a
 * currently-for-sale property). The client gets both runIds back and
 * passes them to /api/photos/poll which waits for both to finish
 * before matching.
 *
 * Cost is ~2x a single run, still in the $0.02-$0.10 range per
 * valuation at these page counts. Both runs go in parallel so wall
 * clock is no worse than a single run.
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

  const soldUrl = buildReaSearchUrl({
    channel: 'sold',
    suburb,
    state,
    postcode,
    propertyType,
  });
  const buyUrl = buildReaSearchUrl({
    channel: 'buy',
    suburb,
    state,
    postcode,
    propertyType,
  });

  // Fire both in parallel. Promise.allSettled so one channel failing
  // (e.g. Apify quota on one actor) doesn't kill the other — we still
  // return whichever succeeded and the poll route degrades gracefully
  // from there.
  const [soldRes, buyRes] = await Promise.allSettled([
    startRun({ maxPagesToScrape, startUrl: soldUrl }),
    startRun({ maxPagesToScrape, startUrl: buyUrl }),
  ]);

  const sold =
    soldRes.status === 'fulfilled'
      ? {
          runId: soldRes.value.runId,
          datasetId: soldRes.value.datasetId,
          status: soldRes.value.status,
        }
      : null;
  const buy =
    buyRes.status === 'fulfilled'
      ? {
          runId: buyRes.value.runId,
          datasetId: buyRes.value.datasetId,
          status: buyRes.value.status,
        }
      : null;

  if (!sold && !buy) {
    const soldErr =
      soldRes.status === 'rejected' ? soldRes.reason : undefined;
    const buyErr = buyRes.status === 'rejected' ? buyRes.reason : undefined;
    const format = (r: unknown): string =>
      r instanceof Error ? r.message : String(r ?? 'unknown');
    const firstApifyErr =
      soldErr instanceof ApifyError
        ? soldErr
        : buyErr instanceof ApifyError
          ? buyErr
          : null;
    return NextResponse.json(
      {
        error: `Both Apify runs failed. sold: ${format(soldErr)}; buy: ${format(buyErr)}`,
        endpoint: firstApifyErr?.endpoint,
        upstreamStatus: firstApifyErr?.status,
      },
      { status: 502 },
    );
  }

  console.log(
    JSON.stringify({
      tag: 'apify-start',
      suburb,
      state,
      postcode,
      propertyType,
      soldUrl,
      buyUrl,
      sold,
      buy,
    }),
  );

  return NextResponse.json({
    sold,
    buy,
    soldUrl,
    buyUrl,
    // Surface per-channel failures so the client can show a nuanced
    // banner without pretending everything worked.
    soldError:
      soldRes.status === 'rejected'
        ? soldRes.reason instanceof Error
          ? soldRes.reason.message
          : String(soldRes.reason)
        : null,
    buyError:
      buyRes.status === 'rejected'
        ? buyRes.reason instanceof Error
          ? buyRes.reason.message
          : String(buyRes.reason)
        : null,
  });
}
