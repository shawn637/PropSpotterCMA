# Deployment & Lock-Down Checklist

Deployment and hardening steps for the PropSpotter CMA app. Roughly the spec's Phase 1–4, reordered so every manual console step is paired with the code-side change it depends on.

---

## Phase 1 — First deploy (mock data only)

Before any HTAG integration. Default `MOCK_DATA=true` means the app produces the Baulkham Hills sample for any address, which is all you need to validate the deploy end-to-end.

1. **Link the project to Vercel.**
   ```
   npm i -g vercel      # once per machine
   vercel                # from the repo root; accept defaults
   ```
2. **Set Anthropic key.**
   - Vercel dashboard → Project → Settings → Environment Variables
   - Add `ANTHROPIC_API_KEY` for Production + Preview + Development, value from <https://console.anthropic.com>.
3. **Set the password gate** (see §Phase 2 below — do not skip, the middleware refuses to serve Vercel production without it).
4. **Deploy.**
   ```
   vercel --prod
   ```
5. **Smoke test.**
   - Hit the production URL, enter the shared password at the Basic auth prompt (any username, the password you set).
   - Submit any address. Expect three numbers roughly $494k / $526k / $544k (mock-data fairValue is $525,800; walk-away stretches with actual DOM).
   - Click Download PDF; confirm it downloads with a branded one-page report and the amber DEMO MODE banner.
   - In Vercel dashboard → project → Logs, confirm no errors on either API route.

Anything goes wrong: redeploy with `vercel --prod` after fixing env vars (existing deployments don't pick up env changes automatically).

---

## Phase 2 — Lock down before sharing

These are the steps from the spec's Phase 2. Some are already done in code; the rest are Vercel / Anthropic console actions that only you can do.

### 2.1 Password gate (code: DONE)

The HTTP Basic auth gate lives in `middleware.ts` and triggers whenever `APP_PASSWORD` is set. To activate:

1. Generate a long random password. E.g.
   ```
   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
   ```
2. Vercel dashboard → Project → Settings → Environment Variables → add `APP_PASSWORD` (Production + Preview + Development).
3. Redeploy (`vercel --prod`). Env changes don't apply to existing deployments.
4. Test: visit the URL; browser prompts for credentials. Username can be anything (e.g. `propspotter`); password is the string you set.

Safety rail: on Vercel production, if `APP_PASSWORD` is unset the middleware returns **503 "This deployment is not configured"** instead of letting the URL through. You can't accidentally ship without the gate.

Logging out: HTTP Basic auth is session-scoped to the browser. To log a tester out, have them clear the site's credentials (Chrome → Settings → Privacy → Site Settings → specific site → permissions) or close the browser.

### 2.2 Rate limiting (code: DONE)

`lib/ratelimit.ts` applies a per-IP fixed-window limit to `/api/cma` and `/api/pdf`. Default 20 requests/minute per IP. Tune via `RATE_LIMIT_PER_MINUTE` env var.

This is a **safety rail against accidents**, not a DoS defense. It's in-memory per serverless instance, so a cold start resets the counter and horizontally-scaled instances each get their own. Upgrade to `@upstash/ratelimit` + Vercel KV when real traffic justifies the setup.

### 2.3 robots.txt (code: DONE)

`public/robots.txt` disallows all user-agents. The middleware also adds `X-Robots-Tag: noindex, nofollow` on every response. Layered — search engines honouring either will skip the URL. This is not access control; it's only for not showing up in Google results.

### 2.4 Anthropic spend cap (MANUAL — do this before the first external test)

1. Open <https://console.anthropic.com> → Settings → Billing.
2. Set a monthly spend limit. **Suggest $50** while testing on Sonnet 4.6.
   - Back-of-envelope: a single valuation uses roughly 2–5k input tokens + ~1k output across the two LLM calls (vendor classification + narrative). At Sonnet 4.6 pricing ($3/$15 per 1M) that's on the order of 3–5 US cents per valuation. $50 covers ~1000 reports.
3. Optionally set an email alert at 50% so you see the ramp coming.

### 2.5 Vercel usage alerts (MANUAL, optional)

Vercel Pro → Usage → set a soft cap. Function invocations and bandwidth are the line items to watch.

---

## Phase 3 — Wire up live HTAG data

The client is now built against the official HTAG OpenAPI spec (v2.0.0) — endpoint paths, HTTP methods, query parameters, and response shapes all match the spec. The parse layer is covered by 32 unit tests (`npm test`) driven from fixtures taken from the spec examples, so the path is proven before deploy.

Endpoints consumed:

| Endpoint | Method | Purpose | Tier |
|---|---|---|---|
| `/v1/address/geocode` | GET | Resolve address → `address_key`, `loc_pid`, locality | Standard |
| `/v1/property/summary` | GET | Physical attributes (beds/baths/lot size) | Enhanced |
| `/v1/property/sold/search` | GET | Comparable sold properties (up to 12, same suburb, last 6 months) | Enhanced |
| `/v1/markets/summary` | GET | `typical_price` | Standard |
| `/v1/markets/growth/annualised` | GET | `price_5y_growth_annualised` for indexing | Enhanced |
| `/v1/markets/cycle` | GET | `growth_rate_cycle` for the cycle stretch | Premium |
| `/v1/markets/demand` | GET | `dom` for the velocity stretch | Enhanced |

Each valuation is ~7 HTAG calls. Property summary is allowed to 404 (not every address has attributes) — the CMA still works without them.

### 3.1 Turn on live mode

1. **Credentials.** Add to Vercel env vars:
   ```
   HTAG_API_KEY=<from HTAG Developer Portal>
   MOCK_DATA=false
   ```
   `HTAG_API_BASE_URL` defaults to `https://api.htagai.com` — override only if you want the dev server (`https://api.dev.htagai.com`).
2. **Redeploy.** `vercel --prod`. Env changes don't apply to existing deployments.

### 3.2 Smoke test the live pipeline

1. **Tail function logs** in Vercel → Logs → filter to `/api/cma`. Every HTAG call emits one structured log line (`{"tag":"htag","method":"GET","path":"...","status":200,"ms":142,"keys":[...]}`) so you can spot which endpoint is slow or returning unexpected shapes.
2. **Hit the full pipeline via the UI** with a real Sydney or regional NSW address you know (e.g. Baulkham Hills, Stanhope Gardens, Orange). Expect ≥ 3 comparable sales and a fair value in the right ballpark for the suburb.
3. **Sanity check the three numbers.** If `fairValue` is wildly off vs your Excel tool, suspect either:
   - `annualisedGrowth5y` denomination — the parser auto-scales values with `|v| > 1` by /100, so either form (`0.072` or `7.2`) works.
   - Comparables outside the target suburb — we pass `proximity=sameSuburb` but inspect `cma.comparables[].fullAddress` in the JSON response if the fair value looks surprising.

### 3.3 If things break

| Response | What to check |
|---|---|
| `502 HTAG upstream failed at /v1/...` | One endpoint returned an unexpected shape. Hit `/api/htag-debug` to see the raw response. Usually a field-name mismatch — fix in `lib/htag/parse.ts` and add a regression test. |
| `422 Not enough recent comparable sales` | HTAG returned fewer than 3 sold properties in `sameSuburb` within 6 months. In `lib/htag/client.ts`'s `getComparables`, loosen `proximity` to `any` with `radius: 2`, or extend `saleFromDate` to 12 months back. |
| Plausibly wrong cycle stage | `mapCycleString` in `parse.ts` handles common synonyms (Recovery/Rising/Peaking/Correction and standard economic terms). If HTAG returns something unexpected it'll default to `Peaking` (0% stretch). Add the string to the matcher + test fixture. |

### 3.4 The `/api/htag-debug` probe

Still available if a specific endpoint misbehaves. Probes all seven endpoints sequentially and returns raw response bodies, top-level keys, status codes, and elapsed times. Use it whenever a 502 comes back from `/api/cma`:

```bash
curl -u any:"$APP_PASSWORD" -X POST https://<your-deploy>/api/htag-debug \
  -H 'Content-Type: application/json' \
  -d '{"address":"413 Anson Street, Orange NSW 2800"}' | jq
```

Behind the password middleware. Leaks the real HTAG response shape to anyone with the password — fine for this test deployment; wrap in a separate `ENABLE_DEBUG=true` env var before ever sharing the password wider.

---

## Phase 4 — Harden for real traffic

### 4.1 HTAG request timeout (DONE)

`HTAG_TIMEOUT_MS` (default 10000) caps every HTAG call with an `AbortController`. Prevents one slow endpoint from consuming the whole 30-second function budget before the LLM calls even start. If real HTAG is slow, raise this, but keep it well under `maxDuration: 30` so the two LLM calls still have room.

### 4.2 Richer mock fixtures (DONE)

`lib/htag/mock.ts` now ships three profiles, routed by address substring so you can smoke-test different market shapes with zero HTAG setup:

| Address contains… | Profile | Cycle | Fair value (mock) |
|---|---|---|---|
| `"Baulkham"` (default) | NSW231 Baulkham Hills | Rising | ~$526k |
| `"Stanhope"` | NSW3682 Stanhope Gardens | Peaking | ~$1.16M |
| `"Correction"` | NSWCORR Correction Springs | Correction | ~$720k |

Use them to verify cycle / velocity stretch behaviours before live HTAG is wired. The cycle=Correction profile also exercises the "walk-away floored at fair value" branch.

### 4.3 Per-valuation structured logging (DONE)

Each successful `/api/cma` response emits one `console.log` line with `tag: "valuation"` and the fields below — no PII (address omitted). Grep-friendly in Vercel Logs.

```jsonc
{
  "tag": "valuation",
  "dataSource": "live",
  "suburb": "Baulkham Hills",
  "state": "NSW",
  "locPid": "NSW231",
  "cycleStage": "Rising",
  "fairValue": 1234567,
  "dispersion": 0.042,
  "comparablesUsed": 8,
  "vendor": { "motivation": "Motivated", "source": "llm", "confidence": 0.6 },
  "numbers": { "opening": 1160000, "target": 1234567, "walkAway": 1271000 },
  "llmTokens": { "input": 850, "output": 142 },
  "actualDaysOnMarket": 19
}
```

HTAG calls separately emit `tag: "htag"` lines (endpoint / status / elapsed / response keys). Together these are enough to monitor volume, cost, and data quality.

### 4.4 Next.js CVE bump (DONE)

Next bumped to 14.2.35 (from 14.2.5). The original Dec-2025 advisory is patched.

There are still 4 high-severity npm audit findings that `npm audit fix --force` would only resolve by upgrading to Next 16, which is a breaking change we shouldn't take during hardening. All four are server-side DoS-style advisories:

| Advisory | Applicability to this app |
|---|---|
| Image Optimizer DoS via remotePatterns | Not applicable — we don't use `next/image` remote patterns. |
| HTTP request smuggling in rewrites | Not applicable — no rewrites configured. |
| `next/image` disk cache exhaustion | Not applicable — we don't use `next/image`. |
| RSC deserialization DoS + Server Components DoS | Low risk behind the password gate; attack surface is small. |

Track them but plan the Next 15/16 upgrade for a dedicated branch once the app is live and we've established usage patterns.

### 4.5 Deferred (do when real traffic justifies it)

- **Upstash + Vercel KV rate limiter.** `lib/ratelimit.ts` is in-memory: a cold start resets counters and horizontally-scaled instances each have their own. Swap to `@upstash/ratelimit` on `Ratelimit.slidingWindow` once the per-IP accidentals pattern shows up or real multi-instance scaling happens.
- **HTAG edge-case UX.** Currently: missing optional fields → heuristic adjustment handles gracefully (Phase 1); empty comparables → 422 (Phase 1); obscure suburb / missing market data → HtagError → 502 with endpoint (Phase 3). Consider converting "no market data" specifically into a user-friendly 422 with a suggested alternative.
- **Richer fixture types.** Current mocks are all Houses. Add Unit / Townhouse profiles once live HTAG proves those paths are exercised.
- **Long-term persistence.** If reports ever need to be retrievable, add a database. Until then the stateless model is intentional.

---

## Environment variable reference

| Variable | Required for | Default | Notes |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | all deploys | — | Vendor classification + narrative. If unset, app falls back to deterministic heuristic. |
| `APP_PASSWORD` | Vercel production | — | Middleware refuses to serve Vercel prod without it. |
| `MOCK_DATA` | anyone using live HTAG | `true` | Set to `false` to use `HTAG_API_KEY`. |
| `HTAG_API_KEY` | live HTAG only | — | Only read when `MOCK_DATA=false`. |
| `HTAG_API_BASE_URL` | live HTAG only | `https://api.prod.htagai.com` | Override if HTAG moves. |
| `CLAUDE_MODEL` | tuning | `claude-sonnet-4-6` | Swap for `claude-haiku-4-5-20251001` for ~3× cheaper. |
| `RATE_LIMIT_PER_MINUTE` | tuning | `20` | Per-IP requests / minute on both API routes. |
| `HTAG_TIMEOUT_MS` | tuning | `10000` | Per-HTAG-call timeout. Keep well under `maxDuration: 30` for /api/cma so LLM calls have room. |

---

## Quick troubleshooting

| Symptom | Likely cause |
|---|---|
| `503 This deployment is not configured` | `APP_PASSWORD` unset on Vercel prod. Add it and redeploy. |
| Browser prompt accepts any password | `APP_PASSWORD` not set, or set only for preview not production. Check Vercel env scoping. |
| `429 Too many requests` | In-memory rate limit tripped. Wait 1 minute or raise `RATE_LIMIT_PER_MINUTE`. |
| Narrative sounds formulaic / repetitive | `ANTHROPIC_API_KEY` unset or Anthropic call failed — app fell back to deterministic prose. Check Vercel Logs. |
| `422 Not enough recent comparable sales` | HTAG returned < 3 comparables after filtering. Widen search in `lib/htag/client.ts` (raise `radius_km` or `months_back`) and redeploy. |
| `502 HTAG upstream failed at <endpoint>` | Live HTAG call failed or returned unexpected shape. Use `/api/htag-debug` to probe the named endpoint and see raw response keys. |
| `501 htag-debug is only meaningful when MOCK_DATA=false` | You hit the debug endpoint while still in mock mode. Set `MOCK_DATA=false` + `HTAG_API_KEY` and redeploy. |
| PDF downloads as a 0-byte file | Usually a `renderToBuffer` crash. Check Vercel Logs on `/api/pdf`. |
| Vercel function times out | Hobby-plan 10s cap, or `maxDuration: 30` in `vercel.json` + slow HTAG upstream. Either bump the plan or swap `CLAUDE_MODEL` to Haiku. |
| `HTAG ... timed out after 10000ms` | One endpoint exceeded `HTAG_TIMEOUT_MS`. Either raise the env var (keep it well under 30s) or probe with `/api/htag-debug` to see which endpoint is slow. |
| Valuation logs missing `llmTokens` counts | Anthropic call fell back to heuristic (no API key, or the call errored). `llmTokens` will be `{input:0,output:0}` in that case; check for preceding `console.warn` lines in Vercel Logs. |
