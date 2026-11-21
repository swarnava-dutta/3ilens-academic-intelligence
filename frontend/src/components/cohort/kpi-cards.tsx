import Link from "next/link";
import type { ReactNode } from "react";
import type { Cohort } from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatNumber, formatPct, num, shareOf, toneFor } from "./format";

function Figure({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="min-w-0 bg-white px-4 py-3">
      <dt className="text-[13px] text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-xl font-semibold tabular-nums text-brand-navy">{value}</dd>
      {hint ? <dd className="mt-0.5 text-xs text-slate-500">{hint}</dd> : null}
    </div>
  );
}

/** One bordered strip of headline figures; hairline dividers come from the 1px grid gap. */
export function KpiGrid({ cohort }: { cohort: Cohort }) {
  const total = cohort.total_submissions ?? 0;
  const completed = cohort.completed ?? 0;
  const review = cohort.human_review ?? 0;
  const failed = cohort.failed ?? 0;
  const totalMarks = num(cohort.total_marks) ?? 0;
  const avgScore = num(cohort.average_score);
  const avgScorePct = avgScore === null ? null : shareOf(avgScore, totalMarks);
  const avgMastery = num(cohort.average_mastery);

  return (
    <dl
      aria-label="Key metrics"
      className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 sm:grid-cols-3 xl:grid-cols-6"
    >
      <Figure
        label="Submissions"
        value={total}
        hint={`${cohort.real_count ?? 0} live · ${cohort.demo_count ?? 0} demo`}
      />
      <Figure label="Completed" value={completed} hint={`${formatPct(shareOf(completed, total))} evaluated`} />
      <Figure
        label="Average score"
        value={
          <>
            {formatNumber(avgScore)}
            <span className="ml-1 text-sm font-normal text-slate-500">/ {formatNumber(totalMarks)}</span>
          </>
        }
        hint={`${formatPct(avgScorePct)} of marks, completed only`}
      />
      <Figure
        label="Average mastery"
        value={formatPct(avgMastery)}
        hint={avgMastery === null ? "Awaiting results" : toneFor(avgMastery).label}
      />
      <Figure
        label="Human review"
        value={<span className={review > 0 ? "text-amber-700" : undefined}>{review}</span>}
        hint={
          review > 0 ? (
            <Link
              href="/"
              className="rounded-sm font-medium text-amber-800 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
            >
              Low OCR confidence · open workspace
            </Link>
          ) : (
            "No sheets waiting"
          )
        }
      />
      <Figure
        label="Failed"
        value={<span className={cn(failed > 0 && "text-red-700")}>{failed}</span>}
        hint={failed > 0 ? "In the dead-letter queue" : "No pipeline failures"}
      />
    </dl>
  );
}
