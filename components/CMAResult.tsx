'use client';

import type { FullValuationResult } from '@/lib/types';

interface CMAResultProps {
  data: FullValuationResult;
  onDownloadPdf: () => void;
  onReset: () => void;
  pdfBusy?: boolean;
}

function currency(n: number): string {
  return `$${Math.round(n).toLocaleString('en-AU')}`;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-AU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function CMAResult({
  data,
  onDownloadPdf,
  onReset,
  pdfBusy,
}: CMAResultProps) {
  const { subject, market, cma, vendorAssessment, maxPrice, narrative } = data;
  const comps = cma.comparables.slice(0, 8);

  return (
    <div className="space-y-6">
      {data.dataSource === 'mock' && (
        <div className="rounded-md bg-amber-50 border border-amber-200 text-amber-900 px-3 py-2 text-sm">
          Demo mode — figures come from fixture data. Live HTAG integration is
          pending.
        </div>
      )}

      <div>
        <h2 className="text-xl font-semibold text-navy">
          {subject.fullAddress}
        </h2>
        <p className="text-sm text-slate-500">
          {subject.propertyType ?? 'House'} · {subject.bedrooms ?? '—'}BR ·{' '}
          {subject.bathrooms ?? '—'}BA ·{' '}
          {subject.landAreaSqm ? `${subject.landAreaSqm} sqm` : '—'}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <NumberCard
          label="Opening offer"
          value={currency(maxPrice.openingOffer)}
          note="6% below target — a constructive starting point."
          accent="border-teal"
        />
        <NumberCard
          label="Target price"
          value={currency(maxPrice.targetPrice)}
          note="Consistent with comparables and vendor posture."
          accent="border-navy"
        />
        <NumberCard
          label="Walk-away max"
          value={currency(maxPrice.walkAwayMax)}
          note="Ceiling given market cycle and property velocity."
          accent="border-gold"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <section className="rounded-lg bg-white border border-slate-200 p-4">
          <h3 className="text-sm font-semibold text-navy mb-2">CMA summary</h3>
          <dl className="text-sm grid grid-cols-2 gap-y-1">
            <dt className="text-slate-500">Fair value</dt>
            <dd className="text-right">{currency(cma.fairValue)}</dd>
            <dt className="text-slate-500">25–75th percentile</dt>
            <dd className="text-right">
              {currency(cma.fairValueLow)}–{currency(cma.fairValueHigh)}
            </dd>
            <dt className="text-slate-500">Dispersion</dt>
            <dd className="text-right">
              {(cma.dispersion * 100).toFixed(1)}%
            </dd>
            <dt className="text-slate-500">Comparables used</dt>
            <dd className="text-right">{cma.comparables.length}</dd>
          </dl>
        </section>

        <section className="rounded-lg bg-white border border-slate-200 p-4">
          <h3 className="text-sm font-semibold text-navy mb-2">
            Market context
          </h3>
          <dl className="text-sm grid grid-cols-2 gap-y-1">
            <dt className="text-slate-500">Suburb</dt>
            <dd className="text-right">
              {market.suburb} {market.state}
            </dd>
            <dt className="text-slate-500">Cycle stage</dt>
            <dd className="text-right">{market.cycleStage}</dd>
            <dt className="text-slate-500">5y growth</dt>
            <dd className="text-right">
              {(market.annualisedGrowth5y * 100).toFixed(1)}%
            </dd>
            <dt className="text-slate-500">Typical DOM</dt>
            <dd className="text-right">{market.typicalDaysOnMarket} days</dd>
          </dl>
        </section>
      </div>

      <section className="rounded-lg bg-white border border-slate-200 p-4">
        <h3 className="text-sm font-semibold text-navy mb-2">
          Adjustments applied
        </h3>
        <dl className="text-sm grid grid-cols-2 gap-y-1">
          <dt className="text-slate-500">Cycle stretch</dt>
          <dd className="text-right">
            {(maxPrice.cycleStretchPct * 100).toFixed(2)}%
          </dd>
          <dt className="text-slate-500">Velocity stretch</dt>
          <dd className="text-right">
            {(maxPrice.velocityStretchPct * 100).toFixed(2)}%
            {maxPrice.velocityRatio != null
              ? ` (ratio ${maxPrice.velocityRatio.toFixed(2)})`
              : ''}
          </dd>
          <dt className="text-slate-500">Vendor leverage</dt>
          <dd className="text-right">
            {(maxPrice.vendorLeveragePct * 100).toFixed(2)}% (
            {vendorAssessment.motivation})
          </dd>
        </dl>
        <p className="text-xs text-slate-500 mt-2">
          Vendor signal: {vendorAssessment.rationale}
        </p>
      </section>

      <section className="rounded-lg bg-white border border-slate-200 p-4">
        <h3 className="text-sm font-semibold text-navy mb-2">
          Comparable sales
        </h3>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500">
                <th className="py-1 pr-2">Address</th>
                <th className="py-1 pr-2 text-right">Sale price</th>
                <th className="py-1 pr-2 text-right">Date</th>
                <th className="py-1 pr-2 text-right">Adj.</th>
                <th className="py-1 pr-2 text-right">Implied value</th>
                <th className="py-1">Flags</th>
              </tr>
            </thead>
            <tbody>
              {comps.map((c) => (
                <tr
                  key={c.addressKey}
                  className="border-t border-slate-100 align-top"
                >
                  <td className="py-1 pr-2">{c.fullAddress}</td>
                  <td className="py-1 pr-2 text-right">
                    {currency(c.salePrice)}
                  </td>
                  <td className="py-1 pr-2 text-right">
                    {shortDate(c.saleDateIso)}
                  </td>
                  <td className="py-1 pr-2 text-right">
                    {c.adjustmentFactor.toFixed(3)}
                  </td>
                  <td className="py-1 pr-2 text-right">
                    {currency(c.impliedSubjectValue)}
                  </td>
                  <td className="py-1 text-slate-500">
                    {c.flags.join(', ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg bg-white border border-slate-200 p-4">
        <h3 className="text-sm font-semibold text-navy mb-2">Narrative</h3>
        <p className="text-sm text-slate-700 whitespace-pre-line leading-relaxed">
          {narrative}
        </p>
      </section>

      <div className="flex flex-wrap gap-3">
        <button
          onClick={onDownloadPdf}
          disabled={pdfBusy}
          className="inline-flex items-center justify-center rounded-md bg-navy px-5 py-2.5 text-white font-medium hover:bg-navy/90 disabled:bg-slate-300"
        >
          {pdfBusy ? 'Preparing PDF…' : 'Download PDF'}
        </button>
        <button
          onClick={onReset}
          className="inline-flex items-center justify-center rounded-md border border-slate-300 px-5 py-2.5 text-navy font-medium hover:bg-slate-50"
        >
          Value another property
        </button>
      </div>

      <p className="text-xs text-slate-500 italic">
        PropSpotter is a property research and advisory service, not a licensed
        financial adviser. These figures are research output, not personal
        financial advice. You make the final decision on any offer.
      </p>
    </div>
  );
}

function NumberCard({
  label,
  value,
  note,
  accent,
}: {
  label: string;
  value: string;
  note: string;
  accent: string;
}) {
  return (
    <div
      className={`rounded-lg bg-cream border-l-4 ${accent} p-4 shadow-sm number-reveal`}
    >
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="text-2xl font-bold text-navy mt-1">{value}</p>
      <p className="text-xs text-slate-500 mt-2">{note}</p>
    </div>
  );
}
