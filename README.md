# farming-baseline — runbook

The script a design partner's team runs themselves. Nothing leaves their system: pure stdlib, makes no network calls, prints only aggregates.

Public source: [github.com/nonameuserd/dpa](https://github.com/nonameuserd/dpa) · also published at [chitmark.com/analysis](https://chitmark.com/analysis) · Chitmark by Open Agent Ledger

Two equivalent implementations — send whichever fits the partner's stack:

| File | Runtime | Notes |
| --- | --- | --- |
| `farming-baseline.py` | Python 3.9+ | Zero dependencies |
| `farming-baseline.mts` | Node ≥ 24 (`node farming-baseline.mts`) or any Node ≥ 18 (`npx tsx farming-baseline.mts`) | Zero dependencies, TypeScript, no npm install needed |

Both produce byte-identical JSON output (verified against a shared fixture) — either one can be sent to Chitmark after the partner runs it.

## What it computes

- **Totals:** signups, accounts with usage, total credits used, conversions.
- **Clusters:** accounts sharing an email domain (public domains excluded), accounts sharing an IP prefix (default /24 for IPv4, /48 for IPv6), and burst signup windows within a flagged group.
- **Fast label:** credits burned within 72h of signup — the signal that matters before slow outcomes (conversion/chargeback) arrive.
- **Dollar figure:** credits used by the flagged cohort × the partner's per-credit cost basis, plus its share of total burn. Conservative by construction: it only counts accounts in clusters, never lone accounts.

## CSV schemas

| File | Columns | Notes |
| --- | --- | --- |
| `signups.csv` | `user_id, signed_up_at, email_domain, ip, credits_granted` | `ip`, `email_domain`, `credits_granted` optional. `user_id` must be a stable key that also appears in `usage.csv`. |
| `usage.csv` | `user_id, used_at, credits_used` | One row per metered event. `credits_used` can be any numeric unit — whatever they meter. |
| `conversions.csv` (optional) | `user_id, converted_at` | Marks accounts that became paying customers. |

Timestamps: ISO or `%Y-%m-%d %H:%M:%S`.

## Run

```bash
# Python (any 3.9+)
python3 farming-baseline.py --signups signups.csv --usage usage.csv \
  --credit-cost-usd 0.002 --out summary.json

# TypeScript — Node >= 24 (type stripping is built in)
node farming-baseline.mts --signups signups.csv --usage usage.csv \
  --credit-cost-usd 0.002 --out summary.json

# TypeScript — any Node >= 18 (npx fetches tsx on first run; no install)
npx tsx farming-baseline.mts --signups signups.csv --usage usage.csv \
  --credit-cost-usd 0.002 --out summary.json
```

The `summary.json` output is the only thing the partner forwards to Chitmark.

## Flags worth setting per partner

- `--credit-cost-usd` — blended infra cost per credit (or retail price — pick one and say which in the report).
- `--domain-cluster-min` / `--ip-cluster-min` — defaults 3; lower if their free tier is small, higher for consumer-scale properties.
- `--burst-window-minutes` / `--burst-min` — defaults 15 min / 3 signups.
- `--ignore-domains` — add their own corporate domain and any consumer mail providers they see a lot of.

## Privacy notes for the partner

- No network access, no external enrichment — pure local computation.
- Raw emails/IPs are used only for grouping; the report prints group *counts* and JSON outputs rounded aggregates. No identifiers are written to `summary.json`.
- They may pre-hash `user_id` / `ip` / `email` before exporting; clustering still works on hashes for domains (the hash of the domain is stable) and burst timing, but IP-prefix clustering needs raw IPs (or a prefix-hash they compute themselves).

## Honest limits (say these out loud)

- Clustering is heuristic. Office NATs (shared /24) and shared consumer domains can cause false-positive cohorts — the report is a baseline, not an accusation. The Chitmark paid analysis (next rung) adds IP/ASN/domain enrichment, velocity counters, and outcome-tuned scoring to resolve those cases.
- No individual account is flagged in the report — only cohorts. Individual enforcement happens only in the paid design-partner engagement, where the partner's team sees every verdict with reasons.

## Security (for their security team)

Anticipate the question "why would I run a stranger's script?" — here is the answer, all of it true:

- **No network calls, ever.** The scripts use only the standard library — no HTTP, no sockets, no DNS. They run correctly with the network unplugged. Suggest: run in a sandbox/VM with no network access, or watch with a network monitor (`lsof -i` / Wireshark) during the run. Nothing can leave.
- **Zero dependencies, zero installs.** No npm packages, no pip packages — nothing pulled from a registry, so no supply-chain surface.
- **Fully readable.** ~200 lines each. The analysis is reproducible by hand, so the script is a convenience, not a requirement: their engineer can write the aggregation in their own notebook if they prefer. **Spec-first:** the real ask is three CSV exports; the scripts are optional sugar.
- **Checksum verification.** Chitmark publishes both scripts on chitmark.com and GitHub. Compare before running: `shasum -a 256 farming-baseline.py` (or `sha256sum`) must match the published hash; diff the emailed copy against the public one. Current hashes (regenerate after any edit):
  - `farming-baseline.py` → `0deedbbef0c94009fab291a94f4cf74e4239b48d073ac9a3b6219f523a0e66f4`
  - `farming-baseline.mts` → `8d5dac7cd187f470eb5da6e403521ea9e5481c8367316f38c4614629dbe5df81`
- **Inputs stay on their machine.** CSVs never leave; the only output to share is `summary.json`, which contains rounded aggregates and group counts — no identifiers, no raw values (verified: the JSON contains no emails, IPs, or user IDs).
- **They can pre-hash before export.** `user_id` / `ip` / `email` hashed in their export step still works for domain and timing clustering (see Privacy notes).

## What the dollar figure means

`flagged_cost_usd = Σ credits used by flagged cohort × credit_cost_usd`. It answers the case-study milestone question — "what $ of free-tier compute is attributable to automation?" — and the companion numbers (72h burn, conversion contrast) are the fast-label evidence that farming cohorts don't convert.
