import React from 'react';
import {
  Document,
  Image,
  Page,
  StyleSheet,
  Text,
  View,
} from '@react-pdf/renderer';

import type { FullValuationResult } from '@/lib/types';

/**
 * Photo data URIs keyed for the report. Subject slot mirrors the
 * SUBJECT_KEY convention on the client; per-comp slot is keyed by
 * comparable.addressKey. Values are already base64-encoded data URIs —
 * the PDF route is responsible for fetching URLs and encoding them
 * before calling through, so this module stays pure-render and doesn't
 * reach out to the network.
 */
export interface ReportPhotos {
  subject?: string;
  comparables?: Record<string, string>;
}

const COLORS = {
  navy: '#1F3A5F',
  gold: '#C9A74D',
  teal: '#2B8A8E',
  cream: '#FBF7EE',
  lightBlue: '#E8EEF5',
  text: '#111827',
  muted: '#4B5563',
  border: '#D1D5DB',
  warn: '#B45309',
  warnBg: '#FEF3C7',
};

const styles = StyleSheet.create({
  page: {
    paddingTop: 32,
    paddingBottom: 40,
    paddingHorizontal: 32,
    fontSize: 9,
    color: COLORS.text,
    fontFamily: 'Helvetica',
    backgroundColor: '#FFFFFF',
  },
  brandRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    borderBottomWidth: 2,
    borderBottomColor: COLORS.navy,
    paddingBottom: 6,
    marginBottom: 12,
  },
  brandName: { fontSize: 16, color: COLORS.navy, fontWeight: 700 },
  brandTag: { fontSize: 8, color: COLORS.muted },
  demoBanner: {
    backgroundColor: COLORS.warnBg,
    color: COLORS.warn,
    padding: 4,
    marginBottom: 8,
    fontSize: 8,
    textAlign: 'center',
    borderRadius: 2,
  },
  title: { fontSize: 14, color: COLORS.navy, marginBottom: 2 },
  subtitle: { fontSize: 9, color: COLORS.muted, marginBottom: 10 },
  numbersRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  numberCard: {
    flex: 1,
    borderLeftWidth: 3,
    backgroundColor: COLORS.cream,
    padding: 8,
  },
  numberLabel: { fontSize: 7, color: COLORS.muted, marginBottom: 2 },
  numberValue: { fontSize: 14, color: COLORS.navy, fontWeight: 700 },
  numberNote: { fontSize: 7, color: COLORS.muted, marginTop: 2 },
  sectionHeader: {
    fontSize: 10,
    color: COLORS.navy,
    fontWeight: 700,
    marginTop: 8,
    marginBottom: 4,
    borderBottomWidth: 0.5,
    borderBottomColor: COLORS.border,
    paddingBottom: 2,
  },
  twoCol: { flexDirection: 'row', gap: 12 },
  col: { flex: 1 },
  kvRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  k: { color: COLORS.muted },
  v: { color: COLORS.text },
  table: { marginTop: 4 },
  tableHead: {
    flexDirection: 'row',
    backgroundColor: COLORS.lightBlue,
    paddingVertical: 3,
    paddingHorizontal: 4,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 3,
    paddingHorizontal: 4,
    borderBottomWidth: 0.5,
    borderBottomColor: COLORS.border,
  },
  th: { fontSize: 7, fontWeight: 700, color: COLORS.navy },
  td: { fontSize: 7 },
  cAddr: { flex: 2.4 },
  cSize: { flex: 1, textAlign: 'right' },
  cVision: { flex: 1.4 },
  cPrice: { flex: 1.2, textAlign: 'right' },
  cDate: { flex: 0.9, textAlign: 'right' },
  cAdj: { flex: 0.8, textAlign: 'right' },
  cImpl: { flex: 1.2, textAlign: 'right' },
  cFlags: { flex: 1.1 },
  narrative: {
    marginTop: 6,
    fontSize: 9,
    lineHeight: 1.4,
  },
  disclaimer: {
    marginTop: 10,
    fontSize: 7,
    color: COLORS.muted,
    fontStyle: 'italic',
  },
  footer: {
    position: 'absolute',
    bottom: 16,
    left: 32,
    right: 32,
    flexDirection: 'row',
    justifyContent: 'space-between',
    fontSize: 7,
    color: COLORS.muted,
    borderTopWidth: 0.5,
    borderTopColor: COLORS.border,
    paddingTop: 4,
  },
  subjectBlock: { flexDirection: 'row', gap: 10 },
  subjectPhoto: {
    width: 120,
    height: 90,
    objectFit: 'cover',
    borderRadius: 2,
    borderWidth: 0.5,
    borderColor: COLORS.border,
  },
  photoGallery: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 4,
  },
  photoCard: {
    width: '25%',
    padding: 3,
  },
  photoImage: {
    width: '100%',
    height: 70,
    objectFit: 'cover',
    borderRadius: 2,
    borderWidth: 0.5,
    borderColor: COLORS.border,
  },
  photoCaption: {
    fontSize: 6,
    color: COLORS.muted,
    marginTop: 2,
  },
  photoCaptionBold: {
    fontSize: 6,
    color: COLORS.text,
    marginTop: 1,
  },
});

function currency(n: number): string {
  return `$${Math.round(n).toLocaleString('en-AU')}`;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-AU', {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
  });
}

export function ValuationReport({
  data,
  photos,
}: {
  data: FullValuationResult;
  photos?: ReportPhotos;
}) {
  const { subject, market, cma, vendorAssessment, maxPrice, narrative } = data;
  const comps = cma.comparables.slice(0, 8);
  const compPhotos = comps
    .map((c) => ({ comp: c, photo: photos?.comparables?.[c.addressKey] }))
    .filter((p): p is { comp: typeof comps[number]; photo: string } => !!p.photo);

  return (
    <Document title={`PropSpotter CMA — ${subject.fullAddress}`}>
      <Page size="A4" style={styles.page}>
        <View style={styles.brandRow}>
          <View>
            <Text style={styles.brandName}>PropSpotter</Text>
            <Text style={styles.brandTag}>
              Property research and advisory — Australia
            </Text>
          </View>
          <Text style={styles.brandTag}>
            Generated {shortDate(data.generatedAtIso)}
          </Text>
        </View>

        {data.dataSource === 'mock' && (
          <Text style={styles.demoBanner}>
            DEMO MODE — Mock data. Figures are illustrative only.
          </Text>
        )}

        <Text style={styles.title}>Comparable Market Analysis</Text>
        <Text style={styles.subtitle}>{subject.fullAddress}</Text>

        <View style={styles.numbersRow}>
          <View style={[styles.numberCard, { borderLeftColor: COLORS.teal }]}>
            <Text style={styles.numberLabel}>OPENING OFFER</Text>
            <Text style={styles.numberValue}>{currency(maxPrice.openingOffer)}</Text>
            <Text style={styles.numberNote}>
              6% below target — a constructive starting point.
            </Text>
          </View>
          <View style={[styles.numberCard, { borderLeftColor: COLORS.navy }]}>
            <Text style={styles.numberLabel}>TARGET PRICE</Text>
            <Text style={styles.numberValue}>{currency(maxPrice.targetPrice)}</Text>
            <Text style={styles.numberNote}>
              Consistent with comparables and vendor posture.
            </Text>
          </View>
          <View style={[styles.numberCard, { borderLeftColor: COLORS.gold }]}>
            <Text style={styles.numberLabel}>WALK-AWAY MAX</Text>
            <Text style={styles.numberValue}>{currency(maxPrice.walkAwayMax)}</Text>
            <Text style={styles.numberNote}>
              Ceiling given market cycle and property velocity.
            </Text>
          </View>
        </View>

        <View style={styles.twoCol}>
          <View style={styles.col}>
            <Text style={styles.sectionHeader}>Subject property</Text>
            <View style={styles.subjectBlock}>
              {photos?.subject && (
                // eslint-disable-next-line jsx-a11y/alt-text
                <Image src={photos.subject} style={styles.subjectPhoto} />
              )}
              <View style={{ flex: 1 }}>
                <View style={styles.kvRow}>
                  <Text style={styles.k}>Type</Text>
                  <Text style={styles.v}>{subject.propertyType ?? 'House'}</Text>
                </View>
                <View style={styles.kvRow}>
                  <Text style={styles.k}>Bedrooms</Text>
                  <Text style={styles.v}>{subject.bedrooms ?? '—'}</Text>
                </View>
                <View style={styles.kvRow}>
                  <Text style={styles.k}>Bathrooms</Text>
                  <Text style={styles.v}>{subject.bathrooms ?? '—'}</Text>
                </View>
                <View style={styles.kvRow}>
                  <Text style={styles.k}>Car spaces</Text>
                  <Text style={styles.v}>{subject.carSpaces ?? '—'}</Text>
                </View>
                <View style={styles.kvRow}>
                  <Text style={styles.k}>Land size</Text>
                  <Text style={styles.v}>
                    {subject.landAreaSqm ? `${subject.landAreaSqm} sqm` : '—'}
                  </Text>
                </View>
                <View style={styles.kvRow}>
                  <Text style={styles.k}>Floor area</Text>
                  <Text style={styles.v}>
                    {subject.floorAreaSqm ? `${subject.floorAreaSqm} sqm` : '—'}
                  </Text>
                </View>
                <View style={styles.kvRow}>
                  <Text style={styles.k}>Year built</Text>
                  <Text style={styles.v}>{subject.yearBuilt ?? '—'}</Text>
                </View>
              </View>
            </View>
          </View>
          <View style={styles.col}>
            <Text style={styles.sectionHeader}>CMA summary</Text>
            <View style={styles.kvRow}>
              <Text style={styles.k}>Fair value</Text>
              <Text style={styles.v}>{currency(cma.fairValue)}</Text>
            </View>
            <View style={styles.kvRow}>
              <Text style={styles.k}>25–75th percentile</Text>
              <Text style={styles.v}>
                {currency(cma.fairValueLow)}–{currency(cma.fairValueHigh)}
              </Text>
            </View>
            <View style={styles.kvRow}>
              <Text style={styles.k}>Dispersion</Text>
              <Text style={styles.v}>{(cma.dispersion * 100).toFixed(1)}%</Text>
            </View>
            <View style={styles.kvRow}>
              <Text style={styles.k}>Comparables used</Text>
              <Text style={styles.v}>{cma.comparables.length}</Text>
            </View>
            <Text style={styles.sectionHeader}>Market context</Text>
            <View style={styles.kvRow}>
              <Text style={styles.k}>Suburb</Text>
              <Text style={styles.v}>
                {market.suburb} {market.state}
              </Text>
            </View>
            <View style={styles.kvRow}>
              <Text style={styles.k}>Cycle stage</Text>
              <Text style={styles.v}>{market.cycleStage}</Text>
            </View>
            <View style={styles.kvRow}>
              <Text style={styles.k}>5y growth</Text>
              <Text style={styles.v}>
                {(market.annualisedGrowth5y * 100).toFixed(1)}%
              </Text>
            </View>
            <View style={styles.kvRow}>
              <Text style={styles.k}>Typical DOM</Text>
              <Text style={styles.v}>{market.typicalDaysOnMarket} days</Text>
            </View>
          </View>
        </View>

        {data.tenureProfile && (
          <>
            <Text style={styles.sectionHeader}>
              Neighbourhood tenure (ABS 2021 Census G37 · SA1{' '}
              {data.tenureProfile.sa1Code})
            </Text>
            <View style={styles.kvRow}>
              <Text style={styles.k}>Owner-occupied</Text>
              <Text style={styles.v}>
                {data.tenureProfile.ownerOccupierPct.toFixed(1)}%
              </Text>
            </View>
            <View style={styles.kvRow}>
              <Text style={styles.k}>Private rental</Text>
              <Text style={styles.v}>
                {data.tenureProfile.privateRentalPct.toFixed(1)}%
              </Text>
            </View>
            <View style={styles.kvRow}>
              <Text style={styles.k}>Public housing</Text>
              <Text style={styles.v}>
                {data.tenureProfile.publicHousingPct.toFixed(1)}%
              </Text>
            </View>
            <View style={styles.kvRow}>
              <Text style={styles.k}>Other / not stated</Text>
              <Text style={styles.v}>
                {data.tenureProfile.otherPct.toFixed(1)}%
              </Text>
            </View>
          </>
        )}

        {data.seifaProfile && (
          <>
            <Text style={styles.sectionHeader}>
              SEIFA (ABS 2021 · national deciles, 1 disadvantaged →
              10 advantaged)
            </Text>
            <View style={styles.kvRow}>
              <Text style={styles.k}>IRSD (disadvantage)</Text>
              <Text style={styles.v}>
                {data.seifaProfile.irsd.decileAus}/10 (score{' '}
                {data.seifaProfile.irsd.score || '—'})
              </Text>
            </View>
            <View style={styles.kvRow}>
              <Text style={styles.k}>IRSAD (advantage & disadv.)</Text>
              <Text style={styles.v}>
                {data.seifaProfile.irsad.decileAus}/10 (score{' '}
                {data.seifaProfile.irsad.score || '—'})
              </Text>
            </View>
            <View style={styles.kvRow}>
              <Text style={styles.k}>IER (economic resources)</Text>
              <Text style={styles.v}>
                {data.seifaProfile.ier.decileAus}/10 (score{' '}
                {data.seifaProfile.ier.score || '—'})
              </Text>
            </View>
            <View style={styles.kvRow}>
              <Text style={styles.k}>IEO (education & occupation)</Text>
              <Text style={styles.v}>
                {data.seifaProfile.ieo.decileAus}/10 (score{' '}
                {data.seifaProfile.ieo.score || '—'})
              </Text>
            </View>
          </>
        )}

        {data.demographics && (
          <>
            <Text style={styles.sectionHeader}>
              Demographics (ABS 2021 Census G02 · SA1 medians)
            </Text>
            {data.demographics.medianAge != null && (
              <View style={styles.kvRow}>
                <Text style={styles.k}>Median age</Text>
                <Text style={styles.v}>
                  {data.demographics.medianAge} yrs
                </Text>
              </View>
            )}
            {data.demographics.averageHouseholdSize != null && (
              <View style={styles.kvRow}>
                <Text style={styles.k}>Avg household size</Text>
                <Text style={styles.v}>
                  {data.demographics.averageHouseholdSize.toFixed(1)}
                </Text>
              </View>
            )}
            {data.demographics.medianPersonalIncomeWeekly != null && (
              <View style={styles.kvRow}>
                <Text style={styles.k}>Median personal income</Text>
                <Text style={styles.v}>
                  $
                  {data.demographics.medianPersonalIncomeWeekly.toLocaleString(
                    'en-AU',
                  )}
                  /wk
                </Text>
              </View>
            )}
            {data.demographics.medianHouseholdIncomeWeekly != null && (
              <View style={styles.kvRow}>
                <Text style={styles.k}>Median household income</Text>
                <Text style={styles.v}>
                  $
                  {data.demographics.medianHouseholdIncomeWeekly.toLocaleString(
                    'en-AU',
                  )}
                  /wk
                </Text>
              </View>
            )}
            {data.demographics.medianRentWeekly != null && (
              <View style={styles.kvRow}>
                <Text style={styles.k}>Median rent</Text>
                <Text style={styles.v}>
                  $
                  {data.demographics.medianRentWeekly.toLocaleString('en-AU')}
                  /wk
                </Text>
              </View>
            )}
            {data.demographics.medianMortgageMonthly != null && (
              <View style={styles.kvRow}>
                <Text style={styles.k}>Median mortgage</Text>
                <Text style={styles.v}>
                  $
                  {data.demographics.medianMortgageMonthly.toLocaleString(
                    'en-AU',
                  )}
                  /mo
                </Text>
              </View>
            )}
          </>
        )}

        {data.riskProfile && (
          <>
            <Text style={styles.sectionHeader}>
              Hazard &amp; risk overlays
              {data.riskProfile.provider
                ? ` (${data.riskProfile.state})`
                : ` — no provider for ${data.riskProfile.state} yet`}
            </Text>
            <View style={styles.kvRow}>
              <Text style={styles.k}>Bushfire</Text>
              <Text style={styles.v}>
                {data.riskProfile.bushfire.level.toUpperCase()}
                {data.riskProfile.bushfire.zone
                  ? ` — ${data.riskProfile.bushfire.zone}`
                  : ''}
              </Text>
            </View>
            <View style={styles.kvRow}>
              <Text style={styles.k}>Flood</Text>
              <Text style={styles.v}>
                {data.riskProfile.flood.level.toUpperCase()}
                {data.riskProfile.flood.zone
                  ? ` — ${data.riskProfile.flood.zone}`
                  : ''}
              </Text>
            </View>
          </>
        )}

        <Text style={styles.sectionHeader}>Adjustments applied</Text>
        <View style={styles.kvRow}>
          <Text style={styles.k}>Cycle stretch</Text>
          <Text style={styles.v}>
            {(maxPrice.cycleStretchPct * 100).toFixed(2)}%
          </Text>
        </View>
        <View style={styles.kvRow}>
          <Text style={styles.k}>Velocity stretch</Text>
          <Text style={styles.v}>
            {(maxPrice.velocityStretchPct * 100).toFixed(2)}%
            {maxPrice.velocityRatio != null
              ? ` (ratio ${maxPrice.velocityRatio.toFixed(2)})`
              : ''}
          </Text>
        </View>
        <View style={styles.kvRow}>
          <Text style={styles.k}>Vendor leverage</Text>
          <Text style={styles.v}>
            {(maxPrice.vendorLeveragePct * 100).toFixed(2)}% ({vendorAssessment.motivation})
          </Text>
        </View>

        <Text style={styles.sectionHeader}>Comparable sales</Text>
        <View style={styles.table}>
          <View style={styles.tableHead}>
            <Text style={[styles.th, styles.cAddr]}>Address</Text>
            <Text style={[styles.th, styles.cSize]}>Land/Floor</Text>
            <Text style={[styles.th, styles.cVision]}>Vision</Text>
            <Text style={[styles.th, styles.cPrice]}>Sale price</Text>
            <Text style={[styles.th, styles.cDate]}>Date</Text>
            <Text style={[styles.th, styles.cAdj]}>Adj.</Text>
            <Text style={[styles.th, styles.cImpl]}>Implied value</Text>
            <Text style={[styles.th, styles.cFlags]}>Flags</Text>
          </View>
          {comps.map((c) => {
            const vision = c.visionAttrs
              ? [
                  c.visionAttrs.storeys !== 'unknown' && c.visionAttrs.storeys,
                  c.visionAttrs.constructionMaterial !== 'unknown' &&
                    c.visionAttrs.constructionMaterial,
                  c.visionAttrs.conditionGrade !== 'unknown' &&
                    c.visionAttrs.conditionGrade,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : '';
            return (
              <View key={c.addressKey} style={styles.tableRow}>
                <Text style={[styles.td, styles.cAddr]}>{c.fullAddress}</Text>
                <Text style={[styles.td, styles.cSize]}>
                  {`${c.landAreaSqm ?? '—'}/${c.floorAreaSqm ?? '—'}`}
                </Text>
                <Text style={[styles.td, styles.cVision]}>{vision || '—'}</Text>
                <Text style={[styles.td, styles.cPrice]}>
                  {currency(c.salePrice)}
                </Text>
                <Text style={[styles.td, styles.cDate]}>
                  {shortDate(c.saleDateIso)}
                </Text>
                <Text style={[styles.td, styles.cAdj]}>
                  {c.adjustmentFactor.toFixed(3)}
                </Text>
                <Text style={[styles.td, styles.cImpl]}>
                  {currency(c.impliedSubjectValue)}
                </Text>
                <Text style={[styles.td, styles.cFlags]}>
                  {c.flags.join(', ') || '—'}
                </Text>
              </View>
            );
          })}
        </View>

        {compPhotos.length > 0 && (
          <>
            <Text style={styles.sectionHeader}>Comparable photos</Text>
            <View style={styles.photoGallery}>
              {compPhotos.map(({ comp, photo }) => (
                <View key={comp.addressKey} style={styles.photoCard}>
                  {/* eslint-disable-next-line jsx-a11y/alt-text */}
                  <Image src={photo} style={styles.photoImage} />
                  <Text style={styles.photoCaptionBold}>
                    {comp.fullAddress}
                  </Text>
                  <Text style={styles.photoCaption}>
                    {currency(comp.salePrice)} · {shortDate(comp.saleDateIso)}
                  </Text>
                </View>
              ))}
            </View>
          </>
        )}

        <Text style={styles.sectionHeader}>Narrative</Text>
        <Text style={styles.narrative}>{narrative}</Text>

        <Text style={styles.disclaimer}>
          PropSpotter is a property research and advisory service. This report
          is research output, not personal financial advice. PropSpotter is not
          a licensed financial adviser. Figures are indicative and depend on
          the accuracy of source data. The reader is responsible for their own
          purchasing decisions.
        </Text>

        <View style={styles.footer} fixed>
          <Text>PropSpotter CMA — not a licensed financial adviser</Text>
          <Text>{subject.fullAddress}</Text>
        </View>
      </Page>
    </Document>
  );
}
