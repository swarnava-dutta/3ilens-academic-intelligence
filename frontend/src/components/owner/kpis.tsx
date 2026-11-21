import type { ReactNode } from "react";
import { URGENCY_LABELS, URGENCY_RULE } from "@/components/shared/urgency-badge";
import { num, shareOf } from "@/components/cohort/format";
import type { OwnerDashboard, Urgency } from "@/lib/types";
import { cn } from "@/lib/utils";
import { inr, pct } from "./format";

/** One figure in a KPI strip. */
export function Figure({
  label,
  value,
  hint,
  tone = "default",
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "amber" | "rose";
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 bg-white px-4 py-3", className)}>
      <p className="text-xs text-slate-500">{label}</p>
      <p
        className={cn(
          "mt-0.5 text-xl font-semibold tabular-nums text-brand-navy",
          tone === "amber" && "text-amber-700",
          tone === "rose" && "text-rose-700",
        )}
      >
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

/** Bordered row of figures with hairline dividers (wraps on small screens). */
export const stripCls = "grid gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200";

export function OwnerKpis({ data }: { data: OwnerDashboard }) {
  const t = data.totals;
  const ops = data.operations;
  const target = num(ops?.target_inr) ?? 5;
  const perStudent = num(ops?.avg_cost_per_student_inr);
  const overTarget = perStudent !== null && perStudent > target;

  return (
    <section aria-label="Institution totals" className={cn(stripCls, "grid-cols-2 md:grid-cols-4 xl:grid-cols-7")}>
      <Figure label="Students" value={t.students} hint={`${t.batches} batches · ${t.tests} tests · ${t.faculty} faculty`} />
      <Figure
        label="Completed"
        value={
          <>
            {t.completed}
            <span className="text-sm font-normal text-slate-500"> / {t.submissions}</span>
          </>
        }
        hint={`submissions evaluated${t.processing ? ` · ${t.processing} processing` : ""}`}
      />
      <Figure label="Average score" value={pct(t.average_pct)} hint="% of max marks, completed results" />
      <Figure
        label="Released / provisional"
        value={
          <>
            {t.released}
            <span className="text-sm font-normal text-slate-500"> / {t.provisional}</span>
          </>
        }
        hint="released / awaiting a teacher"
      />
      <Figure
        label="Review backlog"
        tone={t.human_review > 0 ? "amber" : "default"}
        value={t.human_review}
        hint={t.human_review > 0 ? "sheets waiting for OCR review" : "no sheets waiting"}
      />
      <Figure
        label="Failed"
        tone={t.failed > 0 ? "rose" : "default"}
        value={t.failed}
        hint={t.failed > 0 ? "in the dead-letter queue" : "no pipeline failures"}
      />
      <Figure
        label="Total AI cost"
        className="col-span-2 md:col-span-2 xl:col-span-1"
        value={inr(ops?.total_cost_inr)}
        hint={
          perStudent === null ? (
            <>per student unknown · target {inr(target)}</>
          ) : (
            <span className={overTarget ? "font-medium text-rose-700" : "text-lime-800"}>
              {inr(perStudent)} per student, {overTarget ? "over" : "within"} the {inr(target)} target
            </span>
          )
        }
      />
    </section>
  );
}

const ORDER: Urgency[] = ["at_risk", "needs_attention", "on_track"];
const FILLS: Record<Urgency, string> = {
  at_risk: "bg-rose-600",
  needs_attention: "bg-amber-400",
  on_track: "bg-brand-lime-600",
};
const TEXT: Record<Urgency, string> = {
  at_risk: "text-rose-700",
  needs_attention: "text-amber-800",
  on_track: "text-lime-800",
};

/** Institution-wide urgency split: one bar plus counts and shares as text. */
export function OwnerUrgencyStrip({ data }: { data: OwnerDashboard }) {
  const counts = data.urgency_counts ?? { on_track: 0, needs_attention: 0, at_risk: 0 };
  const total = counts.on_track + counts.needs_attention + counts.at_risk;
  return (
    <section aria-labelledby="owner-urgency-title" className="rounded-md border border-slate-200 bg-white px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="owner-urgency-title" className="text-[15px] font-semibold text-brand-navy">
          Urgency <span className="text-[13px] font-normal text-slate-500">· {total} completed results</span>
        </h2>
        <p className="text-xs text-slate-500" title={URGENCY_RULE}>
          &ge;70% on track · 55-70% needs attention · &lt;55% at risk
        </p>
      </div>
      <UrgencyBar counts={counts} className="mt-3 h-2" />
      <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        {ORDER.map((u) => (
          <div key={u} className="flex items-baseline gap-1.5">
            <dt className={cn("font-medium", TEXT[u])}>{URGENCY_LABELS[u]}</dt>
            <dd className="tabular-nums text-slate-800">
              <span className="font-semibold">{counts[u]}</span>{" "}
              <span className="text-xs text-slate-500">{pct(shareOf(counts[u], total))}</span>
            </dd>
          </div>
        ))}
      </dl>
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
      className={cn("flex w-full gap-px overflow-hidden rounded-sm bg-slate-100", className)}
    >
      {total > 0
        ? ORDER.filter((u) => counts[u] > 0).map((u) => (
            <span key={u} className={cn("h-full", FILLS[u])} style={{ width: `${shareOf(counts[u], total) ?? 0}%` }} />
          ))
        : null}
    </div>
  );
}
