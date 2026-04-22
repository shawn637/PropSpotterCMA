import { NextResponse } from 'next/server';
import { z } from 'zod';

import { analyzeListing } from '@/lib/llm/vision';
import { clientKey, rateLimit } from '@/lib/ratelimit';
import type { VisionAttributes } from '@/lib/types';

export const runtime = 'nodejs';
// Multi-image Vision calls on large comp sets can push well past the
// default 60 s. Pro tier caps maxDuration at 300 s; that's our ceiling.
export const maxDuration = 300;

/**
 * Batch-analyze listing photos. ONE Claude Vision call per target
 * (subject or comp), each call bundling up to ~10 images from that
 * listing so the model can see kitchen + bathroom + backyard + façade
 * together before classifying. Called from the CMAResult review UI
 * once the Apify scrape has populated per-listing image URL arrays.
 *
 * Cost note: each listing call is ~10 images × ~1500 input tokens =
 * ~15k input tokens + ~300 output on Sonnet 4.6, or roughly US$0.05
 * per listing. A typical request of 1 subject + 10 comps is ≈ US$0.50.
 * Per-IP rate limit (20/min by default) still applies.
 *
 * Back-compat: a target with `imageUrl: string` (singular) is treated
 * as a length-1 `imageUrls` array.
 */
const TargetSchema = z
  .object({
    addressKey: z.string().min(1),
    imageUrls: z.array(z.string().url()).min(1).max(20).optional(),
    imageUrl: z.string().url().optional(),
  })
  .refine((t) => (t.imageUrls && t.imageUrls.length > 0) || !!t.imageUrl, {
    message: 'must supply imageUrls[] or imageUrl',
  });

const VisionRequest = z.object({
  subject: TargetSchema.optional(),
  comps: z.array(TargetSchema).max(12),
});

interface CompVisionResult {
  addressKey: string;
  attrs: VisionAttributes | null;
  error?: string;
  imagesSent?: number;
}

interface VisionResponse {
  subject?: {
    attrs: VisionAttributes | null;
    error?: string;
    imagesSent?: number;
  };
  comps: CompVisionResult[];
  totalTokens: { input: number; output: number };
}

function urlsFor(t: z.infer<typeof TargetSchema>): string[] {
  if (t.imageUrls && t.imageUrls.length > 0) return t.imageUrls;
  if (t.imageUrl) return [t.imageUrl];
  return [];
}

export async function POST(req: Request) {
  const rl = rateLimit(`vision:${clientKey(req)}`);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please wait a minute and try again.' },
      {
        status: 429,
        headers: {
          'X-RateLimit-Limit': String(rl.limit),
          'X-RateLimit-Remaining': String(rl.remaining),
          'X-RateLimit-Reset': String(Math.ceil(rl.resetAt / 1000)),
        },
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

  const parsed = VisionRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request.', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { subject, comps } = parsed.data;

  // Fire all vision calls in parallel. Promise.all keeps the response
  // shape deterministic in input order; per-listing failures surface
  // as { attrs: null, error } rather than rejecting the whole batch.
  const subjectPromise = subject
    ? analyzeListing(urlsFor(subject))
    : Promise.resolve(null);
  const compPromises = comps.map((c) => analyzeListing(urlsFor(c)));

  const [subjectResult, ...compResults] = await Promise.all([
    subjectPromise,
    ...compPromises,
  ]);

  let totalInput = 0;
  let totalOutput = 0;
  const tally = (u?: { input: number; output: number }) => {
    if (u) {
      totalInput += u.input;
      totalOutput += u.output;
    }
  };

  const subjectOut = subjectResult
    ? {
        attrs: subjectResult.attrs,
        error: subjectResult.error,
        imagesSent: subjectResult.imagesSent,
      }
    : undefined;
  if (subjectResult) tally(subjectResult.tokenUsage);

  const compsOut: CompVisionResult[] = compResults.map((r, i) => {
    tally(r.tokenUsage);
    return {
      addressKey: comps[i].addressKey,
      attrs: r.attrs,
      error: r.error,
      imagesSent: r.imagesSent,
    };
  });

  const payload: VisionResponse = {
    subject: subjectOut,
    comps: compsOut,
    totalTokens: { input: totalInput, output: totalOutput },
  };

  console.log(
    JSON.stringify({
      tag: 'vision',
      compCount: comps.length,
      hasSubject: !!subject,
      failedComps: compsOut.filter((c) => c.attrs == null).length,
      subjectImagesSent: subjectOut?.imagesSent,
      compImagesSent: compsOut.map((c) => c.imagesSent),
      tokens: payload.totalTokens,
    }),
  );

  return NextResponse.json(payload);
}
