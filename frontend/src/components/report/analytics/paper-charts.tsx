"use client";

import { BarList, CellGrid, ChartFrame, Columns, Dumbbell, HeatStrip } from "@/components/charts";
import { CONTEXT, CRITICAL, INK, Legend, SERIES } from "@/components/charts/core";
import { BLOOM_LABELS } from "@/components/shared/bloom-badge";
import type { QuestionAccuracy, QuestionEvaluation, Result } from "@/lib/types";
import { fmtNumber, ratioPct } from "../format";
import { Note, pct, round1 } from "./shared";

const markTone = (p: number) => (p >= 50 ? "default" : "warning");

/** Above 40 questions, marks by question is an outcome grid instead of a bar per question. */
export const GRID_FROM = 41;

const KINDS = {
  right: { label: "right", fill: SERIES[0], ink: "#fff" },
  partial: { label: "part marks", fill: "#cdeef4", ink: INK },
  wrong: { label: "wrong", fill: CRITICAL, ink: "#fff" },
  blank: { label: "blank", fill: CONTEXT, ink: INK },
  bonus: { label: "bonus", fill: SERIES[2], ink: "#fff" },
};
type Kind = keyof typeof KINDS;

const kindOf = (q: QuestionEvaluation): Kind =>
  q.bonus
    ? "bonus"
    : q.outcome === "FULL"
      ? "right"
      : q.outcome === "BLANK"
        ? "blank"
        : q.outcome === "PARTIAL"
          ? "partial"
          : "wrong";

/** "18 right · 8 wrong (−8) · 19 blank"; part marks and bonus only when there are some. */
const countLine = (n: (k: Kind) => number, lost: number) =>
  (Object.keys(KINDS) as Kind[])
    .filter((k) => n(k) || k === "right" || k === "wrong" || k === "blank")
    .map((k) => `${n(k)} ${KINDS[k].label}${k === "wrong" && lost ? ` (−${fmtNumber(lost)})` : ""}`)
    .join(" · ");

/** Questions per subject (subjects from the topics), in paper order; a question no topic lists goes under "Other". */
function bySubject(result: Result, qs: QuestionEvaluation[]) {
  const subjectOf = new Map(result.topic_mastery.flatMap((t) => t.questions.map((n) => [n, t.subject] as const)));
  const groups = new Map<string, QuestionEvaluation[]>();
  for (const q of qs) {
    const s = subjectOf.get(q.question) || "Other";
    groups.set(s, [...(groups.get(s) ?? []), q]);
  }
  return [...groups].map(([subject, items]) => {
    // MCQ attempts; a bonus carries no penalty risk, so it is left out (as in the negative-marking profile).
    const mcq = items.filter((q) => q.question_type === "mcq" && !q.bonus && kindOf(q) !== "blank");
    return {
      subject,
      items,
      n: (k: Kind) => items.filter((q) => kindOf(q) === k).length,
      lost: items.reduce((s, q) => s + (q.penalty || 0), 0),
      score: items.reduce((s, q) => s + q.estimated_marks, 0),
      max: items.reduce((s, q) => s + q.max_marks, 0),
      attempted: mcq.length,
      right: mcq.filter((q) => kindOf(q) === "right").length,
    };
  });
}

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
  // Questions with something read off the sheet (a blank bonus question reads FULL but has nothing).
  const read = qs.filter((q) => q.outcome !== "BLANK" && !(q.bonus && !q.student_answer.trim()));
  const threshold = result.extraction.threshold * 100;
  const low = read.filter((q) => q.confidence * 100 < threshold);
  const least = read.length ? read.reduce((w, q) => (q.confidence < w.confidence ? q : w)) : null;

  const grid = qs.length >= GRID_FROM;
  const groups = grid ? bySubject(result, qs) : [];
  const kinds = (Object.keys(KINDS) as Kind[]).filter((k) => qs.some((q) => kindOf(q) === k));
  const mostBlank = groups.reduce((m, g) => (g.n("blank") > m.n("blank") ? g : m), groups[0]);
  const total = (k: Kind) => qs.filter((q) => kindOf(q) === k).length;

  return (
    <div className="space-y-6">
      <ChartFrame
        title="Marks by question"
        takeaway={
          grid
            ? `${countLine(total, groups.reduce((s, g) => s + g.lost, 0))} of ${qs.length} questions` +
              (groups.length > 1 && mostBlank.n("blank")
                ? `; most blanks in ${mostBlank.subject} (${mostBlank.n("blank")}).`
                : ".")
            : `Full marks on ${full} of ${qs.length} questions` +
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
        {grid ? (
          <div className="space-y-3">
            <Legend items={kinds.map((k) => ({ label: KINDS[k].label, color: KINDS[k].fill }))} />
            {groups.map((g) => (
              <div key={g.subject} className="space-y-1.5">
                <p className="flex flex-wrap justify-between gap-x-3 text-xs text-slate-600">
                  <span>
                    <span className="font-semibold text-slate-800">{g.subject}</span> {countLine(g.n, g.lost)}
                  </span>
                  <span className="ml-auto tabular-nums">
                    {fmtNumber(g.score)} / {fmtNumber(g.max)} marks
                  </span>
                </p>
                <CellGrid
                  cells={g.items.map((q) => {
                    const k = KINDS[kindOf(q)];
                    const rows: [string, string][] = [["Outcome", k.label]];
                    if (q.question_type === "mcq") rows.push(["Marked", q.selected_option ?? "—"], ["Key", q.correct_option ?? "—"]);
                    rows.push(["Marks", `${fmtNumber(q.estimated_marks)} / ${fmtNumber(q.max_marks)}`]);
                    return { text: String(q.question), title: `Q${q.question} ${q.topic}`, fill: k.fill, ink: k.ink, rows };
                  })}
                />
              </div>
            ))}
          </div>
        ) : (
          <BarList
            items={qs.map((q) => ({
              label: `Q${q.question} ${q.topic}`,
              value: Math.max(0, q.estimated_marks),
              max: q.max_marks,
              tone: markTone(ratioPct(q.estimated_marks, q.max_marks)),
              valueLabel: `${fmtNumber(q.estimated_marks)} / ${fmtNumber(q.max_marks)}`,
            }))}
          />
        )}
        {!grid && qs.some((q) => markTone(ratioPct(q.estimated_marks, q.max_marks)) === "warning") ? (
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

/** MCQ answering per subject: accuracy when attempted and what wrong answers cost; nothing without negative marking. */
export function WrongAnswers({ result }: { result: Result }) {
  const nm = result.patterns?.negative_marking;
  const qs = [...result.question_evaluations].sort((a, b) => a.question - b.question);
  const groups = bySubject(result, qs).filter((g) => g.attempted);
  if (!nm || !groups.length) return null;
  const acc = (g: (typeof groups)[number]) => round1((g.right / g.attempted) * 100);
  const share = (v: number, g: (typeof groups)[number]) => round1(ratioPct(v, g.max));
  const lost = groups.reduce((s, g) => s + g.lost, 0);
  const breakEven = round1(nm.break_even * 100);
  const below = groups.filter((g) => acc(g) < breakEven);
  const list = (parts: string[]) =>
    parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  const takeaway =
    `Right on ${list(groups.map((g, i) => `${pct(acc(g))} ${i ? "in" : "of attempts in"} ${g.subject}`))}` +
    (below.length
      ? `; ${list(below.map((g) => g.subject))} ${below.length === 1 ? "is" : "are"} below the ${pct(breakEven)} break-even.`
      : `, ${groups.length === 1 ? "above" : "all above"} the ${pct(breakEven)} break-even.`) +
    (lost
      ? ` Wrong answers cost ${fmtNumber(lost)} mark${lost === 1 ? "" : "s"}: ${fmtNumber(result.total_score)} now, ` +
        `${fmtNumber(result.total_score + lost)} had they been left blank.`
      : " No marks were lost to wrong answers.");
  return (
    <ChartFrame
      title="Wrong answers by subject"
      takeaway={takeaway}
      table={{
        columns: ["Subject", "Attempted", "Right", "Accuracy %", "Marks lost", "Score", "Left blank instead", "Out of"],
        rows: groups.map((g) => [g.subject, g.attempted, g.right, acc(g), g.lost, g.score, g.score + g.lost, g.max]),
      }}
    >
      <Dumbbell
        rows={groups.map((g) => ({ label: g.subject, a: share(g.score, g), b: share(g.score + g.lost, g) }))}
        aLabel="Score now"
        bLabel="Wrong answers left blank"
        domain={[0, 100]}
        unit="%"
      />
    </ChartFrame>
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
