import { renderToBuffer } from '@react-pdf/renderer';
import { NextResponse } from 'next/server';

import { ValuationReport } from '@/lib/pdf/report';
import type { FullValuationResult } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 15;

export async function POST(req: Request) {
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
      { error: 'Valuation result payload is incomplete.' },
      { status: 400 },
    );
  }

  try {
    const buffer = await renderToBuffer(<ValuationReport data={data} />);
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

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'report'
  );
}
