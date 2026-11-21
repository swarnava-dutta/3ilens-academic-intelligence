"use client";

import { BarList, ChartFrame, Scatter, StackedBars, Waterfall } from "@/components/charts";
import { IllustrativePill } from "@/components/shared/illustrative-pill";
import type { Result } from "@/lib/types";
import { fmtNumber, fmtRoi } from "../format";
import { Note, pct, round1, signedPts } from "./shared";

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
  return (
    <ChartFrame
      title={title}
      takeaway={
        below
          ? `${below} of ${topics.length} topics are below target (dark tick); the weakest is ${topics[0].topic} at ${pct(topics[0].mastery)}.`
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
          ? `${weak.length} of ${topics.length} topics are below ${WEAK_MASTERY}% mastery and at or above the median exam weightage (${fmtNumber(split, 2)}%): ${weak.join(", ")}.`
          : `No topic is both below ${WEAK_MASTERY}% mastery and at or above the median exam weightage.`) +
        " Marker size is effort hours."
      }
      legend={
        focus.size && hasContext
          ? [
              { label: "Top 5 by ROI", series: 1 },
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

export function ProjectedGain({ result }: { result: Result }) {
  const title = "Projected gain";
  const plan = result.study_plan;
  const ps = plan.projected_score;
  const marks = new Map(result.topic_mastery.map((t) => [t.topic, t.max_marks]));
  const total = result.topic_mastery.reduce((s, t) => s + t.max_marks, 0);
  // The projected score's arithmetic: this window's share of each topic's gap, weighted by its marks.
  const steps = plan.focus
    .slice(0, 5)
    .map((t) => {
      const share = t.effort_hours > 0 ? Math.min(1, t.allocated_hours / t.effort_hours) : 0;
      const gain = total ? ((marks.get(t.topic) ?? 0) * share * Math.max(0, t.target_mastery - t.mastery)) / total : 0;
      return { label: t.topic, value: round1(gain) };
    })
    .filter((s) => s.value > 0);
  if (!steps.length || ps.expected <= ps.current) {
    return (
      <ChartFrame title={title}>
        <Note>No projected gain: no focus topic is below target.</Note>
      </ChartFrame>
    );
  }
  const running = steps.map((_, i) => round1(steps.slice(0, i + 1).reduce((s, x) => s + x.value, ps.current)));
  const end = running[running.length - 1];
  const biggest = steps.reduce((m, s) => (s.value > m.value ? s : m));
  return (
    <ChartFrame
      title={title}
      takeaway={
        `Working the top ${steps.length === 1 ? "topic" : `${steps.length} topics`} could take this paper from ${pct(ps.current)} to ${pct(end)} ` +
        `(range ${pct(ps.low)}–${pct(ps.high)}); the biggest step is ${biggest.label} (${signedPts(biggest.value)}).`
      }
      table={{
        columns: ["Step", "Change (pts)", "Running total %"],
        rows: [
          ["Current score", ps.current, ps.current],
          ...steps.map((s, i) => [s.label, s.value, running[i]]),
          ["Projected score", round1(end - ps.current), end],
        ],
      }}
    >
      <Waterfall start={{ label: "Current score", value: ps.current }} steps={steps} endLabel="Projected score" unit="%" />
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
  const minutes = new Map<string, number>();
  for (const d of days) for (const b of d.blocks) minutes.set(b.topic, (minutes.get(b.topic) ?? 0) + b.minutes);
  const ranked = [...minutes].sort((a, b) => b[1] - a[1]).map(([topic]) => topic);
  const OTHER = "Other topics";
  const names = ranked.length <= 3 ? ranked : [ranked[0], ranked[1], OTHER];
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
  const totalH = round1([...minutes.values()].reduce((s, m) => s + m, 0) / 60);
  return (
    <ChartFrame
      title={title}
      takeaway={
        `${fmtNumber(totalH)} h planned over ${days.length} days; ${ranked[0]} takes the most (${fmtNumber(round1(minutes.get(ranked[0])! / 60))} h)` +
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
      <StackedBars rows={rows} seriesOrder={names} unit=" h" />
    </ChartFrame>
  );
}
