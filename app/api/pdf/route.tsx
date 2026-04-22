import { renderToBuffer } from '@react-pdf/renderer';
import { NextResponse } from 'next/server';

import { ReportPhotos, ValuationReport } from '@/lib/pdf/report';
import { clientKey, rateLimit } from '@/lib/ratelimit';
import type { FullValuationResult } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 20;

/**
 * Optional image URLs sent alongside the valuation payload. The client
 * already has these from the Apify scrape + Claude Vision flow; we
 * fetch them server-side here, encode them as data URIs, and hand them
 * to the PDF renderer. Pre-fetching server-side (rather than letting
 * @react-pdf/renderer hit the network at render time) keeps rendering
 * deterministic and lets a single failing image fall through without
 * blowing up the whole report.
 */
interface PdfRequest {
  data: FullValuationResult;
  photoUrls?: {
    subject?: string;
    comparables?: Record<string, string>;
  };
}

const IMAGE_FETCH_TIMEOUT_MS = 6000;

export async function POST(req: Request) {
  const rl = rateLimit(`pdf:${clientKey(req)}`);
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

  let body: PdfRequest;
  try {
    const raw = (await req.json()) as unknown;
    // Back-compat: older clients POST the FullValuationResult directly
    // rather than {data, photoUrls}. Detect that shape and wrap it.
    if (raw && typeof raw === 'object' && 'subject' in raw) {
      body = { data: raw as FullValuationResult };
    } else {
      body = raw as PdfRequest;
    }
  } catch {
    return NextResponse.json(
      { error: 'Request body must be JSON.' },
      { status: 400 },
    );
  }

  const data = body?.data;
  if (!data?.subject?.fullAddress || !data?.maxPrice || !data?.cma) {
    return NextResponse.json(
      { error: 'Valuation result payload is incomplete.' },
      { status: 400 },
    );
  }

  const photos = await resolvePhotos(body?.photoUrls);

  try {
    const buffer = await renderToBuffer(
      <ValuationReport data={data} photos={photos} />,
    );
    const filename = `propspotter-cma-${slugify(data.subject.fullAddress)}.pdf`;
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('PDF route failed:', err);
    const message = err instanceof Error ? err.message : 'PDF render failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Fetch each photo URL in parallel and convert to a data URI.
 * Individual failures are swallowed — the PDF renders without that
 * photo rather than failing as a whole.
 */
async function resolvePhotos(
  urls: PdfRequest['photoUrls'] | undefined,
): Promise<ReportPhotos | undefined> {
  if (!urls) return undefined;

  const entries: Array<{ key: string; url: string; slot: 'subject' | 'comp' }> =
    [];
  if (urls.subject) entries.push({ key: 'subject', url: urls.subject, slot: 'subject' });
  if (urls.comparables) {
    for (const [k, u] of Object.entries(urls.comparables)) {
      if (u) entries.push({ key: k, url: u, slot: 'comp' });
    }
  }
  if (entries.length === 0) return undefined;

  const resolved = await Promise.all(
    entries.map(async (e) => ({
      ...e,
      dataUri: await fetchAsDataUri(e.url),
    })),
  );

  const photos: ReportPhotos = { comparables: {} };
  for (const r of resolved) {
    if (!r.dataUri) continue;
    if (r.slot === 'subject') photos.subject = r.dataUri;
    else photos.comparables![r.key] = r.dataUri;
  }
  return photos;
}

async function fetchAsDataUri(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      IMAGE_FETCH_TIMEOUT_MS,
    );
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? 'image/jpeg';
    // Only embed actual image content — guard against HTML error pages
    // coming back as 200s.
    if (!ct.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${ct};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'report'
  );
}
