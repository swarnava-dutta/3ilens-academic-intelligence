// Roster CSV: the rows on screen (current filters and sort, every row - not only the first page),
// with the same pct / delta values. Numbers stay plain ASCII ("-0.4") so a spreadsheet reads them
// as numbers; the screen draws the same value with a typographic minus.
import { URGENCY_LABELS } from "@/components/shared/urgency-badge";
import type { RosterRow } from "@/lib/types";
import { isoDay, OUTCOME_LABELS, shortReason } from "./format";

const COLUMNS = [
  "name",
  "roll/ref",
  "batch",
  "latest test",
  "uploaded (IST)",
  "questions",
  "score",
  "total",
  "pct",
  "urgency",
  "moved by",
  "change vs previous paper",
  "trend",
  "previous test",
  "weakest topic",
  "weakest %",
  "exam technique",
  "actions since latest paper",
  "action since latest paper",
  "most recent action (any date)",
  "its outcome",
  "newer paper outside filter",
  "demo",
];

/** RFC 4180 field; a leading = + - @ is prefixed with ' so a spreadsheet never runs it as a formula. */
function field(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  const numeric = /^[+-]?\d+(\.\d+)?$/.test(text);
  if (!numeric && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const one = (n: number) => n.toFixed(1);
const marks = (n: number) => String(Number(n.toFixed(2)));

function trendText(r: RosterRow): string {
  if (!r.previous) return "";
  if (!r.previous.comparable) return "different kind of test (not a trend)";
  return r.trend ?? "";
}

function techniqueText(r: RosterRow): string {
  const nm = r.negative_marking;
  if (!nm) return "";
  return nm.verdict === "guessing" ? "wrong answers costing marks" : nm.verdict === "skipping" ? "skipping too many" : "working";
}

export function rosterCsv(rows: RosterRow[]): string {
  const lines = [COLUMNS.join(",")];
  for (const r of rows) {
    const l = r.latest;
    const weakest = r.topics[0];
    const last = r.actions.last;
    const since = r.actions.since_latest > 0 && last ? `${last.topic} (${isoDay(last.applied_at)})` : l && l.urgency !== "on_track" ? "none yet" : "";
    lines.push(
      [
        r.student_name,
        r.student_ref,
        r.batch.name,
        l ? `${l.test_name} ${l.test_version}`.trim() : "",
        l ? isoDay(l.date) : "",
        l ? l.questions : "",
        l ? marks(l.score) : "",
        l ? marks(l.total_marks) : "",
        l ? one(l.pct) : "",
        l ? URGENCY_LABELS[l.urgency] : r.pending ? "Not graded" : "",
        shortReason(r),
        r.delta_pct === null ? "" : (r.delta_pct > 0 ? "+" : "") + one(r.delta_pct),
        trendText(r),
        r.previous ? r.previous.test_name : "",
        weakest ? weakest.topic : "",
        weakest ? one(weakest.mastery) : "",
        techniqueText(r),
        l ? r.actions.since_latest : "",
        since,
        last ? `${last.topic} (${isoDay(last.applied_at)})` : "",
        last
          ? `${OUTCOME_LABELS[last.outcome_status]}${last.mastery_change !== null ? ` ${last.mastery_change > 0 ? "+" : ""}${one(last.mastery_change)}` : ""}`
          : "",
        r.newer ? `${r.newer.test_name} ${one(r.newer.pct)}% (${isoDay(r.newer.date)})` : "",
        r.is_demo ? "yes" : "no",
      ]
        .map(field)
        .join(","),
    );
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** Save the CSV through a temporary object URL (nothing leaves the browser). */
export function downloadCsv(rows: RosterRow[], filename: string) {
  const blob = new Blob([rosterCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
