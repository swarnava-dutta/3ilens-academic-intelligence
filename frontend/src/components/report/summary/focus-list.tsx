"use client";

import { Circle, X } from "lucide-react";
import { useState } from "react";
import type { FocusAction, FocusTopicRow, QuestionEvaluation, Result } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FacultyBadge } from "../faculty-badge";
import { fmtMarks, fmtNumber, fmtPct1, fmtPctValue, slug } from "../format";
import { FOLD, focusQuestion, openFoldAndScroll } from "../report-events";
import { TeacherOnly } from "../report-view-mode";
import { card, focusRing, linkButton, numeric } from "./tokens";

const ACTION_LABEL: Record<FocusAction, string> = {
  learn: "Learn",
  drill: "Fix errors",
  fix_errors: "Fix errors",
  review: "Keep warm",
};

const CHIPS_SHOWN = 6;

/** "Q4" chip: wrong (red, X glyph) or blank (hollow circle); opens the question's card. */
function RefChip({ n, kind }: { n: number; kind: QuestionEvaluation["result_kind"] | undefined }) {
  const wrong = kind === "wrong" || kind === "zero" || kind === "partial";
  return (
    <button
      type="button"
      onClick={() => focusQuestion(n)}
      title={`Q${n}: ${wrong ? "wrong" : "blank"} — open the question`}
      className={cn(
        "inline-flex min-h-7 cursor-pointer items-center gap-1 rounded-sm border px-1.5 text-[11px] font-medium transition-colors duration-150",
        numeric,
        focusRing,
        wrong ? "border-red-200 bg-red-50 text-red-800 hover:bg-red-100" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
      )}
    >
      {wrong ? <X className="h-3 w-3" aria-hidden /> : <Circle className="h-2.5 w-2.5" aria-hidden />}Q{n}
      <span className="sr-only">{wrong ? " wrong" : " blank"}</span>
    </button>
  );
}

/** One labelled row of question chips ("Skipped 19", "Wrong 8"), the first few, then "+N more". */
function RefRow({
  label,
  refs,
  kinds,
  glyph,
}: {
  label: string;
  refs: number[];
  kinds: Map<number, QuestionEvaluation>;
  glyph: "blank" | "wrong";
}) {
  const [all, setAll] = useState(false);
  if (!refs.length) return null;
  const shown = all ? refs : refs.slice(0, CHIPS_SHOWN);
  const more = refs.length - shown.length;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="mr-1 inline-flex min-w-[5.25rem] items-center gap-1 text-xs font-medium text-slate-700">
        {glyph === "wrong" ? (
          <X className="h-3 w-3 text-red-700" aria-hidden />
        ) : (
          <Circle className="h-2.5 w-2.5 text-slate-500" aria-hidden />
        )}
        {label} <span className={numeric}>{refs.length}</span>
      </span>
      {shown.map((n) => (
        <RefChip key={n} n={n} kind={kinds.get(n)?.result_kind} />
      ))}
      {more > 0 ? (
        <button type="button" onClick={() => setAll(true)} className={cn(linkButton, "min-h-7 px-1 text-xs")}>
          +{more} more
        </button>
      ) : null}
    </div>
  );
}

function FocusRow({
  row,
  rank,
  kinds,
  target,
}: {
  row: FocusTopicRow;
  rank: number;
  kinds: Map<number, QuestionEvaluation>;
  target: number;
}) {
  const kindOf = (n: number) => kinds.get(n)?.result_kind;
  // The server sends both lists; an older payload only has question_refs.
  const blank = row.blank_refs ?? row.question_refs.filter((n) => kindOf(n) === "blank");
  const wrong = row.wrong_refs ?? row.question_refs.filter((n) => kindOf(n) !== "blank");
  // The chips follow the advice: a topic to learn starts from what was skipped.
  const lists: [string, number[], "blank" | "wrong"][] =
    row.action === "learn"
      ? [
          ["Skipped", blank, "blank"],
          ["Wrong", wrong, "wrong"],
        ]
      : [
          ["Wrong", wrong, "wrong"],
          ["Skipped", blank, "blank"],
        ];
  return (
    <li id={`focus-${slug(row.topic)}`} className={cn(card, "scroll-mt-28 p-3 sm:p-4 md:scroll-mt-36 print:break-inside-avoid")}>
      <div className="flex gap-3">
        <span
          className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-md bg-[#1E40AF] text-sm font-semibold text-white", numeric)}
          aria-hidden
        >
          {rank}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <h3 className="text-[15px] font-semibold text-[#1E3A8A]">
              <span className="sr-only">{rank}. </span>
              {row.topic}
              {row.subject && row.subject !== row.topic ? (
                <span className="font-normal text-slate-500"> · {row.subject}</span>
              ) : null}
            </h3>
            <p className="text-[13px] text-slate-700">
              Marks to {fmtNumber(target)}%{" "}
              <span className={cn("font-semibold text-[#B45309]", numeric)}>+{fmtMarks(row.gain)}</span>
            </p>
          </div>
          <p className="mt-0.5 text-[13px] text-slate-600">
            Now{" "}
            <span className={numeric}>
              {fmtMarks(row.score)}/{fmtMarks(row.max_marks)} ({fmtPct1(row.score, row.max_marks)})
            </span>
            {row.low_evidence ? <span className="text-slate-500"> · based on {row.n} {row.n === 1 ? "question" : "questions"}</span> : null}
          </p>
          <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] text-slate-800">
            <span className="rounded-sm border border-[#1E40AF]/40 px-1.5 py-px text-xs font-semibold text-[#1E40AF]">
              {ACTION_LABEL[row.action]}
            </span>
            <span className="min-w-0">{row.what_to_study}</span>
          </p>
          {blank.length || wrong.length ? (
            <div className="mt-2 space-y-1 print:hidden">
              {lists.map(([label, refs, glyph]) => (
                <RefRow key={label} label={label} refs={refs} kinds={kinds} glyph={glyph} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/** "Physics and Chemistry to 70% add +116: 518/720 (71.9%), past the On track line (504)." */
export function routeLine(result: Result): string | null {
  const focus = result.focus_topics;
  const band = result.score_band;
  const rows = focus?.rows ?? [];
  const target = focus?.target_pct ?? 85;
  if (!band || band.marks_to_target <= 0 || Math.abs(band.target_pct - target) > 1e-9 || !rows.length) return null;
  const picked: FocusTopicRow[] = [];
  let sum = 0;
  for (const r of rows) {
    picked.push(r);
    sum += r.gain;
    if (sum >= band.marks_to_target - 1e-9) break;
  }
  if (sum < band.marks_to_target - 1e-9) return null;
  const names = picked.map((r) => r.topic);
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const line = band.target_source === "batch_target" ? "your target" : "the On track line";
  const end = result.total_score + sum;
  return (
    `${who} to ${fmtNumber(target)}% ${names.length === 1 ? "adds" : "add"} +${fmtMarks(sum)}: ` +
    `${fmtMarks(end)}/${fmtMarks(result.total_marks)} (${fmtPct1(end, result.total_marks)}), past ${line} (${fmtMarks(band.target_marks)}).`
  );
}

/**
 * "Where to focus": the server's chapters (or subjects, when no chapters were read) below the score
 * card's target, ranked by the marks reaching it adds, each with what to study and its questions in two
 * labelled rows (skipped / wrong, in the order of the advice). Areas already at the target get one
 * "keep warm" line, not a row. One target everywhere: the score card's (the 70% On track line or the
 * batch target); 85% only once the student is past it.
 */
export function FocusList({ result }: { result: Result }) {
  const focus = result.focus_topics;
  const kinds = new Map(result.question_evaluations.map((q) => [q.question, q]));
  const rows = focus?.rows ?? [];
  const target = focus?.target_pct ?? 85;
  const warm = focus?.keep_warm ?? [];
  return (
    <div className="space-y-2">
      {focus?.level === "subject" ? (
        <TeacherOnly>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-slate-600">
            Chapter breakdown is not available for this paper yet.
            <button type="button" onClick={() => openFoldAndScroll(FOLD.review)} className={linkButton}>
              Re-grade to read chapters from the printed paper
            </button>
            <FacultyBadge />
          </p>
        </TeacherOnly>
      ) : null}
      {rows.length ? (
        <ol className="space-y-2">
          {rows.map((r, i) => (
            <FocusRow key={r.topic} row={r} rank={i + 1} kinds={kinds} target={target} />
          ))}
        </ol>
      ) : (
        <p className={cn(card, "p-3 text-sm text-slate-700")}>
          Every {focus?.level === "chapter" ? "chapter" : "subject"} is at {fmtNumber(target)}% or above: keep it up with mixed
          timed practice.
        </p>
      )}
      {rows.length && warm.length ? (
        <p className="text-[13px] text-slate-700">
          <span className="font-medium text-slate-800">Keep warm: </span>
          {warm.map((w, i) => (
            <span key={w.topic}>
              {i ? ", " : ""}
              {w.topic} <span className={numeric}>({fmtPctValue(w.mastery)})</span>
            </span>
          ))}
          {focus?.keep_warm_more ? ` and ${focus.keep_warm_more} more` : ""} {warm.length === 1 ? "is" : "are"} already at{" "}
          {fmtNumber(target)}% or above; a short mixed set each week keeps {warm.length === 1 ? "it" : "them"} there.
        </p>
      ) : null}
    </div>
  );
}
