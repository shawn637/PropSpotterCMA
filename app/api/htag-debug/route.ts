import { NextResponse } from 'next/server';
import { z } from 'zod';

import { HtagError, isMockMode, rawHtagFetch } from '@/lib/htag/client';
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
 *     -d '{"address":"42 Example St, Baulkham Hills NSW 2153","locPid":"NSW231"}'
 *
 * The response is a sequence of stages. Each stage records the endpoint
 * it hit, the status code, elapsed time, top-level response keys, and
 * (on success) the full raw JSON body so you can map field names to the
 * interfaces in lib/types.ts.
 */
const RequestSchema = z.object({
  address: z.string().min(4).max(300),
  // Optional: if you already have a loc_pid for the suburb, we'll also
  // probe the market endpoints. Without it, market stages are skipped
  // because they key off loc_pid.
  locPid: z.string().min(1).max(64).optional(),
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
    return NextResponse.json(
      { error: 'Too many requests.' },
      { status: 429 },
    );
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

  // Stage 1: standardise. HTAG expects a batch request (addresses array)
  // and returns array-shaped results. Flatten to the first result for
  // downstream key extraction.
  const standardised = await runStage(
    stages,
    'standardise',
    '/v1/address/standardise',
    'POST',
    JSON.stringify({ addresses: [parsed.address] }),
  );
  const flat = flattenFirstResult(standardised);
  if (flat) {
    if (typeof flat.address_key === 'string') addressKey = flat.address_key;
    if (!derivedLocPid && typeof flat.loc_pid === 'string') {
      derivedLocPid = flat.loc_pid;
    }
  }

  // Stage 2: property summary (only if standardise gave us an address key)
  if (addressKey) {
    await runStage(
      stages,
      'property-summary',
      `/v1/property/${encodeURIComponent(addressKey)}/summary`,
      'GET',
    );
  } else {
    stages.push({
      name: 'property-summary',
      endpoint: '(skipped)',
      method: 'GET',
      ok: false,
      elapsedMs: 0,
      error: 'No address_key found in standardise response.',
    });
  }

  // Stage 3: sold search (keyed off address_key + loc_pid)
  if (addressKey) {
    await runStage(
      stages,
      'sold-search',
      '/v1/property/sold/search',
      'POST',
      JSON.stringify({
        address_key: addressKey,
        loc_pid: derivedLocPid,
        radius_km: 2,
        months_back: 6,
        property_type: 'House',
        limit: 12,
      }),
    );
  }

  // Stages 4–7: market endpoints (only if we have a loc_pid)
  if (derivedLocPid) {
    const q = `?loc_pid=${encodeURIComponent(derivedLocPid)}`;
    await Promise.all([
      runStage(stages, 'market-growth', `/v1/markets/growth/annualised${q}`, 'GET'),
      runStage(stages, 'market-cycle', `/v1/markets/cycle${q}`, 'GET'),
      runStage(stages, 'market-demand', `/v1/markets/demand${q}`, 'GET'),
      runStage(stages, 'market-summary', `/v1/markets/summary${q}`, 'GET'),
    ]);
  } else {
    stages.push({
      name: 'market-*',
      endpoint: '(skipped)',
      method: 'GET',
      ok: false,
      elapsedMs: 0,
      error: 'No loc_pid supplied and none returned by standardise.',
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

/**
 * Batch endpoints return either a bare array or an object wrapping an
 * array. Returns the first element as a flat object, or null if the
 * response can't be flattened — the stage record already shows the raw
 * body so you can see the true shape anyway.
 */
function flattenFirstResult(response: unknown): Record<string, unknown> | null {
  if (Array.isArray(response)) {
    return typeof response[0] === 'object' && response[0] !== null
      ? (response[0] as Record<string, unknown>)
      : null;
  }
  if (typeof response === 'object' && response !== null) {
    const obj = response as Record<string, unknown>;
    for (const key of ['results', 'data', 'addresses']) {
      const inner = obj[key];
      if (Array.isArray(inner) && inner.length > 0) {
        const first = inner[0];
        if (typeof first === 'object' && first !== null) {
          return first as Record<string, unknown>;
        }
      }
    }
    return obj;
  }
  return null;
}
