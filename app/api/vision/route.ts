import { NextResponse } from 'next/server';
import { z } from 'zod';

import { analyzeFacade } from '@/lib/llm/vision';
import { clientKey, rateLimit } from '@/lib/ratelimit';
import type { VisionAttributes } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Batch-analyze facade photos. Each image → one Claude Vision call.
 * Called from the CMAResult review UI after the user pastes image URLs
 * against comps and (optionally) the subject.
 *
 * Cost note: each image ≈ 2k input + ~200 output tokens on Sonnet 4.6,
 * or roughly US$0.01 per image. A typical request of 1 subject + 10
 * comps is ≈ US$0.07. The per-IP rate limit (20/min by default)
 * already applies via the shared ratelimit module.
 */
const VisionRequest = z.object({
  subject: z
    .object({
      addressKey: z.string().min(1),
      imageUrl: z.string().url(),
    })
    .optional(),
  comps: z
    .array(
      z.object({
        addressKey: z.string().min(1),
        imageUrl: z.string().url(),
      }),
    )
    .max(12),
});

interface CompVisionResult {
  addressKey: string;
  attrs: VisionAttributes | null;
  error?: string;
}

interface VisionResponse {
  subject?: { attrs: VisionAttributes | null; error?: string };
  comps: CompVisionResult[];
  totalTokens: { input: number; output: number };
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
  // shape deterministic in input order; per-image failures are captured
  // as { attrs: null, error } rather than rejecting the whole batch.
  const subjectPromise = subject
    ? analyzeFacade(subject.imageUrl)
    : Promise.resolve(null);
  const compPromises = comps.map((c) => analyzeFacade(c.imageUrl));

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
    ? { attrs: subjectResult.attrs, error: subjectResult.error }
    : undefined;
  if (subjectResult) tally(subjectResult.tokenUsage);

  const compsOut: CompVisionResult[] = compResults.map((r, i) => {
    tally(r.tokenUsage);
    return {
      addressKey: comps[i].addressKey,
      attrs: r.attrs,
      error: r.error,
    };
  });

  const payload: VisionResponse = {
    subject: subjectOut,
    comps: compsOut,
    totalTokens: { input: totalInput, output: totalOutput },
  };

  // Structured log line: grep '"tag":"vision"' in Vercel logs to see
  // per-request image count + token spend.
  console.log(
    JSON.stringify({
      tag: 'vision',
      compCount: comps.length,
      hasSubject: !!subject,
      failedComps: compsOut.filter((c) => c.attrs == null).length,
      tokens: payload.totalTokens,
    }),
  );

  return NextResponse.json(payload);
}
