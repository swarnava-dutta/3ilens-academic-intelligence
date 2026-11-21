import Link from "next/link";
import type { Cohort } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Card } from "./card";
import { formatPct, plural, shareOf } from "./format";

export function PipelineHealth({ cohort }: { cohort: Cohort }) {
  const segments = [
    { key: "completed", label: "Completed", count: cohort.completed ?? 0, fill: "bg-brand-lime-600" },
    { key: "processing", label: "Processing", count: cohort.processing ?? 0, fill: "bg-brand-cyan" },
    { key: "review", label: "Human review", count: cohort.human_review ?? 0, fill: "bg-amber-500" },
    { key: "failed", label: "Failed", count: cohort.failed ?? 0, fill: "bg-red-600" },
  ];
  const whole = segments.reduce((sum, s) => sum + s.count, 0);
  const summary = segments
    .map((s) => `${s.label} ${s.count} (${formatPct(shareOf(s.count, whole))})`)
    .join(", ");

  return (
    <Card aria-labelledby="cohort-pipeline-title" className="p-4 sm:p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="cohort-pipeline-title" className="text-[15px] font-semibold text-brand-navy">
          Pipeline health
        </h2>
        <p className="text-xs tabular-nums text-slate-500">
          {plural(whole, "submission")} across upload, OCR and evaluation
        </p>
      </div>

      <div
        role="img"
        aria-label={whole > 0 ? `Pipeline status: ${summary}` : "No submissions in the pipeline yet"}
        className="mt-3 flex h-2 w-full gap-px overflow-hidden rounded-sm bg-slate-100"
      >
        {whole > 0
          ? segments
              .filter((s) => s.count > 0)
              .map((s) => (
                <div
                  key={s.key}
                  title={`${s.label}: ${s.count} (${formatPct(shareOf(s.count, whole))})`}
                  className={cn("min-w-1", s.fill)}
                  style={{ width: `${shareOf(s.count, whole) ?? 0}%` }}
                />
              ))
          : null}
      </div>

      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[13px] sm:grid-cols-4">
        {segments.map((s) => {
          const content = (
            <>
              <span className={cn("h-2 w-2 shrink-0 rounded-sm", s.fill)} aria-hidden />
              <span className="truncate text-slate-600">{s.label}</span>
              <span className="ml-auto font-semibold tabular-nums text-slate-800 sm:ml-1">{s.count}</span>
              <span className="tabular-nums text-slate-500">{formatPct(shareOf(s.count, whole))}</span>
            </>
          );
          return (
            <li key={s.key} className="min-w-0">
              {s.key === "review" && s.count > 0 ? (
                <Link
                  href="/"
                  title="Open the Faculty Workspace review queue"
                  className="flex items-center gap-1.5 rounded-sm text-amber-800 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
                >
                  {content}
                </Link>
              ) : (
                <div className="flex items-center gap-1.5">{content}</div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
