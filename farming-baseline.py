"""Farming baseline analysis — run this on your own machine.

Computes aggregate-only numbers from CSV exports. The script makes no
network calls, so nothing leaves your system. Output is a JSON summary
you can review and share, plus a printed markdown report.

Inputs:
  --signups      signups.csv     columns: user_id, signed_up_at, email_domain,
                                 ip (optional), credits_granted (optional)
  --usage        usage.csv       columns: user_id, used_at, credits_used
  --conversions  conversions.csv columns: user_id, converted_at (optional)
  --credit-cost-usd              0.002   cost of one credit in USD (blended
                                         infra cost or retail price — pick one
                                         and state it in the report)
  --domain-cluster-min           3       accounts sharing an email domain to
                                         flag a cluster
  --ip-cluster-min               3       accounts sharing an IP prefix to flag
  --cluster-ip-prefix            24      IPv4 prefix bits for clustering
  --burst-window-minutes         15      signups in a window this long sharing
                                         a flagged group count as a burst
  --burst-min                    3       signups needed in a window for a burst
  --ignore-domains               comma-separated public domains excluded from
                                 domain clustering
  --out                          summary.json

Run:  python3 farming-baseline.py --signups signups.csv --usage usage.csv \
      --credit-cost-usd 0.002 --out summary.json
"""

import argparse
import csv
import ipaddress
import json
import sys
from collections import defaultdict
from datetime import datetime, timedelta

DEFAULT_IGNORE = (
    "gmail.com,outlook.com,hotmail.com,yahoo.com,icloud.com,aol.com,proton.me,"
    "protonmail.com"
)


def parse_args():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--signups", required=True)
    p.add_argument("--usage", required=True)
    p.add_argument("--conversions")
    p.add_argument("--credit-cost-usd", type=float, default=0.0)
    p.add_argument("--domain-cluster-min", type=int, default=3)
    p.add_argument("--ip-cluster-min", type=int, default=3)
    p.add_argument("--cluster-ip-prefix", type=int, default=24)
    p.add_argument("--burst-window-minutes", type=int, default=15)
    p.add_argument("--burst-min", type=int, default=3)
    p.add_argument("--ignore-domains", default=DEFAULT_IGNORE)
    p.add_argument("--out", default="summary.json")
    return p.parse_args()


def load_csv(path, required):
    rows = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        names = reader.fieldnames or []
        missing = [c for c in required if c not in names]
        if missing:
            sys.exit(f"{path}: missing columns {missing}; have {names}")
        for row in reader:
            if row.get(required[0], "").strip():
                rows.append(row)
    return rows


def parse_ts(value):
    value = value.strip()
    for fmt in (
        "%Y-%m-%dT%H:%M:%S.%f",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d",
    ):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    sys.exit(f"unparseable timestamp: {value!r}")


def ip_prefix(raw, bits):
    try:
        ip = ipaddress.ip_address(raw.strip())
    except ValueError:
        return None
    if ip.version == 4:
        return str(ipaddress.ip_network(f"{ip}/{min(bits, 32)}", strict=False))
    return str(ipaddress.ip_network(f"{ip}/48", strict=False))


def has_burst(times, window, k):
    times = sorted(times)
    j = 0
    for i in range(len(times)):
        while j < len(times) and times[j] - times[i] <= window:
            j += 1
        if j - i >= k:
            return True
    return False


def cohort_stats(user_ids, credits_all, credits_72h, converted, by_user):
    return {
        "accounts": len(user_ids),
        "credits_granted": round(
            sum(by_user[uid]["credits_granted"] for uid in user_ids), 2
        ),
        "credits_used": round(sum(credits_all.get(uid, 0.0) for uid in user_ids), 2),
        "credits_used_72h": round(
            sum(credits_72h.get(uid, 0.0) for uid in user_ids), 2
        ),
        "converted": sum(1 for uid in user_ids if uid in converted),
    }


def main():
    args = parse_args()
    ignore = {d.strip().lower() for d in args.ignore_domains.split(",") if d.strip()}

    signups = load_csv(args.signups, ["user_id", "signed_up_at"])
    usage = load_csv(args.usage, ["user_id", "used_at", "credits_used"])
    conversions = (
        load_csv(args.conversions, ["user_id", "converted_at"])
        if args.conversions
        else []
    )
    converted = {r["user_id"] for r in conversions}

    by_user = {}
    for r in signups:
        try:
            grant = float(r["credits_granted"]) if r.get("credits_granted") else 0.0
        except ValueError:
            grant = 0.0
        by_user[r["user_id"]] = {
            "signed_up_at": parse_ts(r["signed_up_at"]),
            "email_domain": (r.get("email_domain") or "").strip().lower(),
            "ip": (r.get("ip") or "").strip(),
            "credits_granted": grant,
        }

    total_credits = 0.0
    credits_72h = defaultdict(float)
    credits_all = defaultdict(float)
    orphan_usage_rows = 0
    for r in usage:
        try:
            amount = float(r["credits_used"])
        except ValueError:
            continue
        ts = parse_ts(r["used_at"])
        total_credits += amount
        uid = r["user_id"]
        credits_all[uid] += amount
        if uid not in by_user:
            orphan_usage_rows += 1
            continue
        if ts <= by_user[uid]["signed_up_at"] + timedelta(hours=72):
            credits_72h[uid] += amount

    domains = defaultdict(set)
    for uid, u in by_user.items():
        if u["email_domain"] and u["email_domain"] not in ignore:
            domains[u["email_domain"]].add(uid)

    prefixes = defaultdict(set)
    for uid, u in by_user.items():
        pref = ip_prefix(u["ip"], args.cluster_ip_prefix) if u["ip"] else None
        if pref:
            prefixes[pref].add(uid)

    domain_clusters = {
        d: us for d, us in domains.items() if len(us) >= args.domain_cluster_min
    }
    ip_clusters = {
        p: us for p, us in prefixes.items() if len(us) >= args.ip_cluster_min
    }

    flagged = set()
    for us in list(domain_clusters.values()) + list(ip_clusters.values()):
        flagged |= us

    window = timedelta(minutes=args.burst_window_minutes)
    burst_groups = [
        label
        for label, us in list(domain_clusters.items())
        + [(f"ip:{p}", us) for p, us in ip_clusters.items()]
        if has_burst(
            [by_user[uid]["signed_up_at"] for uid in us], window, args.burst_min
        )
    ]

    flagged_stats = cohort_stats(
        flagged, credits_all, credits_72h, converted, by_user
    )
    clean_stats = cohort_stats(
        set(by_user) - flagged, credits_all, credits_72h, converted, by_user
    )

    share = (
        round(flagged_stats["credits_used"] / total_credits, 4)
        if total_credits
        else 0.0
    )
    dollar_figure = {
        "credit_cost_usd": args.credit_cost_usd,
        "flagged_cost_usd": round(
            flagged_stats["credits_used"] * args.credit_cost_usd, 2
        ),
        "flagged_cost_72h_usd": round(
            flagged_stats["credits_used_72h"] * args.credit_cost_usd, 2
        ),
        "share_of_total_burn": share,
    }

    summary = {
        "generated_at": datetime.utcnow().isoformat(timespec="seconds"),
        "inputs": {
            "signups": args.signups,
            "usage": args.usage,
            "conversions": args.conversions or None,
            "cluster_ip_prefix": args.cluster_ip_prefix,
            "burst_window_minutes": args.burst_window_minutes,
            "burst_min": args.burst_min,
        },
        "totals": {
            "signups": len(by_user),
            "accounts_with_usage": len(credits_all),
            "total_credits_used": round(total_credits, 2),
            "converted": len(converted),
            "orphan_usage_rows": orphan_usage_rows,
        },
        "clusters": {
            "domain_cluster_groups": len(domain_clusters),
            "ip_cluster_groups": len(ip_clusters),
            "burst_groups": len(burst_groups),
        },
        "cohorts": {"flagged": flagged_stats, "clean": clean_stats},
        "dollar_figure": dollar_figure,
    }

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)

    print("# Farming baseline")
    print(
        f"signups: {summary['totals']['signups']} | accounts with usage: "
        f"{summary['totals']['accounts_with_usage']} | total credits used: "
        f"{summary['totals']['total_credits_used']} | converted: "
        f"{summary['totals']['converted']}"
    )
    print(
        f"flagged cohorts: {len(domain_clusters)} domain + "
        f"{len(ip_clusters)} ip-prefix groups ({len(flagged)} accounts) | "
        f"burst groups: {len(burst_groups)}"
    )
    if domain_clusters:
        print(
            "domain groups: "
            + ", ".join(f"{d} ({len(us)})" for d, us in domain_clusters.items())
        )
    if ip_clusters:
        print(
            "ip-prefix groups: "
            + ", ".join(f"{p} ({len(us)})" for p, us in ip_clusters.items())
        )
    if burst_groups:
        print("burst groups: " + ", ".join(burst_groups))
    print(
        f"{'cohort':<12}{'accounts':>10}{'credits_used':>16}"
        f"{'credits_72h':>14}{'converted':>12}"
    )
    for name, stats in (("flagged", flagged_stats), ("clean", clean_stats)):
        print(
            f"{name:<12}{stats['accounts']:>10}{stats['credits_used']:>16}"
            f"{stats['credits_used_72h']:>14}{stats['converted']:>12}"
        )
    print(
        f"dollar figure (at ${args.credit_cost_usd}/credit): "
        f"${dollar_figure['flagged_cost_usd']} ({share * 100:.1f}% of total "
        f"burn); 72h: ${dollar_figure['flagged_cost_72h_usd']}"
    )
    print(f"summary written to {args.out}")


if __name__ == "__main__":
    main()
