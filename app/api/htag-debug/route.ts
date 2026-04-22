import { NextResponse } from 'next/server';
import { z } from 'zod';

import { HtagError, isMockMode, rawHtagFetch } from '@/lib/htag/client';
import { firstResult } from '@/lib/htag/parse';
import { clientKey, rateLimit } from '@/lib/ratelimit';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * Phase 3 helper. Hits each HTAG endpoint the app depends on and returns
 * the raw JSON so you can confirm the real response shape without
 * running the full CMA pipeline.
 *
 * Protected by the app password middleware, so no additional auth here.
 * Disabled entirely in mock mode — there's nothing meaningful to debug.
 *
 * Usage:
 *   curl -u any:$APP_PASSWORD -X POST https://<deploy>/api/htag-debug \
 *     -H 'Content-Type: application/json' \
 *     -d '{"address":"413 Anson Street, Orange NSW 2800"}'
 *
 * The response is a sequence of stages. Each stage records the endpoint
 * it hit, the HTTP method, status, elapsed time, top-level response
 * keys, and (on success) the full raw JSON body so you can map field
 * names to the parsers in lib/htag/parse.ts.
 */
const RequestSchema = z.object({
  address: z.string().min(4).max(300),
  // Optional: if you already have a loc_pid, skip geocode and jump
  // straight to the market endpoints for that suburb.
  locPid: z.string().min(1).max(64).optional(),
  propertyType: z
    .enum(['house', 'unit', 'townhouse', 'land', 'rural'])
    .default('house'),
});

interface Stage {
  name: string;
  endpoint: string;
  method: string;
  ok: boolean;
  status?: number;
  elapsedMs: number;
  responseKeys?: string[];
  body?: unknown;
  error?: string;
}

export async function POST(req: Request) {
  const rl = rateLimit(`htag-debug:${clientKey(req)}`);
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests.' }, { status: 429 });
  }

  if (isMockMode()) {
    return NextResponse.json(
      {
        error:
          'htag-debug is only meaningful when MOCK_DATA=false. Set MOCK_DATA=false and HTAG_API_KEY in env, then redeploy.',
      },
      { status: 501 },
    );
  }

  let parsed: z.infer<typeof RequestSchema>;
  try {
    parsed = RequestSchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: 'Invalid request body.', details: String(err) },
      { status: 400 },
    );
  }

  const stages: Stage[] = [];
  let addressKey: string | undefined;
  let derivedLocPid: string | undefined = parsed.locPid;

  // Stage 1: /v1/address/geocode — canonical identity + loc_pid.
  const geocodePath = `/v1/address/geocode?address=${encodeURIComponent(parsed.address)}`;
  const geocode = await runStage(stages, 'geocode', geocodePath, 'GET');
  try {
    const row = firstResult(geocode, geocodePath);
    if (typeof row.address_key === 'string') addressKey = row.address_key;
    if (!derivedLocPid && typeof row.loc_pid === 'string') {
      derivedLocPid = row.loc_pid;
    }
  } catch {
    /* already logged as a failed stage */
  }

  // Stage 2: /v1/property/summary — physical attributes (optional, may
  // 404 even for a valid address_key).
  if (addressKey) {
    const summaryPath = `/v1/property/summary?address_key=${encodeURIComponent(addressKey)}`;
    await runStage(stages, 'property-summary', summaryPath, 'GET');
  } else {
    stages.push({
      name: 'property-summary',
      endpoint: '(skipped)',
      method: 'GET',
      ok: false,
      elapsedMs: 0,
      error: 'No address_key from geocode.',
    });
  }

  // Stage 3: /v1/property/sold/search — recent comparable sales.
  if (addressKey) {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6);
    const params = new URLSearchParams({
      address_key: addressKey,
      proximity: 'sameSuburb',
      propertyType: parsed.propertyType,
      saleFromDate: sixMonthsAgo.toISOString().slice(0, 10),
      limit: '12',
    });
    await runStage(
      stages,
      'sold-search',
      `/v1/property/sold/search?${params.toString()}`,
      'GET',
    );
  }

  // Stages 4–7: the four /v1/markets/* endpoints, all keyed off
  // level=suburb + area_id=<loc_pid>.
  if (derivedLocPid) {
    const params = new URLSearchParams({
      level: 'suburb',
      area_id: derivedLocPid,
      property_type: parsed.propertyType,
    });
    const q = `?${params.toString()}`;
    await Promise.all([
      runStage(stages, 'market-summary', `/v1/markets/summary${q}`, 'GET'),
      runStage(stages, 'market-growth-annualised', `/v1/markets/growth/annualised${q}`, 'GET'),
      runStage(stages, 'market-cycle', `/v1/markets/cycle${q}`, 'GET'),
      runStage(stages, 'market-demand', `/v1/markets/demand${q}`, 'GET'),
    ]);
  } else {
    stages.push({
      name: 'market-*',
      endpoint: '(skipped)',
      method: 'GET',
      ok: false,
      elapsedMs: 0,
      error: 'No loc_pid supplied and none returned by geocode.',
    });
  }

  return NextResponse.json({
    mode: 'live',
    requestedAddress: parsed.address,
    derivedAddressKey: addressKey,
    derivedLocPid,
    stages,
  });
}

async function runStage(
  stages: Stage[],
  name: string,
  endpoint: string,
  method: 'GET' | 'POST',
  body?: string,
): Promise<unknown | null> {
  const startedAt = Date.now();
  try {
    const init: RequestInit = { method };
    if (body != null) init.body = body;
    const json = await rawHtagFetch<unknown>(endpoint, init);
    stages.push({
      name,
      endpoint,
      method,
      ok: true,
      status: 200,
      elapsedMs: Date.now() - startedAt,
      responseKeys:
        json && typeof json === 'object' && !Array.isArray(json)
          ? Object.keys(json).slice(0, 30)
          : [],
      body: json,
    });
    return json;
  } catch (err) {
    const stage: Stage = {
      name,
      endpoint,
      method,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
    if (err instanceof HtagError) stage.status = err.status;
    stages.push(stage);
    return null;
  }
}
