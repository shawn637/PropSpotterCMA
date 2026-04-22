import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  ApifyError,
  getDatasetItems,
  getRunStatus,
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
 * Poll a previously-started Apify run. The client supplies:
 *   runId      — from /api/photos/start
 *   datasetId  — from /api/photos/start
 *   comps      — the current list of comparables the UI is showing,
 *                so the server can match REA listings against them
 *                and return a compact {addressKey, imageUrl} map.
 *
 * Response shape is a discriminated union:
 *   { status: 'RUNNING' | 'READY' | '...' }
 *   { status: 'SUCCEEDED', matched: [{addressKey, imageUrl, matchReason}],
 *     totalListings: number, unmatchedAddressKeys: string[] }
 *   { status: 'FAILED' | 'TIMED-OUT' | 'ABORTED', error: string }
 *
 * The client polls this endpoint every 3–5 s until `finished` is true.
 * All matching runs server-side so the response stays small (tens of
 * bytes per comp instead of tens of KB of raw REA listing data).
 */
const PollRequest = z.object({
  runId: z.string().min(1).max(64),
  datasetId: z.string().min(1).max(64),
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

  const { runId, datasetId, comps, subject } = parsed.data;

  try {
    const snap = await getRunStatus(runId);
    if (!snap.finished) {
      return NextResponse.json({
        status: snap.status,
        finished: false,
        runId,
        datasetId,
      });
    }
    if (!snap.succeeded) {
      return NextResponse.json(
        {
          status: snap.status,
          finished: true,
          error: `Apify run ${runId} terminated with status ${snap.status}`,
        },
        { status: 502 },
      );
    }

    const items = await getDatasetItems<ReaScraperListing>(snap.datasetId);
    const soldOnly = items.filter(
      (i) => i && (i.isSoldChannel === true || i.isSoldChannel === undefined),
    );

    // matchListingsToComps expects the full Comparable shape; we only
    // received the essential fields over the wire (to keep the POST
    // body small). Reconstitute with defaults so the matcher is happy.
    const compsForMatch: Comparable[] = comps.map((c) => ({
      addressKey: c.addressKey,
      fullAddress: c.fullAddress,
      salePrice: c.salePrice,
      saleDateIso: c.saleDateIso,
    }));

    const matchResult = matchListingsToComps(
      compsForMatch,
      soldOnly,
      subject,
    );
    const matchedKeys = new Set(matchResult.comps.map((m) => m.addressKey));
    const unmatchedAddressKeys = comps
      .map((c) => c.addressKey)
      .filter((k) => !matchedKeys.has(k));

    console.log(
      JSON.stringify({
        tag: 'apify-poll',
        runId,
        datasetId,
        totalListings: items.length,
        matchedCount: matchResult.comps.length,
        unmatchedCount: unmatchedAddressKeys.length,
        subjectMatched: !!matchResult.subject,
      }),
    );

    return NextResponse.json({
      status: snap.status,
      finished: true,
      runId,
      datasetId,
      totalListings: items.length,
      matched: matchResult.comps,
      subjectMatch: matchResult.subject ?? null,
      unmatchedAddressKeys,
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
