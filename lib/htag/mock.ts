import type {
  Comparable,
  MarketContext,
  PropertyDetails,
} from '@/lib/types';

/**
 * Mock fixtures, per-profile. Routing is address-substring based so you
 * can smoke-test different market shapes (Rising / Peaking / Correction)
 * with zero HTAG setup:
 *
 *   "... Baulkham Hills ..."      → Rising market
 *   "... Stanhope ..."            → Peaking market
 *   "... Correction ..."          → Correction-phase market (edge case)
 *   default                       → Baulkham Hills (Rising)
 */
export interface MockProfile {
  key: string;
  subject: PropertyDetails;
  market: MarketContext;
  comparables: Comparable[];
  listingDescription: string;
}

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Profile 1: Baulkham Hills NSW2153 — Rising market, Standard vendor by default.
// Matches the numbers in the handoff spec (fair value ~$525k).
// ---------------------------------------------------------------------------

const BAULKHAM_SUBJECT: PropertyDetails = {
  addressKey: 'mock-baulkham-hills-42-example-st',
  fullAddress: '42 Example Street, Baulkham Hills NSW 2153',
  suburb: 'Baulkham Hills',
  state: 'NSW',
  postcode: '2153',
  locPid: 'NSW231',
  landAreaSqm: 620,
  bedrooms: 4,
  bathrooms: 2,
  carSpaces: 2,
  yearBuilt: 1995,
  propertyType: 'House',
};

const BAULKHAM_MARKET: MarketContext = {
  locPid: 'NSW231',
  suburb: 'Baulkham Hills',
  state: 'NSW',
  annualisedGrowth5y: 0.072,
  cycleStage: 'Rising',
  typicalDaysOnMarket: 38,
  typicalPrice: 528_000,
  medianSalePrice: 520_000,
};

const BAULKHAM_COMPARABLES: Comparable[] = [
  { addressKey: 'mock-baulkham-1', fullAddress: '8 Sample Crescent, Baulkham Hills NSW 2153', salePrice: 505_000, saleDateIso: daysAgoIso(28), landAreaSqm: 610, bedrooms: 4, bathrooms: 2, carSpaces: 2, distanceKm: 0.4, htagAdjustmentFactor: 1.02, propertyType: 'House' },
  { addressKey: 'mock-baulkham-2', fullAddress: '15 Demo Avenue, Baulkham Hills NSW 2153', salePrice: 518_000, saleDateIso: daysAgoIso(52), landAreaSqm: 640, bedrooms: 4, bathrooms: 2, carSpaces: 2, distanceKm: 0.8, htagAdjustmentFactor: 0.99, propertyType: 'House' },
  { addressKey: 'mock-baulkham-3', fullAddress: '27 Placeholder Road, Baulkham Hills NSW 2153', salePrice: 495_000, saleDateIso: daysAgoIso(75), landAreaSqm: 580, bedrooms: 3, bathrooms: 2, carSpaces: 2, distanceKm: 1.1, htagAdjustmentFactor: 1.04, propertyType: 'House' },
  { addressKey: 'mock-baulkham-4', fullAddress: '33 Fixture Close, Baulkham Hills NSW 2153', salePrice: 540_000, saleDateIso: daysAgoIso(94), landAreaSqm: 650, bedrooms: 4, bathrooms: 3, carSpaces: 2, distanceKm: 0.9, htagAdjustmentFactor: 0.97, propertyType: 'House' },
  { addressKey: 'mock-baulkham-5', fullAddress: '49 Seed Street, Baulkham Hills NSW 2153', salePrice: 522_000, saleDateIso: daysAgoIso(40), landAreaSqm: 630, bedrooms: 4, bathrooms: 2, carSpaces: 2, distanceKm: 0.6, htagAdjustmentFactor: 1.0, propertyType: 'House' },
  { addressKey: 'mock-baulkham-6', fullAddress: '12 Dummy Drive, Baulkham Hills NSW 2153', salePrice: 488_000, saleDateIso: daysAgoIso(110), landAreaSqm: 570, bedrooms: 3, bathrooms: 1, carSpaces: 1, distanceKm: 1.4, htagAdjustmentFactor: 1.08, propertyType: 'House' },
  { addressKey: 'mock-baulkham-7', fullAddress: '71 Test Grove, Baulkham Hills NSW 2153', salePrice: 558_000, saleDateIso: daysAgoIso(61), landAreaSqm: 700, bedrooms: 4, bathrooms: 2, carSpaces: 2, distanceKm: 1.0, htagAdjustmentFactor: 0.94, propertyType: 'House' },
  { addressKey: 'mock-baulkham-8', fullAddress: '4 Prototype Place, Baulkham Hills NSW 2153', salePrice: 530_000, saleDateIso: daysAgoIso(35), landAreaSqm: 620, bedrooms: 4, bathrooms: 2, carSpaces: 2, distanceKm: 0.5, htagAdjustmentFactor: 0.98, propertyType: 'House' },
  { addressKey: 'mock-baulkham-9', fullAddress: '19 Specimen Street, Baulkham Hills NSW 2153', salePrice: 512_000, saleDateIso: daysAgoIso(82), landAreaSqm: 600, bedrooms: 4, bathrooms: 2, carSpaces: 2, distanceKm: 0.7, htagAdjustmentFactor: 1.01, propertyType: 'House' },
  { addressKey: 'mock-baulkham-10', fullAddress: '63 Example Street, Baulkham Hills NSW 2153', salePrice: 548_000, saleDateIso: daysAgoIso(22), landAreaSqm: 660, bedrooms: 4, bathrooms: 2, carSpaces: 2, distanceKm: 0.3, htagAdjustmentFactor: 0.96, propertyType: 'House' },
];

const BAULKHAM_LISTING =
  'Beautifully presented four-bedroom family home in a sought-after pocket of Baulkham Hills. The vendor says sell — relocation means this one needs to go. Open plan living, updated kitchen, low-maintenance gardens, double garage. Walking distance to shops and schools.';

// ---------------------------------------------------------------------------
// Profile 2: Stanhope Gardens NSW2768 — Peaking market, standard listing copy.
// Peaking: cycleStretch = 0, so the walk-away ceiling equals the fair value
// unless a velocity stretch kicks in. Good for testing the "no cycle
// leverage, rely on vendor posture" path.
// ---------------------------------------------------------------------------

const STANHOPE_SUBJECT: PropertyDetails = {
  addressKey: 'mock-stanhope-gardens-11-sample-cct',
  fullAddress: '11 Sample Circuit, Stanhope Gardens NSW 2768',
  suburb: 'Stanhope Gardens',
  state: 'NSW',
  postcode: '2768',
  locPid: 'NSW3682',
  landAreaSqm: 420,
  bedrooms: 4,
  bathrooms: 2,
  carSpaces: 2,
  yearBuilt: 2005,
  propertyType: 'House',
};

const STANHOPE_MARKET: MarketContext = {
  locPid: 'NSW3682',
  suburb: 'Stanhope Gardens',
  state: 'NSW',
  annualisedGrowth5y: 0.045,
  cycleStage: 'Peaking',
  typicalDaysOnMarket: 52,
  typicalPrice: 1_180_000,
  medianSalePrice: 1_150_000,
};

const STANHOPE_COMPARABLES: Comparable[] = [
  { addressKey: 'mock-stanhope-1', fullAddress: '6 Fixture Way, Stanhope Gardens NSW 2768', salePrice: 1_140_000, saleDateIso: daysAgoIso(30), landAreaSqm: 400, bedrooms: 4, bathrooms: 2, carSpaces: 2, distanceKm: 0.3, htagAdjustmentFactor: 1.01, propertyType: 'House' },
  { addressKey: 'mock-stanhope-2', fullAddress: '22 Demo Parade, Stanhope Gardens NSW 2768', salePrice: 1_165_000, saleDateIso: daysAgoIso(58), landAreaSqm: 430, bedrooms: 4, bathrooms: 2, carSpaces: 2, distanceKm: 0.9, htagAdjustmentFactor: 0.99, propertyType: 'House' },
  { addressKey: 'mock-stanhope-3', fullAddress: '9 Placeholder Street, Stanhope Gardens NSW 2768', salePrice: 1_120_000, saleDateIso: daysAgoIso(72), landAreaSqm: 390, bedrooms: 3, bathrooms: 2, carSpaces: 2, distanceKm: 1.0, htagAdjustmentFactor: 1.03, propertyType: 'House' },
  { addressKey: 'mock-stanhope-4', fullAddress: '35 Sample Grove, Stanhope Gardens NSW 2768', salePrice: 1_195_000, saleDateIso: daysAgoIso(89), landAreaSqm: 450, bedrooms: 4, bathrooms: 3, carSpaces: 2, distanceKm: 1.2, htagAdjustmentFactor: 0.97, propertyType: 'House' },
  { addressKey: 'mock-stanhope-5', fullAddress: '17 Seed Close, Stanhope Gardens NSW 2768', salePrice: 1_155_000, saleDateIso: daysAgoIso(44), landAreaSqm: 410, bedrooms: 4, bathrooms: 2, carSpaces: 2, distanceKm: 0.5, htagAdjustmentFactor: 1.0, propertyType: 'House' },
  { addressKey: 'mock-stanhope-6', fullAddress: '50 Specimen Drive, Stanhope Gardens NSW 2768', salePrice: 1_210_000, saleDateIso: daysAgoIso(66), landAreaSqm: 460, bedrooms: 5, bathrooms: 3, carSpaces: 2, distanceKm: 1.1, htagAdjustmentFactor: 0.94, propertyType: 'House' },
  { addressKey: 'mock-stanhope-7', fullAddress: '28 Test Avenue, Stanhope Gardens NSW 2768', salePrice: 1_085_000, saleDateIso: daysAgoIso(102), landAreaSqm: 380, bedrooms: 3, bathrooms: 2, carSpaces: 2, distanceKm: 1.3, htagAdjustmentFactor: 1.05, propertyType: 'House' },
  { addressKey: 'mock-stanhope-8', fullAddress: '4 Prototype Rise, Stanhope Gardens NSW 2768', salePrice: 1_170_000, saleDateIso: daysAgoIso(38), landAreaSqm: 420, bedrooms: 4, bathrooms: 2, carSpaces: 2, distanceKm: 0.6, htagAdjustmentFactor: 1.0, propertyType: 'House' },
];

const STANHOPE_LISTING =
  'Four-bedroom family residence in the heart of Stanhope Gardens. Formal living, open plan family/meals, covered alfresco, double lock-up garage. Close to Stanhope Village and Stanhope Public School. Inspections by appointment.';

// ---------------------------------------------------------------------------
// Profile 3: hypothetical Correction-phase suburb. Triggers the -2% cycle
// stretch and a long-DOM velocity penalty. Use the word "Correction" in
// the test address to route here.
// ---------------------------------------------------------------------------

const CORRECTION_SUBJECT: PropertyDetails = {
  addressKey: 'mock-correction-example',
  fullAddress: '1 Example Street, Correction Springs NSW 2000',
  suburb: 'Correction Springs',
  state: 'NSW',
  postcode: '2000',
  locPid: 'NSWCORR',
  landAreaSqm: 500,
  bedrooms: 3,
  bathrooms: 2,
  carSpaces: 1,
  yearBuilt: 1988,
  propertyType: 'House',
};

const CORRECTION_MARKET: MarketContext = {
  locPid: 'NSWCORR',
  suburb: 'Correction Springs',
  state: 'NSW',
  annualisedGrowth5y: -0.01,
  cycleStage: 'Correction',
  typicalDaysOnMarket: 84,
  typicalPrice: 720_000,
  medianSalePrice: 705_000,
};

const CORRECTION_COMPARABLES: Comparable[] = [
  { addressKey: 'mock-correction-1', fullAddress: '5 Demo Close, Correction Springs NSW 2000', salePrice: 720_000, saleDateIso: daysAgoIso(40), landAreaSqm: 500, bedrooms: 3, bathrooms: 2, carSpaces: 1, distanceKm: 0.5, htagAdjustmentFactor: 1.0, propertyType: 'House' },
  { addressKey: 'mock-correction-2', fullAddress: '18 Sample Road, Correction Springs NSW 2000', salePrice: 695_000, saleDateIso: daysAgoIso(68), landAreaSqm: 480, bedrooms: 3, bathrooms: 1, carSpaces: 1, distanceKm: 0.9, htagAdjustmentFactor: 1.03, propertyType: 'House' },
  { addressKey: 'mock-correction-3', fullAddress: '29 Placeholder Lane, Correction Springs NSW 2000', salePrice: 745_000, saleDateIso: daysAgoIso(98), landAreaSqm: 520, bedrooms: 3, bathrooms: 2, carSpaces: 2, distanceKm: 1.0, htagAdjustmentFactor: 0.97, propertyType: 'House' },
  { addressKey: 'mock-correction-4', fullAddress: '41 Seed Crescent, Correction Springs NSW 2000', salePrice: 688_000, saleDateIso: daysAgoIso(112), landAreaSqm: 470, bedrooms: 3, bathrooms: 2, carSpaces: 1, distanceKm: 1.2, htagAdjustmentFactor: 1.04, propertyType: 'House' },
  { addressKey: 'mock-correction-5', fullAddress: '7 Specimen Avenue, Correction Springs NSW 2000', salePrice: 735_000, saleDateIso: daysAgoIso(55), landAreaSqm: 510, bedrooms: 4, bathrooms: 2, carSpaces: 1, distanceKm: 0.7, htagAdjustmentFactor: 0.98, propertyType: 'House' },
];

const CORRECTION_LISTING =
  'Mortgagee in possession. Urgent sale — all offers considered. Three-bedroom home on a good-sized block; some updating opportunities. Presented as-is. Inspection by appointment.';

export const PROFILES: Record<string, MockProfile> = {
  baulkham: {
    key: 'baulkham',
    subject: BAULKHAM_SUBJECT,
    market: BAULKHAM_MARKET,
    comparables: BAULKHAM_COMPARABLES,
    listingDescription: BAULKHAM_LISTING,
  },
  stanhope: {
    key: 'stanhope',
    subject: STANHOPE_SUBJECT,
    market: STANHOPE_MARKET,
    comparables: STANHOPE_COMPARABLES,
    listingDescription: STANHOPE_LISTING,
  },
  correction: {
    key: 'correction',
    subject: CORRECTION_SUBJECT,
    market: CORRECTION_MARKET,
    comparables: CORRECTION_COMPARABLES,
    listingDescription: CORRECTION_LISTING,
  },
};

export function pickProfile(address: string): MockProfile {
  const s = (address ?? '').toLowerCase();
  if (s.includes('stanhope')) return PROFILES.stanhope;
  if (s.includes('correction')) return PROFILES.correction;
  return PROFILES.baulkham;
}

export function profileByLocPid(locPid: string): MockProfile | undefined {
  return Object.values(PROFILES).find((p) => p.subject.locPid === locPid);
}

// Legacy exports — kept so the default Baulkham profile can still be
// imported directly. The client and debug route go through pickProfile /
// profileByLocPid.
export const MOCK_SUBJECT = PROFILES.baulkham.subject;
export const MOCK_MARKET = PROFILES.baulkham.market;
export const MOCK_COMPARABLES = PROFILES.baulkham.comparables;
export const MOCK_LISTING_DESCRIPTION = PROFILES.baulkham.listingDescription;
