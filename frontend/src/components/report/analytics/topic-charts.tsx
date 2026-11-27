"use client";

import { BarList, ChartFrame, Scatter, StackedBars, Waterfall } from "@/components/charts";
import { IllustrativePill } from "@/components/shared/illustrative-pill";
import type { Result } from "@/lib/types";
import { fmtNumber, fmtPct1, fmtRoi, orJoin, plannedMinutesText } from "../format";
import { Note, pct, round1 } from "./shared";

/** Defaults of the ROI engine (backend analytics.py). */
const TARGET_MASTERY = 85;
const WEAK_MASTERY = 70;
const EXAM_TOTAL_MARKS = 720;

const Tag = ({ label }: { label: string }) => (
  <div>
    <IllustrativePill label={label} />
  </div>
);

export function TopicTargets({ result }: { result: Result }) {
  const title = "Topic mastery vs target";
  const topics = [...result.topic_mastery].sort((a, b) => a.mastery - b.mastery || a.topic.localeCompare(b.topic));
  if (!topics.length) {
    return (
      <ChartFrame title={title}>
        <Note>No topic-level marks were recorded for this result.</Note>
      </ChartFrame>
    );
  }
  const planned = new Map(result.study_plan.topics.map((t) => [t.topic, t.target_mastery]));
  const target = (topic: string) => planned.get(topic) || TARGET_MASTERY;
  const below = topics.filter((t) => t.mastery < target(t.topic)).length;
  const lowest = topics.filter((t) => t.mastery === topics[0].mastery).length;
  return (
    <ChartFrame
      title={title}
      takeaway={
        below
          ? `${below} of ${topics.length} topics are below target (dark tick); ` +
            (lowest === 1
              ? `the weakest is ${topics[0].topic} at ${pct(topics[0].mastery)}.`
              : `${lowest} topics tie for weakest at ${pct(topics[0].mastery)}.`)
          : `All ${topics.length} topics are at or above target (dark tick).`
      }
      table={{
        columns: ["Topic", "Mastery %", "Target %", "Marks", "Out of"],
        rows: topics.map((t) => [t.topic, t.mastery, target(t.topic), t.score, t.max_marks]),
      }}
    >
      <BarList
        items={topics.map((t) => ({
          label: t.topic,
          value: t.mastery,
          max: 100,
          target: target(t.topic),
          valueLabel: pct(t.mastery),
        }))}
        unit="%"
      />
    </ChartFrame>
  );
}

export function FocusQuadrant({ result }: { result: Result }) {
  const title = "Where to focus";
  const plan = result.study_plan;
  const topics = plan.topics;
  if (!topics.length) {
    return (
      <ChartFrame title={title}>
        <Note>No study plan is available for this result.</Note>
      </ChartFrame>
    );
  }
  const weight = (marks: number) => Math.round((marks / EXAM_TOTAL_MARKS) * 10000) / 100;
  const weights = topics.map((t) => weight(t.exam_marks)).sort((a, b) => a - b);
  const mid = weights.length >> 1;
  const split = weights.length % 2 ? weights[mid] : (weights[mid - 1] + weights[mid]) / 2;
  const focus = new Set(plan.focus.slice(0, 5).map((t) => t.topic));
  const weak = topics.filter((t) => t.mastery < WEAK_MASTERY && weight(t.exam_marks) >= split).map((t) => t.topic);
  const hasContext = topics.some((t) => !focus.has(t.topic));
  return (
    <ChartFrame
      title={title}
      takeaway={
        (weak.length
          ? `${weak.length} of ${topics.length} topics are below ${WEAK_MASTERY}% mastery and at or above the median exam weightage (${fmtNumber(split, 2)}%): ` +
            (weak.length > 4 ? `${weak.slice(0, 3).join(", ")} and ${weak.length - 3} more.` : `${weak.join(", ")}.`)
          : `No topic is both below ${WEAK_MASTERY}% mastery and at or above the median exam weightage.`) +
        " Marker size is effort hours."
      }
      legend={
        focus.size && hasContext
          ? [
              { label: "Study plan focus", series: 1 },
              { label: "Other topics", series: "context" },
            ]
          : undefined
      }
      table={{
        columns: ["Topic", "Mastery %", "Exam weightage %", "Effort h", "ROI"],
        rows: topics.map((t) => [t.topic, t.mastery, weight(t.exam_marks), t.effort_hours, fmtRoi(t.roi)]),
      }}
    >
      <Scatter
        points={topics.map((t) => ({
          id: t.topic,
          label: t.topic,
          x: t.mastery,
          y: weight(t.exam_marks),
          size: t.effort_hours,
          tone: focus.has(t.topic) || !focus.size ? "default" : "context",
        }))}
        xLabel="Mastery %"
        yLabel="Exam weightage %"
        // Padded so markers at 0% / 100% mastery or at the top weight stay inside the plot.
        xDomain={[-5, 108]}
        yDomain={[0, Math.max(1, Math.ceil(weights[weights.length - 1] * 1.1))]}
        quadrants={{
          x: WEAK_MASTERY,
          y: split,
          labels: ["Priority focus", "Maintain", "Deprioritise", "No action"],
        }}
      />
      <Tag label="Illustrative weightage" />
    </ChartFrame>
  );
}

/**
 * The projected score as steps in marks on this paper (402 → +89 → +81 → +40 → 612 of 720, 85.0%): each
 * focus topic's gap to its target from the unrounded score / max, times this window's share of its
 * effort. The steps add up exactly to the projected score, so the bars, the table and the takeaway agree.
 */
export function projectedSteps(result: Result): { label: string; value: number }[] {
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
