import Link from "next/link";
import type { ReactNode } from "react";
import { BarList } from "@/components/charts";
import { BLOOM_LABELS } from "@/components/shared/bloom-badge";
import type { Cohort, StudentRiskRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FOCUS_RING, formatNumber, formatPct, lost, nOf, pct1, plural } from "./format";

const THRESHOLDS = "default - confirm with academic lead";
const LINK = cn("rounded-sm font-medium text-slate-800 hover:text-cyan-700 hover:underline", FOCUS_RING);

/** Accuracy as 0-100: the patterns API reports fractions (0-1). */
function accPct(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return value <= 1 ? value * 100 : value;
}

function Section({ summary, open, children }: { summary: ReactNode; open?: boolean; children: ReactNode }) {
  return (
    <details open={open} className="group border-b border-slate-200 py-3 last:border-b-0">
      <summary className={cn("cursor-pointer rounded-sm text-sm text-slate-700 marker:text-slate-500 hover:text-brand-navy", FOCUS_RING)}>
        {summary}
      </summary>
      <div className="mt-3 space-y-4 pl-4">{children}</div>
    </details>
  );
}

function Title({ children }: { children: ReactNode }) {
  return <span className="font-semibold text-slate-900">{children}</span>;
}

function SubHead({ children }: { children: ReactNode }) {
  return <h4 className="text-[13px] font-semibold text-slate-700">{children}</h4>;
}

/** Name + value on one line, the detail under it (fits a phone without sideways scroll). */
function People({
  rows,
  empty,
}: {
  rows: { id: number; name: string; value: string; detail?: string; tone?: "bad" | "neutral" }[];
  empty: string;
}) {
  if (!rows.length) return <p className="text-sm text-slate-600">{empty}</p>;
  return (
    <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
      {rows.map((r) => (
        <li key={r.id} className="px-3 py-1.5">
          <p className="flex items-baseline justify-between gap-3 text-sm">
            <Link href={`/report/${r.id}`} className={cn(LINK, "min-w-0 truncate")}>
              {r.name}
            </Link>
            <span className={cn("shrink-0 font-semibold tabular-nums", r.tone === "bad" ? "text-red-700" : "text-slate-800")}>
              {r.value}
            </span>
          </p>
          {r.detail ? <p className="mt-0.5 text-xs text-slate-600">{r.detail}</p> : null}
        </li>
      ))}
    </ul>
  );
}

function riskRows(rows: StudentRiskRow[], value: (r: StudentRiskRow) => string) {
  return rows.map((r) => ({ id: r.submission_id, name: r.student_name, value: value(r), detail: r.detail, tone: "bad" as const }));
}

/** Chapter rows as a compact grid: name, then the figures (wraps to two lines on a phone). */
function ChapterFigures({
  rows,
}: {
  rows: { topic: string; whole?: boolean; cells: { label: string; value: string; strong?: boolean }[] }[];
}) {
  return (
    <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
      {rows.map((r) => (
        <li key={r.topic} className="flex flex-col gap-0.5 px-3 py-1.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <span className="text-sm text-slate-800">
            {r.topic}
            {r.whole ? <span className="ml-1.5 text-xs text-slate-600">(whole subject, not tagged by chapter)</span> : null}
          </span>
          <span className="flex flex-wrap gap-x-4 text-xs tabular-nums text-slate-600">
            {r.cells.map((c) => (
              <span key={c.label}>
                {c.label} <span className={cn("text-slate-800", c.strong && "font-semibold text-red-700")}>{c.value}</span>
              </span>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Exam behaviour (NEET-specific): negative marking, skipping, end-of-paper fatigue and recall vs
 * application. One collapsible section each; the summary line carries the key fact.
 */
export function BehaviourTab({ cohort }: { cohort: Cohort }) {
  const attempt = cohort.attempt ?? null;
  const patterns = cohort.patterns;
  const rows = cohort.students_view ?? [];
  const fatigue = patterns?.fatigue ?? null;
  const transfer = patterns?.transfer ?? null;
  const over = patterns?.negative_marking?.students ?? [];

  if (!attempt && !fatigue && !transfer) {
    return (
      <p className="text-sm text-slate-600">
        No multiple-choice questions here, and no recall-vs-application pairs - nothing to show on exam behaviour.
      </p>
    );
  }

  const lostMost = [...rows]
    .filter((r) => r.negative_marks > 0)
    .sort((a, b) => b.negative_marks - a.negative_marks || a.student_name.localeCompare(b.student_name))
    .slice(0, 5);
  const skippers = rows
    .filter((r) => r.mcq_count > 0 && r.blanks / r.mcq_count >= 0.25)
    .sort((a, b) => b.blanks / b.mcq_count - a.blanks / a.mcq_count);
  const bloom = (patterns?.bloom_profile ?? []).filter((b) => b.questions > 0 && accPct(b.accuracy) !== null);
  // +4 / -1: the marks lost equal the wrong answers, so one figure says both.
  const oneForOne = attempt ? attempt.negative_marks_total === attempt.wrong : false;
  const blankRate = attempt ? attempt.blank_rate ?? Math.round((attempt.blanks / attempt.mcq_answers) * 1000) / 10 : null;
  const perStudent = attempt ? attempt.same_length !== false && attempt.students === (cohort.scope?.students ?? 0) : false;
  // Only the first section is open on arrival.
  const firstOpen = attempt ? "negative" : fatigue ? "fatigue" : "transfer";

  return (
    <div>
      {attempt ? (
        <Section
          open={firstOpen === "negative"}
          summary={
            <>
              <Title>Negative marking</Title> - {formatNumber(attempt.negative_marks_total)} marks lost
              {over.length ? `; ${plural(over.length, "student")} guessing below the 20% line` : ""}
            </>
          }
        >
          <p className="text-[13px] text-slate-600">
            NEET +4/−1: attempting pays off when a student is at least 20% sure of the answer (with 4 options, a pure guess
            still gains +0.25 on average). {plural(attempt.wrong, "wrong answer")} cost{" "}
            {formatNumber(attempt.negative_marks_total)} marks, {formatNumber(attempt.negative_per_student)} per student
            {attempt.students < (cohort.scope?.students ?? 0) ? ` (of the ${attempt.students} with MCQ papers)` : ""};{" "}
            {pct1(attempt.accuracy_attempted)} of attempts were right.
          </p>
          <div className="space-y-1.5">
            <SubHead>By chapter</SubHead>
            <ChapterFigures
              rows={attempt.by_topic
                .filter((t) => t.wrong > 0)
                .map((t) => ({
                  topic: t.topic,
                  whole: t.subject_level,
                  cells: [
                    oneForOne
                      ? { label: "wrong", value: `${t.wrong} (${lost(t.negative_marks)} marks)`, strong: t.negative_marks > 0 }
                      : { label: "wrong", value: String(t.wrong) },
                    ...(oneForOne ? [] : [{ label: "lost", value: lost(t.negative_marks), strong: t.negative_marks > 0 }]),
                    { label: "right when attempted", value: pct1(t.accuracy_attempted) },
                  ],
                }))}
            />
          </div>
          <div className="space-y-1.5">
            <SubHead>Lost most</SubHead>
            <People
              rows={lostMost.map((r) => ({
                id: r.submission_id,
                name: r.student_name,
                value: lost(r.negative_marks),
                detail: `${plural(r.wrong, "wrong answer")} of ${r.attempted} attempted · ${pct1(r.accuracy_attempted)} right when attempted`,
                tone: "bad",
              }))}
              empty="No student lost marks to wrong answers."
            />
          </div>
          {over.length ? (
            <div className="space-y-1.5">
              <SubHead>Guessing below the 20% line (wrong answers outweigh the right ones in a chapter)</SubHead>
              <People rows={riskRows(over, (r) => lost(r.value))} empty="" />
            </div>
          ) : null}
        </Section>
      ) : null}

      {attempt ? (
        <Section
          summary={
            <>
              <Title>Skipping</Title> -{" "}
              {perStudent
                ? `${formatNumber(attempt.blanks_per_student)} blanks per student (${pct1(blankRate)} of answers)`
                : `${pct1(blankRate)} of answers left blank`}
            </>
          }
        >
          <div className="space-y-1.5">
            <SubHead>Blank rate by chapter</SubHead>
            <ChapterFigures
              rows={[...attempt.by_topic]
                .sort((a, b) => b.blank_rate - a.blank_rate)
                .filter((t) => t.blanks > 0)
                .map((t) => ({
                  topic: t.topic,
                  whole: t.subject_level,
                  cells: [
                    { label: "blank", value: `${t.blanks} of ${t.answers}` },
                    { label: "rate", value: pct1(t.blank_rate), strong: t.blank_rate >= 30 },
                  ],
                }))}
            />
          </div>
          <div className="space-y-1.5">
            <SubHead>Skipped a quarter of the paper or more</SubHead>
            <People
              rows={skippers.map((r) => ({
                id: r.submission_id,
                name: r.student_name,
                value: `${r.blanks} of ${r.mcq_count}`,
                detail: `${pct1(Math.round((r.blanks / r.mcq_count) * 1000) / 10)} left blank · ${pct1(r.accuracy_attempted)} right when attempted`,
              }))}
              empty="No student left a quarter of the paper blank."
            />
          </div>
        </Section>
      ) : null}

      {fatigue ? (
        <Section
          open={firstOpen === "fatigue"}
          summary={
            <>
              <Title>End-of-paper fatigue</Title> - {nOf(fatigue.flagged_count, fatigue.students_profiled)} flagged
            </>
          }
        >
          <p className="text-[13px] text-slate-600">
            Class accuracy {formatPct(accPct(fatigue.early_accuracy))} in the first two thirds of the paper vs{" "}
            {formatPct(accPct(fatigue.late_accuracy))} in the final third, over the {plural(fatigue.students_profiled, "student")}
            whose paper had 6 or more questions.
          </p>
          <People rows={riskRows(fatigue.students, (r) => `${formatNumber(r.value)} pts`)} empty="No student is flagged for fatigue." />
        </Section>
      ) : null}

      {transfer ? (
        <Section
          open={firstOpen === "transfer"}
          summary={
            <>
              <Title>Recall vs application</Title> - accuracy by question level
            </>
          }
        >
          {bloom.length ? (
            <BarList
              unit="%"
              items={bloom.map((b) => ({
                label: `${b.level} ${BLOOM_LABELS[b.level]}`,
                value: accPct(b.accuracy) ?? 0,
                max: 100,
                valueLabel: `${formatPct(accPct(b.accuracy))} · ${plural(b.questions, "answer")}`,
              }))}
            />
          ) : null}
          <p className="text-xs text-slate-600">
            Memorising = recall questions ({BLOOM_LABELS.K1} / {BLOOM_LABELS.K2}) right but application questions (K3+) on
            the same concept wrong.
          </p>
          <div className="space-y-1.5">
            <SubHead>Memorising in 2+ concepts</SubHead>
            <People
              rows={transfer.students.map((r) => ({
                id: r.submission_id,
                name: r.student_name,
                value: plural(Math.round(r.value), "concept"),
                detail: r.detail,
              }))}
              empty="No student is memorising in two or more concepts."
            />
          </div>
        </Section>
      ) : null}

      <p className="mt-3 text-xs text-slate-600">Thresholds: {THRESHOLDS}.</p>
    </div>
  );
}
