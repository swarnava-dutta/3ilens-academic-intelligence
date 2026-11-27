"use client";

import { Star } from "lucide-react";
import type { CSSProperties } from "react";
import type { Result, SubjectDiagnosis, SubjectRollup } from "@/lib/types";
import { URGENCY_LABELS } from "@/components/shared/urgency-badge";
import { cn } from "@/lib/utils";
import { fmtMarks, fmtPct1, slug } from "../format";
import { BandChip } from "./band-chip";
import { COLOR, WRONG_HATCH, card, numeric } from "./tokens";

const DIAGNOSIS: Record<SubjectDiagnosis, string> = {
  skipping: "Mostly skipped",
  wrong_answers: "Mostly wrong answers",
  mixed: "Skipped and wrong",
  solid: "Solid",
};

type Segment = { key: string; n: number; label: string; style: CSSProperties; glyph?: boolean };

/** Segment looks: right navy, wrong red hatch, blank hollow slate outline, bonus light blue with a star. */
export const SEGMENT_STYLE = {
  right: { background: COLOR.navy },
  wrong: { backgroundImage: WRONG_HATCH },
  blank: { background: "#fff", boxShadow: "inset 0 0 0 1.5px #94A3B8" },
  bonus: { background: COLOR.bonus },
  partial: { background: "#FCD34D" },
} satisfies Record<string, CSSProperties>;

/** Small swatch matching a segment, for the counts line (the words carry the meaning). */
export function Swatch({ kind, className }: { kind: keyof typeof SEGMENT_STYLE; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("relative inline-grid h-2.5 w-2.5 shrink-0 place-items-center rounded-[2px] align-[-1px]", className)}
      style={SEGMENT_STYLE[kind]}
    >
      {kind === "bonus" ? <Star className="h-2 w-2 fill-[#1E40AF] text-[#1E40AF]" /> : null}
    </span>
  );
}

function segments(row: SubjectRollup, mcq: boolean): Segment[] {
  if (!mcq) {
    return [
      { key: "full", n: row.full, label: "full", style: SEGMENT_STYLE.right },
      { key: "partial", n: row.partial, label: "partial", style: SEGMENT_STYLE.partial },
      { key: "zero", n: row.zero, label: "zero", style: SEGMENT_STYLE.wrong },
      { key: "blank", n: row.blank, label: "blank", style: SEGMENT_STYLE.blank },
    ];
  }
  return [
    { key: "right", n: row.right ?? 0, label: "right", style: SEGMENT_STYLE.right },
    { key: "wrong", n: row.wrong ?? 0, label: "wrong", style: SEGMENT_STYLE.wrong },
    { key: "blank", n: row.blank_scorable ?? row.blank, label: "blank", style: SEGMENT_STYLE.blank },
    { key: "bonus", n: row.bonus ?? 0, label: "bonus", style: SEGMENT_STYLE.bonus, glyph: true },
  ];
}

function OutcomeBar({ parts, subject }: { parts: Segment[]; subject: string }) {
  const total = Math.max(1, parts.reduce((s, p) => s + p.n, 0));
  const shown = parts.filter((p) => p.n > 0);
  return (
    <div
      role="img"
      aria-label={`${subject}: ${shown.map((p) => `${p.n} ${p.label}`).join(", ")}`}
      className="flex h-3 w-full gap-px overflow-hidden rounded-[2px] [print-color-adjust:exact]"
    >
      {shown.map((p) => (
        <span
          key={p.key}
          className="grid h-full min-w-[3px] place-items-center overflow-hidden"
          style={{ ...p.style, width: `${(p.n / total) * 100}%` }}
        >
          {p.glyph ? <Star className="h-2 w-2 fill-[#1E40AF] text-[#1E40AF]" aria-hidden /> : null}
        </span>
      ))}
    </div>
  );
}

function SubjectCard({ row, mcq }: { row: SubjectRollup; mcq: boolean }) {
  const parts = segments(row, mcq);
  const right = row.right ?? 0;
  const attempted = row.attempted ?? 0;
  const scorable = row.questions - (row.bonus ?? 0);
  const penalty = row.penalty ?? 0;
  const band = row.band ?? "needs_attention";
  return (
    <article
      id={`subject-${slug(row.subject)}`}
      aria-labelledby={`subject-${slug(row.subject)}-name`}
      className={cn(card, "min-w-0 scroll-mt-28 p-3 sm:p-4 md:scroll-mt-36 print:break-inside-avoid")}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 id={`subject-${slug(row.subject)}-name`} className="text-[15px] font-semibold text-[#1E3A8A]">
          {row.subject}
        </h3>
        <BandChip band={band} label={URGENCY_LABELS[band]} />
      </div>
      <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
        <span className={cn("text-xl font-semibold text-slate-900", numeric)}>
          {fmtMarks(row.score)} <span className="text-sm font-normal text-slate-500">/ {fmtMarks(row.max_marks)}</span>
        </span>
        <span className={cn("text-sm font-medium text-slate-800", numeric)}>{fmtPct1(row.score, row.max_marks)}</span>
      </p>
      <div className="mt-2">
        <OutcomeBar parts={parts} subject={row.subject} />
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-700">
          {parts
            .filter((p) => p.n > 0 || p.key === "right" || p.key === "wrong" || p.key === "blank")
            .map((p) => (
              <span key={p.key} className="inline-flex items-center gap-1">
                <Swatch kind={(p.key === "full" ? "right" : p.key === "zero" ? "wrong" : p.key) as keyof typeof SEGMENT_STYLE} />
                <span className={numeric}>{p.n}</span> {p.label}
                {p.key === "wrong" && penalty > 0 ? <span className={numeric}>({fmtMarks(-penalty)})</span> : null}
              </span>
            ))}
        </p>
      </div>
      {mcq ? (
        <dl className="mt-3 grid gap-1 border-t border-slate-100 pt-2 text-[13px]">
          <div className="flex justify-between gap-2">
            <dt className="text-slate-600">Answered</dt>
            <dd className={numeric}>
              {attempted} of {scorable} ({fmtPct1(attempted, scorable)})
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-slate-600">Right when answered</dt>
            <dd className={numeric}>
              {fmtPct1(right, attempted)} ({right}/{attempted})
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-slate-600">Lost to wrong answers</dt>
            <dd className={cn(numeric, penalty > 0 && "text-red-700")}>{fmtMarks(-penalty)}</dd>
          </div>
        </dl>
      ) : null}
      {row.diagnosis ? (
        <p className="mt-2 text-[13px] font-medium text-slate-800">
          <span className="text-slate-500">Diagnosis: </span>
          {DIAGNOSIS[row.diagnosis]}
        </p>
      ) : null}
    </article>
  );
}

/**
 * One card per subject (score, band, right / wrong / blank / bonus, answered, right when answered,
 * marks lost to wrong answers, a one-line diagnosis). The cards carry every number once; no chart
 * repeats them. Three across only on wide screens (two then one on tablets) so the rows never wrap.
 */
export function SubjectCards({ result }: { result: Result }) {
  const rows = result.subject_rollup;
  const mcq = result.question_evaluations.some((q) => q.question_type === "mcq");
  if (!rows.length) return <p className="text-sm text-slate-600">No subject marks were recorded for this result.</p>;
  return (
    <div
      className={cn(
        "grid gap-3",
        rows.length >= 3
          ? "sm:grid-cols-2 lg:grid-cols-3 print:grid-cols-3"
          : rows.length === 2
            ? "sm:grid-cols-2 print:grid-cols-2"
            : "",
      )}
    >
      {rows.map((r) => (
        <SubjectCard key={r.subject} row={r} mcq={mcq} />
      ))}
    </div>
  );
}
