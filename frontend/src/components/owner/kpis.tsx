import type { ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleCheck,
  CircleAlert,
  FileCheck2,
  IndianRupee,
  Target,
  Users,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { URGENCY_RULE, UrgencyBadge } from "@/components/shared/urgency-badge";
import { num, shareOf } from "@/components/cohort/format";
import type { OwnerDashboard, Urgency } from "@/lib/types";
import { cn } from "@/lib/utils";
import { inr, pct } from "./format";

function Tile({
  label,
  icon: Icon,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  icon: LucideIcon;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "amber" | "rose";
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-sm",
        tone === "amber" && "border-amber-300 bg-amber-50",
        tone === "rose" && "border-rose-200 bg-rose-50/70",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-slate-600">{label}</p>
        <span
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-brand-cyan-50 text-brand-cyan-600",
            tone === "amber" && "bg-amber-100 text-amber-700",
            tone === "rose" && "bg-rose-100 text-rose-600",
          )}
        >
          <Icon className="h-4 w-4" aria-hidden />
        </span>
      </div>
      <div className="mt-2 text-2xl font-bold tracking-tight text-brand-navy tabular-nums">{value}</div>
      {hint ? <p className="mt-1 text-xs text-slate-600">{hint}</p> : null}
    </div>
  );
}

export function OwnerKpis({ data }: { data: OwnerDashboard }) {
  const t = data.totals;
  const ops = data.operations;
  const target = num(ops?.target_inr) ?? 5;
  const perStudent = num(ops?.avg_cost_per_student_inr);
  const overTarget = perStudent !== null && perStudent > target;

  return (
    <section aria-label="Institution totals" className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-7">
      <Tile
        label="Students"
        icon={Users}
        value={t.students}
        hint={`${t.batches} batches · ${t.tests} tests · ${t.faculty} faculty`}
      />
      <Tile
        label="Completed"
        icon={CheckCircle2}
        value={
          <span>
            {t.completed}
            <span className="ml-1 text-base font-semibold text-slate-500">/ {t.submissions}</span>
          </span>
        }
        hint={`of submissions evaluated${t.processing ? ` · ${t.processing} processing` : ""}`}
      />
      <Tile
        label="Average score"
        icon={Target}
        value={pct(t.average_pct)}
        hint="% of max marks, completed results, all tests"
      />
      <Tile
        label="Released / provisional"
        icon={FileCheck2}
        value={
          <span>
            {t.released}
            <span className="ml-1 text-base font-semibold text-slate-500">/ {t.provisional}</span>
          </span>
        }
        hint="results released to students / awaiting a teacher"
      />
      <Tile
        label="Review backlog"
        icon={AlertTriangle}
        tone={t.human_review > 0 ? "amber" : "default"}
        value={t.human_review}
        hint={t.human_review > 0 ? "sheets waiting for OCR review" : "no sheets waiting"}
      />
      <Tile
        label="Failed"
        icon={XCircle}
        tone={t.failed > 0 ? "rose" : "default"}
        value={t.failed}
        hint={t.failed > 0 ? "in the dead-letter queue" : "no pipeline failures"}
      />
      <Tile
        label="Total AI cost"
        icon={IndianRupee}
        value={inr(ops?.total_cost_inr)}
        hint={
          <span className="flex items-start gap-1">
            {perStudent === null ? (
              <>avg per student unknown · target {inr(target)}</>
            ) : (
              <>
                {overTarget ? (
                  <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0 text-rose-600" aria-hidden />
                ) : (
                  <CircleCheck className="mt-px h-3.5 w-3.5 shrink-0 text-lime-700" aria-hidden />
                )}
                <span className={overTarget ? "font-medium text-rose-700" : "font-medium text-lime-800"}>
                  {inr(perStudent)} per student {overTarget ? "- over" : "- within"} the {inr(target)} target
                </span>
              </>
            )}
          </span>
        }
      />
    </section>
  );
}

const ORDER: Urgency[] = ["at_risk", "needs_attention", "on_track"];
const FILLS: Record<Urgency, string> = {
  at_risk: "bg-rose-500",
  needs_attention: "bg-amber-400",
  on_track: "bg-brand-lime-600",
};

/** Institution-wide urgency split (UrgencyBadge styling, counts and shares as text). */
export function OwnerUrgencyStrip({ data }: { data: OwnerDashboard }) {
  const counts = data.urgency_counts ?? { on_track: 0, needs_attention: 0, at_risk: 0 };
  const total = counts.on_track + counts.needs_attention + counts.at_risk;
  return (
    <section
      aria-labelledby="owner-urgency-title"
      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="owner-urgency-title" className="text-sm font-semibold text-brand-navy">
          Urgency across the institution <span className="font-normal text-slate-600">· {total} completed results</span>
        </h2>
        <p className="text-xs text-slate-600" title={URGENCY_RULE}>
          &ge;70% on track · 55-70% needs attention · &lt;55% at risk
        </p>
      </div>
      <UrgencyBar counts={counts} className="mt-3 h-2.5" />
      <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
        {ORDER.map((u) => (
          <li key={u} className="flex items-center gap-2">
            <UrgencyBadge urgency={u} size="sm" />
            <span className="text-lg font-bold tabular-nums text-brand-navy">{counts[u]}</span>
            <span className="text-xs tabular-nums text-slate-600">{pct(shareOf(counts[u], total))}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Stacked urgency bar (at risk -> on track) with a text equivalent for screen readers. */
export function UrgencyBar({
  counts,
  className,
}: {
  counts: { on_track: number; needs_attention: number; at_risk: number };
  className?: string;
}) {
  const total = counts.on_track + counts.needs_attention + counts.at_risk;
  const text = `${counts.at_risk} at risk, ${counts.needs_attention} need attention, ${counts.on_track} on track`;
  return (
    <div
      role="img"
      aria-label={text}
      title={text}
      className={cn("flex w-full gap-0.5 overflow-hidden rounded-full bg-slate-100", className)}
    >
      {total > 0
        ? ORDER.filter((u) => counts[u] > 0).map((u) => (
            <span key={u} className={cn("h-full", FILLS[u])} style={{ width: `${shareOf(counts[u], total) ?? 0}%` }} />
          ))
        : null}
    </div>
  );
}
