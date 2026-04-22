'use client';

import { useState } from 'react';

import { AddressForm } from '@/components/AddressForm';
import { CMAResult } from '@/components/CMAResult';
import { LoadingState } from '@/components/LoadingState';
import type { CMARequest, FullValuationResult } from '@/lib/types';

type ViewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'result'; data: FullValuationResult }
  | { kind: 'error'; message: string };

export default function Home() {
  const [view, setView] = useState<ViewState>({ kind: 'idle' });
  const [pdfBusy, setPdfBusy] = useState(false);

  async function handleSubmit(req: CMARequest) {
    setView({ kind: 'loading' });
    try {
      const res = await fetch('/api/cma', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          body?.error ?? `CMA request failed (${res.status} ${res.statusText})`,
        );
      }
      const data = (await res.json()) as FullValuationResult;
      setView({ kind: 'result', data });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error.';
      setView({ kind: 'error', message });
    }
  }

  async function handleDownloadPdf() {
    if (view.kind !== 'result') return;
    setPdfBusy(true);
    try {
      const res = await fetch('/api/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(view.data),
      });
      if (!res.ok) throw new Error(`PDF render failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileNameFor(view.data.subject.fullAddress);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      alert('Could not generate the PDF. Please try again.');
    } finally {
      setPdfBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <header className="mb-8 border-b-2 border-navy pb-4">
        <h1 className="text-2xl font-bold text-navy">PropSpotter CMA</h1>
        <p className="text-sm text-slate-600">
          Paste an address. Get a comparable market analysis and three
          negotiation reference numbers you can use — not a price
          recommendation.
        </p>
      </header>

      {view.kind === 'idle' && (
        <section className="rounded-lg bg-white border border-slate-200 p-5 shadow-sm">
          <AddressForm onSubmit={handleSubmit} />
        </section>
      )}

      {view.kind === 'loading' && <LoadingState />}

      {view.kind === 'error' && (
        <div className="rounded-md bg-red-50 border border-red-200 text-red-800 px-4 py-3">
          <p className="font-semibold">Something went wrong</p>
          <p className="text-sm mt-1">{view.message}</p>
          <button
            onClick={() => setView({ kind: 'idle' })}
            className="mt-3 rounded-md border border-red-300 px-3 py-1.5 text-sm hover:bg-red-100"
          >
            Try again
          </button>
        </div>
      )}

      {view.kind === 'result' && (
        <CMAResult
          data={view.data}
          onDownloadPdf={handleDownloadPdf}
          onReset={() => setView({ kind: 'idle' })}
          pdfBusy={pdfBusy}
        />
      )}
    </main>
  );
}

function fileNameFor(address: string): string {
  const slug = address
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `propspotter-cma-${slug || 'report'}.pdf`;
}
