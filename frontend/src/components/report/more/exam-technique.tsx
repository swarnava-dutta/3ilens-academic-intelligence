import type { Result, SubjectPacing } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmtMarks, fmtPct1, fmtRulePct } from "../format";
import { modalMarks } from "../normalize-summary";
import { BloomProfileCard } from "../patterns/bloom-profile";
import { realMinus } from "../patterns/shared";
import { TransferCard } from "../patterns/transfer";
import { numeric } from "../summary/tokens";

/** A drop this large (points, answered questions only) in a subject's second half is worth naming. */
const DROP_PTS = 10;
/** ...and only when both halves have this many answers. */
const MIN_ANSWERED = 5;

const signedPts = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${(Math.round(Math.abs(v) * 10) / 10).toFixed(1)} pts`;

/** "105 right × 4 − 26 = 394, + 8 bonus = 402" (MCQ papers with one mark value). */
export function reconciliationLine(result: Result): string | null {
  const qs = result.question_evaluations;
  if (!qs.length || qs.some((q) => q.question_type !== "mcq")) return null;
  const per = modalMarks(qs);
  if (!per || qs.some((q) => !q.bonus && q.max_marks !== per)) return null;
  const nm = result.patterns.negative_marking;
  const right = result.outcome_counts.right ?? 0;
  const penalty = qs.reduce((s, q) => s + Math.max(0, q.penalty || 0), 0);
  const bonusMarks = nm?.reconciliation?.bonus_marks ?? qs.filter((q) => q.bonus).reduce((s, q) => s + q.estimated_marks, 0);
  const net = nm?.reconciliation?.net_answered ?? right * per - penalty;
  const total = nm?.reconciliation?.total ?? result.total_score;
  const head = `${right} right × ${fmtMarks(per)}${penalty ? ` − ${fmtMarks(penalty)}` : ""} = ${fmtMarks(net)}`;
  return bonusMarks ? `${head}, + ${fmtMarks(bonusMarks)} bonus = ${fmtMarks(total)}` : `${head} = your score`;
}

function PacingCell({ right, attempted }: { right: number; attempted: number }) {
  return attempted ? (
    <span className={numeric}>
      {fmtPct1(right, attempted)} <span className="text-slate-500">({right}/{attempted})</span>
    </span>
  ) : (
    <span className="text-slate-500">none answered</span>
  );
}

function Pacing({ rows }: { rows: SubjectPacing[] }) {
  const drops = rows.filter(
    (r) =>
      r.change_pts !== null &&
      r.change_pts <= -DROP_PTS &&
      r.first_attempted >= MIN_ANSWERED &&
      r.second_attempted >= MIN_ANSWERED,
  );
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold text-[#1E3A8A]">Pacing within each subject</h4>
      <p className="text-[13px] text-slate-600">
        Right answers as a share of the questions you answered, first half of each section against the second half.
        Blanks are not counted as wrong.
      </p>
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full border-collapse text-[13px]">
          <caption className="sr-only">Accuracy on answered questions, first and second half of each subject</caption>
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
              <th scope="col" className="py-2 pr-3 font-medium">Subject</th>
              <th scope="col" className="py-2 pr-3 font-medium">First half</th>
              <th scope="col" className="py-2 pr-3 font-medium">Second half</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.subject} className="border-b border-slate-100">
                <th scope="row" className="py-1.5 pr-3 text-left font-medium text-slate-800">{r.subject}</th>
                <td className="py-1.5 pr-3">
                  <span className={cn("mr-1.5 text-xs text-slate-500", numeric)}>
                    Q{r.first_from}–Q{r.first_to}
                  </span>
                  <PacingCell right={r.first_right} attempted={r.first_attempted} />
                </td>
                <td className="py-1.5 pr-3">
                  <span className={cn("mr-1.5 text-xs text-slate-500", numeric)}>
                    Q{r.second_from}–Q{r.second_to}
                  </span>
                  <PacingCell right={r.second_right} attempted={r.second_attempted} />
                </td>
                <td className={cn("py-1.5 pr-3 text-right", numeric)}>{r.change_pts === null ? "—" : signedPts(r.change_pts)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 sm:hidden">
        {rows.map((r) => (
          <li key={r.subject} className="rounded-md border border-slate-200 p-2.5 text-[13px]">
            <p className="flex justify-between gap-2 font-medium text-slate-800">
              {r.subject}
              <span className={numeric}>{r.change_pts === null ? "—" : signedPts(r.change_pts)}</span>
            </p>
            <p className="mt-0.5 text-xs text-slate-700">
              <span className={numeric}>
                Q{r.first_from}–Q{r.first_to}
              </span>{" "}
              <PacingCell right={r.first_right} attempted={r.first_attempted} />
            </p>
            <p className="text-xs text-slate-700">
              <span className={numeric}>
                Q{r.second_from}–Q{r.second_to}
              </span>{" "}
              <PacingCell right={r.second_right} attempted={r.second_attempted} />
            </p>
          </li>
        ))}
      </ul>
      <p className="text-[13px] font-medium text-slate-800">
        {drops.length
          ? `Accuracy fell in the second half of ${drops.map((r) => r.subject).join(" and ")}: practise that section under time.`
          : "Accuracy held or rose in the second half of every subject, so there is no sign of tiring late in the paper."}
      </p>
    </div>
  );
}

/** "26 wrong answers cost 26 marks · pacing in each subject" for the fold teaser. */
export function techniqueTeaser(result: Result): string {
  const wrong = result.outcome_counts.wrong ?? 0;
  const penalty = result.question_evaluations.reduce((s, q) => s + Math.max(0, q.penalty || 0), 0);
  const blank = result.outcome_counts.blank;
  if (!result.patterns.negative_marking) return `${blank} left blank · pacing within each subject`;
  return `${wrong} wrong ${wrong === 1 ? "answer" : "answers"} cost ${fmtMarks(penalty)} ${penalty === 1 ? "mark" : "marks"} · ${blank} left blank · pacing within each subject`;
}

/**
 * F2 "Exam technique": what wrong answers cost per subject (with the score reconciliation), the
 * attempt rule, pacing within each subject on answered questions, and the Bloom / transfer profiles
 * only when they say something.
 */
export function ExamTechnique({ result }: { result: Result }) {
  const nm = result.patterns.negative_marking;
  const rows = result.subject_rollup.filter((r) => (r.attempted ?? 0) > 0 || r.questions > 0);
  const line = reconciliationLine(result);
  const pacing = result.patterns.fatigue?.within_subject ?? [];
  const transfer = result.patterns.transfer;
  return (
    <div className="space-y-5">
      {nm ? (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-[#1E3A8A]">Negative marking by subject</h4>
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full border-collapse text-[13px]">
              <caption className="sr-only">Answers and negative marking per subject</caption>
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th scope="col" className="py-2 pr-3 font-medium">Subject</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Answered</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Right</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Wrong</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Right when answered</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Lost to wrong answers</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.subject} className="border-b border-slate-100">
                    <th scope="row" className="py-1.5 pr-3 text-left font-medium text-slate-800">{r.subject}</th>
                    <td className={cn("py-1.5 pr-3 text-right", numeric)}>
                      {r.attempted ?? 0} of {r.questions - (r.bonus ?? 0)}
                    </td>
                    <td className={cn("py-1.5 pr-3 text-right", numeric)}>{r.right ?? 0}</td>
                    <td className={cn("py-1.5 pr-3 text-right", numeric)}>{r.wrong ?? 0}</td>
                    <td className={cn("py-1.5 pr-3 text-right", numeric)}>{fmtPct1(r.right ?? 0, r.attempted ?? 0)}</td>
                    <td className={cn("py-1.5 pr-3 text-right", numeric, (r.penalty ?? 0) > 0 && "text-red-700")}>
                      {fmtMarks(-(r.penalty ?? 0))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="space-y-2 sm:hidden">
            {rows.map((r) => (
              <li key={r.subject} className="rounded-md border border-slate-200 p-2.5 text-[13px]">
                <p className="flex justify-between gap-2 font-medium text-slate-800">
                  {r.subject}
                  <span className={cn(numeric, (r.penalty ?? 0) > 0 && "text-red-700")}>{fmtMarks(-(r.penalty ?? 0))}</span>
                </p>
                <p className="mt-0.5 text-xs text-slate-700">
                  Answered <span className={numeric}>{r.attempted ?? 0}</span> of{" "}
                  <span className={numeric}>{r.questions - (r.bonus ?? 0)}</span> · right when answered{" "}
                  <span className={numeric}>{fmtPct1(r.right ?? 0, r.attempted ?? 0)}</span>
                </p>
              </li>
            ))}
          </ul>
          {line ? (
            <p className="text-[13px] text-slate-800">
              <span className="text-slate-600">How the score adds up: </span>
              <span className={numeric}>{line}</span>
            </p>
          ) : null}
          <p className="text-[13px] text-slate-700">
            Marking <span className={numeric}>{realMinus(nm.scheme)}</span>: a guess gains marks on average once you are more
            than <span className={numeric}>{fmtRulePct(nm.break_even * 100)}</span> sure of it, so rule out what you can, then
            answer.
          </p>
          {nm.recommendation ? <p className="text-[13px] text-slate-700">{realMinus(nm.recommendation)}</p> : null}
        </div>
      ) : (
        <p className="text-[13px] text-slate-600">This paper has no negative marking.</p>
      )}

      {pacing.length ? <Pacing rows={pacing} /> : null}

      {result.patterns.bloom_informative ? <BloomProfileCard buckets={result.patterns.bloom_profile} /> : null}
      {transfer && transfer.concepts.length ? <TransferCard profile={transfer} note="" /> : null}
    </div>
  );
}
