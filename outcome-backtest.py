"""Outcome backtest — the milestone-2 comparison, stated as a number.

Compares your current funnel-blind block rules against an outcome-tuned
policy on the metric that matters: **dollars saved per false-block**.

Runs offline, stdlib only, on your own machine. Prints a markdown report and
writes aggregate-only summary.json. No identifiers ever leave your system.

Inputs:
  --events              events.csv     columns: event_id, signed_up_at,
                                       decision_funnel_blind, decision_chitmark,
                                       outcome, credit_burn_usd (optional),
                                       chargeback_usd (optional),
                                       converted_usd (optional)
  --label-maturity-days 14             events signed up this many days before
                                       "today" are dropped — their outcome
                                       labels have not matured yet (credit burn
                                       shows up at 24-72h, conversions take
                                       longer). 0 disables the cutoff.
  --out                 summary.json

Decisions (per column): `allow` or `block`.
Outcome labels: `abuse` (credit_burn or chargeback), `converted` (became a
paying customer), `silent` (neither). An event that both burned credits and
converted is counted as abuse — conservative, and the caller's choice.

Interpretation: the outcome-tuned policy should block the SAME abuse dollars
with FEWER false blocks of converted customers. If it does not, the
differentiation is not showing up in your data — that is the honest finding.

Run:
  python3 outcome-backtest.py --events events.csv --out summary.json
"""

import argparse
import csv
import json
import sys
from datetime import datetime, timedelta, timezone

REQUIRED_COLUMNS = [
    "event_id",
    "signed_up_at",
    "decision_funnel_blind",
    "decision_chitmark",
    "outcome",
]
OPTIONAL_COLUMNS = [
    "credit_burn_usd",
    "chargeback_usd",
    "converted_usd",
]
OUTCOMES = {"abuse", "converted", "silent"}
DECISIONS = {"allow", "block"}


class Event:
    __slots__ = (
        "event_id",
        "signed_up_at",
        "decision_funnel_blind",
        "decision_chitmark",
        "outcome",
        "abuse_usd",
        "good_usd",
        "mature",
    )

    def __init__(self, row, maturity_cutoff, false_block_cost_usd):
        self.event_id = row["event_id"]
        self.signed_up_at = parse_datetime(row["signed_up_at"])
        self.decision_funnel_blind = row["decision_funnel_blind"]
        self.decision_chitmark = row["decision_chitmark"]
        self.outcome = row["outcome"]
        burn = as_usd(row.get("credit_burn_usd"))
        chargeback = as_usd(row.get("chargeback_usd"))
        converted = as_usd(row.get("converted_usd"))
        if not converted and false_block_cost_usd:
            converted = false_block_cost_usd
        self.abuse_usd = burn + chargeback
        self.good_usd = converted
        self.mature = maturity_cutoff is None or (
            self.signed_up_at is not None and self.signed_up_at < maturity_cutoff
        )

    @property
    def value(self):
        if self.outcome == "abuse":
            return self.abuse_usd
        if self.outcome == "converted":
            return self.good_usd
        return 0.0


def parse_args():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--events", required=True)
    p.add_argument("--label-maturity-days", type=int, default=14)
    p.add_argument("--false-block-cost-usd", type=float, default=0.0)
    p.add_argument("--out", default="summary.json")
    return p.parse_args()


def load_events(path):
    with open(path, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        missing = [c for c in REQUIRED_COLUMNS if c not in (reader.fieldnames or [])]
        if missing:
            fail(f"events.csv is missing required column(s): {', '.join(missing)}")
        return list(reader)


def parse_datetime(value):
    if not value:
        return None
    text = str(value).strip()
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f"):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    try:
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed
    except ValueError:
        return None


def as_usd(value):
    if value in (None, ""):
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        fail(f"non-numeric dollar value: {value!r}")


def fail(message):
    print(f"error: {message}", file=sys.stderr)
    sys.exit(2)


def norm(value):
    """Serialize whole floats as ints so summary.json matches the TS build."""
    return int(value) if isinstance(value, float) and value == int(value) else value


def evaluate(events, decision_key):
    blocks = 0
    abuse_blocked = 0
    abuse_blocked_usd = 0.0
    false_blocks = 0
    false_block_usd = 0.0
    abuse_missed = 0
    abuse_missed_usd = 0.0
    for event in events:
        blocked = event.decision_funnel_blind == "block" if decision_key == "funnel_blind" else event.decision_chitmark == "block"
        if event.outcome == "abuse":
            if blocked:
                abuse_blocked += 1
                abuse_blocked_usd += event.abuse_usd
            else:
                abuse_missed += 1
                abuse_missed_usd += event.abuse_usd
        elif event.outcome == "converted" and blocked:
            false_blocks += 1
            false_block_usd += event.good_usd
        if blocked:
            blocks += 1
    saved_per_false_block = (
        round(abuse_blocked_usd / false_blocks, 2) if false_blocks else None
    )
    return {
        "blocks": blocks,
        "abuse_blocked": abuse_blocked,
        "false_blocks": false_blocks,
        "abuse_missed": abuse_missed,
        "dollars_saved_usd": norm(round(abuse_blocked_usd, 2)),
        "dollars_lost_usd": norm(round(false_block_usd, 2)),
        "dollars_saved_per_false_block": norm(saved_per_false_block),
    }


def render_markdown(events, counts, funnel, tuned, maturity_days):
    lines = []
    lines.append("# Outcome backtest — summary")
    lines.append("")
    lines.append(
        f"- Events analyzed: **{counts['events']}** "
        f"({counts['events_with_decision']} with both decisions recorded)"
    )
    if counts["dropped_immature"]:
        lines.append(
            f"- Dropped as immature labels: **{counts['dropped_immature']}** "
            f"(signed up within the {maturity_days}-day label window)"
        )
    lines.append(
        f"- Abuse events: **{counts['abuse']}** (${counts['abuse_usd']:.2f}) · "
        f"Converted: **{counts['converted']}** (${counts['good_usd']:.2f}) · "
        f"Silent: **{counts['silent']}**"
    )
    lines.append("")

    header = (
        "| Policy | Blocks | Abuse blocked | False blocks | Abuse missed | "
        "Saved | Lost | $ saved / false-block |"
    )
    lines.append(header)
    lines.append("|---|---|---|---|---|---|---|---|")
    for label, policy in (("Funnel-blind (current)", funnel), ("Outcome-tuned", tuned)):
        per = (
            f"${policy['dollars_saved_per_false_block']:,.2f}"
            if policy["dollars_saved_per_false_block"] is not None
            else "no false blocks"
        )
        lines.append(
            f"| {label} | {policy['blocks']} | {policy['abuse_blocked']} | "
            f"{policy['false_blocks']} | {policy['abuse_missed']} | "
            f"${policy['dollars_saved_usd']:,.2f} | ${policy['dollars_lost_usd']:,.2f} "
            f"| {per} |"
        )
    lines.append("")

    funnel_per = funnel["dollars_saved_per_false_block"]
    tuned_per = tuned["dollars_saved_per_false_block"]
    if funnel_per is not None and tuned_per is not None:
        verdict = (
            "The outcome-tuned policy blocks the same abuse dollars with fewer "
            "false blocks of paying customers."
            if tuned["false_blocks"] < funnel["false_blocks"]
            and tuned["dollars_saved_usd"] >= funnel["dollars_saved_usd"]
            else "The outcome-tuned policy did not improve on the current rules "
            "in this data — that is the honest finding, not a bug."
        )
    else:
        verdict = (
            "Neither policy had a false-block-free sample, or one policy "
            "produced no false blocks; compare the rows directly."
        )
    lines.append(f"**Verdict:** {verdict}")
    lines.append("")
    lines.append(
        "**Honest limits:** this compares recorded decisions, not a live A/B — "
        "the outcome-tuned policy is what your labels would have recommended. "
        "Labels mature slowly (burn at 24-72h, conversions longer), so the "
        f"{maturity_days}-day maturity cutoff matters. Dropping the wrong cohort, "
        "or a mislabeled outcome, moves every number here."
    )
    return "\n".join(lines)


def main():
    args = parse_args()
    raw = load_events(args.events)
    if not raw:
        fail("events.csv has no rows")

    maturity_cutoff = None
    if args.label_maturity_days > 0:
        maturity_cutoff = datetime.now(timezone.utc) - timedelta(
            days=args.label_maturity_days
        )

    events = []
    counts = {
        "events": 0,
        "events_with_decision": 0,
        "dropped_immature": 0,
        "abuse": 0,
        "abuse_usd": 0.0,
        "converted": 0,
        "good_usd": 0.0,
        "silent": 0,
    }
    for row in raw:
        event = Event(row, maturity_cutoff, args.false_block_cost_usd)
        if not event.mature:
            counts["dropped_immature"] += 1
            continue
        events.append(event)
        counts["events"] += 1
        if (
            event.decision_funnel_blind in DECISIONS
            and event.decision_chitmark in DECISIONS
        ):
            counts["events_with_decision"] += 1
        if event.outcome == "abuse":
            counts["abuse"] += 1
            counts["abuse_usd"] += event.abuse_usd
        elif event.outcome == "converted":
            counts["converted"] += 1
            counts["good_usd"] += event.good_usd
        else:
            counts["silent"] += 1
    counts["abuse_usd"] = norm(round(counts["abuse_usd"], 2))
    counts["good_usd"] = norm(round(counts["good_usd"], 2))

    funnel = evaluate(events, "funnel_blind")
    tuned = evaluate(events, "chitmark")

    report = render_markdown(
        events, counts, funnel, tuned, args.label_maturity_days
    )
    print(report)

    summary = {
        "schema_version": 1,
        "generated_by": "chitmark outcome-backtest",
        "events": counts["events"],
        "events_with_both_decisions": counts["events_with_decision"],
        "dropped_immature": counts["dropped_immature"],
        "abuse_events": counts["abuse"],
        "abuse_value_usd": counts["abuse_usd"],
        "converted_events": counts["converted"],
        "good_value_usd": counts["good_usd"],
        "silent_events": counts["silent"],
        "policies": {
            "funnel_blind": funnel,
            "outcome_tuned": tuned,
        },
        "outcome_tuned_advantage": {
            "false_blocks_removed": max(funnel["false_blocks"] - tuned["false_blocks"], 0),
            "dollars_saved_per_false_block_delta_usd": norm(
                round(
                    tuned["dollars_saved_per_false_block"] - funnel["dollars_saved_per_false_block"],
                    2,
                )
                if funnel["dollars_saved_per_false_block"] is not None
                and tuned["dollars_saved_per_false_block"] is not None
                else None
            ),
        },
        "label_maturity_days": args.label_maturity_days,
    }

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2, sort_keys=True)
        fh.write("\n")
    print(f"\nsummary written to {args.out}")


if __name__ == "__main__":
    main()
