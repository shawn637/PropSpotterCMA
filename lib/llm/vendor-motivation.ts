import Anthropic from '@anthropic-ai/sdk';

import type {
  CMAResult,
  MarketContext,
  MaxPriceResult,
  PropertyDetails,
  VendorAssessment,
  VendorMotivation,
} from '@/lib/types';

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

  const prompt = `${BRAND_RULES}

Write a 2-3 paragraph narrative (plain prose, no headings, no bullet lists, no markdown) for a PropSpotter CMA report. Tone: professional, direct, educational. Around 180 words.

Paragraph 1: describe the subject property and summarise the CMA fair value. Mention the comparables count and whether the spread is tight or wide.

Paragraph 2: explain the market context (cycle stage, growth, typical days on market vs actual) and the vendor assessment in plain language. Do NOT say "buyers agent" or "buyers agency". Do NOT tell the reader what to pay — describe the three numbers as information the reader can use.

Paragraph 3: walk through the three numbers (opening offer, target, walk-away max) and what each represents in negotiation terms. Close with a reminder that the reader makes the final decision.

Data:
- Subject: ${args.subject.fullAddress} (${args.subject.propertyType ?? 'House'}, ${args.subject.bedrooms ?? '?'}BR / ${args.subject.bathrooms ?? '?'}BA / ${args.subject.landAreaSqm ?? '?'}sqm)
- CMA fair value: $${args.cma.fairValue.toLocaleString()} (range $${args.cma.fairValueLow.toLocaleString()}-$${args.cma.fairValueHigh.toLocaleString()}, dispersion ${(args.cma.dispersion * 100).toFixed(1)}%)
- Comparables used: ${args.cma.comparables.length}
- Market: ${args.market.suburb} ${args.market.state}, cycle ${args.market.cycleStage}, 5y growth ${(args.market.annualisedGrowth5y * 100).toFixed(1)}%, typical DOM ${args.market.typicalDaysOnMarket}
- Actual DOM: ${args.actualDaysOnMarket ?? 'not provided'}
- Vendor: ${args.vendorAssessment.motivation} (confidence ${(args.vendorAssessment.confidence * 100).toFixed(0)}%) — ${args.vendorAssessment.rationale}
- Opening offer: $${args.maxPrice.openingOffer.toLocaleString()}
- Target: $${args.maxPrice.targetPrice.toLocaleString()}
- Walk-away max: $${args.maxPrice.walkAwayMax.toLocaleString()}`;

  try {
    const client = makeClient();
    const response = await client.messages.create({
      model: model(),
      max_tokens: 800,
      system: BRAND_RULES,
      messages: [{ role: 'user', content: prompt }],
    });

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
