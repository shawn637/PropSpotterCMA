export type CycleStage = 'Recovery' | 'Rising' | 'Peaking' | 'Correction';

export type VendorMotivation = 'Standard' | 'Motivated' | 'Distressed';

/**
 * Structured attributes extracted by Claude Vision from the complete
 * set of listing photos (façade + interiors + backyard), not just one
 * image. All fields optional-with-'unknown' / 'not_visible' because the
 * model should not have to guess when the relevant room or feature
 * isn't pictured.
 */
export type StoreyCount = 'single' | 'double' | 'multi' | 'unknown';
export type ConstructionMaterial =
  | 'brick'
  | 'weatherboard'
  | 'fibro'
  | 'render'
  | 'mixed'
  | 'unknown';
export type ConditionGrade =
  | 'poor'
  | 'average'
  | 'renovated'
  | 'new'
  | 'unknown';
/**
 * Room-specific condition grade. Adds 'not_visible' for the case where
 * a listing doesn't include an interior shot of that room — which
 * happens often enough for bathrooms that we don't want to fold it
 * into 'unknown' (which means "visible but ambiguous").
 */
export type RoomCondition = ConditionGrade | 'not_visible';
export type RoofType = 'tile' | 'metal' | 'unknown';

export type LandQuality =
  | 'neglected'
  | 'basic'
  | 'landscaped'
  | 'premium'
  | 'unknown';
export type BackyardSize = 'none' | 'small' | 'medium' | 'large' | 'unknown';

/**
 * Open-enum visual feature tags. The model is free to emit any of the
 * listed feature strings when the photos show them. Kept as an open
 * string[] rather than strict enums because REA listings surface a
 * long tail of features we don't want to enumerate exhaustively.
 */
export type VisualFeature =
  | 'pool'
  | 'view'
  | 'renovation'
  | 'modern_kitchen'
  | 'modern_bathroom'
  | 'outdoor_entertaining'
  | 'fireplace'
  | 'solar'
  | 'air_conditioning'
  | 'granny_flat'
  | 'corner_block'
  | 'main_road'
  | 'near_powerlines'
  | 'mature_trees';

export interface VisionAttributes {
  storeys: StoreyCount;
  constructionMaterial: ConstructionMaterial;
  /**
   * Overall condition synthesised across ALL photos (façade, kitchen,
   * bathroom, living areas, grounds). A listing whose kitchen is
   * pristine but whose bathroom is dated sits at 'average'; uniformly
   * pristine sits at 'renovated' or 'new'.
   */
  conditionGrade: ConditionGrade;
  kitchenCondition: RoomCondition;
  bathroomCondition: RoomCondition;
  landQuality: LandQuality;
  backyardSize: BackyardSize;
  features: VisualFeature[];
  roofType: RoofType;
  notes: string;
  imageUrls: string[];
}

export interface PropertyDetails {
  addressKey: string;
  fullAddress: string;
  suburb: string;
  state: string;
  postcode: string;
  locPid: string;
  /** WGS84 decimal degrees. Optional — not every geocode response
   *  carries coordinates, and the CMA math doesn't need them. The ABS
   *  G37 spatial query is the main consumer. */
  latitude?: number;
  longitude?: number;
  landAreaSqm?: number;
  floorAreaSqm?: number;
  bedrooms?: number;
  bathrooms?: number;
  carSpaces?: number;
  yearBuilt?: number;
  propertyType?: 'House' | 'Unit' | 'Townhouse' | 'Other';
  visionAttrs?: VisionAttributes;
  /** ABS 2021 Census G37 tenure shares for the subject's SA1.
   *  Populated in /api/cma after geocoding. Consumed by compute.ts's
   *  deriveTenureAdjustment and by the narrative prompt. */
  tenureProfile?: TenureProfile;
}

export interface Comparable {
  addressKey: string;
  fullAddress: string;
  salePrice: number;
  saleDateIso: string;
  landAreaSqm?: number;
  floorAreaSqm?: number;
  bedrooms?: number;
  bathrooms?: number;
  carSpaces?: number;
  yearBuilt?: number;
  distanceKm?: number;
  htagAdjustmentFactor?: number;
  propertyType?: 'House' | 'Unit' | 'Townhouse' | 'Other';
  visionAttrs?: VisionAttributes;
  /** WGS84 decimal degrees — only when HTAG sold-search surfaces them.
   *  Used to look up the comp's SA1 for the tenure adjustment. */
  latitude?: number;
  longitude?: number;
  /** ABS 2021 Census G37 tenure shares for THIS comp's SA1. Distinct
   *  from the subject's tenureProfile and from FullValuationResult's
   *  subject-level tenureProfile. Populated in the CMA route by
   *  fetching in parallel with the subject tenure call. */
  tenureProfile?: TenureProfile;
}

export interface ComparableWithDerived extends Comparable {
  monthsSinceSale: number;
  indexedSalePrice: number;
  adjustmentFactor: number;
  adjustmentSource: 'htag' | 'heuristic';
  impliedSubjectValue: number;
  flags: string[];
}

export interface MarketContext {
  locPid: string;
  suburb: string;
  state: string;
  annualisedGrowth5y: number;
  cycleStage: CycleStage;
  typicalDaysOnMarket: number;
  typicalPrice?: number;
  medianSalePrice?: number;
}

export interface CMAResult {
  fairValue: number;
  fairValueLow: number;
  fairValueHigh: number;
  dispersion: number;
  comparables: ComparableWithDerived[];
  notes: string[];
}

export interface VendorAssessment {
  motivation: VendorMotivation;
  confidence: number;
  rationale: string;
  triggerPhrases: string[];
  source: 'llm' | 'fallback';
}

export interface MaxPriceInputs {
  fairValue: number;
  cycleStage: CycleStage;
  vendorMotivation: VendorMotivation;
  actualDaysOnMarket?: number;
  typicalDaysOnMarket: number;
}

export interface MaxPriceResult {
  openingOffer: number;
  targetPrice: number;
  walkAwayMax: number;
  cycleStretchPct: number;
  velocityStretchPct: number;
  vendorLeveragePct: number;
  velocityRatio?: number;
}

export interface FullValuationResult {
  subject: PropertyDetails;
  market: MarketContext;
  cma: CMAResult;
  vendorAssessment: VendorAssessment;
  maxPrice: MaxPriceResult;
  narrative: string;
  generatedAtIso: string;
  dataSource: 'mock' | 'live';
  requestedAddress: string;
  actualDaysOnMarket?: number;
  /** ABS 2021 Census G37 tenure share at the subject's SA1. Optional —
   *  the valuation renders without it if the ABS FeatureServer is
   *  unreachable or we couldn't resolve an SA1 for the subject. */
  tenureProfile?: TenureProfile;
  /** ABS 2021 SEIFA scores and deciles at the subject's SA1. Socio-
   *  economic indexes — the strongest single "is this pocket rising
   *  or falling" signal in Australian property research. */
  seifaProfile?: SeifaProfile;
  /** ABS 2021 Census G02 demographic medians at the subject's SA1.
   *  Median income / rent / mortgage / household size. Feeds the
   *  "can the typical household here afford the price" check. */
  demographics?: G02Demographics;
}

export interface CMARequest {
  address: string;
  listingDescription?: string;
  actualDaysOnMarket?: number;
}

/**
 * ABS 2021 Census G37 tenure shares at SA1 granularity (~200-800 people,
 * the finest ABS statistical unit). Sourced live from the ABS Digital
 * Atlas ArcGIS FeatureServer; see lib/abs/client.ts.
 *
 * The three headline percentages don't sum to 100 because G37 includes
 * minor tenure categories we don't surface (rent-free, life tenure,
 * "tenure not stated", rented from individuals not in the same
 * household). `otherPct` captures the residual so the UI can make that
 * transparent rather than hide the gap.
 */
export interface TenureProfile {
  sa1Code: string;
  totalDwellings: number;
  ownerOccupierPct: number;
  privateRentalPct: number;
  publicHousingPct: number;
  otherPct: number;
}

/**
 * ABS 2021 SEIFA (Socio-Economic Indexes for Areas) at SA1.
 * Higher score = more advantaged. Deciles are national, 1 (most
 * disadvantaged) → 10 (most advantaged); state-level deciles have
 * the same rank scale against a smaller pool. Scores hover around
 * 1000 (national mean).
 *
 *   IRSD  = Index of Relative Socio-economic Disadvantage — only
 *           captures disadvantage (low-income, unemployment, no-car,
 *           crowding). Useful for risk screening.
 *   IRSAD = …Advantage and Disadvantage — two-sided index; rising
 *           deciles signal gentrification or already-established
 *           upper-tier areas.
 *   IER   = Index of Economic Resources — income + mortgage/rent
 *           burden + wealth proxies. Tracks spending power.
 *   IEO   = Index of Education and Occupation — degree-holders and
 *           professional/managerial shares. Leading indicator for
 *           long-run price growth.
 */
export interface SeifaProfile {
  sa1Code: string;
  irsd: { score: number; decileAus: number };
  irsad: { score: number; decileAus: number };
  ier: { score: number; decileAus: number };
  ieo: { score: number; decileAus: number };
}

/**
 * ABS 2021 Census G02 "Selected Medians and Averages" at SA1.
 * Only the fields that move investment decisions are surfaced;
 * additional G02 columns exist but add noise without signal for
 * valuation work. Weekly values in dollars.
 */
export interface G02Demographics {
  sa1Code: string;
  medianAge?: number;
  medianHouseholdIncomeWeekly?: number;
  medianPersonalIncomeWeekly?: number;
  medianRentWeekly?: number;
  medianMortgageMonthly?: number;
  averageHouseholdSize?: number;
}
