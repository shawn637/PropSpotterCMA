import React from 'react';
import {
  Document,
  Page,
  StyleSheet,
  Text,
  View,
} from '@react-pdf/renderer';

import type { FullValuationResult } from '@/lib/types';

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
  cAddr: { flex: 2.6 },
  cSize: { flex: 1.1, textAlign: 'right' },
  cPrice: { flex: 1.2, textAlign: 'right' },
  cDate: { flex: 1, textAlign: 'right' },
  cAdj: { flex: 0.9, textAlign: 'right' },
  cImpl: { flex: 1.3, textAlign: 'right' },
  cFlags: { flex: 1.3 },
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

export function ValuationReport({ data }: { data: FullValuationResult }) {
  const { subject, market, cma, vendorAssessment, maxPrice, narrative } = data;
  const comps = cma.comparables.slice(0, 8);

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
            <Text style={[styles.th, styles.cPrice]}>Sale price</Text>
            <Text style={[styles.th, styles.cDate]}>Date</Text>
            <Text style={[styles.th, styles.cAdj]}>Adj.</Text>
            <Text style={[styles.th, styles.cImpl]}>Implied value</Text>
            <Text style={[styles.th, styles.cFlags]}>Flags</Text>
          </View>
          {comps.map((c) => (
            <View key={c.addressKey} style={styles.tableRow}>
              <Text style={[styles.td, styles.cAddr]}>{c.fullAddress}</Text>
              <Text style={[styles.td, styles.cSize]}>
                {`${c.landAreaSqm ?? '—'}/${c.floorAreaSqm ?? '—'}`}
              </Text>
              <Text style={[styles.td, styles.cPrice]}>
                {currency(c.salePrice)}
              </Text>
              <Text style={[styles.td, styles.cDate]}>{shortDate(c.saleDateIso)}</Text>
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
          ))}
        </View>

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
