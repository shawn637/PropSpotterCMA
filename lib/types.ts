export type CycleStage = 'Recovery' | 'Rising' | 'Peaking' | 'Correction';

export type VendorMotivation = 'Standard' | 'Motivated' | 'Distressed';

/**
 * Structured attributes extracted from a listing photo by Claude Vision.
 * All fields optional-with-'unknown' because the model should not have
 * to guess when the façade isn't visible or the angle is ambiguous.
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
export type RoofType = 'tile' | 'metal' | 'unknown';

export interface VisionAttributes {
  storeys: StoreyCount;
  constructionMaterial: ConstructionMaterial;
  conditionGrade: ConditionGrade;
  roofType: RoofType;
  notes: string;
  imageUrl: string;
}

export interface PropertyDetails {
  addressKey: string;
  fullAddress: string;
  suburb: string;
  state: string;
  postcode: string;
  locPid: string;
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
}

export interface CMARequest {
  address: string;
  listingDescription?: string;
  actualDaysOnMarket?: number;
}
