# Chitmark farming-baseline analysis

A free, read-only analysis that puts a dollar figure on how much of your free tier is being drained by AI-agent farming — fake signups spinning up credits and API keys. It runs on your machine, against your own data. Nothing leaves your system.

- **Zero dependencies, zero installs, zero network calls** — pure Python 3.9+ stdlib, or Node ≥ 18 built-ins
- **~200 lines, fully readable** — your engineers can audit it in 10 minutes or skip it entirely and reproduce the math themselves
- **Public source:** [github.com/nonameuserd/dpa](https://github.com/nonameuserd/dpa) · Chitmark by Open Agent Ledger

## What you need

Three CSV exports from your own warehouse:

| File | Columns | Notes |
| --- | --- | --- |
| `signups.csv` | `user_id, signed_up_at, email_domain, ip, credits_granted` | `ip`, `email_domain`, `credits_granted` optional. `user_id` must match `usage.csv`. |
| `usage.csv` | `user_id, used_at, credits_used` | One row per metered event. Any numeric unit. |
| `conversions.csv` (optional) | `user_id, converted_at` | Accounts that became paying customers. |

Timestamps: ISO (`2026-08-01T09:00:00`) or `YYYY-MM-DD HH:MM:SS`.

## Run

```bash
# Python (3.9+)
python3 farming-baseline.py --signups signups.csv --usage usage.csv \
  --credit-cost-usd 0.002 --out summary.json

# TypeScript — Node >= 24 (type stripping is built in, nothing to install)
node farming-baseline.mts --signups signups.csv --usage usage.csv \
  --credit-cost-usd 0.002 --out summary.json

# TypeScript — any Node >= 18 (npx fetches tsx once; no project install)
npx tsx farming-baseline.mts --signups signups.csv --usage usage.csv \
  --credit-cost-usd 0.002 --out summary.json
```

The `summary.json` output — rounded aggregates and group counts, no identifiers — is the only thing worth sharing from the run.

## Try it first

The `example/` folder has a small synthetic dataset (30 signups: 12 farm accounts + 18 normal users, 3 conversions) — run it to see what the output looks like before touching real data:

```bash
cd example
python3 ../farming-baseline.py --signups signups.csv --usage usage.csv \
  --conversions conversions.csv --credit-cost-usd 0.002 --out summary.json
```

Expected output: 12 flagged accounts burning ~96% of credits with 0 conversions, 18 clean accounts with 3 conversions — `example/summary.json` is the reference result.

## Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--credit-cost-usd` | 0 | Your cost per credit (blended infra cost or retail — pick one and say which) |
| `--domain-cluster-min` | 3 | Accounts sharing an email domain to flag a cluster |
| `--ip-cluster-min` | 3 | Accounts sharing an IP prefix to flag |
| `--cluster-ip-prefix` | 24 | IPv4 prefix bits for clustering (/48 for IPv6) |
| `--burst-window-minutes` | 15 | Signups this close together in a flagged group count as a burst |
| `--burst-min` | 3 | Signups needed in a window for a burst |
| `--ignore-domains` | common public domains | Comma-separated domains excluded from domain clustering |
| `--out` | `summary.json` | Output path |

## Verify the file you received

The scripts work correctly with **no network access** — run them in a sandbox with the network unplugged if your security team wants proof. Compare checksums against this page and the GitHub repo:

```bash
shasum -a 256 farming-baseline.py      # macOS
sha256sum farming-baseline.py          # Linux
```

- `farming-baseline.py` → `0deedbbef0c94009fab291a94f4cf74e4239b48d073ac9a3b6219f523a0e66f4`
- `farming-baseline.mts` → `8d5dac7cd187f470eb5da6e403521ea9e5481c8367316f38c4614629dbe5df81`

## What it computes

- **Totals:** signups, accounts with usage, total credits used, conversions.
- **Clusters:** accounts sharing an email domain (public domains excluded), accounts sharing an IP prefix, and burst signup windows within a flagged group.
- **Fast label:** credits burned within 72h of signup.
- **Dollar figure:** credits used by the flagged cohort × your per-credit cost, plus its share of total burn. Conservative by construction — it only counts accounts in clusters, never lone accounts.

The 72h credit-burn and the conversion contrast (flagged vs. clean cohorts) are the numbers that separate farming cohorts from real users.

## License

Public domain (Unlicense). You can run, copy, modify, and audit it freely — that's the point.
