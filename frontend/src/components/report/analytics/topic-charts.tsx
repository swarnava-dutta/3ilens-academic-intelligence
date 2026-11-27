"use client";

import { ChartFrame, StackedBars, Waterfall } from "@/components/charts";
import { round1 } from "@/components/charts/core";
import { IllustrativePill } from "@/components/shared/illustrative-pill";
import type { Result } from "@/lib/types";
import { fmtNumber, fmtPct1, orJoin, plannedMinutesText } from "../format";
import { Note, pct } from "./shared";

const Tag = ({ label }: { label: string }) => (
  <div>
    <IllustrativePill label={label} />
  </div>
);

/**
 * The projected score as steps in marks on this paper (402 → +89 → +81 → +40 → 612 of 720, 85.0%): each
 * focus topic's gap to its target from the unrounded score / max, times this window's share of its
 * effort. The steps add up exactly to the projected score, so the bars, the table and the takeaway agree.
 */
function projectedSteps(result: Result): { label: string; value: number }[] {
  const own = new Map(result.topic_mastery.map((t) => [t.topic, t]));
  return result.study_plan.focus
    .slice(0, 5)
    .map((t) => {
      const row = own.get(t.topic);
      const max = row?.max_marks ?? 0;
      const share = t.effort_hours > 0 ? Math.min(1, t.allocated_hours / t.effort_hours) : 0;
      const gap = max > 0 ? Math.max(0, (t.target_mastery / 100) * max - (row?.score ?? 0)) : 0;
      return { label: t.topic, value: gap * share };
    })
    .filter((s) => s.value > 1e-9);
}

export function ProjectedGain({ result }: { result: Result }) {
  const title = "Projected gain";
  const ps = result.study_plan.projected_score;
  const total = result.total_marks;
  const start = result.total_score;
  const steps = projectedSteps(result);
  if (!steps.length || total <= 0) {
    return (
      <ChartFrame title={title}>
        <Note>No projected gain: no focus topic is below target.</Note>
      </ChartFrame>
    );
  }
  const marks = (v: number) => fmtNumber(Math.round(v * 100) / 100, 2);
  const pctOf = (v: number) => fmtPct1(v, total);
  const running = steps.map((_, i) => steps.slice(0, i + 1).reduce((s, x) => s + x.value, start));
  const end = running[running.length - 1];
  const biggest = steps.reduce((m, s) => (s.value > m.value ? s : m));
  return (
    <ChartFrame
      title={title}
      takeaway={
        `Working the top ${steps.length === 1 ? "topic" : `${steps.length} topics`} to target could take this paper from ` +
        `${marks(start)} to ${marks(end)}/${marks(total)} (${pctOf(start)} → ${pctOf(end)}; range ${pct(ps.low)}–${pct(ps.high)}); ` +
        `the biggest step is ${biggest.label} (+${marks(biggest.value)} marks).`
      }
      table={{
        columns: ["Step", "Change (marks)", "Running total (marks)", "Running total %"],
        rows: [
          ["Current score", marks(start), marks(start), pctOf(start)],
          ...steps.map((s, i) => [s.label, `+${marks(s.value)}`, marks(running[i]), pctOf(running[i])]),
          ["Projected score", `+${marks(end - start)}`, marks(end), pctOf(end)],
        ],
      }}
    >
      <Waterfall start={{ label: "Current score", value: start }} steps={steps} endLabel="Projected score" />
      <Tag label="Illustrative · not a calibrated forecast" />
    </ChartFrame>
  );
}

const DAY = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

export function PlanLoad({ result }: { result: Result }) {
  const title = "Study plan load";
  const days = result.study_plan.weekly_calendar.filter((d) => d.blocks.length);
  if (!days.length) {
    return (
      <ChartFrame title={title}>
        <Note>This plan has no weekly calendar.</Note>
      </ChartFrame>
    );
  }
  const CHECKPOINT = "Checkpoint mini-test";
  const minutes = new Map<string, number>();
  for (const d of days) for (const b of d.blocks) minutes.set(b.topic, (minutes.get(b.topic) ?? 0) + b.minutes);
  // Topics by minutes (the checkpoint is not a topic: its own series, last).
  const ranked = [...minutes].filter(([t]) => t !== CHECKPOINT).sort((a, b) => b[1] - a[1]).map(([topic]) => topic);
  const OTHER = "Other topics";
  const shownTopics = ranked.length <= 3 ? ranked : [ranked[0], ranked[1], OTHER];
  const names = minutes.has(CHECKPOINT) ? [...shownTopics, CHECKPOINT] : shownTopics;
  const bucket = (topic: string) => (names.includes(topic) ? topic : OTHER);
  const label = (d: (typeof days)[number]) => {
    const t = d.date ? Date.parse(d.date) : NaN;
    return Number.isNaN(t) ? `Day ${d.day}` : DAY.format(t);
  };
  const rows = days.map((d) => {
    const hours = new Map<string, number>();
    for (const b of d.blocks) hours.set(bucket(b.topic), (hours.get(bucket(b.topic)) ?? 0) + b.minutes / 60);
    return { label: label(d), segments: names.map((name) => ({ name, value: round1(hours.get(name) ?? 0) })) };
  });
  const planned = result.study_plan.planned_minutes_total ?? [...minutes.values()].reduce((s, m) => s + m, 0);
  const most = ranked.length ? (minutes.get(ranked[0]) ?? 0) : 0;
  const tied = ranked.filter((t) => minutes.get(t) === most);
  const lead = tied.length > 1 ? `${orJoin(tied).replace(/ or /, " and ")} take the most (${most} min each)` : `${ranked[0]} takes the most (${most} min)`;
  return (
    <ChartFrame
      title={title}
      takeaway={
        `${plannedMinutesText(planned)} planned over ${days.length} days; ${lead}` +
        (ranked.length > 3 ? `; ${ranked.length - 2} more topics are grouped as other.` : ".")
      }
      table={{
        columns: ["Day", ...names.map((n) => `${n} h`), "Total h"],
        rows: rows.map((r) => [
          r.label,
          ...r.segments.map((s) => s.value),
          round1(r.segments.reduce((s, x) => s + x.value, 0)),
        ]),
      }}
    >
      <StackedBars rows={rows} seriesOrder={names} unit=" h" rest={minutes.has(CHECKPOINT) ? CHECKPOINT : OTHER} />
    </ChartFrame>
  );
}
