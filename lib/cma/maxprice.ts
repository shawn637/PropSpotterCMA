import type {
  CycleStage,
  MaxPriceInputs,
  MaxPriceResult,
  VendorMotivation,
} from '@/lib/types';

export const CYCLE_STRETCH: Record<CycleStage, number> = {
  Recovery: 0.01,
  Rising: 0.025,
  Peaking: 0,
  Correction: -0.02,
};

export const VENDOR_LEVERAGE: Record<VendorMotivation, number> = {
  Standard: 0,
  Motivated: -0.05,
  Distressed: -0.10,
};

const OPENING_OFFER_DISCOUNT = 0.94;

/**
 * Maps the ratio of actual DOM to typical DOM into a ceiling adjustment.
 * A fast-selling listing (ratio < 1) indicates competitive pressure, so we
 * stretch the ceiling upward. A slow-moving listing gives us room to pull
 * the ceiling back.
 */
export function velocityStretch(
  actualDays: number | undefined,
  typicalDays: number,
): { stretch: number; ratio?: number } {
  if (actualDays == null || typicalDays <= 0) return { stretch: 0 };
  const ratio = actualDays / typicalDays;
  let stretch: number;
  if (ratio <= 0.5) stretch = 0.01;
  else if (ratio < 0.8) stretch = 0.005;
  else if (ratio <= 1.2) stretch = 0;
  else if (ratio < 1.8) stretch = -0.01;
  else stretch = -0.02;
  return { stretch, ratio };
}

export function computeMaxPrice(inputs: MaxPriceInputs): MaxPriceResult {
  const cycleStretchPct = CYCLE_STRETCH[inputs.cycleStage] ?? 0;
  const { stretch: velocityStretchPct, ratio: velocityRatio } = velocityStretch(
    inputs.actualDaysOnMarket,
    inputs.typicalDaysOnMarket,
  );
  const vendorLeveragePct = VENDOR_LEVERAGE[inputs.vendorMotivation] ?? 0;

  const walkAwayRaw =
    inputs.fairValue * (1 + cycleStretchPct + velocityStretchPct);
  const walkAwayMax = Math.max(walkAwayRaw, inputs.fairValue);

  const targetRaw = inputs.fairValue * (1 + vendorLeveragePct);
  const targetPrice = Math.min(targetRaw, walkAwayMax);

  const openingOffer = targetPrice * OPENING_OFFER_DISCOUNT;

  return {
    openingOffer: round100(openingOffer),
    targetPrice: round100(targetPrice),
    walkAwayMax: round100(walkAwayMax),
    cycleStretchPct,
    velocityStretchPct,
    vendorLeveragePct,
    velocityRatio,
  };
}

function round100(value: number): number {
  return Math.round(value / 100) * 100;
}
