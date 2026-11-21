"use client";

import { BarList, ChartFrame, Columns, HeatStrip } from "@/components/charts";
import { BLOOM_LABELS } from "@/components/shared/bloom-badge";
import type { QuestionAccuracy, Result } from "@/lib/types";
import { fmtNumber, ratioPct } from "../format";
import { Note, pct, round1 } from "./shared";

const markTone = (p: number) => (p >= 50 ? "default" : "warning");

export function QuestionMarks({ result }: { result: Result }) {
  const qs = [...result.question_evaluations].sort((a, b) => a.question - b.question);
  if (!qs.length) {
    return (
      <ChartFrame title="Marks by question">
        <Note>No question-level marks were recorded for this result.</Note>
      </ChartFrame>
    );
  }
  const full = qs.filter((q) => q.estimated_marks >= q.max_marks).length;
  const lost = (q: (typeof qs)[number]) => q.max_marks - q.estimated_marks;
  const maxLost = Math.max(...qs.map(lost));
  const worst = qs.filter((q) => lost(q) === maxLost);
  const read = qs.filter((q) => q.outcome !== "BLANK");
  const threshold = result.extraction.threshold * 100;
  const low = read.filter((q) => q.confidence * 100 < threshold);
  const least = read.length ? read.reduce((w, q) => (q.confidence < w.confidence ? q : w)) : null;

  return (
    <div className="space-y-6">
      <ChartFrame
        title="Marks by question"
        takeaway={
          `Full marks on ${full} of ${qs.length} questions` +
          (full === qs.length
            ? "."
            : worst.length === 1
              ? `; most marks lost on Q${worst[0].question} ${worst[0].topic} (${fmtNumber(worst[0].estimated_marks)} of ${fmtNumber(worst[0].max_marks)}).`
              : `; the largest loss on one question is ${fmtNumber(maxLost)} mark${maxLost === 1 ? "" : "s"}, on ${worst.length} questions.`)
        }
        table={{
          columns: ["Question", "Topic", "Marks", "Out of", "%"],
          rows: qs.map((q) => [
            `Q${q.question}`,
            q.topic,
            q.estimated_marks,
            q.max_marks,
            round1(ratioPct(q.estimated_marks, q.max_marks)),
          ]),
        }}
      >
        <BarList
          items={qs.map((q) => ({
            label: `Q${q.question} ${q.topic}`,
            value: Math.max(0, q.estimated_marks),
            max: q.max_marks,
            tone: markTone(ratioPct(q.estimated_marks, q.max_marks)),
            valueLabel: `${fmtNumber(q.estimated_marks)} / ${fmtNumber(q.max_marks)}`,
          }))}
        />
        {qs.some((q) => markTone(ratioPct(q.estimated_marks, q.max_marks)) === "warning") ? (
          <p className="text-xs text-slate-500">Amber bars scored under half the marks.</p>
        ) : null}
      </ChartFrame>

      <ChartFrame
        title={result.voice ? "Transcript confidence by question" : "Reading confidence by question"}
        takeaway={
          least
            ? `${low.length ? `${low.length} of ${read.length} answers` : "No answer"} read below the ${pct(threshold)} review threshold; ` +
              `lowest Q${least.question} at ${pct(least.confidence * 100)}.`
            : undefined
        }
        table={{
          columns: ["Question", "Confidence %"],
          rows: read.map((q) => [`Q${q.question}`, round1(q.confidence * 100)]),
        }}
      >
        {read.length ? (
          <div className="space-y-2">
            <HeatStrip
              cells={read.map((q) => ({ label: `Q${q.question}`, value: q.confidence * 100 }))}
              domain={[50, 100]}
              format={(v) => `${Math.round(v)}%`}
            />
            {qs.length > read.length ? (
              <p className="text-xs text-slate-500">Blank answers are left out.</p>
            ) : null}
          </div>
        ) : (
          <Note>Every answer is blank, so there is nothing to read.</Note>
        )}
      </ChartFrame>
    </div>
  );
}

export function BloomAccuracy({ result }: { result: Result }) {
  const title = "Accuracy by thinking skill";
  const buckets = (result.patterns.bloom_profile ?? [])
    .filter((b) => b.accuracy !== null && b.questions > 0)
    .sort((a, b) => a.level.localeCompare(b.level));
  if (!buckets.length) {
    return (
      <ChartFrame title={title}>
        <Note>No Bloom levels are tagged on this paper&apos;s questions.</Note>
      </ChartFrame>
    );
  }
  const items = buckets.map((b) => ({ label: `${b.level} ${BLOOM_LABELS[b.level]}`, value: round1((b.accuracy ?? 0) * 100) }));
  const top = Math.max(...items.map((i) => i.value));
  const bottom = Math.min(...items.map((i) => i.value));
  const at = (v: number) => `${items.filter((i) => i.value === v).map((i) => i.label).join(" and ")} (${pct(v)})`;
  const takeaway =
    items.length === 1
      ? `All tagged questions are ${items[0].label}: ${pct(items[0].value)} of the marks.`
      : top === bottom
        ? `Every level at ${pct(top)}.`
        : `Strongest at ${at(top)}, weakest at ${at(bottom)}.`;
  return (
    <ChartFrame
      title={title}
      takeaway={takeaway}
      table={{
        columns: ["Level", "Questions", "Marks", "Out of", "Accuracy %"],
        rows: buckets.map((b, i) => [items[i].label, b.questions, b.marks, b.max_marks, items[i].value]),
      }}
    >
      <Columns items={items} domain={[0, 100]} unit="%" />
    </ChartFrame>
  );
}

const mean = (qs: QuestionAccuracy[]) => (qs.reduce((s, q) => s + q.accuracy, 0) / qs.length) * 100;
const span = (qs: QuestionAccuracy[]) =>
  qs.length === 1 ? `Q${qs[0].question}` : `Q${qs[0].question}–Q${qs[qs.length - 1].question}`;

export function Stamina({ result }: { result: Result }) {
  const title = "Accuracy through the paper";
  const f = result.patterns.fatigue;
  const series = [...(f?.series ?? [])].sort((a, b) => a.question - b.question);
  const late = series.filter((q) => q.final_third);
  const rest = series.filter((q) => !q.final_third);
  if (!f || !late.length || rest.length < 2) {
    return (
      <ChartFrame title={title}>
        <Note>Shown for papers with six or more questions.</Note>
      </ChartFrame>
    );
  }
  const half = Math.ceil(rest.length / 2);
  const groups = [
    { name: "Early", qs: rest.slice(0, half) },
    { name: "Middle", qs: rest.slice(half) },
    { name: "Late", qs: late },
  ];
  const items = groups.map((g) => ({ label: `${g.name} ${span(g.qs)}`, value: round1(mean(g.qs)) }));
  const before = pct(round1(f.early_accuracy * 100));
  const after = pct(round1(f.late_accuracy * 100));
  const takeaway = f.flagged
    ? `Accuracy falls from ${before} to ${after} in ${span(late)}; flagged as possible end-of-paper fatigue.`
    : `${span(late)} at ${after} against ${before} earlier; no fatigue flag at the default threshold.`;
  return (
    <ChartFrame
      title={title}
      takeaway={takeaway}
      table={{
        columns: ["Part", "Questions", "Accuracy %"],
        rows: groups.map((g, i) => [g.name, span(g.qs), items[i].value]),
      }}
    >
      <Columns items={items} domain={[0, 100]} unit="%" />
    </ChartFrame>
  );
}
