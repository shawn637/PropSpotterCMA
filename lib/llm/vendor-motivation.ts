import Anthropic from '@anthropic-ai/sdk';

import type {
  CMAResult,
  MarketContext,
  MaxPriceResult,
  PropertyDetails,
  VendorAssessment,
  VendorMotivation,
  VisionAttributes,
} from '@/lib/types';

/**
 * Render a VisionAttributes into a compact one-liner for the narrative
 * prompt. Only surfaces fields that have real information — 'unknown'
 * / 'not_visible' are dropped so we don't pollute the model's context
 * with noise. Features are joined with commas, prefixed by "features:"
 * so the model can distinguish from the structured condition fields.
 */
function formatVisionForPrompt(v: VisionAttributes): string {
  const parts: string[] = [];
  if (v.storeys !== 'unknown') parts.push(v.storeys);
  if (v.constructionMaterial !== 'unknown') parts.push(v.constructionMaterial);
  if (v.conditionGrade !== 'unknown')
    parts.push(`overall condition ${v.conditionGrade}`);
  if (v.kitchenCondition !== 'unknown' && v.kitchenCondition !== 'not_visible')
    parts.push(`kitchen ${v.kitchenCondition}`);
  if (
    v.bathroomCondition !== 'unknown' &&
    v.bathroomCondition !== 'not_visible'
  )
    parts.push(`bathroom ${v.bathroomCondition}`);
  if (v.landQuality !== 'unknown') parts.push(`land ${v.landQuality}`);
  if (v.backyardSize !== 'unknown') parts.push(`backyard ${v.backyardSize}`);
  if (v.features.length > 0)
    parts.push(`features: ${v.features.map((f) => f.replace(/_/g, ' ')).join(', ')}`);
  if (v.notes) parts.push(`notes: ${v.notes}`);
  return parts.length > 0 ? parts.join('; ') : 'no meaningful signal';
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

export interface TokenUsage {
  input: number;
  output: number;
}

export interface VendorAssessmentResult {
  assessment: VendorAssessment;
  tokenUsage?: TokenUsage;
}

export interface NarrativeResult {
  text: string;
  tokenUsage?: TokenUsage;
}

const DEFAULT_MODEL = 'claude-sonnet-4-6';

function model(): string {
  return process.env.CLAUDE_MODEL ?? DEFAULT_MODEL;
}

function hasApiKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

function makeClient(): Anthropic {
  return new Anthropic();
}

const BRAND_RULES = `You are assisting PropSpotter, an Australian property research and advisory service.
PropSpotter is NOT a buyers agent or buyers agency and does not negotiate, bid, or transact on behalf of clients.
Never use the terms "buyers agent", "buyer's agent", or "buyers agency" anywhere in your output.
PropSpotter provides research, comparable market analysis, and educational tools; clients make their own decisions.
PropSpotter is not a licensed financial adviser. Nothing you write is personal financial advice.`;

const VENDOR_SYSTEM_PROMPT = `${BRAND_RULES}

Your task: classify how motivated a property vendor appears to be, based on a listing description.

Return one of three categories:
- "Standard": neutral listing language, no urgency signals.
- "Motivated": clear cues that the vendor wants/needs to sell (relocation, divorce, "must sell", "genuine vendor says sell", "all offers considered", price reductions, extended time on market noted).
- "Distressed": strong urgency or financial stress cues ("mortgagee in possession", "deceased estate", "urgent sale", "receivers sale", "bank repossession", "bankruptcy").

Be conservative. Absent clear evidence, return "Standard". Confidence is a number between 0 and 1.
Rationale must be one or two short sentences that quote or paraphrase the specific cues. If the description is empty, return "Standard" with confidence 0.3.`;

const VENDOR_TOOL: Anthropic.Tool = {
  name: 'record_vendor_motivation',
  description:
    'Record the vendor motivation classification. Always call this tool with your classification; do not respond with prose.',
  input_schema: {
    type: 'object',
    properties: {
      motivation: {
        type: 'string',
        enum: ['Standard', 'Motivated', 'Distressed'],
      },
      confidence: { type: 'number' },
      rationale: { type: 'string' },
      trigger_phrases: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: ['motivation', 'confidence', 'rationale', 'trigger_phrases'],
  },
};

export async function assessVendorMotivation(
  listingDescription: string | undefined,
): Promise<VendorAssessmentResult> {
  const description = (listingDescription ?? '').trim();

  if (!description) {
    return {
      assessment: {
        motivation: 'Standard',
        confidence: 0.3,
        rationale:
          'No listing description provided; defaulting to Standard vendor.',
        triggerPhrases: [],
        source: 'fallback',
      },
    };
  }

  if (!hasApiKey()) {
    return { assessment: heuristicVendorAssessment(description) };
  }

  try {
    const client = makeClient();
    const response = await client.messages.create({
      model: model(),
      max_tokens: 512,
      system: VENDOR_SYSTEM_PROMPT,
      tools: [VENDOR_TOOL],
      tool_choice: { type: 'tool', name: VENDOR_TOOL.name },
      messages: [
        {
          role: 'user',
          content: `Listing description:\n\n${description}`,
        },
      ],
    });

    const tokenUsage: TokenUsage = {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
    };

    const toolUse = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    if (!toolUse) {
      return { assessment: heuristicVendorAssessment(description), tokenUsage };
    }
    const input = toolUse.input as Record<string, unknown>;
    const motivation = normaliseMotivation(input.motivation);
    const confidence = clamp01(Number(input.confidence ?? 0.5));
    const rationale = typeof input.rationale === 'string'
      ? input.rationale.trim()
      : 'Classified by LLM.';
    const triggerPhrases = Array.isArray(input.trigger_phrases)
      ? (input.trigger_phrases as unknown[])
          .filter((p): p is string => typeof p === 'string')
          .slice(0, 6)
      : [];

    return {
      assessment: {
        motivation,
        confidence,
        rationale,
        triggerPhrases,
        source: 'llm',
      },
      tokenUsage,
    };
  } catch (error) {
    console.warn(
      'assessVendorMotivation LLM call failed; using heuristic fallback.',
      error,
    );
    return { assessment: heuristicVendorAssessment(description) };
  }
}

export async function generateNarrative(args: {
  subject: PropertyDetails;
  market: MarketContext;
  cma: CMAResult;
  vendorAssessment: VendorAssessment;
  maxPrice: MaxPriceResult;
  actualDaysOnMarket?: number;
}): Promise<NarrativeResult> {
  if (!hasApiKey()) return { text: fallbackNarrative(args) };

  const subjectVision = args.subject.visionAttrs;
  const subjectVisionLine = subjectVision
    ? `- Subject visual profile (Claude Vision, synthesised across the listing gallery): ${formatVisionForPrompt(subjectVision)}`
    : '- Subject visual profile: not analysed (no photos available)';

  // Up to 8 comp lines so the model can name specific comps in the
  // narrative rather than treating them as a faceless "set". Include
  // each comp's vision profile when present — that's what lets the
  // writer explain WHY a particular comp landed where it did.
  const compLines = args.cma.comparables
    .slice(0, 8)
    .map((c) => {
      const vision = c.visionAttrs
        ? formatVisionForPrompt(c.visionAttrs)
        : 'no visual profile';
      return `  * ${c.fullAddress} — sold $${c.salePrice.toLocaleString()} (${shortDate(c.saleDateIso)}), adj ${c.adjustmentFactor.toFixed(3)} → implied $${Math.round(c.impliedSubjectValue).toLocaleString()}; ${vision}`;
    })
    .join('\n');

  const prompt = `${BRAND_RULES}

Write a 3-4 paragraph narrative (plain prose, no headings, no bullet lists, no markdown) for a PropSpotter CMA report. Tone: professional, direct, educational. Around 250 words.

Paragraph 1: describe the subject property, including its visual profile if provided (overall condition, kitchen, bathroom, land quality, notable features like pool or main-road exposure). Summarise the CMA fair value, comparables count, and whether the spread is tight or wide.

Paragraph 2: comment on the COMPARABLE SET. Reference at least two specific comparables by street address and explain what they tell us — e.g. "a renovated single-storey on X Street sold for Y; a dated comparable on Z sold for less." Call out when the vision data shows meaningful differences between subject and comps (renovated kitchen vs dated, pool asymmetry, different landscaping tier). Do not invent condition data — only reference what's supplied in the Data section below.

Paragraph 3: explain the market context (cycle stage, growth, typical days on market vs actual) and the vendor assessment in plain language. Do NOT say "buyers agent" or "buyers agency". Do NOT tell the reader what to pay — describe the three numbers as information the reader can use.

Paragraph 4: walk through the three numbers (opening offer, target, walk-away max) and what each represents in negotiation terms. Close with a reminder that the reader makes the final decision.

Data:
- Subject: ${args.subject.fullAddress} (${args.subject.propertyType ?? 'House'}, ${args.subject.bedrooms ?? '?'}BR / ${args.subject.bathrooms ?? '?'}BA / ${args.subject.landAreaSqm ?? '?'}sqm land / ${args.subject.floorAreaSqm ?? '?'}sqm floor)
${subjectVisionLine}
- CMA fair value: $${args.cma.fairValue.toLocaleString()} (range $${args.cma.fairValueLow.toLocaleString()}-$${args.cma.fairValueHigh.toLocaleString()}, dispersion ${(args.cma.dispersion * 100).toFixed(1)}%)
- Comparables used: ${args.cma.comparables.length}
- Comparable set:
${compLines}
- Market: ${args.market.suburb} ${args.market.state}, cycle ${args.market.cycleStage}, 5y growth ${(args.market.annualisedGrowth5y * 100).toFixed(1)}%, typical DOM ${args.market.typicalDaysOnMarket}
- Actual DOM: ${args.actualDaysOnMarket ?? 'not provided'}
- Vendor: ${args.vendorAssessment.motivation} (confidence ${(args.vendorAssessment.confidence * 100).toFixed(0)}%) — ${args.vendorAssessment.rationale}
- Opening offer: $${args.maxPrice.openingOffer.toLocaleString()}
- Target: $${args.maxPrice.targetPrice.toLocaleString()}
- Walk-away max: $${args.maxPrice.walkAwayMax.toLocaleString()}`;

  try {
    const client = makeClient();
    // Per-call hard deadline so a single slow Anthropic response can
    // fail fast rather than burning the /api/narrative route's
    // function budget. 90 s is well above the ~15 s Sonnet 4.6
    // typically takes for a 250-word response on this prompt.
    const response = await client.messages.create(
      {
        model: model(),
        max_tokens: 1200,
        system: BRAND_RULES,
        messages: [{ role: 'user', content: prompt }],
      },
      { timeout: 90_000 },
    );

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    const tokenUsage: TokenUsage = {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
    };

    if (!text) return { text: fallbackNarrative(args), tokenUsage };
    return { text: sanitiseProhibitedTerms(text), tokenUsage };
  } catch (error) {
    console.warn(
      'generateNarrative LLM call failed; using fallback prose.',
      error,
    );
    return { text: fallbackNarrative(args) };
  }
}

function heuristicVendorAssessment(description: string): VendorAssessment {
  const lower = description.toLowerCase();
  const distressedCues = [
    'mortgagee in possession',
    'mortgagee sale',
    'receivers sale',
    'bank repossession',
    'bankruptcy',
    'urgent sale',
    'deceased estate',
  ];
  const motivatedCues = [
    'must sell',
    'all offers considered',
    'vendor says sell',
    'genuine vendor',
    'relocating',
    'relocation',
    'reduced price',
    'price reduced',
    'motivated vendor',
    'make an offer',
  ];

  const hits = (cues: string[]) => cues.filter((c) => lower.includes(c));
  const d = hits(distressedCues);
  if (d.length > 0) {
    return {
      motivation: 'Distressed',
      confidence: 0.75,
      rationale: `Listing text contains distressed-sale language (${d.join(', ')}).`,
      triggerPhrases: d,
      source: 'fallback',
    };
  }
  const m = hits(motivatedCues);
  if (m.length > 0) {
    return {
      motivation: 'Motivated',
      confidence: 0.6,
      rationale: `Listing text suggests a motivated vendor (${m.join(', ')}).`,
      triggerPhrases: m,
      source: 'fallback',
    };
  }
  return {
    motivation: 'Standard',
    confidence: 0.5,
    rationale: 'No explicit motivation signals detected in the listing copy.',
    triggerPhrases: [],
    source: 'fallback',
  };
}

function fallbackNarrative(args: {
  subject: PropertyDetails;
  market: MarketContext;
  cma: CMAResult;
  vendorAssessment: VendorAssessment;
  maxPrice: MaxPriceResult;
  actualDaysOnMarket?: number;
}): string {
  const { subject, market, cma, vendorAssessment, maxPrice } = args;
  const p1 = `${subject.fullAddress} is a ${subject.propertyType?.toLowerCase() ?? 'home'} with an indicative fair value around $${cma.fairValue.toLocaleString()}, drawn from ${cma.comparables.length} recent comparable sales in ${market.suburb}. The 25th–75th percentile of implied values runs $${cma.fairValueLow.toLocaleString()} to $${cma.fairValueHigh.toLocaleString()}.`;
  const p2 = `${market.suburb} is currently assessed as ${market.cycleStage.toLowerCase()}, with a five-year annualised growth rate of ${(market.annualisedGrowth5y * 100).toFixed(1)}% and a typical time on market of ${market.typicalDaysOnMarket} days. The vendor appears ${vendorAssessment.motivation.toLowerCase()} (${vendorAssessment.rationale}). These inputs feed into a negotiation framework rather than a price recommendation — PropSpotter does not tell clients what to pay.`;
  const p3 = `The three reference numbers are an opening offer of $${maxPrice.openingOffer.toLocaleString()} (a constructive starting point), a target of $${maxPrice.targetPrice.toLocaleString()} (a figure consistent with recent comparable evidence and vendor posture), and a walk-away max of $${maxPrice.walkAwayMax.toLocaleString()} (the ceiling at which you keep the deal defensible given the market cycle and property velocity). The final decision sits with you.`;
  return sanitiseProhibitedTerms(`${p1}\n\n${p2}\n\n${p3}`);
}

function sanitiseProhibitedTerms(text: string): string {
  return text
    .replace(/buyer'?s?\s+agency/gi, 'property advisory service')
    .replace(/buyer'?s?\s+agent/gi, 'property adviser');
}

function normaliseMotivation(raw: unknown): VendorMotivation {
  const s = String(raw ?? '').toLowerCase();
  if (s.startsWith('dist')) return 'Distressed';
  if (s.startsWith('motiv')) return 'Motivated';
  return 'Standard';
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}
