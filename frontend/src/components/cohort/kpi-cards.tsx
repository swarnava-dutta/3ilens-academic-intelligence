import Link from "next/link";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Brain,
  CheckCircle2,
  Files,
  Target,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { Cohort } from "@/lib/types";
import { cn } from "@/lib/utils";
import { clampPct, formatNumber, formatPct, num, shareOf, toneFor } from "./format";

type Accent = "navy" | "cyan" | "lime" | "amber" | "rose";

const ACCENTS: Record<Accent, { icon: string; card: string }> = {
  navy: { icon: "bg-slate-100 text-brand-navy", card: "" },
  cyan: { icon: "bg-brand-cyan-50 text-brand-cyan-600", card: "" },
  lime: { icon: "bg-brand-lime-50 text-lime-700", card: "" },
  amber: { icon: "bg-amber-100 text-amber-700", card: "border-amber-300 bg-amber-50" },
  rose: { icon: "bg-rose-100 text-rose-600", card: "border-rose-200 bg-rose-50/70" },
};

function KpiCard({
  label,
  icon: Icon,
  accent,
  highlighted = false,
  value,
  hint,
  footer,
}: {
  label: string;
  icon: LucideIcon;
  accent: Accent;
  /** Apply the tinted card background (used for review/failure when count > 0). */
  highlighted?: boolean;
  value: ReactNode;
  hint?: ReactNode;
  footer?: ReactNode;
}) {
  const a = ACCENTS[accent];
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5",
        highlighted && a.card,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-slate-500 sm:text-sm">{label}</p>
        <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-xl", a.icon)}>
          <Icon className="h-4 w-4" aria-hidden />
        </span>
      </div>
      <div className="mt-2 text-2xl font-bold tracking-tight text-brand-navy sm:text-3xl">{value}</div>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
      {footer ? <div className="mt-auto pt-3">{footer}</div> : null}
    </div>
  );
}

export function KpiGrid({ cohort }: { cohort: Cohort }) {
  const total = cohort.total_submissions ?? 0;
  const completed = cohort.completed ?? 0;
  const review = cohort.human_review ?? 0;
  const failed = cohort.failed ?? 0;
  const totalMarks = num(cohort.total_marks) ?? 0;
  const avgScore = num(cohort.average_score);
  const avgScorePct = avgScore === null ? null : shareOf(avgScore, totalMarks);
  const avgMastery = num(cohort.average_mastery);
  const tone = toneFor(avgMastery);

  return (
    <section aria-label="Key metrics" className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 xl:grid-cols-6">
      <KpiCard
        label="Total submissions"
        icon={Files}
        accent="navy"
        value={total}
        hint={`${cohort.real_count ?? 0} live · ${cohort.demo_count ?? 0} demo`}
      />
      <KpiCard
        label="Completed"
        icon={CheckCircle2}
        accent="lime"
        value={completed}
        hint={`${formatPct(shareOf(completed, total))} of submissions evaluated`}
      />
      <KpiCard
        label="Average score"
        icon={Target}
        accent="cyan"
        value={
          <span>
            {formatNumber(avgScore)}
            <span className="ml-1 text-base font-semibold text-slate-400">/ {formatNumber(totalMarks)}</span>
          </span>
        }
        hint={`${formatPct(avgScorePct)} of marks · completed only`}
      />
      <KpiCard
        label="Average mastery"
        icon={Brain}
        accent="cyan"
        value={formatPct(avgMastery)}
        hint={avgMastery === null ? "Awaiting results" : tone.label}
        footer={
          <div className="h-1.5 w-full rounded-full bg-slate-100" aria-hidden>
            <div
              className={cn("h-full rounded-full", tone.bar)}
              style={{ width: `${clampPct(avgMastery)}%` }}
            />
          </div>
        }
      />
      <KpiCard
        label="Human review"
        icon={AlertTriangle}
        accent="amber"
        highlighted={review > 0}
        value={<span className={review > 0 ? "text-amber-800" : undefined}>{review}</span>}
        hint={review > 0 ? "Low OCR confidence – AI grading paused" : "No sheets waiting"}
        footer={
          <Link
            href="/"
            className="inline-flex items-center gap-1 rounded text-xs font-semibold text-amber-800 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500"
          >
            Open workspace
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        }
      />
      <KpiCard
        label="Failed"
        icon={XCircle}
        accent="rose"
        highlighted={failed > 0}
        value={<span className={failed > 0 ? "text-rose-700" : undefined}>{failed}</span>}
        hint={failed > 0 ? "Routed to the dead-letter queue" : "No pipeline failures"}
      />
    </section>
  );
}
