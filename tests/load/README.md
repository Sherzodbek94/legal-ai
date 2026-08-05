# Load testing

k6 is a standalone Go binary, not an npm package — it runs its own JavaScript
runtime, which is why `k6-load-test.js` has no imports from `node_modules` and is
not part of the Jest suite.

## Install

```bash
# macOS
brew install k6

# Windows
winget install k6 --source winget

# Linux (Debian/Ubuntu)
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
```

## Run

The API must be **running and seeded** — the script signs in as the seeded owner,
and without that every authenticated request 401s and the run measures nothing
but the login error path.

```bash
docker compose up -d
npm run db:deploy && npm run db:seed
npm run dev            # in another terminal

npm run test:load
```

Against another environment:

```bash
k6 run -e BASE_URL=https://staging.example.com tests/load/k6-load-test.js
```

## What it asserts

| Threshold | Budget | Why this number |
| --- | --- | --- |
| `read_latency` p95 | **500ms** | The requirement. Covers the endpoints a signed-in user hits on every page load. |
| `auth_latency` p95 | 1500ms | Login runs bcrypt at cost 12 — roughly 250ms of *deliberate* CPU per call. Holding it to 500ms would be asking for the password hashing to be weakened. |
| `errors` | < 1% | |
| `http_req_failed` | < 5%, aborts | Stops a clearly failing run after 30s instead of burning the full four minutes. |

## What it deliberately does not test

- **Document export and OCR.** Both legitimately take seconds — Chromium and
  Tesseract respectively. Including them would make the p95 measure how many PDFs
  were requested rather than whether the API is healthy. They need their own
  budgets and their own scenario.
- **Hybrid search.** `mode=lexical` only. Hybrid spends an OpenAI embedding call
  per query; at 200 VUs that is thousands of billable calls measuring OpenAI's
  latency rather than ours.

## Profile

Ramps 0 → 50 → 200 VUs, holds 200 for two minutes, ramps down. The ramp is
deliberate: an instant step to 200 measures cold start — empty connection pools,
unwarmed JIT — which is a real thing to test but a different one from steady-state
capacity.

Results are written to `tests/load/summary.json` for tracking across runs.
