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
