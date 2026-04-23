'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { computeCMA } from '@/lib/cma/compute';
import { computeMaxPrice } from '@/lib/cma/maxprice';
import type {
  Comparable,
  FullValuationResult,
  VisionAttributes,
} from '@/lib/types';

const SUBJECT_KEY = '__SUBJECT__';

export interface PdfPhotoUrls {
  subject?: string;
  comparables?: Record<string, string>;
}

interface CMAResultProps {
  data: FullValuationResult;
  onDownloadPdf: (
    current: FullValuationResult,
    photoUrls: PdfPhotoUrls,
  ) => void;
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
/**
 * Build the photo payload the PDF route expects: subject (if available)
 * plus per-comp entries for whichever comps survived the user's
 * exclusion filter. Comps no longer in the CMA are dropped — no sense
 * paying the server-side fetch cost for photos that won't render.
 */
function collectPdfPhotoUrls(
  imageUrls: Record<string, string>,
  cma: FullValuationResult['cma'],
): PdfPhotoUrls {
  const out: PdfPhotoUrls = { comparables: {} };
  const subjectUrl = imageUrls[SUBJECT_KEY]?.trim();
  if (subjectUrl) out.subject = subjectUrl;
  for (const c of cma.comparables) {
    const u = imageUrls[c.addressKey]?.trim();
    if (u) out.comparables![c.addressKey] = u;
  }
  return out;
}

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
  const { subject, market, vendorAssessment } = data;
  const originalComps = data.cma.comparables;

  // Narrative is kept in client state so we can regenerate it after
  // Vision lands (or the user edits exclusions). Seeded from the
  // server's initial /api/cma response.
  const [narrative, setNarrative] = useState<string>(data.narrative);
  const [narrativeBusy, setNarrativeBusy] = useState(false);
  const [narrativeError, setNarrativeError] = useState<string | null>(null);
  // True once the post-Vision regeneration has fired, so we don't
  // re-fire it on every re-render.
  // Two independent guards so the mount regeneration and the post-
  // Vision regeneration can each fire exactly once without blocking
  // each other. The mount one swaps the server-shipped fallback
  // prose for an LLM-backed version; the post-Vision one upgrades it
  // again once Claude Vision has classified the photos.
  const narrativeFiredOnMountRef = useRef(false);
  const narrativeRegeneratedRef = useRef(false);

  // Client-side toggle state. Keys in this set are comps the user has
  // manually excluded from the running CMA.
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  // Per-comp (+ subject) HERO image URL — used for PDF thumbnails and
  // the UI URL field. Either auto-populated by the Apify matcher or
  // pasted by the user.
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  // Per-comp (+ subject) FULL image gallery from the Apify scrape.
  // Keyed the same way; values are string[] (hero first). Vision calls
  // pass the whole array so the model sees kitchen + bathroom +
  // backyard, not just the façade. Falls back to [imageUrls[key]] when
  // the user only pasted one URL manually.
  const [listingImageUrls, setListingImageUrls] = useState<
    Record<string, string[]>
  >({});
  // Vision results keyed by addressKey (SUBJECT_KEY for the subject).
  const [visionMap, setVisionMap] = useState<Record<string, VisionAttributes>>(
    {},
  );
  const [analyzing, setAnalyzing] = useState(false);
  const [visionError, setVisionError] = useState<string | null>(null);

  // Auto-fetch (Apify scraper) state.
  const [autoFetching, setAutoFetching] = useState<
    null | 'starting' | 'polling' | 'done'
  >(null);
  const [autoFetchError, setAutoFetchError] = useState<string | null>(null);
  const [autoFetchUnmatched, setAutoFetchUnmatched] = useState<string[]>([]);
  // Which tier sourced the subject photos. null = nothing fetched yet
  // (or fetch failed entirely). 'rea-property-detail' means the
  // Tier-2 raw HTML fallback fired, which we should call out so the
  // user knows visual comparison is on slightly thinner ice than a
  // current REA listing would give.
  const [subjectPhotoSource, setSubjectPhotoSource] = useState<
    'rea-buy' | 'rea-sold' | 'rea-property-detail' | null
  >(null);

  // Recompute CMA + three-numbers on the fly whenever the excluded set,
  // the vision attributes, or the source data change. No server
  // round-trip needed — both modules are pure and run fine in the
  // browser.
  const { current, enoughComps } = useMemo(() => {
    const subjectWithVision = {
      ...subject,
      visionAttrs: visionMap[SUBJECT_KEY] ?? subject.visionAttrs,
    };
    const keptRaw = originalComps
      .filter((c) => !excluded.has(c.addressKey))
      .map((c) => ({
        ...toPlainComparable(c),
        visionAttrs: visionMap[c.addressKey] ?? c.visionAttrs,
      }));
    const recomputedCma = computeCMA(subjectWithVision, keptRaw, market);
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
      subject: subjectWithVision,
      cma: recomputedCma,
      maxPrice: recomputedMax,
      // Use the client-side narrative state so PDF downloads + the
      // /api/narrative POST (which echoes `current`) carry the most
      // recent regenerated prose, not the stale server seed.
      narrative,
    };
    return { current: currentResult, enoughComps: enough };
  }, [
    originalComps,
    excluded,
    visionMap,
    subject,
    market,
    vendorAssessment.motivation,
    data,
    narrative,
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

  function setImageUrl(key: string, url: string) {
    setImageUrls((prev) => ({ ...prev, [key]: url }));
  }

  async function runVisionAnalysis() {
    setAnalyzing(true);
    setVisionError(null);
    try {
      // Prefer the full gallery from the Apify matcher; fall back to
      // the single manually-pasted URL when only that is available.
      const urlsFor = (key: string): string[] => {
        const gallery = listingImageUrls[key];
        if (gallery && gallery.length > 0) return gallery;
        const single = (imageUrls[key] ?? '').trim();
        return single ? [single] : [];
      };

      const subjectUrls = urlsFor(SUBJECT_KEY);
      const compEntries = originalComps
        .filter((c) => !excluded.has(c.addressKey))
        .map((c) => ({ addressKey: c.addressKey, imageUrls: urlsFor(c.addressKey) }))
        .filter((e) => e.imageUrls.length > 0);

      if (subjectUrls.length === 0 && compEntries.length === 0) {
        setVisionError('Paste at least one image URL first.');
        setAnalyzing(false);
        return;
      }

      const body: Record<string, unknown> = { comps: compEntries };
      if (subjectUrls.length > 0) {
        body.subject = {
          addressKey: subject.addressKey,
          imageUrls: subjectUrls,
        };
      }

      const res = await fetch('/api/vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(
          errBody?.error ?? `Vision request failed (${res.status})`,
        );
      }
      const result = (await res.json()) as {
        subject?: { attrs: VisionAttributes | null; error?: string };
        comps: Array<{
          addressKey: string;
          attrs: VisionAttributes | null;
          error?: string;
        }>;
      };

      setVisionMap((prev) => {
        const next = { ...prev };
        if (result.subject?.attrs) next[SUBJECT_KEY] = result.subject.attrs;
        for (const r of result.comps) {
          if (r.attrs) next[r.addressKey] = r.attrs;
        }
        return next;
      });

      // Collect per-image failures into a single banner so the user
      // can see which URLs couldn't be classified (bad URL, auth
      // wall, private CDN etc).
      const failed: string[] = [];
      if (result.subject?.error) failed.push(`subject: ${result.subject.error}`);
      for (const r of result.comps) {
        if (r.error) failed.push(`${r.addressKey.slice(0, 18)}…: ${r.error}`);
      }
      if (failed.length > 0) {
        setVisionError(
          `${failed.length} image(s) couldn't be classified:\n${failed.join('\n')}`,
        );
      }
    } catch (err) {
      setVisionError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalyzing(false);
    }
  }

  function clearVision() {
    setVisionMap({});
    setVisionError(null);
  }

  /**
   * One-click "Auto-fetch photos": kicks off an Apify scrape of
   * realestate.com.au sold listings for the subject's suburb, polls
   * until complete, merges the matched image URLs into `imageUrls`
   * state, then auto-triggers the Claude Vision pass so the facade
   * attributes flow straight into the similarity adjustment without
   * an extra click.
   */
  async function runAutoFetch() {
    setAutoFetching('starting');
    setAutoFetchError(null);
    setAutoFetchUnmatched([]);

    try {
      const activeComps = originalComps
        .filter((c) => !excluded.has(c.addressKey))
        .map((c) => ({
          addressKey: c.addressKey,
          fullAddress: c.fullAddress,
          salePrice: c.salePrice,
          saleDateIso: c.saleDateIso,
        }));

      if (activeComps.length === 0) {
        throw new Error('No active comparables to fetch photos for.');
      }

      // 1. Start both runs (sold channel for comps + buy channel for
      //    the subject) in parallel. Server responds as soon as both
      //    runs are queued on Apify.
      const startRes = await fetch('/api/photos/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          suburb: subject.suburb,
          state: subject.state,
          postcode: subject.postcode,
          propertyType: (subject.propertyType ?? 'house').toLowerCase(),
          // 10 pages = ~500 listings per channel, the deepest sweep
          // we offer. Catches subjects on page 7+ of busy suburbs.
          // Tier-2 REA property-detail fallback in /api/photos/poll
          // picks up anything still missed.
          maxPagesToScrape: 10,
        }),
      });
      if (!startRes.ok) {
        const err = await startRes.json().catch(() => ({}));
        throw new Error(err?.error ?? `Start failed (${startRes.status})`);
      }
      const startBody = (await startRes.json()) as {
        sold: { runId: string; datasetId: string } | null;
        buy: { runId: string; datasetId: string } | null;
      };
      if (!startBody.sold && !startBody.buy) {
        throw new Error('Both Apify runs failed to start.');
      }

      // 2. Poll until BOTH finished (or either one finishes and the
      //    other was unavailable). Apify cold start is ~20-30 s, full
      //    scrape typically 30-60 s. Cap at 3 min wall clock, ~60
      //    polls at 3 s.
      setAutoFetching('polling');
      const maxAttempts = 60;
      const pollIntervalMs = 3000;
      type Match = {
        addressKey: string;
        imageUrl: string;
        imageUrls: string[];
        matchReason: 'address' | 'price+date';
      };
      type SubjectMatch = Match & {
        source?: 'rea-buy' | 'rea-sold' | 'rea-property-detail';
        fallbackUsed?: boolean;
      };
      let matched: Match[] = [];
      let subjectMatch: SubjectMatch | null = null;
      let unmatched: string[] = [];
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        const pollRes = await fetch('/api/photos/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sold: startBody.sold,
            buy: startBody.buy,
            comps: activeComps,
            subject: {
              addressKey: subject.addressKey,
              fullAddress: subject.fullAddress,
              suburb: subject.suburb,
              state: subject.state,
              postcode: subject.postcode,
            },
          }),
        });
        if (!pollRes.ok) {
          const err = await pollRes.json().catch(() => ({}));
          throw new Error(err?.error ?? `Poll failed (${pollRes.status})`);
        }
        const body = (await pollRes.json()) as {
          status: string;
          finished: boolean;
          matched?: Match[];
          subjectMatch?: SubjectMatch | null;
          unmatchedAddressKeys?: string[];
        };
        if (body.finished) {
          matched = body.matched ?? [];
          subjectMatch = body.subjectMatch ?? null;
          unmatched = body.unmatchedAddressKeys ?? [];
          break;
        }
      }

      if (matched.length === 0 && !subjectMatch && unmatched.length === 0) {
        throw new Error(
          'Scrape timed out after 3 minutes without finishing. Try again or paste URLs manually.',
        );
      }

      // 3. Merge matched image URLs into state. imageUrls holds the
      //    HERO for PDF/UI; listingImageUrls holds the full gallery
      //    that feeds the Vision call.
      setImageUrls((prev) => {
        const next = { ...prev };
        for (const m of matched) next[m.addressKey] = m.imageUrl;
        if (subjectMatch) next[SUBJECT_KEY] = subjectMatch.imageUrl;
        return next;
      });
      setListingImageUrls((prev) => {
        const next = { ...prev };
        for (const m of matched) next[m.addressKey] = m.imageUrls;
        if (subjectMatch) next[SUBJECT_KEY] = subjectMatch.imageUrls;
        return next;
      });
      setAutoFetchUnmatched(unmatched);
      setSubjectPhotoSource(subjectMatch?.source ?? null);
      setAutoFetching('done');

      // 4. Chain straight into Claude Vision. Include subject match if
      //    we found one — the subject's visual attrs are half the
      //    similarity comparison. Feed the FULL gallery per listing
      //    (not just the hero) so the model sees kitchen + bathroom +
      //    backyard together.
      const visionTargets: Array<{ addressKey: string; imageUrls: string[] }> =
        matched.map((m) => ({
          addressKey: m.addressKey,
          imageUrls: m.imageUrls,
        }));
      if (subjectMatch) {
        visionTargets.push({
          addressKey: SUBJECT_KEY,
          imageUrls: subjectMatch.imageUrls,
        });
      }
      if (visionTargets.length > 0) {
        await analyzeImagesDirect(visionTargets);
      }
    } catch (err) {
      setAutoFetchError(err instanceof Error ? err.message : String(err));
      setAutoFetching(null);
    }
  }

  /**
   * Chain: after auto-fetch succeeds, run the vision analysis on the
   * fresh URL gallery per listing without waiting for a state-update
   * round trip. Each target carries ALL photos for that listing so
   * Claude can synthesise across kitchen, bathroom, backyard, façade.
   * Subject entries (addressKey === SUBJECT_KEY) are split out into
   * the /api/vision body's `subject` field.
   */
  async function analyzeImagesDirect(
    targets: Array<{ addressKey: string; imageUrls: string[] }>,
  ) {
    if (targets.length === 0) return;
    setAnalyzing(true);
    setVisionError(null);
    try {
      const subjectTarget = targets.find((t) => t.addressKey === SUBJECT_KEY);
      const compTargets = targets.filter((t) => t.addressKey !== SUBJECT_KEY);

      const body: Record<string, unknown> = {
        comps: compTargets.map((c) => ({
          addressKey: c.addressKey,
          imageUrls: c.imageUrls,
        })),
      };
      if (subjectTarget) {
        body.subject = {
          addressKey: subject.addressKey,
          imageUrls: subjectTarget.imageUrls,
        };
      }

      const res = await fetch('/api/vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? `Vision failed (${res.status})`);
      }
      const result = (await res.json()) as {
        subject?: { attrs: VisionAttributes | null; error?: string };
        comps: Array<{
          addressKey: string;
          attrs: VisionAttributes | null;
          error?: string;
        }>;
      };
      setVisionMap((prev) => {
        const next = { ...prev };
        if (result.subject?.attrs) next[SUBJECT_KEY] = result.subject.attrs;
        for (const r of result.comps) {
          if (r.attrs) next[r.addressKey] = r.attrs;
        }
        return next;
      });
      const compFails = result.comps.filter((c) => c.attrs == null).length;
      const subjFail = result.subject && !result.subject.attrs ? 1 : 0;
      const total = compFails + subjFail;
      if (total > 0) {
        setVisionError(
          `${total} image(s) couldn't be classified by Claude Vision.`,
        );
      }

      // Narrative regeneration is triggered by a useEffect watching
      // `visionMap` (see below). That path waits for React to flush
      // the setVisionMap call and for useMemo to rebuild `current`
      // with the fresh visual attrs; doing it here would fire against
      // the stale pre-Vision `current` closure.
    } catch (err) {
      setVisionError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalyzing(false);
    }
  }

  /**
   * Regenerate the narrative paragraph against the client's CURRENT
   * result (post-exclusion + post-Vision). Uses a functional state
   * update style via the `current` closure so it's always reading the
   * latest `current` when the button is clicked — critical for the
   * manual-regenerate case after the user toggles a comp.
   */
  async function regenerateNarrative() {
    setNarrativeBusy(true);
    setNarrativeError(null);
    try {
      const res = await fetch('/api/narrative', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // current is always the live snapshot from useMemo.
        body: JSON.stringify(current),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? `Narrative failed (${res.status})`);
      }
      const body = (await res.json()) as { narrative?: string };
      if (typeof body.narrative === 'string' && body.narrative.length > 0) {
        setNarrative(body.narrative);
      }
    } catch (err) {
      setNarrativeError(err instanceof Error ? err.message : String(err));
    } finally {
      setNarrativeBusy(false);
    }
  }

  /**
   * Auto-fire the photo fetch once, right after the CMA first loads.
   * Uses a ref rather than a state flag so React 18's dev-mode double
   * effect invocation doesn't kick off two Apify runs. Gracefully
   * no-ops if the /api/photos/start route returns an error (e.g. when
   * APIFY_API_TOKEN is unset) — user can still fall back to manual URL
   * paste.
   */
  const autoFiredRef = useRef(false);
  useEffect(() => {
    if (autoFiredRef.current) return;
    if (!subject.postcode || !subject.suburb || !subject.state) return;
    autoFiredRef.current = true;
    runAutoFetch().catch(() => {
      // runAutoFetch already surfaces errors via state; swallow the
      // rejection so it doesn't become an unhandled promise.
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * On-mount narrative regeneration. /api/cma ships a fast
   * synchronous fallback so the route stays inside Vercel's function
   * budget; the moment the result is on screen we upgrade the prose
   * with an LLM-backed version that cites specific comps and the ABS
   * tenure numbers.
   */
  useEffect(() => {
    if (narrativeFiredOnMountRef.current) return;
    narrativeFiredOnMountRef.current = true;
    void regenerateNarrative();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Post-Vision narrative regeneration. Watches visionMap rather than
   * running inline in analyzeImagesDirect so that by the time the
   * POST fires, React has committed the setVisionMap update and
   * useMemo has rebuilt `current` with the fresh visual attrs.
   * Otherwise the auto-regen would close over pre-Vision `current`
   * and the prose wouldn't cite any visual findings.
   */
  useEffect(() => {
    if (narrativeRegeneratedRef.current) return;
    if (Object.keys(visionMap).length === 0) return;
    narrativeRegeneratedRef.current = true;
    void regenerateNarrative();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visionMap]);

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
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-navy">
            Neighbourhood tenure (subject)
          </h3>
          {data.tenureProfile ? (
            <span className="text-xs text-slate-400">
              ABS 2021 Census · SA1 {data.tenureProfile.sa1Code} ·{' '}
              {data.tenureProfile.totalDwellings} dwellings
            </span>
          ) : (
            <span className="text-xs text-amber-700">
              Not resolved — no SA1 match for the subject&rsquo;s coordinates.
            </span>
          )}
        </div>
        {data.tenureProfile ? (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <TenureCell
                label="Owner-occupied"
                value={data.tenureProfile.ownerOccupierPct}
                accent="text-teal"
              />
              <TenureCell
                label="Private rental"
                value={data.tenureProfile.privateRentalPct}
                accent="text-navy"
              />
              <TenureCell
                label="Public housing"
                value={data.tenureProfile.publicHousingPct}
                accent={
                  data.tenureProfile.publicHousingPct >= 15
                    ? 'text-red-600'
                    : data.tenureProfile.publicHousingPct >= 10
                      ? 'text-amber-600'
                      : 'text-gold'
                }
              />
              <TenureCell
                label="Other / not stated"
                value={data.tenureProfile.otherPct}
                accent="text-slate-500"
              />
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Shares are from the Australian Bureau of Statistics 2021 Census
              G37 table at the subject&rsquo;s SA1 (Statistical Area Level
              1 — the finest ABS unit, typically 200&ndash;800 people).
              Private rental covers real-estate-agent and other private
              landlords; public housing covers state/territory and
              community housing. The <strong>OO/PR/PH</strong> column in
              the comparables table below shows the same breakdown for each
              comp&rsquo;s SA1, coloured amber at ≥10% and red at ≥15%
              public housing. Shares may not sum to 100% because some
              dwellings fall in minor categories (rent-free, tenure not
              stated).
            </p>
          </>
        ) : (
          <p className="text-xs text-slate-600">
            The subject&rsquo;s SA1 couldn&rsquo;t be resolved from the
            available coordinates, so the tenure card and the per-comp
            tenure adjustment are skipped for this run. Check the Vercel
            logs for <code>&quot;tag&quot;:&quot;abs-skip&quot;</code> or{' '}
            <code>&quot;tag&quot;:&quot;geocode-fallback&quot;</code> to
            see why, or hit <code>/api/abs-debug?address=...</code>{' '}
            directly to probe the ABS endpoint.
          </p>
        )}
      </section>

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
                <th className="py-1 pr-2">Vision</th>
                <th
                  className="py-1 pr-2 text-right"
                  title="SA1 tenure mix: Owner-occupier / Private rental / Public housing (%)"
                >
                  OO/PR/PH
                </th>
                <th className="py-1 pr-2 text-right">Sale price</th>
                <th className="py-1 pr-2 text-right">Date</th>
                <th className="py-1 pr-2 text-right">Adj.</th>
                <th className="py-1 pr-2 text-right">Implied value</th>
                <th className="py-1">Flags</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map(({ comp: c, active }) => {
                const derivedComp = cma.comparables.find(
                  (dc) => dc.addressKey === c.addressKey,
                );
                const attrs = visionMap[c.addressKey];
                return (
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
                    <td className="py-1 pr-2 text-xs text-slate-600">
                      <VisionBadges attrs={attrs} />
                    </td>
                    <td
                      className="py-1 pr-2 text-right text-xs"
                      title={
                        c.tenureProfile
                          ? `SA1 ${c.tenureProfile.sa1Code} (${c.tenureProfile.totalDwellings} dwellings)`
                          : 'SA1 tenure not resolved for this comp'
                      }
                    >
                      <TenureInline profile={c.tenureProfile} />
                    </td>
                    <td className="py-1 pr-2 text-right">
                      {currency(c.salePrice)}
                    </td>
                    <td className="py-1 pr-2 text-right">
                      {shortDate(c.saleDateIso)}
                    </td>
                    <td className="py-1 pr-2 text-right">
                      {(derivedComp ?? c).adjustmentFactor.toFixed(3)}
                    </td>
                    <td className="py-1 pr-2 text-right">
                      {currency((derivedComp ?? c).impliedSubjectValue)}
                    </td>
                    <td className="py-1 text-slate-500">
                      {(derivedComp ?? c).flags.join(', ') || '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg bg-white border border-slate-200 p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-navy">
            Refine with façade photos (Claude Vision)
          </h3>
          {Object.keys(visionMap).length > 0 && (
            <button
              onClick={clearVision}
              className="text-xs rounded-md border border-slate-300 px-2 py-1 hover:bg-slate-50"
            >
              Clear vision data
            </button>
          )}
        </div>
        <p className="text-xs text-slate-500 mb-3">
          Click <strong>Auto-fetch photos</strong> to scrape realestate.com.au
          sold listings for this suburb and auto-populate the URL fields
          below — typically 30–60 seconds end-to-end. Or paste URLs
          manually. Either way, &ldquo;Analyze visuals&rdquo; runs Claude
          Sonnet 4.6 on each image to classify storeys, construction
          material, and condition, which then feeds the similarity
          adjustment.
        </p>

        <div className="mb-3 flex items-center gap-3">
          <button
            onClick={runAutoFetch}
            disabled={!!autoFetching || analyzing}
            className="rounded-md bg-navy px-4 py-2 text-white text-sm font-medium hover:bg-navy/90 disabled:bg-slate-300"
          >
            {autoFetching === 'starting' && 'Starting scrape…'}
            {autoFetching === 'polling' && 'Waiting for scrape…'}
            {autoFetching === 'done' && !analyzing && 'Photos fetched ✓'}
            {autoFetching === null && 'Auto-fetch photos'}
          </button>
          {autoFetchUnmatched.length > 0 && (
            <span className="text-xs text-amber-700">
              {autoFetchUnmatched.length} comp(s) had no match — paste
              URLs manually below.
            </span>
          )}
        </div>

        {autoFetchError && (
          <div className="mb-3 rounded-md bg-red-50 border border-red-200 text-red-800 px-3 py-2 text-xs">
            {autoFetchError}
          </div>
        )}

        {autoFetching === 'done' && subjectPhotoSource === 'rea-property-detail' && (
          <div className="mb-3 rounded-md bg-amber-50 border border-amber-200 text-amber-900 px-3 py-2 text-xs">
            <strong>Subject photos via fallback.</strong> The subject
            wasn&rsquo;t in the suburb-wide REA scrape (off-market, sold
            years ago, or beyond the 10-page sweep), so we pulled images
            directly from REA&rsquo;s permanent property-detail page.
            That fallback is flakier than a current listing — the gallery
            may be stale or partial. Visual comparison still runs as
            normal.
          </div>
        )}

        {autoFetching === 'done' && subjectPhotoSource === null && (
          <div className="mb-3 rounded-md bg-red-50 border border-red-300 text-red-900 px-3 py-2 text-xs">
            <strong>Subject photos unavailable.</strong> Neither the
            suburb-wide REA scrape nor the property-detail fallback
            returned a usable gallery for the subject. Visual
            comparison is <strong>disabled</strong> for this run —
            adjustment factors fall back to structural data (land,
            floor, beds, baths, year built) only, and the kitchen /
            bathroom / land-quality / feature legs of the similarity
            adjustment will read as neutral. Paste any subject image
            URL below to re-enable the visual comparison.
          </div>
        )}

        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <span className="w-40 text-xs text-slate-500 truncate">
              Subject
            </span>
            <input
              type="url"
              value={imageUrls[SUBJECT_KEY] ?? ''}
              onChange={(e) => setImageUrl(SUBJECT_KEY, e.target.value)}
              placeholder="https://… photo URL"
              className="flex-1 rounded-md border border-slate-300 px-2 py-1 text-xs focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy"
            />
            <VisionBadges attrs={visionMap[SUBJECT_KEY]} />
          </div>
          {originalComps
            .filter((c) => !excluded.has(c.addressKey))
            .map((c) => (
              <div key={c.addressKey} className="flex items-center gap-2 text-sm">
                <span
                  className="w-40 text-xs text-slate-500 truncate"
                  title={c.fullAddress}
                >
                  {c.fullAddress}
                </span>
                <input
                  type="url"
                  value={imageUrls[c.addressKey] ?? ''}
                  onChange={(e) => setImageUrl(c.addressKey, e.target.value)}
                  placeholder="https://… photo URL"
                  className="flex-1 rounded-md border border-slate-300 px-2 py-1 text-xs focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy"
                />
                <VisionBadges attrs={visionMap[c.addressKey]} />
              </div>
            ))}
        </div>

        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={runVisionAnalysis}
            disabled={analyzing}
            className="rounded-md bg-teal px-4 py-2 text-white text-sm font-medium hover:bg-teal/90 disabled:bg-slate-300"
          >
            {analyzing ? 'Analyzing…' : 'Analyze visuals'}
          </button>
          {Object.keys(visionMap).length > 0 && (
            <span className="text-xs text-slate-500">
              {Object.keys(visionMap).length} image(s) classified; numbers
              above updated.
            </span>
          )}
        </div>

        {visionError && (
          <div className="mt-3 rounded-md bg-amber-50 border border-amber-200 text-amber-900 px-3 py-2 text-xs whitespace-pre-line">
            {visionError}
          </div>
        )}
      </section>

      <section className="rounded-lg bg-white border border-slate-200 p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-navy">Narrative</h3>
          <button
            onClick={regenerateNarrative}
            disabled={narrativeBusy || analyzing || !enoughComps}
            className="text-xs rounded-md border border-slate-300 px-2 py-1 hover:bg-slate-50 disabled:opacity-50"
            title="Rewrite the narrative using the current comparables, numbers, and Vision findings."
          >
            {narrativeBusy ? 'Regenerating…' : 'Regenerate'}
          </button>
        </div>
        <p className="text-sm text-slate-700 whitespace-pre-line leading-relaxed">
          {narrative}
        </p>
        {narrativeError && (
          <p className="mt-2 text-xs text-amber-700">
            Couldn&rsquo;t regenerate: {narrativeError}
          </p>
        )}
      </section>

      <div className="flex flex-wrap gap-3">
        <button
          onClick={() =>
            onDownloadPdf(current, collectPdfPhotoUrls(imageUrls, cma))
          }
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

function TenureCell({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: string;
}) {
  return (
    <div className="rounded-md border border-slate-200 px-3 py-2">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`text-xl font-semibold ${accent}`}>{value.toFixed(1)}%</p>
    </div>
  );
}

function TenureInline({
  profile,
}: {
  profile?: FullValuationResult['subject']['tenureProfile'];
}) {
  if (!profile) return <span className="text-slate-300">—</span>;
  // Colour the PH share when it crosses the 10% / 15% thresholds Shawn
  // called out so reviewers can eyeball discounts at a glance.
  const phClass =
    profile.publicHousingPct >= 15
      ? 'text-red-600 font-semibold'
      : profile.publicHousingPct >= 10
        ? 'text-amber-600'
        : 'text-slate-600';
  return (
    <span className="tabular-nums">
      <span className="text-teal">{profile.ownerOccupierPct.toFixed(0)}</span>
      <span className="text-slate-400">/</span>
      <span className="text-navy">{profile.privateRentalPct.toFixed(0)}</span>
      <span className="text-slate-400">/</span>
      <span className={phClass}>{profile.publicHousingPct.toFixed(0)}</span>
    </span>
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

function VisionBadges({ attrs }: { attrs?: VisionAttributes }) {
  if (!attrs) return <span className="text-slate-400">—</span>;
  const parts: string[] = [];
  if (attrs.storeys !== 'unknown') parts.push(attrs.storeys);
  if (attrs.constructionMaterial !== 'unknown')
    parts.push(attrs.constructionMaterial);
  if (attrs.conditionGrade !== 'unknown')
    parts.push(`overall ${attrs.conditionGrade}`);
  if (
    attrs.kitchenCondition !== 'unknown' &&
    attrs.kitchenCondition !== 'not_visible'
  )
    parts.push(`kitchen ${attrs.kitchenCondition}`);
  if (
    attrs.bathroomCondition !== 'unknown' &&
    attrs.bathroomCondition !== 'not_visible'
  )
    parts.push(`bath ${attrs.bathroomCondition}`);
  if (attrs.landQuality !== 'unknown') parts.push(`land ${attrs.landQuality}`);
  if (attrs.backyardSize !== 'unknown')
    parts.push(`yard ${attrs.backyardSize}`);
  for (const f of attrs.features) parts.push(f.replace(/_/g, ' '));
  if (parts.length === 0) return <span className="text-slate-400">unknown</span>;
  return (
    <span className="text-teal">
      {parts.join(' · ')}
      {attrs.notes ? (
        <span className="ml-1 text-slate-400" title={attrs.notes}>
          ⓘ
        </span>
      ) : null}
    </span>
  );
}
