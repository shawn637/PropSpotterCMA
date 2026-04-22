import Anthropic from '@anthropic-ai/sdk';

import type {
  ConditionGrade,
  ConstructionMaterial,
  RoofType,
  StoreyCount,
  VisionAttributes,
} from '@/lib/types';

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
PropSpotter provides research, comparable market analysis, and educational tools; clients make their own decisions.`;

const VISION_SYSTEM_PROMPT = `${BRAND_RULES}

Your task: classify the physical attributes of a residential property from a single listing photo.

Return one tool call with your best assessment. When the façade is not
clearly visible, the angle is wrong, or the image shows only the interior,
use 'unknown' for that field rather than guessing. "unknown" is a first-
class value — unconfident guesses are worse than no guess.

Field definitions:

- storeys:
  * single       — one main living level above ground
  * double       — two main living levels (standard Australian two-storey)
  * multi        — three or more levels (rare for freestanding houses)
  * unknown      — can't tell from this angle (e.g. interior-only photo)

- construction_material (primary external wall material):
  * brick        — face brick, brick veneer
  * render       — rendered / painted masonry (Hebel, painted brick)
  * weatherboard — timber cladding (horizontal boards)
  * fibro        — fibre-cement sheeting (older post-war stock)
  * mixed        — two or more of the above across the main elevation
  * unknown      — can't tell

- condition_grade:
  * new          — obviously new construction, pristine finishes
  * renovated    — recent update evident (modern windows, paint, landscaping)
  * average      — maintained, neither new nor tired
  * poor         — visible deterioration, dated finishes, needs work
  * unknown      — can't tell

- roof_type:
  * tile         — concrete or terracotta tiles
  * metal        — Colorbond / corrugated sheet
  * unknown      — not visible

- notes: one short sentence flagging anything unusual (e.g. "heritage
  frontage", "recent second-storey addition", "corner block"). Keep under
  20 words.`;

const VISION_TOOL: Anthropic.Tool = {
  name: 'classify_property_facade',
  description:
    'Record your classification of the property shown in the photo. Always call this tool; do not respond with prose.',
  input_schema: {
    type: 'object',
    properties: {
      storeys: {
        type: 'string',
        enum: ['single', 'double', 'multi', 'unknown'],
      },
      construction_material: {
        type: 'string',
        enum: ['brick', 'render', 'weatherboard', 'fibro', 'mixed', 'unknown'],
      },
      condition_grade: {
        type: 'string',
        enum: ['new', 'renovated', 'average', 'poor', 'unknown'],
      },
      roof_type: {
        type: 'string',
        enum: ['tile', 'metal', 'unknown'],
      },
      notes: { type: 'string' },
    },
    required: [
      'storeys',
      'construction_material',
      'condition_grade',
      'roof_type',
      'notes',
    ],
  },
};

export interface AnalyzeFacadeResult {
  attrs: VisionAttributes | null;
  error?: string;
  tokenUsage?: { input: number; output: number };
}

/**
 * Run Claude Vision on a single listing photo URL. Returns structured
 * VisionAttributes via forced tool use, or { attrs: null, error } if
 * the call failed (bad URL, Anthropic outage, malformed tool_use).
 *
 * Idempotent and pure-ish: same URL + same model gives the same answer
 * within any single call, though vision classifications are not
 * deterministic across calls (they're temperature-sampled).
 */
export async function analyzeFacade(
  imageUrl: string,
): Promise<AnalyzeFacadeResult> {
  if (!hasApiKey()) {
    return { attrs: null, error: 'ANTHROPIC_API_KEY not set' };
  }
  if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) {
    return { attrs: null, error: 'imageUrl must be an http(s) URL' };
  }

  let imageBase64: string;
  let mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  try {
    const fetched = await fetchImage(imageUrl);
    imageBase64 = fetched.base64;
    mediaType = fetched.mediaType;
  } catch (err) {
    return {
      attrs: null,
      error: `could not fetch image: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const client = makeClient();
    const response = await client.messages.create({
      model: model(),
      max_tokens: 800,
      system: VISION_SYSTEM_PROMPT,
      tools: [VISION_TOOL],
      tool_choice: { type: 'tool', name: VISION_TOOL.name },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: imageBase64,
              },
            },
            {
              type: 'text',
              text: 'Classify the property shown in this listing photo.',
            },
          ],
        },
      ],
    });

    const tokenUsage = {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
    };

    const toolUse = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    if (!toolUse) {
      return { attrs: null, error: 'no tool_use block in response', tokenUsage };
    }

    const input = toolUse.input as Record<string, unknown>;
    const attrs: VisionAttributes = {
      storeys: normaliseStoreys(input.storeys),
      constructionMaterial: normaliseMaterial(input.construction_material),
      conditionGrade: normaliseCondition(input.condition_grade),
      roofType: normaliseRoof(input.roof_type),
      notes:
        typeof input.notes === 'string'
          ? input.notes.trim().slice(0, 400)
          : '',
      imageUrl,
    };
    return { attrs, tokenUsage };
  } catch (err) {
    return {
      attrs: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB — Anthropic's per-image limit
const FETCH_TIMEOUT_MS = 10_000;

async function fetchImage(imageUrl: string): Promise<{
  base64: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(imageUrl, {
      signal: controller.signal,
      headers: {
        // Some listing CDNs reject fetches without a browser-like UA.
        'User-Agent':
          'Mozilla/5.0 PropSpotterCMA/1.0 (+https://propspotter.com.au)',
      },
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`upstream ${res.status} ${res.statusText}`);
  }
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  const mediaType = inferMediaType(contentType, imageUrl);
  if (!mediaType) {
    throw new Error(`unsupported media type: ${contentType || 'unknown'}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `image too large (${buf.byteLength} > ${MAX_IMAGE_BYTES} bytes)`,
    );
  }
  return { base64: buf.toString('base64'), mediaType };
}

function inferMediaType(
  contentType: string,
  url: string,
):
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp'
  | null {
  if (contentType.includes('jpeg') || contentType.includes('jpg'))
    return 'image/jpeg';
  if (contentType.includes('png')) return 'image/png';
  if (contentType.includes('gif')) return 'image/gif';
  if (contentType.includes('webp')) return 'image/webp';
  // Fall back to extension-based sniff when the CDN doesn't set a
  // useful content-type.
  const lower = url.toLowerCase().split('?')[0];
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  return null;
}

function normaliseStoreys(raw: unknown): StoreyCount {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'single' || s === 'double' || s === 'multi') return s;
  return 'unknown';
}

function normaliseMaterial(raw: unknown): ConstructionMaterial {
  const s = String(raw ?? '').toLowerCase();
  if (
    s === 'brick' ||
    s === 'render' ||
    s === 'weatherboard' ||
    s === 'fibro' ||
    s === 'mixed'
  )
    return s;
  return 'unknown';
}

function normaliseCondition(raw: unknown): ConditionGrade {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'new' || s === 'renovated' || s === 'average' || s === 'poor')
    return s;
  return 'unknown';
}

function normaliseRoof(raw: unknown): RoofType {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'tile' || s === 'metal') return s;
  return 'unknown';
}
