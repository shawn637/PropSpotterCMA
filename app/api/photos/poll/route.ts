import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  ApifyError,
  getDatasetItems,
  getRunStatus,
  type ApifyRunSnapshot,
} from '@/lib/apify/client';
import {
  matchListingsToComps,
  type ReaScraperListing,
} from '@/lib/apify/match';
import { clientKey, rateLimit } from '@/lib/ratelimit';
import type { Comparable } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * Poll the sold + buy Apify runs started by /api/photos/start. Returns
 * `finished: false` until BOTH runs terminate. Once both are done
 * (regardless of individual success/failure), fetches whichever
 * datasets succeeded and runs the matcher:
 *
 *   comps    ← sold dataset (or buy dataset as last-resort fallback)
 *   subject  ← buy dataset (or sold dataset as fallback)
 *
 * Response shape (when finished):
 *   {
 *     status: 'DONE',
 *     finished: true,
 *     matched: [{addressKey, imageUrl, matchReason}],
 *     subjectMatch: {addressKey, imageUrl, matchReason} | null,
 *     unmatchedAddressKeys: [...],
 *     totalListings: { sold: number, buy: number },
 *     errors: { sold?: string, buy?: string }
 *   }
 */
const PollRequest = z.object({
  sold: z
    .object({
      runId: z.string().min(1).max(64),
      datasetId: z.string().min(1).max(64),
    })
    .nullable()
    .optional(),
  buy: z
    .object({
      runId: z.string().min(1).max(64),
      datasetId: z.string().min(1).max(64),
    })
    .nullable()
    .optional(),
  comps: z
    .array(
      z.object({
        addressKey: z.string().min(1),
        fullAddress: z.string().min(1),
        salePrice: z.number(),
        saleDateIso: z.string().min(1),
      }),
    )
    .min(1)
    .max(20),
  subject: z
    .object({
      addressKey: z.string().min(1),
      fullAddress: z.string().min(1),
    })
    .optional(),
});

export async function POST(req: Request) {
  const rl = rateLimit(`photos-poll:${clientKey(req)}`);
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

  const parsed = PollRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request.', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { sold, buy, comps, subject } = parsed.data;
  if (!sold && !buy) {
    return NextResponse.json(
      { error: 'At least one of sold or buy run info is required.' },
      { status: 400 },
    );
  }

  try {
    const soldSnap = sold ? await getRunStatus(sold.runId) : null;
    const buySnap = buy ? await getRunStatus(buy.runId) : null;

    const soldFinished = !soldSnap || soldSnap.finished;
    const buyFinished = !buySnap || buySnap.finished;

    if (!(soldFinished && buyFinished)) {
      return NextResponse.json({
        status: 'RUNNING',
        finished: false,
        sold: soldSnap && { status: soldSnap.status, finished: soldSnap.finished },
        buy: buySnap && { status: buySnap.status, finished: buySnap.finished },
      });
    }

    // Both runs terminated. Fetch datasets for whichever succeeded.
    const [soldItems, buyItems] = await Promise.all([
      fetchDatasetSafely(soldSnap),
      fetchDatasetSafely(buySnap),
    ]);

    const soldListings = ((soldItems.items ?? []) as ReaScraperListing[])
      .filter(
        (i) =>
          !!i && (i.isSoldChannel === true || i.isSoldChannel === undefined),
      );
    const buyListings = ((buyItems.items ?? []) as ReaScraperListing[]).filter(
      (i) => !!i,
    );

    const compsForMatch: Comparable[] = comps.map((c) => ({
      addressKey: c.addressKey,
      fullAddress: c.fullAddress,
      salePrice: c.salePrice,
      saleDateIso: c.saleDateIso,
    }));

    // Comps match from sold dataset. If sold failed entirely, fall back
    // to buy (unlikely to contain the sold comps but cheap to try).
    const compsSource = soldListings.length > 0 ? soldListings : buyListings;
    const compsMatchResult = matchListingsToComps(compsForMatch, compsSource);

    // Subject matches from buy dataset first (typical pre-purchase case:
    // subject is currently listed). Fall back to sold if not found —
    // covers the case where the subject itself recently sold.
    let subjectMatch: ReturnType<
      typeof matchListingsToComps
    >['subject'];
    if (subject) {
      const buyTry = matchListingsToComps([], buyListings, subject);
      if (buyTry.subject) {
        subjectMatch = buyTry.subject;
      } else {
        const soldTry = matchListingsToComps([], soldListings, subject);
        if (soldTry.subject) {
          subjectMatch = soldTry.subject;
        }
      }
    }

    const matchedKeys = new Set(
      compsMatchResult.comps.map((m) => m.addressKey),
    );
    const unmatchedAddressKeys = comps
      .map((c) => c.addressKey)
      .filter((k) => !matchedKeys.has(k));

    const errors: { sold?: string; buy?: string } = {};
    if (soldSnap && !soldSnap.succeeded) {
      errors.sold = `sold run ended ${soldSnap.status}`;
    }
    if (buySnap && !buySnap.succeeded) {
      errors.buy = `buy run ended ${buySnap.status}`;
    }
    if (soldItems.error) errors.sold = soldItems.error;
    if (buyItems.error) errors.buy = buyItems.error;

    console.log(
      JSON.stringify({
        tag: 'apify-poll',
        soldRunId: sold?.runId,
        buyRunId: buy?.runId,
        soldCount: soldListings.length,
        buyCount: buyListings.length,
        matchedCount: compsMatchResult.comps.length,
        unmatchedCount: unmatchedAddressKeys.length,
        subjectMatched: !!subjectMatch,
        errors,
      }),
    );

    return NextResponse.json({
      status: 'DONE',
      finished: true,
      matched: compsMatchResult.comps,
      subjectMatch: subjectMatch ?? null,
      unmatchedAddressKeys,
      totalListings: {
        sold: soldListings.length,
        buy: buyListings.length,
      },
      errors,
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

async function fetchDatasetSafely(
  snap: ApifyRunSnapshot | null,
): Promise<{ items: unknown[] | null; error?: string }> {
  if (!snap) return { items: null };
  if (!snap.succeeded) {
    return {
      items: null,
      error: `run ended with status ${snap.status}`,
    };
  }
  try {
    const items = await getDatasetItems<unknown>(snap.datasetId);
    return { items };
  } catch (err) {
    return {
      items: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
