/**
 * Outcome backtest — the milestone-2 comparison, stated as a number.
 *
 * TypeScript mirror of outcome-backtest.py (byte-identical summary.json,
 * verified against the shared example fixture). Compares your current
 * funnel-blind block rules against an outcome-tuned policy on the metric
 * that matters: **dollars saved per false-block**.
 *
 * Runs offline, built-ins only. Prints a markdown report and writes
 * aggregate-only summary.json. No identifiers ever leave your system.
 *
 * Inputs:
 *   --events               events.csv     columns: event_id, signed_up_at,
 *                                         decision_funnel_blind,
 *                                         decision_chitmark, outcome,
 *                                         credit_burn_usd (optional),
 *                                         chargeback_usd (optional),
 *                                         converted_usd (optional)
 *   --label-maturity-days  14             events signed up this many days
 *                                         before "today" are dropped — their
 *                                         outcome labels have not matured.
 *                                         0 disables the cutoff.
 *   --out                  summary.json
 *
 * Decisions (per column): `allow` or `block`.
 * Outcome labels: `abuse` (credit_burn or chargeback), `converted` (became a
 * paying customer), `silent` (neither). An event that both burned credits and
 * converted is counted as abuse — conservative, and the caller's choice.
 *
 * Run (Node >= 24, type stripping built in):
 *   node outcome-backtest.mts --events events.csv --out summary.json
 * Any Node >= 18: npx tsx outcome-backtest.mts ...
 */

const REQUIRED_COLUMNS = [
  "event_id",
  "signed_up_at",
  "decision_funnel_blind",
  "decision_chitmark",
  "outcome",
] as const;
const OUTCOMES = new Set(["abuse", "converted", "silent"]);
const DECISIONS = new Set(["allow", "block"]);

import { readFileSync, writeFileSync } from "node:fs";

type EventRow = {
  event_id: string;
  signed_up_at: string;
  decision_funnel_blind: string;
  decision_chitmark: string;
  outcome: string;
  credit_burn_usd?: string;
  chargeback_usd?: string;
  converted_usd?: string;
};

type Event = {
  event_id: string;
  signed_up_at: string;
  decision_funnel_blind: string;
  decision_chitmark: string;
  outcome: string;
  abuse_usd: number;
  good_usd: number;
  mature: boolean;
};

type PolicyResult = {
  blocks: number;
  abuse_blocked: number;
  false_blocks: number;
  abuse_missed: number;
  dollars_saved_usd: number;
  dollars_lost_usd: number;
  dollars_saved_per_false_block: number | null;
};

type Counts = {
  events: number;
  events_with_both_decisions: number;
  dropped_immature: number;
  abuse: number;
  abuse_usd: number;
  converted: number;
  good_usd: number;
  silent: number;
};

function parseArgs(argv: string[]): {
  events: string;
  labelMaturityDays: number;
  falseBlockCostUsd: number;
  out: string;
} {
  let events = "";
  let out = "summary.json";
  let labelMaturityDays = 14;
  let falseBlockCostUsd = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--events" && value) {
      events = value;
      i += 1;
    } else if (flag === "--out" && value) {
      out = value;
      i += 1;
    } else if (flag === "--label-maturity-days" && value) {
      labelMaturityDays = Number(value);
      i += 1;
    } else if (flag === "--false-block-cost-usd" && value) {
      falseBlockCostUsd = Number(value);
      i += 1;
    } else {
      fail(`unknown argument: ${flag}`);
    }
  }
  if (!events) fail("--events events.csv is required");
  return { events, out, labelMaturityDays, falseBlockCostUsd };
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}

function asUsd(value: string | undefined): number {
  if (value === undefined || value === "") return 0;
  const n = Number(value);
  if (Number.isNaN(n)) fail(`non-numeric dollar value: ${value}`);
  return n;
}

function parseDatetime(value: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function loadEvents(path: string): EventRow[] {
  const text = readFileSync(path, "utf-8");
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) fail("events.csv has no rows");
  const header = lines[0].split(",");
  for (const column of REQUIRED_COLUMNS) {
    if (!header.includes(column)) {
      fail(`events.csv is missing required column(s): ${column}`);
    }
  }
  const rows: EventRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    header.forEach((column, index) => {
      row[column] = (cells[index] ?? "").trim();
    });
    rows.push(row as unknown as EventRow);
  }
  return rows;
}

function buildEvent(
  row: EventRow,
  maturityCutoff: Date | null,
  falseBlockCostUsd: number,
): Event {
  const burn = asUsd(row.credit_burn_usd);
  const chargeback = asUsd(row.chargeback_usd);
  let converted = asUsd(row.converted_usd);
  if (!converted && falseBlockCostUsd) converted = falseBlockCostUsd;
  const signedUpAt = parseDatetime(row.signed_up_at);
  const mature =
    maturityCutoff === null || (signedUpAt !== null && signedUpAt < maturityCutoff);
  return {
    event_id: row.event_id,
    signed_up_at: row.signed_up_at,
    decision_funnel_blind: row.decision_funnel_blind,
    decision_chitmark: row.decision_chitmark,
    outcome: row.outcome,
    abuse_usd: burn + chargeback,
    good_usd: converted,
    mature,
  };
}

function evaluate(events: Event[], decisionKey: "funnel_blind" | "chitmark"): PolicyResult {
  let blocks = 0;
  let abuseBlocked = 0;
  let abuseBlockedUsd = 0;
  let falseBlocks = 0;
  let falseBlockUsd = 0;
  let abuseMissed = 0;
  for (const event of events) {
    const blocked =
      decisionKey === "funnel_blind"
        ? event.decision_funnel_blind === "block"
        : event.decision_chitmark === "block";
    if (event.outcome === "abuse") {
      if (blocked) {
        abuseBlocked += 1;
        abuseBlockedUsd += event.abuse_usd;
      } else {
        abuseMissed += 1;
      }
    } else if (event.outcome === "converted" && blocked) {
      falseBlocks += 1;
      falseBlockUsd += event.good_usd;
    }
    if (blocked) blocks += 1;
  }
  const savedPerFalseBlock = falseBlocks
    ? round2(abuseBlockedUsd / falseBlocks)
    : null;
  return {
    blocks,
    abuse_blocked: abuseBlocked,
    false_blocks: falseBlocks,
    abuse_missed: abuseMissed,
    dollars_saved_usd: round2(abuseBlockedUsd),
    dollars_lost_usd: round2(falseBlockUsd),
    dollars_saved_per_false_block: savedPerFalseBlock,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Thousands-separated $ formatting, matching the Python report. */
function money(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Serialize with alphabetically sorted keys, indented like Python's
 * json.dump(sort_keys=True, indent=2) — byte-identical to the Python build.
 */
function sortedStringify(value: unknown, indent = 0): string {
  const pad = " ".repeat(indent);
  const childPad = " ".repeat(indent + 2);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return (
      "[\n" +
      value
        .map((item) => `${childPad}${sortedStringify(item, indent + 2)}`)
        .join(",\n") +
      `\n${pad}]`
    );
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length === 0) return "{}";
    return (
      "{\n" +
      keys
        .map(
          (key) =>
            `${childPad}${JSON.stringify(key)}: ${sortedStringify(record[key], indent + 2)}`,
        )
        .join(",\n") +
      `\n${pad}}`
    );
  }
  return JSON.stringify(value);
}

function renderMarkdown(
  counts: Counts,
  funnel: PolicyResult,
  tuned: PolicyResult,
  maturityDays: number,
): string {
  const lines: string[] = [];
  lines.push("# Outcome backtest — summary", "");
  lines.push(
    `- Events analyzed: **${counts.events}** ` +
      `(${counts.events_with_both_decisions} with both decisions recorded)`,
  );
  if (counts.dropped_immature) {
    lines.push(
      `- Dropped as immature labels: **${counts.dropped_immature}** ` +
        `(signed up within the ${maturityDays}-day label window)`,
    );
  }
  lines.push(
    `- Abuse events: **${counts.abuse}** ($${counts.abuse_usd.toFixed(2)}) · ` +
      `Converted: **${counts.converted}** ($${counts.good_usd.toFixed(2)}) · ` +
      `Silent: **${counts.silent}**`,
    "",
  );
  lines.push(
    "| Policy | Blocks | Abuse blocked | False blocks | Abuse missed | Saved | Lost | $ saved / false-block |",
    "|---|---|---|---|---|---|---|---|",
  );
  for (const [label, policy] of [
    ["Funnel-blind (current)", funnel],
    ["Outcome-tuned", tuned],
  ] as const) {
    const per =
      policy.dollars_saved_per_false_block === null
        ? "no false blocks"
        : money(policy.dollars_saved_per_false_block);
    lines.push(
      `| ${label} | ${policy.blocks} | ${policy.abuse_blocked} | ` +
        `${policy.false_blocks} | ${policy.abuse_missed} | ` +
        `${money(policy.dollars_saved_usd)} | ${money(policy.dollars_lost_usd)} | ${per} |`,
    );
  }
  lines.push("");
  const funnelPer = funnel.dollars_saved_per_false_block;
  const tunedPer = tuned.dollars_saved_per_false_block;
  let verdict: string;
  if (funnelPer !== null && tunedPer !== null) {
    verdict =
      tuned.false_blocks < funnel.false_blocks && tuned.dollars_saved_usd >= funnel.dollars_saved_usd
        ? "The outcome-tuned policy blocks the same abuse dollars with fewer false blocks of paying customers."
        : "The outcome-tuned policy did not improve on the current rules in this data — that is the honest finding, not a bug.";
  } else {
    verdict =
      "Neither policy had a false-block-free sample, or one policy produced no false blocks; compare the rows directly.";
  }
  lines.push(`**Verdict:** ${verdict}`, "");
  lines.push(
    "**Honest limits:** this compares recorded decisions, not a live A/B — " +
      "the outcome-tuned policy is what your labels would have recommended. " +
      "Labels mature slowly (burn at 24-72h, conversions longer), so the " +
      `${maturityDays}-day maturity cutoff matters. Dropping the wrong cohort, ` +
      "or a mislabeled outcome, moves every number here.",
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rows = loadEvents(args.events);

  const maturityCutoff =
    args.labelMaturityDays > 0
      ? new Date(Date.now() - args.labelMaturityDays * 24 * 60 * 60 * 1000)
      : null;

  const events: Event[] = [];
  const counts: Counts = {
    events: 0,
    events_with_both_decisions: 0,
    dropped_immature: 0,
    abuse: 0,
    abuse_usd: 0,
    converted: 0,
    good_usd: 0,
    silent: 0,
  };
  for (const row of rows) {
    const event = buildEvent(row, maturityCutoff, args.falseBlockCostUsd);
    if (!event.mature) {
      counts.dropped_immature += 1;
      continue;
    }
    events.push(event);
    counts.events += 1;
    if (
      DECISIONS.has(event.decision_funnel_blind) &&
      DECISIONS.has(event.decision_chitmark)
    ) {
      counts.events_with_both_decisions += 1;
    }
    if (event.outcome === "abuse") {
      counts.abuse += 1;
      counts.abuse_usd += event.abuse_usd;
    } else if (event.outcome === "converted") {
      counts.converted += 1;
      counts.good_usd += event.good_usd;
    } else {
      counts.silent += 1;
    }
  }
  counts.abuse_usd = round2(counts.abuse_usd);
  counts.good_usd = round2(counts.good_usd);

  const funnel = evaluate(events, "funnel_blind");
  const tuned = evaluate(events, "chitmark");
  const funnelPer = funnel.dollars_saved_per_false_block;
  const tunedPer = tuned.dollars_saved_per_false_block;

  const report = renderMarkdown(counts, funnel, tuned, args.labelMaturityDays);
  console.log(report);

  const summary = {
    schema_version: 1,
    generated_by: "chitmark outcome-backtest",
    events: counts.events,
    events_with_both_decisions: counts.events_with_both_decisions,
    dropped_immature: counts.dropped_immature,
    abuse_events: counts.abuse,
    abuse_value_usd: counts.abuse_usd,
    converted_events: counts.converted,
    good_value_usd: counts.good_usd,
    silent_events: counts.silent,
    policies: {
      funnel_blind: funnel,
      outcome_tuned: tuned,
    },
    outcome_tuned_advantage: {
      false_blocks_removed: Math.max(
        funnel.false_blocks - tuned.false_blocks,
        0,
      ),
      dollars_saved_per_false_block_delta_usd:
        funnelPer !== null && tunedPer !== null
          ? round2(tunedPer - funnelPer)
          : null,
    },
    label_maturity_days: args.labelMaturityDays,
  };

  writeFileSync(args.out, `${sortedStringify(summary)}\n`);
  console.log(`\nsummary written to ${args.out}`);
}

await main();
