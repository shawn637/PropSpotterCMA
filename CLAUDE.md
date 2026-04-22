# CLAUDE.md — PropSpotter CMA App

Context for future Claude Code sessions working on this repo. Read this first.

## What this is

Public test deployment of an automated CMA (Comparable Market Analysis) and
max-price calculator for PropSpotter — an Australian property research and
advisory service. Shawn pastes an address, gets three negotiation reference
numbers (opening offer / target / walk-away max) and a branded PDF report.

## Non-negotiable terminology

- **Never** write "buyers agent", "buyer's agent", "buyers agency", or
  "buyer's agency" anywhere in the app, prompts, or reports.
  PropSpotter is **not** a buyers agent; it is a property research and
  advisory service. `lib/llm/vendor-motivation.ts` enforces this in the LLM
  system prompt and also post-sanitises the output; keep both.
- **Never** frame the three numbers as "what to pay" or "the right price."
  They are negotiation *reference* information. The client makes the
  decision.
- PropSpotter is **not** a licensed financial adviser. The disclaimer in
  `lib/pdf/report.tsx` and the page footer must remain.

## Three-numbers methodology

All in `lib/cma/maxprice.ts`.

```
walkAwayMax   = fairValue × (1 + cycleStretch + velocityStretch)  [floored at fairValue]
targetPrice   = fairValue × (1 + vendorLeverage)                  [capped at walkAwayMax]
openingOffer  = targetPrice × 0.94                                [rounded to nearest $100]
```

- `cycleStretch` is a lookup on HTAG's market-cycle stage:
  Recovery +1%, Rising +2.5%, Peaking 0%, Correction −2%.
- `velocityStretch` compares actual DOM to typical DOM.
  ratio ≤ 0.5 → +1%, < 0.8 → +0.5%, ≤ 1.2 → 0%, < 1.8 → −1%, ≥ 1.8 → −2%.
- `vendorLeverage` is a lookup on the LLM's vendor classification:
  Standard 0%, Motivated −5%, Distressed −10%.

All numbers rounded to the nearest $100. Do not change the rounding without
asking Shawn — the reports should look "Excel-clean."

## CMA math

All in `lib/cma/compute.ts`.

- Filter comparables to same suburb, ≤ 6 months old, same property type.
- **Size-mismatch filter** drops comps whose land OR floor area is >50%
  different from the subject (single-vs-double-storey outliers).
- Index each sale forward by `salePrice × (1 + growth × min(months, 12)/12)`
  — the 12-month cap prevents over-indexing stale sales.
- Apply HTAG's `htagAdjustmentFactor` if supplied, else a heuristic based
  on land size / floor area / bed / bath / carspaces / year built /
  (optional) Claude Vision attributes. Clamped to [0.7, 1.3].
- **Claude Vision leg** (optional): when the user pastes a façade photo
  URL for the subject and comps in the UI, `lib/llm/vision.ts` extracts
  storey count / construction material / condition / roof type per image.
  `deriveVisualAdjustment` in compute.ts factors those into the
  similarity multiplier (storey mismatch ±8%, material ±5%, condition
  ±8%). See also `app/api/vision/route.ts`.
- Fair value = median of implied values. Low = 25th pctile, High = 75th.
- Need ≥ 3 comparables after filtering; the route returns 422 if not.
- The UI lets the user **exclude** individual comps and the CMA +
  three-numbers recompute live in the browser by calling `computeCMA` /
  `computeMaxPrice` directly — both modules are pure so there's no
  server round-trip for refinement.

## Data flow

```
POST /api/cma
  → htag/client.ts: subject + comparables + market context
  → cma/compute.ts: CMA
  → llm/vendor-motivation.ts: vendor classification
  → cma/maxprice.ts: three numbers (uses vendor + cycle + DOM)
  → llm/vendor-motivation.ts: narrative
  → FullValuationResult JSON

POST /api/pdf
  → @react-pdf/renderer.renderToBuffer(<ValuationReport data=...>)
  → application/pdf with Content-Disposition: attachment
```

## HTAG integration

`lib/htag/client.ts` is built against the HTAG OpenAPI spec v2.0.0. The
parse layer in `lib/htag/parse.ts` is pure and tested — run `npm test`
for 32 fixture-backed assertions before deploying any change. Endpoints:

- `GET /v1/address/geocode` — canonical identity + loc_pid
- `GET /v1/property/summary` — physical attributes (optional, may 404)
- `GET /v1/property/sold/search` — comparables (proximity=sameSuburb,
  last 6 months, limit 12)
- `GET /v1/markets/{summary,growth/annualised,cycle,demand}` — all
  keyed off `level=suburb&area_id=<loc_pid>`

Auth is `x-api-key` header only. Base URL defaults to
`https://api.htagai.com` (override with `HTAG_API_BASE_URL` for dev).

When debugging a 502 from `/api/cma`, hit `/api/htag-debug` first — it
probes all seven endpoints and returns raw bodies, which maps 1:1 to
the parser shapes in `parse.ts`.

## Auth

`middleware.ts` is an HTTP Basic auth gate reading `APP_PASSWORD` from env.
If the env var is unset, the gate is disabled (do not deploy that way).
Username is not checked — only password. The browser's native auth dialog
is the login UI.

## Environment variables

Required in production:

- `ANTHROPIC_API_KEY` — needed for vendor classification and narrative.
- `APP_PASSWORD` — shared password gate.

Optional:

- `CLAUDE_MODEL` — defaults to `claude-sonnet-4-6`.
- `MOCK_DATA` — defaults to `true`. Set to `false` to use live HTAG.
- `HTAG_API_KEY`, `HTAG_API_BASE_URL` — only read when `MOCK_DATA=false`.

## LLM guidance

- Default model is `claude-sonnet-4-6`. The SDK method is
  `client.messages.create()` (no `.beta.`).
- Three call sites:
  - `lib/llm/vendor-motivation.ts` → classifies listing copy into
    Standard/Motivated/Distressed via forced tool use.
  - `lib/llm/vendor-motivation.ts` → writes the narrative paragraph for
    the PDF.
  - `lib/llm/vision.ts` → Claude Vision on façade photos; extracts
    storeys / construction material / condition / roof type via forced
    tool use (tool name `classify_property_facade`). Images are fetched
    server-side and base64-encoded before send because SDK 0.30 doesn't
    yet type URL image sources.
- Both classification calls have hard-coded fallbacks (heuristic keyword
  matcher for vendor; `attrs: null` for vision). The app must produce a
  valid report even without an Anthropic key.
- System prompts start with a BRAND_RULES block forbidding the prohibited
  terminology. Keep that prefix stable — it is where prompt caching will
  take effect once the prompt grows past ~2k tokens.

## What not to do

- Do not add `temperature`, `top_p`, or `top_k` unless the target model is
  Sonnet 4.6 or older and there's a specific reason. Opus 4.7 rejects them
  with 400.
- Do not use `budget_tokens` — adaptive thinking (`{type: "adaptive"}`) is
  the pattern on 4.6 and later. Sonnet 4.6 without thinking is plenty for
  these tasks.
- Do not persist or log PII (addresses, listing text). This app is
  stateless by design.
- Do not push to any branch other than
  `claude/propspotter-cma-handoff-3DqgE` without Shawn's explicit consent.

## Verifying a build locally

```
npm install
npx tsc --noEmit
npm run build
```

A clean production build should report two dynamic API routes
(`/api/cma`, `/api/pdf`) and one static home page.
