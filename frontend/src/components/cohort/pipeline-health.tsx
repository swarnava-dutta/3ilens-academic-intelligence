import Link from "next/link";
import { Activity, AlertTriangle, CheckCircle2, Loader2, XCircle, type LucideIcon } from "lucide-react";
import type { Cohort } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Card } from "./card";
import { formatPct, plural, shareOf } from "./format";

interface Segment {
  key: string;
  label: string;
  count: number;
  fill: string;
  icon: LucideIcon;
  iconClass: string;
}

export function PipelineHealth({ cohort }: { cohort: Cohort }) {
  const segments: Segment[] = [
    {
      key: "completed",
      label: "Completed",
      count: cohort.completed ?? 0,
      fill: "bg-brand-lime-600",
      icon: CheckCircle2,
      iconClass: "text-lime-700",
    },
    {
      key: "processing",
      label: "Processing",
      count: cohort.processing ?? 0,
      fill: "bg-brand-cyan",
      icon: Loader2,
      iconClass: "text-brand-cyan-600",
    },
    {
      key: "review",
      label: "Human review",
      count: cohort.human_review ?? 0,
      fill: "bg-amber-500",
      icon: AlertTriangle,
      iconClass: "text-amber-600",
    },
    {
      key: "failed",
      label: "Failed",
      count: cohort.failed ?? 0,
      fill: "bg-rose-500",
      icon: XCircle,
      iconClass: "text-rose-600",
    },
  ];
  const whole = segments.reduce((sum, s) => sum + s.count, 0);
  const summary = segments
    .map((s) => `${s.label} ${s.count} (${formatPct(shareOf(s.count, whole))})`)
    .join(", ");

  return (
    <Card aria-labelledby="cohort-pipeline-title" className="py-4 sm:py-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id="cohort-pipeline-title"
          className="inline-flex items-center gap-2 text-sm font-semibold text-brand-navy"
        >
          <Activity className="h-4 w-4 text-brand-cyan-600" aria-hidden />
          Pipeline health
        </h2>
        <p className="text-xs text-slate-500">
          {plural(whole, "submission")} across upload → OCR → evaluation
        </p>
      </div>

      <div
        role="img"
        aria-label={whole > 0 ? `Pipeline status: ${summary}` : "No submissions in the pipeline yet"}
        className="mt-3 flex h-7 w-full gap-0.5 rounded-md bg-slate-100"
      >
        {whole > 0
          ? segments
              .filter((s) => s.count > 0)
              .map((s) => {
                const share = shareOf(s.count, whole) ?? 0;
                return (
                  <div
                    key={s.key}
                    title={`${s.label}: ${s.count} (${formatPct(share)})`}
                    className={cn(
                      "flex min-w-1.5 items-center rounded-[4px] px-1.5 text-xs font-semibold text-slate-900 transition-[width] duration-500",
                      s.fill,
                    )}
                    style={{ width: `${share}%` }}
                  >
                    {share >= 16 ? <span className="whitespace-nowrap">{formatPct(share)}</span> : null}
                  </div>
                );
              })
          : null}
      </div>

      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        {segments.map((s) => {
          const Icon = s.icon;
          const content = (
            <>
              <span className="flex min-w-0 items-center gap-1.5">
                <span className={cn("h-2.5 w-2.5 shrink-0 rounded-sm", s.fill)} aria-hidden />
                <Icon className={cn("h-3.5 w-3.5 shrink-0", s.iconClass)} aria-hidden />
                <span className="truncate text-slate-600">{s.label}</span>
              </span>
              <span className="mt-0.5 block pl-4 tabular-nums text-slate-400">
                <span className="text-sm font-semibold text-slate-800">{s.count}</span> ·{" "}
                {formatPct(shareOf(s.count, whole))}
              </span>
            </>
          );
          return (
            <li key={s.key} className="min-w-0 text-xs">
              {s.key === "review" && s.count > 0 ? (
                <Link
                  href="/"
                  title="Open the Faculty Workspace review queue"
                  className="block rounded hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500"
                >
                  {content}
                </Link>
              ) : (
                <div>{content}</div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
