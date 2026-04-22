import Anthropic from '@anthropic-ai/sdk';

import type {
  BackyardSize,
  ConditionGrade,
  ConstructionMaterial,
  LandQuality,
  RoofType,
  RoomCondition,
  StoreyCount,
  VisionAttributes,
  VisualFeature,
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

Your task: classify the physical attributes of a residential property from the COMPLETE set of listing photos provided — façade, kitchen, bathroom, living areas, backyard, grounds, and any other visible rooms or features. Synthesise across all photos. A single photo is never enough; weigh every image before deciding.

Return one tool call with your best assessment. Use 'unknown' when a feature is visible but ambiguous, and 'not_visible' for room-specific fields when no photo of that room was included. "unknown" and "not_visible" are first-class values — unconfident guesses are worse than no guess.

Field definitions:

- storeys:
  * single       — one main living level above ground
  * double       — two main living levels (standard Australian two-storey)
  * multi        — three or more levels
  * unknown      — can't tell from the set of photos

- construction_material (primary external wall material, from façade/grounds shots):
  * brick        — face brick, brick veneer
  * render       — rendered / painted masonry (Hebel, painted brick)
  * weatherboard — timber cladding
  * fibro        — fibre-cement sheeting (older post-war stock)
  * mixed        — two or more of the above across the elevation
  * unknown      — can't tell

- condition_grade (OVERALL condition synthesised across façade, kitchen, bathroom, living, grounds — not just the façade):
  * new          — obviously new construction, pristine finishes throughout
  * renovated    — recent update evident (modern kitchen/bathroom, fresh paint, landscaping)
  * average      — maintained, neither new nor tired
  * poor         — visible deterioration or dated finishes in multiple areas
  * unknown      — insufficient photos to judge

- kitchen_condition (condition of the KITCHEN specifically, from kitchen photos):
  * new / renovated / average / poor — same scale as condition_grade
  * unknown      — kitchen visible but ambiguous
  * not_visible  — no kitchen photo provided

- bathroom_condition (condition of the BATHROOM specifically):
  * new / renovated / average / poor — same scale
  * unknown      — bathroom visible but ambiguous
  * not_visible  — no bathroom photo provided

- land_quality (grounds / garden / yard, from exterior shots):
  * neglected    — bare dirt, dead lawn, no landscaping
  * basic        — functional lawn, minimal beds, basic fencing
  * landscaped   — established garden beds, healthy lawn, decent fencing
  * premium      — manicured, mature trees, designer landscaping, entertaining areas
  * unknown      — no exterior / yard shots

- backyard_size (relative size of usable backyard):
  * none         — essentially no backyard (townhouse / courtyard)
  * small        — small courtyard or kids' play area
  * medium       — standard suburban backyard
  * large        — generous backyard / acreage feel
  * unknown      — not pictured

- features: array of short tags for anything notable that affects value. Only include tags you are reasonably confident about. Use these exact strings:
  pool, view, renovation, modern_kitchen, modern_bathroom, outdoor_entertaining,
  fireplace, solar, air_conditioning, granny_flat, corner_block, main_road,
  near_powerlines, mature_trees

- roof_type:
  * tile         — concrete or terracotta tiles
  * metal        — Colorbond / corrugated sheet
  * unknown      — not visible

- notes: one or two short sentences flagging anything unusual that the structured fields don't capture (e.g. "heritage frontage", "recent second-storey addition", "pool needs resurfacing", "outdated but structurally sound"). Under 40 words.`;

const VISION_TOOL: Anthropic.Tool = {
  name: 'classify_property_facade',
  description:
    'Record your classification of the property shown across ALL provided listing photos. Always call this tool; do not respond with prose.',
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
      kitchen_condition: {
        type: 'string',
        enum: ['new', 'renovated', 'average', 'poor', 'unknown', 'not_visible'],
      },
      bathroom_condition: {
        type: 'string',
        enum: ['new', 'renovated', 'average', 'poor', 'unknown', 'not_visible'],
      },
      land_quality: {
        type: 'string',
        enum: ['neglected', 'basic', 'landscaped', 'premium', 'unknown'],
      },
      backyard_size: {
        type: 'string',
        enum: ['none', 'small', 'medium', 'large', 'unknown'],
      },
      features: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'pool',
            'view',
            'renovation',
            'modern_kitchen',
            'modern_bathroom',
            'outdoor_entertaining',
            'fireplace',
            'solar',
            'air_conditioning',
            'granny_flat',
            'corner_block',
            'main_road',
            'near_powerlines',
            'mature_trees',
          ],
        },
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
      'kitchen_condition',
      'bathroom_condition',
      'land_quality',
      'backyard_size',
      'features',
      'roof_type',
      'notes',
    ],
  },
};

export interface AnalyzeListingResult {
  attrs: VisionAttributes | null;
  error?: string;
  tokenUsage?: { input: number; output: number };
  /** How many of the submitted URLs we actually sent to Claude (fetches can fail per image). */
  imagesSent?: number;
}

/** Max images to send per listing. Cap protects token spend; 10 is
 *  enough to see hero + kitchen + bathroom + at least one other interior
 *  + backyard + street on a typical REA listing. */
const MAX_VISION_IMAGES_PER_CALL = 10;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB — Anthropic's per-image limit
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Run Claude Vision on the full set of photos for ONE listing — subject
 * or comparable. The model synthesises across every image in the set
 * so the resulting VisionAttributes reflects kitchen + bathroom +
 * grounds, not just the façade. Returns { attrs: null, error } if the
 * call failed (all images unreachable, Anthropic outage, malformed
 * tool_use).
 */
export async function analyzeListing(
  imageUrls: string[],
): Promise<AnalyzeListingResult> {
  if (!hasApiKey()) {
    return { attrs: null, error: 'ANTHROPIC_API_KEY not set' };
  }
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    return { attrs: null, error: 'imageUrls must be a non-empty array' };
  }

  // Deduplicate and cap.
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const u of imageUrls) {
    if (typeof u !== 'string' || !/^https?:\/\//i.test(u)) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    deduped.push(u);
    if (deduped.length >= MAX_VISION_IMAGES_PER_CALL) break;
  }
  if (deduped.length === 0) {
    return { attrs: null, error: 'no valid http(s) image URLs supplied' };
  }

  // Fetch all images in parallel. Individual failures are tolerated —
  // as long as AT LEAST ONE image makes it through, the Vision call
  // still runs (just on a smaller set).
  const fetched = await Promise.all(
    deduped.map(async (url) => {
      try {
        const img = await fetchImage(url);
        return { url, ...img };
      } catch {
        return null;
      }
    }),
  );
  const usable = fetched.filter(
    (f): f is { url: string; base64: string; mediaType: ImageMediaType } =>
      f !== null,
  );
  if (usable.length === 0) {
    return {
      attrs: null,
      error: 'could not fetch any of the supplied image URLs',
    };
  }

  try {
    const client = makeClient();
    const imageBlocks: Anthropic.ImageBlockParam[] = usable.map((u) => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: u.mediaType,
        data: u.base64,
      },
    }));
    const response = await client.messages.create({
      model: model(),
      max_tokens: 1200,
      system: VISION_SYSTEM_PROMPT,
      tools: [VISION_TOOL],
      tool_choice: { type: 'tool', name: VISION_TOOL.name },
      messages: [
        {
          role: 'user',
          content: [
            ...imageBlocks,
            {
              type: 'text',
              text: `Classify this property using all ${usable.length} listing photo(s) above. Synthesise across every image — do not over-weight any single shot. Respond with one tool call.`,
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
      return {
        attrs: null,
        error: 'no tool_use block in response',
        tokenUsage,
        imagesSent: usable.length,
      };
    }

    const input = toolUse.input as Record<string, unknown>;
    const attrs: VisionAttributes = {
      storeys: normaliseStoreys(input.storeys),
      constructionMaterial: normaliseMaterial(input.construction_material),
      conditionGrade: normaliseCondition(input.condition_grade),
      kitchenCondition: normaliseRoomCondition(input.kitchen_condition),
      bathroomCondition: normaliseRoomCondition(input.bathroom_condition),
      landQuality: normaliseLandQuality(input.land_quality),
      backyardSize: normaliseBackyardSize(input.backyard_size),
      features: normaliseFeatures(input.features),
      roofType: normaliseRoof(input.roof_type),
      notes:
        typeof input.notes === 'string'
          ? input.notes.trim().slice(0, 400)
          : '',
      imageUrls: usable.map((u) => u.url),
    };
    return { attrs, tokenUsage, imagesSent: usable.length };
  } catch (err) {
    return {
      attrs: null,
      error: err instanceof Error ? err.message : String(err),
      imagesSent: usable.length,
    };
  }
}

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

async function fetchImage(imageUrl: string): Promise<{
  base64: string;
  mediaType: ImageMediaType;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(imageUrl, {
      signal: controller.signal,
      headers: {
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
): ImageMediaType | null {
  if (contentType.includes('jpeg') || contentType.includes('jpg'))
    return 'image/jpeg';
  if (contentType.includes('png')) return 'image/png';
  if (contentType.includes('gif')) return 'image/gif';
  if (contentType.includes('webp')) return 'image/webp';
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

function normaliseRoomCondition(raw: unknown): RoomCondition {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'not_visible') return 'not_visible';
  return normaliseCondition(s);
}

function normaliseLandQuality(raw: unknown): LandQuality {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'neglected' || s === 'basic' || s === 'landscaped' || s === 'premium')
    return s;
  return 'unknown';
}

function normaliseBackyardSize(raw: unknown): BackyardSize {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'none' || s === 'small' || s === 'medium' || s === 'large') return s;
  return 'unknown';
}

const FEATURE_WHITELIST: ReadonlySet<VisualFeature> = new Set<VisualFeature>([
  'pool',
  'view',
  'renovation',
  'modern_kitchen',
  'modern_bathroom',
  'outdoor_entertaining',
  'fireplace',
  'solar',
  'air_conditioning',
  'granny_flat',
  'corner_block',
  'main_road',
  'near_powerlines',
  'mature_trees',
]);

function normaliseFeatures(raw: unknown): VisualFeature[] {
  if (!Array.isArray(raw)) return [];
  const out: VisualFeature[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const s = String(r ?? '').toLowerCase();
    if (!FEATURE_WHITELIST.has(s as VisualFeature)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s as VisualFeature);
  }
  return out;
}

function normaliseRoof(raw: unknown): RoofType {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'tile' || s === 'metal') return s;
  return 'unknown';
}

/**
 * Back-compat shim — older callers passed a single imageUrl. Just wrap
 * and delegate.
 */
export async function analyzeFacade(
  imageUrl: string,
): Promise<AnalyzeListingResult> {
  return analyzeListing([imageUrl]);
}
