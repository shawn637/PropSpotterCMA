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
- **Claude Vision leg** (optional but auto-fired when Apify is configured):
  `lib/llm/vision.ts` runs ONE multi-image Claude call per listing,
  feeding up to 10 photos (façade + kitchen + bathroom + living +
  backyard + grounds) so the model synthesises across the full gallery
  rather than classifying a single street shot. The tool schema
  captures storeys, construction material, overall condition, kitchen
  condition, bathroom condition, land quality (neglected → premium),
  backyard size, plus a feature tag list (pool, view, renovation,
  main_road, near_powerlines, mature_trees, etc.). See
  `app/api/vision/route.ts` for batching and
  `deriveVisualAdjustment` in compute.ts for the scoring: storey ±7%,
  material ±4%, overall condition ±6%, kitchen ±6%, bathroom ±4%, land
  quality ±4%, backyard size ±3%, feature stack ±6%, overall clamp
  [0.80, 1.20]. Cost is ~$0.05 per listing (~$0.50 per valuation with
  10 comps + subject).
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

## ABS Census tenure integration

`lib/abs/client.ts` + `lib/abs/parse.ts` wrap the ABS 2021 Census G37
FeatureServer (Tenure and Landlord Type). We query layer 5 (SA1 — the
finest ABS geographic unit, ~200-800 people) with a point-in-polygon
spatial query using the subject's lat/lng from HTAG geocode, and
compute three headline shares: owner-occupier, private rental, public
housing. Plus a residual `otherPct` for the not-stated / rent-free
categories.

No auth required (public ArcGIS service). 5 s timeout. Fires in
parallel with HTAG comparables + market context in `/api/cma` via
Promise.all; a failing ABS call yields `tenureProfile: null` and the
valuation renders normally without the tenure card. The narrative
prompt includes the tenure line so the writer can interpret what the
mix signals about the pocket (stable family-dominated vs investor-
heavy vs meaningful public-housing exposure).

Depends on `subject.latitude` / `subject.longitude` being populated.
HTAG geocode returns coords for most addresses; when it doesn't, the
tenure leg no-ops cleanly.

## ABS SEIFA + G02 enrichment (Release 1 of the investment-tool plan)

`lib/abs/seifa.ts` and `lib/abs/g02.ts` mirror the G37 pattern
against two additional ABS ArcGIS services at SA1 granularity. All
three fire in parallel from `/api/cma` and are independently wrapped
so any single ABS service being slow or schema-drifted can't break
the valuation.

- **SEIFA** (`services-ap1` host, `/FeatureServer/0`, single-layer
  service already scoped to SA1 by name). Returns IRSD, IRSAD, IER,
  IEO scores + national deciles. UI renders colour-coded deciles
  (red 1-3, amber 4, teal 8-10); narrative prompt instructs the
  writer to call out IRSAD/IEO divergence as a gentrification
  signal.
- **G02** (`services1` host, `/FeatureServer/5` like G37). Surfaces
  median age, median personal / household income weekly, median rent
  weekly, median mortgage monthly, average household size. Used in
  the narrative to cross-check affordability.

Diagnostic: `/api/abs-debug?address=...` fires all three legs in
parallel and returns each profile + per-leg error, so schema drift
is diagnosable in one request.

Log tags: `abs-seifa`, `abs-g02` (alongside existing `abs-g37`).

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
- `APIFY_API_TOKEN`, `APIFY_ACTOR_ID` — power the "Auto-fetch photos"
  button. The actor is a realestate.com.au sold-listing scraper;
  `lib/apify/match.ts` matches scraped rows to HTAG comps by address
  (with a price+date fallback), and the main photo URL is then fed
  into the Claude Vision pass. Leave `APIFY_API_TOKEN` unset to
  disable auto-fetch — manual URL paste still works.

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
