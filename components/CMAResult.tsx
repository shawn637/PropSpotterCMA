'use client';

import { useMemo, useState } from 'react';

import { computeCMA } from '@/lib/cma/compute';
import { computeMaxPrice } from '@/lib/cma/maxprice';
import type { Comparable, FullValuationResult } from '@/lib/types';

interface CMAResultProps {
  data: FullValuationResult;
  onDownloadPdf: (current: FullValuationResult) => void;
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

/**
 * Strip the ComparableWithDerived fields back to a plain Comparable so
 * computeCMA can re-derive them on the current subset. The server's
 * initial result hands us `cma.comparables` with all the indexed /
 * adjustment / implied-value fields already baked in; we don't want to
 * feed those back in on a recompute.
 */
function toPlainComparable(c: Comparable): Comparable {
  return {
    addressKey: c.addressKey,
    fullAddress: c.fullAddress,
    salePrice: c.salePrice,
    saleDateIso: c.saleDateIso,
    landAreaSqm: c.landAreaSqm,
    floorAreaSqm: c.floorAreaSqm,
    bedrooms: c.bedrooms,
    bathrooms: c.bathrooms,
    carSpaces: c.carSpaces,
    yearBuilt: c.yearBuilt,
    distanceKm: c.distanceKm,
    htagAdjustmentFactor: c.htagAdjustmentFactor,
    propertyType: c.propertyType,
  };
}

export function CMAResult({
  data,
  onDownloadPdf,
  onReset,
  pdfBusy,
}: CMAResultProps) {
  const { subject, market, vendorAssessment, narrative } = data;
  const originalComps = data.cma.comparables;

  // Client-side toggle state. Keys in this set are comps the user has
  // manually excluded from the running CMA.
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  // Recompute CMA + three-numbers on the fly whenever the excluded set
  // changes. No server round-trip needed — both modules are pure and
  // run fine in the browser.
  const { current, enoughComps } = useMemo(() => {
    const keptRaw = originalComps
      .filter((c) => !excluded.has(c.addressKey))
      .map(toPlainComparable);
    const recomputedCma = computeCMA(subject, keptRaw, market);
    const enough = recomputedCma.comparables.length >= 3;
    const recomputedMax = enough
      ? computeMaxPrice({
          fairValue: recomputedCma.fairValue,
          cycleStage: market.cycleStage,
          vendorMotivation: vendorAssessment.motivation,
          actualDaysOnMarket: data.actualDaysOnMarket,
          typicalDaysOnMarket: market.typicalDaysOnMarket,
        })
      : data.maxPrice;

    const currentResult: FullValuationResult = {
      ...data,
      cma: recomputedCma,
      maxPrice: recomputedMax,
    };
    return { current: currentResult, enoughComps: enough };
  }, [
    originalComps,
    excluded,
    subject,
    market,
    vendorAssessment.motivation,
    data,
  ]);

  const cma = current.cma;
  const maxPrice = current.maxPrice;
  // Render ALL comps (not a slice of 8) so the review UI shows every
  // option. Excluded ones are still displayed, just dimmed with the
  // checkbox unchecked.
  const activeKeys = new Set(cma.comparables.map((c) => c.addressKey));
  const displayRows = originalComps.map((c) => ({
    comp: c,
    active: activeKeys.has(c.addressKey),
  }));

  function toggle(addressKey: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(addressKey)) next.delete(addressKey);
      else next.add(addressKey);
      return next;
    });
  }

  function resetExclusions() {
    setExcluded(new Set());
  }

  const hasUserExclusions = excluded.size > 0;

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
          {subject.landAreaSqm ? `${subject.landAreaSqm} sqm land` : '— land'} ·{' '}
          {subject.floorAreaSqm ? `${subject.floorAreaSqm} sqm floor` : '— floor'}
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
          {cma.notes.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-slate-600 list-disc list-inside">
              {cma.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
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
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-navy">Comparable sales</h3>
          {hasUserExclusions && (
            <button
              onClick={resetExclusions}
              className="text-xs rounded-md border border-slate-300 px-2 py-1 hover:bg-slate-50"
            >
              Reset exclusions ({excluded.size})
            </button>
          )}
        </div>
        <p className="text-xs text-slate-500 mb-2">
          Untick any comparable that doesn&rsquo;t belong (different storeys,
          materially different condition, wrong street profile). The three
          numbers and CMA summary above recompute live. The narrative below
          is still based on the original set.
        </p>
        {!enoughComps && (
          <div className="rounded-md bg-amber-50 border border-amber-200 text-amber-900 px-3 py-2 text-xs mb-2">
            Fewer than 3 comparables active — numbers are held at the previous
            computation until you re-include more.
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500">
                <th className="py-1 pr-2 w-8"></th>
                <th className="py-1 pr-2">Address</th>
                <th className="py-1 pr-2 text-right">BR/BA</th>
                <th className="py-1 pr-2 text-right">Land</th>
                <th className="py-1 pr-2 text-right">Floor</th>
                <th className="py-1 pr-2 text-right">Sale price</th>
                <th className="py-1 pr-2 text-right">Date</th>
                <th className="py-1 pr-2 text-right">Adj.</th>
                <th className="py-1 pr-2 text-right">Implied value</th>
                <th className="py-1">Flags</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map(({ comp: c, active }) => (
                <tr
                  key={c.addressKey}
                  className={`border-t border-slate-100 align-top ${
                    active ? '' : 'opacity-40 line-through'
                  }`}
                >
                  <td className="py-1 pr-2">
                    <input
                      type="checkbox"
                      checked={active}
                      onChange={() => toggle(c.addressKey)}
                      aria-label={`Include ${c.fullAddress}`}
                    />
                  </td>
                  <td className="py-1 pr-2">{c.fullAddress}</td>
                  <td className="py-1 pr-2 text-right">
                    {c.bedrooms ?? '—'}/{c.bathrooms ?? '—'}
                  </td>
                  <td className="py-1 pr-2 text-right">
                    {c.landAreaSqm ? `${c.landAreaSqm}` : '—'}
                  </td>
                  <td className="py-1 pr-2 text-right">
                    {c.floorAreaSqm ? `${c.floorAreaSqm}` : '—'}
                  </td>
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
          onClick={() => onDownloadPdf(current)}
          disabled={pdfBusy || !enoughComps}
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
