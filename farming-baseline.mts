#!/usr/bin/env node
/**
 * Farming baseline analysis — run this on your own machine.
 *
 * TypeScript port of farming-baseline.py. Zero dependencies, pure Node
 * built-ins, no network calls: nothing leaves your system. Output is a
 * JSON summary you can review and share, plus a printed markdown report.
 *
 * Run (Node >= 24, type stripping):  node farming-baseline.mts
 * Run (any Node >= 18):             npx tsx farming-baseline.mts
 *
 * Options:
 *   --signups      signups.csv     columns: user_id, signed_up_at, email_domain,
 *                                  ip (optional), credits_granted (optional)
 *   --usage        usage.csv       columns: user_id, used_at, credits_used
 *   --conversions  conversions.csv columns: user_id, converted_at (optional)
 *   --credit-cost-usd              0.002   cost of one credit in USD (blended
 *                                          infra cost or retail price — pick one
 *                                          and state it in the report)
 *   --domain-cluster-min           3       accounts sharing an email domain to
 *                                          flag a cluster
 *   --ip-cluster-min               3       accounts sharing an IP prefix to flag
 *   --cluster-ip-prefix            24      IPv4 prefix bits for clustering
 *   --burst-window-minutes         15      signups in a window this long sharing
 *                                          a flagged group count as a burst
 *   --burst-min                    3       signups needed in a window for a burst
 *   --ignore-domains               comma-separated public domains excluded from
 *                                  domain clustering
 *   --out                          summary.json
 *
 * Example:
 *   node farming-baseline.mts --signups signups.csv --usage usage.csv \
 *     --credit-cost-usd 0.002 --out summary.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const DEFAULT_IGNORE =
  "gmail.com,outlook.com,hotmail.com,yahoo.com,icloud.com,aol.com,proton.me,protonmail.com";

interface User {
  signedUpAt: Date;
  emailDomain: string;
  ip: string;
  creditsGranted: number;
}

interface CohortStats {
  accounts: number;
  credits_granted: number;
  credits_used: number;
  credits_used_72h: number;
  converted: number;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function loadCsv(path: string, required: string[]): Record<string, string>[] {
  const parsed = parseCsv(readFileSync(path, "utf8"));
  if (parsed.length === 0) {
    throw new Error(`${path}: empty file`);
  }
  const headers = parsed[0];
  const missing = required.filter((c) => !headers.includes(c));
  if (missing.length > 0) {
    throw new Error(`${path}: missing columns ${missing.join(", ")}; have ${headers.join(", ")}`);
  }
  return parsed
    .slice(1)
    .filter((row) => row[0]?.trim() !== "")
    .map((row) => {
      const rec: Record<string, string> = {};
      headers.forEach((h, i) => {
        rec[h] = (row[i] ?? "").trim();
      });
      return rec;
    });
}

function parseTs(value: string): Date {
  const s = value.trim();
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d;
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (m) {
    const dt = new Date(
      Date.UTC(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        Number(m[6]),
      ),
    );
    if (!isNaN(dt.getTime())) return dt;
  }
  throw new Error(`unparseable timestamp: ${value}`);
}

function ipPrefix(raw: string, bits: number): string | null {
  const s = raw.trim();
  if (s.includes(":")) {
    const parts = s.split(":");
    if (parts.length < 3) return null;
    return `${parts.slice(0, 3).join(":")}::/48`;
  }
  const octets = s.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((o) => isNaN(o) || o < 0 || o > 255)
  ) {
    return null;
  }
  const n = Math.min(bits, 32);
  const mask = n === 0 ? 0 : ((0xffffffff << (32 - n)) >>> 0);
  const int =
    (((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>>
      0);
  const net = (int & mask) >>> 0;
  return `${(net >>> 24) & 255}.${(net >>> 16) & 255}.${(net >>> 8) & 255}.${net & 255}/${n}`;
}

function hasBurst(times: Date[], windowMs: number, k: number): boolean {
  const sorted = [...times].sort((a, b) => a.getTime() - b.getTime());
  let j = 0;
  for (let i = 0; i < sorted.length; i++) {
    while (
      j < sorted.length &&
      sorted[j].getTime() - sorted[i].getTime() <= windowMs
    ) {
      j++;
    }
    if (j - i >= k) return true;
  }
  return false;
}

function cohortStats(
  userIds: Set<string>,
  creditsAll: Map<string, number>,
  credits72h: Map<string, number>,
  converted: Set<string>,
  byUser: Map<string, User>,
): CohortStats {
  return {
    accounts: userIds.size,
    credits_granted: round2(
      [...userIds].reduce(
        (sum, uid) => sum + (byUser.get(uid)?.creditsGranted ?? 0),
        0,
      ),
    ),
    credits_used: round2(
      [...userIds].reduce((sum, uid) => sum + (creditsAll.get(uid) ?? 0), 0),
    ),
    credits_used_72h: round2(
      [...userIds].reduce((sum, uid) => sum + (credits72h.get(uid) ?? 0), 0),
    ),
    converted: [...userIds].filter((uid) => converted.has(uid)).length,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function main(): void {
  const { values } = parseArgs({
    options: {
      signups: { type: "string" },
      usage: { type: "string" },
      conversions: { type: "string" },
      "credit-cost-usd": { type: "string" },
      "domain-cluster-min": { type: "string" },
      "ip-cluster-min": { type: "string" },
      "cluster-ip-prefix": { type: "string" },
      "burst-window-minutes": { type: "string" },
      "burst-min": { type: "string" },
      "ignore-domains": { type: "string" },
      out: { type: "string" },
    },
    allowPositionals: false,
  });

  const signupsPath = values.signups;
  const usagePath = values.usage;
  const outPath = values.out ?? "summary.json";
  if (!signupsPath || !usagePath) {
    console.error(
      "usage: node farming-baseline.mts --signups signups.csv --usage usage.csv [--credit-cost-usd N] [--out summary.json]",
    );
    process.exit(1);
  }

  const creditCostUsd = parseFloat(values["credit-cost-usd"] ?? "0") || 0;
  const domainClusterMin = parseInt(values["domain-cluster-min"] ?? "3", 10) || 3;
  const ipClusterMin = parseInt(values["ip-cluster-min"] ?? "3", 10) || 3;
  const clusterIpPrefix = parseInt(values["cluster-ip-prefix"] ?? "24", 10) || 24;
  const burstWindowMinutes = parseInt(values["burst-window-minutes"] ?? "15", 10) || 15;
  const burstMin = parseInt(values["burst-min"] ?? "3", 10) || 3;
  const ignore = new Set(
    (values["ignore-domains"] ?? DEFAULT_IGNORE)
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  );

  const signups = loadCsv(signupsPath, ["user_id", "signed_up_at"]);
  const usage = loadCsv(usagePath, ["user_id", "used_at", "credits_used"]);
  const conversions = values.conversions
    ? loadCsv(values.conversions, ["user_id", "converted_at"])
    : [];
  const converted = new Set(conversions.map((r) => r["user_id"]));

  const byUser = new Map<string, User>();
  for (const r of signups) {
    const granted = parseFloat(r["credits_granted"] ?? "");
    byUser.set(r["user_id"], {
      signedUpAt: parseTs(r["signed_up_at"]),
      emailDomain: (r["email_domain"] ?? "").toLowerCase(),
      ip: r["ip"] ?? "",
      creditsGranted: isNaN(granted) ? 0 : granted,
    });
  }

  let totalCredits = 0;
  const credits72h = new Map<string, number>();
  const creditsAll = new Map<string, number>();
  let orphanUsageRows = 0;
  for (const r of usage) {
    const amount = parseFloat(r["credits_used"]);
    if (isNaN(amount)) continue;
    const ts = parseTs(r["used_at"]);
    totalCredits += amount;
    const uid = r["user_id"];
    creditsAll.set(uid, (creditsAll.get(uid) ?? 0) + amount);
    const user = byUser.get(uid);
    if (!user) {
      orphanUsageRows++;
      continue;
    }
    if (ts.getTime() - user.signedUpAt.getTime() <= 72 * 3600 * 1000) {
      credits72h.set(uid, (credits72h.get(uid) ?? 0) + amount);
    }
  }

  const domains = new Map<string, Set<string>>();
  for (const [uid, u] of byUser) {
    if (u.emailDomain && !ignore.has(u.emailDomain)) {
      const set = domains.get(u.emailDomain) ?? new Set<string>();
      set.add(uid);
      domains.set(u.emailDomain, set);
    }
  }

  const prefixes = new Map<string, Set<string>>();
  for (const [uid, u] of byUser) {
    const pref = u.ip ? ipPrefix(u.ip, clusterIpPrefix) : null;
    if (pref) {
      const set = prefixes.get(pref) ?? new Set<string>();
      set.add(uid);
      prefixes.set(pref, set);
    }
  }

  const domainClusters = new Map(
    [...domains].filter(([, us]) => us.size >= domainClusterMin),
  );
  const ipClusters = new Map(
    [...prefixes].filter(([, us]) => us.size >= ipClusterMin),
  );

  const flagged = new Set<string>();
  for (const us of [...domainClusters.values(), ...ipClusters.values()]) {
    for (const uid of us) flagged.add(uid);
  }

  const windowMs = burstWindowMinutes * 60 * 1000;
  const groups: [string, Set<string>][] = [
    ...[...domainClusters].map(([d, us]) => [d, us] as [string, Set<string>]),
    ...[...ipClusters].map(([p, us]) => [`ip:${p}`, us] as [string, Set<string>]),
  ];
  const burstGroups = groups
    .filter(([, us]) =>
      hasBurst(
        [...us].map((uid) => byUser.get(uid)!.signedUpAt),
        windowMs,
        burstMin,
      ),
    )
    .map(([label]) => label);

  const flaggedStats = cohortStats(flagged, creditsAll, credits72h, converted, byUser);
  const clean = new Set([...byUser.keys()].filter((uid) => !flagged.has(uid)));
  const cleanStats = cohortStats(clean, creditsAll, credits72h, converted, byUser);

  const share = totalCredits ? round4(flaggedStats.credits_used / totalCredits) : 0;
  const dollarFigure = {
    credit_cost_usd: creditCostUsd,
    flagged_cost_usd: round2(flaggedStats.credits_used * creditCostUsd),
    flagged_cost_72h_usd: round2(flaggedStats.credits_used_72h * creditCostUsd),
    share_of_total_burn: share,
  };

  const summary = {
    generated_at: new Date().toISOString().slice(0, 19),
    inputs: {
      signups: signupsPath,
      usage: usagePath,
      conversions: values.conversions ?? null,
      cluster_ip_prefix: clusterIpPrefix,
      burst_window_minutes: burstWindowMinutes,
      burst_min: burstMin,
    },
    totals: {
      signups: byUser.size,
      accounts_with_usage: creditsAll.size,
      total_credits_used: round2(totalCredits),
      converted: converted.size,
      orphan_usage_rows: orphanUsageRows,
    },
    clusters: {
      domain_cluster_groups: domainClusters.size,
      ip_cluster_groups: ipClusters.size,
      burst_groups: burstGroups.length,
    },
    cohorts: { flagged: flaggedStats, clean: cleanStats },
    dollar_figure: dollarFigure,
  };

  writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log("# Farming baseline");
  console.log(
    `signups: ${summary.totals.signups} | accounts with usage: ${summary.totals.accounts_with_usage} | total credits used: ${summary.totals.total_credits_used} | converted: ${summary.totals.converted}`,
  );
  console.log(
    `flagged cohorts: ${domainClusters.size} domain + ${ipClusters.size} ip-prefix groups (${flagged.size} accounts) | burst groups: ${burstGroups.length}`,
  );
  if (domainClusters.size > 0) {
    console.log(
      "domain groups: " +
        [...domainClusters].map(([d, us]) => `${d} (${us.size})`).join(", "),
    );
  }
  if (ipClusters.size > 0) {
    console.log(
      "ip-prefix groups: " +
        [...ipClusters].map(([p, us]) => `${p} (${us.size})`).join(", "),
    );
  }
  if (burstGroups.length > 0) {
    console.log("burst groups: " + burstGroups.join(", "));
  }
  console.log(
    `${"cohort".padEnd(12)}${"accounts".padStart(10)}${"credits_used".padStart(16)}${"credits_72h".padStart(14)}${"converted".padStart(12)}`,
  );
  for (const [name, stats] of [
    ["flagged", flaggedStats],
    ["clean", cleanStats],
  ] as [string, CohortStats][]) {
    console.log(
      `${name.padEnd(12)}${String(stats.accounts).padStart(10)}${String(stats.credits_used).padStart(16)}${String(stats.credits_used_72h).padStart(14)}${String(stats.converted).padStart(12)}`,
    );
  }
  console.log(
    `dollar figure (at $${creditCostUsd}/credit): $${dollarFigure.flagged_cost_usd} (${(share * 100).toFixed(1)}% of total burn); 72h: $${dollarFigure.flagged_cost_72h_usd}`,
  );
  console.log(`summary written to ${outPath}`);
}

main();
