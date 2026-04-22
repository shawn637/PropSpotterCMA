'use client';

import { FormEvent, useState } from 'react';

/**
 * Browser-based frontend for /api/htag-debug. Password-gated by the same
 * middleware as everything else (the middleware matches /((?!_next/...).*)
 * so /debug is included). Lets you probe every HTAG endpoint without a
 * terminal.
 *
 * Direct URL only — deliberately not linked from the home page to keep
 * the probe surface out of end-user view.
 */
export default function DebugPage() {
  const [address, setAddress] = useState('51 Kentwell St, Stanhope Gardens NSW 2768');
  const [locPid, setLocPid] = useState('');
  const [propertyType, setPropertyType] = useState<'house' | 'unit' | 'townhouse'>('house');
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState<unknown>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResponse(null);
    setStatus(null);
    setErrorText(null);
    try {
      const body: Record<string, unknown> = { address, propertyType };
      if (locPid.trim()) body.locPid = locPid.trim();
      const res = await fetch('/api/htag-debug', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setStatus(res.status);
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        setResponse(await res.json());
      } else {
        setResponse({ rawText: await res.text() });
      }
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function copyToClipboard() {
    if (response == null) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(response, null, 2));
    } catch {
      /* clipboard API may be unavailable — user can select-and-copy */
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-6 border-b-2 border-navy pb-3">
        <h1 className="text-xl font-bold text-navy">HTAG Debug Probe</h1>
        <p className="text-sm text-slate-600 mt-1">
          Hits every HTAG endpoint the app depends on and shows the raw JSON
          responses. Use this when <code>/api/cma</code> returns a 502 or 422
          and you want to know which stage failed.
        </p>
        <p className="text-xs text-slate-500 mt-1">
          Disabled when <code>MOCK_DATA=true</code>; the debug endpoint will
          respond with a 501 in that case.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-3 rounded-lg bg-white border border-slate-200 p-4 shadow-sm">
        <div>
          <label className="block text-sm font-medium text-navy mb-1" htmlFor="address">
            Address
          </label>
          <input
            id="address"
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy"
            required
          />
        </div>
        <div className="flex flex-wrap gap-3">
          <div>
            <label className="block text-sm font-medium text-navy mb-1" htmlFor="loc_pid">
              loc_pid <span className="text-slate-400">(optional)</span>
            </label>
            <input
              id="loc_pid"
              type="text"
              value={locPid}
              onChange={(e) => setLocPid(e.target.value)}
              placeholder="auto-derived from geocode"
              className="w-48 rounded-md border border-slate-300 px-3 py-2 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-navy mb-1" htmlFor="propertyType">
              propertyType
            </label>
            <select
              id="propertyType"
              value={propertyType}
              onChange={(e) => setPropertyType(e.target.value as 'house' | 'unit' | 'townhouse')}
              className="rounded-md border border-slate-300 px-3 py-2 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy"
            >
              <option value="house">house</option>
              <option value="unit">unit</option>
              <option value="townhouse">townhouse</option>
            </select>
          </div>
        </div>
        <button
          type="submit"
          disabled={busy || address.trim().length < 4}
          className="rounded-md bg-navy px-5 py-2 text-white font-medium hover:bg-navy/90 disabled:bg-slate-300"
        >
          {busy ? 'Probing…' : 'Run probe'}
        </button>
      </form>

      {errorText && (
        <div className="mt-4 rounded-md bg-red-50 border border-red-200 text-red-800 px-4 py-3 text-sm">
          {errorText}
        </div>
      )}

      {response != null && (
        <section className="mt-6">
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-sm font-semibold text-navy">
              Response {status != null ? `(HTTP ${status})` : ''}
            </h2>
            <button
              onClick={copyToClipboard}
              className="text-xs rounded-md border border-slate-300 px-2 py-1 hover:bg-slate-50"
            >
              Copy JSON
            </button>
          </div>
          <StagesSummary response={response} />
          <pre className="text-xs overflow-auto rounded-md bg-slate-900 text-slate-100 p-4 max-h-[600px] whitespace-pre">
{JSON.stringify(response, null, 2)}
          </pre>
        </section>
      )}
    </main>
  );
}

interface DebugStage {
  name: string;
  endpoint: string;
  method: string;
  ok: boolean;
  status?: number;
  elapsedMs?: number;
  error?: string;
}

function StagesSummary({ response }: { response: unknown }) {
  if (
    !response ||
    typeof response !== 'object' ||
    !Array.isArray((response as { stages?: unknown }).stages)
  ) {
    return null;
  }
  const stages = (response as { stages: DebugStage[] }).stages;
  return (
    <table className="w-full text-xs mb-3 border border-slate-200 rounded overflow-hidden">
      <thead className="bg-light-blue text-navy">
        <tr>
          <th className="py-1 px-2 text-left">Stage</th>
          <th className="py-1 px-2 text-left">Endpoint</th>
          <th className="py-1 px-2 text-right">Status</th>
          <th className="py-1 px-2 text-right">Elapsed</th>
          <th className="py-1 px-2 text-left">Result</th>
        </tr>
      </thead>
      <tbody>
        {stages.map((s, i) => (
          <tr key={i} className="border-t border-slate-100">
            <td className="py-1 px-2 font-medium">{s.name}</td>
            <td className="py-1 px-2 text-slate-600 break-all">{s.endpoint}</td>
            <td className="py-1 px-2 text-right">{s.status ?? '—'}</td>
            <td className="py-1 px-2 text-right">{s.elapsedMs ?? 0} ms</td>
            <td className={`py-1 px-2 ${s.ok ? 'text-teal' : 'text-red-700'}`}>
              {s.ok ? '✓' : s.error ?? 'failed'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
