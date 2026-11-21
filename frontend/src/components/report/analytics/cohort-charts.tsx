"use client";

import { ChartFrame, Dumbbell, Histogram, LineChart } from "@/components/charts";
import type { Cohort, Result } from "@/lib/types";
import { fmtISTDate } from "../format";
import { Note, pct, round1, signedPts } from "./shared";

export type CohortState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: Cohort };

/** The cohort when it has other graded students to compare with, else the sentence to show instead. */
function peers(cohort: CohortState): Cohort | string {
  if (cohort.status === "loading") return "Loading the batch comparison…";
  if (cohort.status === "error") return `Batch comparison unavailable: ${cohort.message}`;
  if (cohort.data.completed < 2) return "The batch comparison appears once other students on this test are graded.";
  return cohort.data;
}

/** Quiet note when a real student's batch average leans on sample records. */
function SampleNote({ cohort, result }: { cohort: Cohort; result: Result }) {
  if (result.submission.is_demo || !cohort.demo_count) return null;
  return (
    <p className="text-xs text-slate-500">
      Batch includes {cohort.demo_count} sample record{cohort.demo_count === 1 ? "" : "s"}.
    </p>
  );
}

export function CohortComparison({ result, cohort }: { result: Result; cohort: CohortState }) {
  const title = "You vs the batch";
  const c = peers(cohort);
  const avg = typeof c === "string" ? new Map<string, number>() : new Map(c.topic_mastery.map((t) => [t.topic, t.mastery]));
  const rows = result.topic_mastery
    .filter((t) => avg.has(t.topic))
    .map((t) => ({ label: t.topic, a: t.mastery, b: avg.get(t.topic)! }));
  if (typeof c === "string" || !rows.length) {
    return (
      <ChartFrame title={title}>
        <Note>{typeof c === "string" ? c : "No topic on this test matches the batch's topics."}</Note>
      </ChartFrame>
    );
  }
  const above = rows.filter((r) => r.a > r.b).length;
  const widest = rows.reduce((m, r) => (Math.abs(r.a - r.b) > Math.abs(m.a - m.b) ? r : m));
  return (
    <ChartFrame
      title={title}
      takeaway={
        `Above the batch average on ${above} of ${rows.length} topics; the widest gap is ${widest.label} ` +
        `(${signedPts(round1(widest.a - widest.b))}). Average of ${c.completed} graded students.`
      }
      table={{
        columns: ["Topic", "This student %", "Batch average %", "Difference (pts)"],
        rows: rows.map((r) => [r.label, r.a, r.b, round1(r.a - r.b)]),
      }}
    >
      <Dumbbell rows={rows} aLabel="This student" bLabel="Batch average" domain={[0, 100]} unit="%" />
      <SampleNote cohort={c} result={result} />
    </ChartFrame>
  );
}

/** Index of the "40-60%" style band holding `p`; equal-width bands when the labels don't parse. */
function bandOf(labels: string[], p: number) {
  const i = labels.findIndex((label, k) => {
    const m = /(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/.exec(label);
    return m ? p >= Number(m[1]) && (p < Number(m[2]) || (k === labels.length - 1 && p <= Number(m[2]))) : false;
  });
  return i >= 0 ? i : Math.min(labels.length - 1, Math.max(0, Math.floor(p / (100 / labels.length))));
}

export function ScorePosition({ result, cohort }: { result: Result; cohort: CohortState }) {
  const title = "Where the score sits";
  const c = peers(cohort);
  if (typeof c === "string" || !c.score_distribution.length) {
    return (
      <ChartFrame title={title}>
        <Note>{typeof c === "string" ? c : "The batch has no score distribution yet."}</Note>
      </ChartFrame>
    );
  }
  const bins = c.score_distribution;
  const marked = bandOf(
    bins.map((b) => b.label),
    result.percentage,
  );
  const rank = c.ranking.find((r) => r.submission_id === result.submission.id)?.rank;
  const average = c.average_score !== null && c.total_marks ? (c.average_score / c.total_marks) * 100 : null;
  return (
    <ChartFrame
      title={title}
      takeaway={
        `Scored ${pct(result.percentage)}, in the ${bins[marked].label} band` +
        (rank ? `; ranked ${rank} of ${c.ranking.length}` : "") +
        (average !== null ? `; batch average ${pct(round1(average))}.` : ".")
      }
      table={{ columns: ["Band", "Students"], rows: bins.map((b) => [b.label, b.count]) }}
    >
      <Histogram bins={bins} markerIndex={marked} markerLabel="This student" />
      <SampleNote cohort={c} result={result} />
    </ChartFrame>
  );
}

const SHORT = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

export function ScoreTrend({ result }: { result: Result }) {
  const title = "Score trend";
  const tests = [...result.history].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  if (tests.length < 2) {
    return (
      <ChartFrame title={title}>
        <Note>The trend appears after a second test.</Note>
      </ChartFrame>
    );
  }
  // x labels must be unique: a second test on the same day gets a suffix.
  const seen = new Map<string, number>();
  const xs = tests.map((h) => {
    const t = Date.parse(h.date);
    const day = Number.isNaN(t) ? h.rubric_name : SHORT.format(t);
    const n = (seen.get(day) ?? 0) + 1;
    seen.set(day, n);
    return n > 1 ? `${day} (${n})` : day;
  });
  const first = tests[0];
  const last = tests[tests.length - 1];
  return (
    <ChartFrame
      title={title}
      takeaway={
        `${pct(first.pct)} on ${fmtISTDate(first.date)} to ${pct(last.pct)} on ${fmtISTDate(last.date)} ` +
        `(${signedPts(round1(last.pct - first.pct))} over ${tests.length} tests); the tests are not equated for difficulty.`
      }
      table={{
        columns: ["Date", "Test", "Score", "Out of", "%"],
        rows: tests.map((h) => [
          fmtISTDate(h.date),
          `${h.rubric_name}${h.current ? " (this report)" : ""}`,
          h.score,
          h.total_marks,
          h.pct,
        ]),
      }}
    >
      <LineChart
        series={[
          {
            name: result.submission.student_name || "This student",
            series: 1,
            points: tests.map((h, i) => ({ x: xs[i], y: h.pct })),
          },
        ]}
        yDomain={[0, 100]}
        unit="%"
      />
    </ChartFrame>
  );
}
