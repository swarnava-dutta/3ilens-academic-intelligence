import Link from "next/link";
import type { Health } from "@/lib/types";
import { cn } from "@/lib/utils";
import { batchLabel, FALLBACK_BATCH, FALLBACK_INSTITUTION, type QueueFilter } from "./format";

interface WorkspaceHeroProps {
  health: Health | null;
  counts: Record<QueueFilter, number> | null;
}

export function WorkspaceHero({ health, counts }: WorkspaceHeroProps) {
  const institution = health?.institution?.name || FALLBACK_INSTITUTION;
  const batch = batchLabel(health?.batch) ?? FALLBACK_BATCH;
  const exam = health?.batch?.exam || "NEET";
  const days = health?.batch?.days_to_exam;
  const assumed = health?.batch?.exam_date_assumed ?? false;

  const stats = [
    { label: "Active batch", value: batch, numeric: false },
    {
      label: assumed ? `Days to ${exam} (assumed date)` : `Days to ${exam}`,
      value: typeof days === "number" ? days : undefined,
      numeric: true,
      title: `${exam} ${health?.batch?.exam_date ?? ""}${assumed ? " - assumed date (NEET_EXAM_DATE); set the real date on the Cohort page" : ""}`,
    },
    { label: "In pipeline", value: counts?.PROCESSING, numeric: true },
    { label: "Completed", value: counts?.COMPLETED, numeric: true },
    { label: "Human review", value: counts?.HUMAN_REVIEW_REQUIRED, numeric: true, review: true },
  ];

  return (
    <section aria-labelledby="workspace-title" className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm text-slate-500">{institution}</p>
          <h1 id="workspace-title" className="text-2xl font-semibold text-brand-navy">
            Faculty workspace
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Upload answer sheets, follow each one through OCR and grading, and open the student report.
          </p>
        </div>
        <Link
          href="/cohort"
          className="inline-flex h-9 shrink-0 items-center self-start rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-brand-navy transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-2 sm:self-auto"
        >
          Cohort dashboard
        </Link>
      </div>

      <dl className="grid grid-cols-2 divide-slate-200 rounded-md border border-slate-200 bg-white sm:grid-cols-5 sm:divide-x">
        {stats.map(({ label, value, numeric, title, review }, i) => (
          <div
            key={label}
            title={title}
            className={cn(
              "min-w-0 px-4 py-3",
              i === 0 && "col-span-2 border-b border-slate-200 sm:col-span-1 sm:border-b-0",
              i > 2 && "border-t border-slate-200 sm:border-t-0",
              i % 2 === 0 && i > 0 && "border-l border-slate-200 sm:border-l-0",
            )}
          >
            <dt className="truncate text-xs text-slate-500">{label}</dt>
            <dd
              className={cn(
                "mt-0.5 truncate font-semibold text-brand-navy",
                numeric ? "text-xl tabular-nums" : "text-sm leading-7",
                review && typeof value === "number" && value > 0 && "text-amber-700",
              )}
            >
              {value ?? "–"}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
