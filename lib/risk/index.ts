/**
 * Risk overlay router. Picks a per-state provider based on the
 * subject's state, runs the provider's flood + bushfire queries,
 * and returns a unified RiskProfile. VIC, QLD, TAS providers ship
 * in follow-up commits with the same shape — adding them is a
 * matter of implementing one `fetchXxxRiskProfile` function and
 * adding a case here.
 *
 * States without a provider yet return { provider: null, flood +
 * bushfire as level:"unknown" } so the UI shows a clear "coverage
 * not yet available" state rather than silently omitting.
 */

import { fetchNswRiskProfile } from '@/lib/risk/nsw';
import type { HazardLayerResult, RiskProfile } from '@/lib/types';

export async function fetchRiskProfile(args: {
  latitude: number;
  longitude: number;
  state: string;
}): Promise<RiskProfile> {
  const normalisedState = args.state.trim().toUpperCase();
  switch (normalisedState) {
    case 'NSW': {
      const { bushfire, flood } = await fetchNswRiskProfile(
        args.latitude,
        args.longitude,
      );
      return { state: 'NSW', bushfire, flood, provider: 'nsw' };
    }
    // case 'VIC': …   ship in Release 2b
    // case 'QLD': …   ship in Release 2c
    // case 'TAS': …   ship in Release 2d
    default:
      return {
        state: normalisedState,
        bushfire: unsupportedProviderLayer(normalisedState, 'bushfire'),
        flood: unsupportedProviderLayer(normalisedState, 'flood'),
        provider: null,
      };
  }
}

function unsupportedProviderLayer(
  state: string,
  kind: string,
): HazardLayerResult {
  return {
    level: 'unknown',
    error: `No ${kind} risk provider registered for ${state} yet. NSW shipped; VIC/QLD/TAS in follow-up commits.`,
  };
}
