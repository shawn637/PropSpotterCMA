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

Only run this after Phase 2 is complete and you've confirmed the gate works.

### 3.1 Turn on live mode

1. **Credentials.** Add to Vercel env vars:
   ```
   HTAG_API_KEY=<from HTAG Developer Portal>
   HTAG_API_BASE_URL=https://api.prod.htagai.com   # or whatever your portal shows
   MOCK_DATA=false
   ```
2. **Redeploy.** `vercel --prod`. Env changes don't apply to existing deployments.

### 3.2 Probe the API with `/api/htag-debug` (fast path)

The debug endpoint hits every HTAG endpoint the app depends on and returns the raw JSON from each, so you can confirm response shapes without running the full pipeline. This is the primary tool for Phase 3 — it collapses the iteration loop from "deploy → tail logs → edit → redeploy" to one `curl` invocation.

```bash
curl -u any:"$APP_PASSWORD" \
  -X POST https://<your-vercel-url>/api/htag-debug \
  -H 'Content-Type: application/json' \
  -d '{"address":"42 Example St, Baulkham Hills NSW 2153","locPid":"NSW231"}' \
  | jq
```

Response shape:
```jsonc
{
  "mode": "live",
  "requestedAddress": "...",
  "derivedAddressKey": "...",   // what standardise returned
  "derivedLocPid": "NSW231",
  "stages": [
    {
      "name": "standardise",
      "endpoint": "/v1/address/standardise",
      "ok": true,
      "status": 200,
      "elapsedMs": 142,
      "responseKeys": ["address_key", "formatted_address", ...],  // ← map these against lib/htag/client.ts
      "body": { /* full raw JSON */ }
    },
    // ... one stage per endpoint
  ]
}
```

For each stage where `ok: false`, read the `error` message and compare `responseKeys` to what the client expects. Then:

1. **Edit `lib/htag/client.ts`** — each of the five `TODO(htag-live):` markers corresponds to a pair of expectations the debug output will confirm or deny:
   - `TODO(htag-live): 1` — auth header. HTAG likely takes one of `X-API-Key` or `Authorization: Bearer`. The client sends both; remove the unused one once confirmed.
   - `TODO(htag-live): 2` — standardise endpoint response shape.
   - `TODO(htag-live): 3` — property summary fields.
   - `TODO(htag-live): 4` — sold-search endpoint path + body.
   - `TODO(htag-live): 5` — market endpoints (growth / cycle / demand / summary).
2. **Redeploy.** `vercel --prod`.
3. **Re-run the debug probe.** Repeat until every stage returns `ok: true`.

### 3.3 End-to-end smoke test

Once the debug probe is green:

1. **Tail function logs** in Vercel → Logs → filter to `/api/cma`. Look for `{"tag":"htag",...}` lines — each HTAG call emits one, logging endpoint / status / elapsed / top-level response keys (no PII).
2. **Hit the full pipeline.** Use the UI with a real Sydney address you know (e.g. Baulkham Hills, Stanhope Gardens). Expect a real CMA with ≥ 3 comparable sales.
3. **Sanity check the three numbers** look plausible for the suburb. If fairValue is wildly off from your Excel tool's output, the likely culprit is `annualisedGrowth5y` being a different denomination (percent vs decimal — HTAG might return `7.2` where the code expects `0.072`) or comparables outside the target suburb. Inspect `cma.comparables[].fullAddress` in the JSON response.
4. **If `/api/cma` returns 502,** the error body includes `endpoint` and `upstreamStatus` — maps 1:1 to the debug-endpoint stage where you need to iterate further.
5. **If it returns 422** ("Not enough recent comparable sales"), HTAG returned fewer than 3 sales after filtering. Widen the search in `lib/htag/client.ts`'s `getComparables` body (raise `radius_km` or `months_back`), redeploy, and retry.

### 3.4 Clean up

Once live is working end-to-end:

1. **Remove the unused auth header** (`TODO(htag-live): 1`). Keep only the header HTAG actually accepts.
2. **Delete the five `TODO(htag-live):` comments** once each has been confirmed against a real response.
3. **Consider whether to keep `/api/htag-debug`.** It's handy for future upstream changes, but it leaks the real HTAG response shape to anyone behind the password gate. Either leave it (password is fine for a test deploy), wrap it in a separate `ENABLE_DEBUG=true` env var, or delete the route once field names are locked in.

---

## Phase 4 — Harden for real traffic

In rough priority order.

1. **Upgrade rate limiter to Vercel KV** (currently in-memory).
   - `npm i @upstash/ratelimit @vercel/kv`, enable KV in Vercel dashboard, swap `lib/ratelimit.ts` to use `Ratelimit.slidingWindow`.
2. **HTAG edge-case error handling.**
   - Missing land size → heuristic adjustment already handles this, but log a note.
   - Empty comparables array → 422 already handles this.
   - Obscure suburb / no market data → currently throws; convert to a user-friendly 422.
3. **Replace in-memory mocks with a richer fixture library** — multiple states, unit / townhouse, edge cases.
4. **Server-side usage logging.** Today the app is fully stateless. Consider logging each valuation's `subject.locPid`, `cma.fairValue`, and token usage to Vercel Logs (structured JSON, no PII in the body) so you can spot patterns.
5. **Next.js security update.** Repo currently pins `next@14.2.5`, which npm flags for a Dec 2025 CVE. Bump to the latest 14.2.x before going public: `npm i next@^14.2.36` and re-run `npm run build`.

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
