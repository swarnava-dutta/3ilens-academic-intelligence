import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { shareOf } from "@/components/cohort/format";
import { numOrNull } from "@/lib/coerce";
import { pct1 } from "@/lib/format";
import type { OwnerDashboard, Urgency } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmt } from "./format";
import { ageText, ChangeText } from "./owner-ui";
import { focusRing } from "./states";

/**
 * One figure in a KPI strip. With `onClick` it renders as a button (same look) that jumps to
 * the matching detail, e.g. an attention row.
 */
export function Figure({
  label,
  value,
  hint,
  tone = "default",
  className,
  title,
  onClick,
  actionLabel,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "amber" | "rose";
  className?: string;
  /** Tooltip on the tile. */
  title?: string;
  onClick?: () => void;
  /** Visually hidden text appended to a clickable tile, e.g. "Show the at-risk students". */
  actionLabel?: string;
}) {
  const valueCls = cn(
    "mt-0.5 block text-xl font-semibold tabular-nums text-brand-navy",
    tone === "amber" && "text-amber-700",
    tone === "rose" && "text-rose-700",
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={title}
        className={cn(
          "flex min-w-0 flex-col items-stretch justify-start bg-white px-4 py-3 text-left transition-colors duration-150 hover:bg-slate-50",
          focusRing,
          "focus-visible:-outline-offset-2",
          className,
        )}
      >
        <span className="flex items-center justify-between gap-2 text-xs text-slate-500">
          {label}
          {/* Visible cue that the tile opens the matching detail (hover alone is not enough). */}
          <span aria-hidden className="inline-flex items-center gap-0.5 font-medium text-[#037285]">
            View
            <ChevronRight className="h-3.5 w-3.5" />
          </span>
        </span>
        <span className={valueCls}>{value}</span>
        {hint ? <span className="mt-0.5 block text-xs text-slate-500">{hint}</span> : null}
        {actionLabel ? <span className="sr-only">. {actionLabel}</span> : null}
      </button>
    );
  }
  return (
    <div className={cn("min-w-0 bg-white px-4 py-3", className)} title={title}>
      <p className="text-xs text-slate-500">{label}</p>
      <p className={valueCls}>{value}</p>
      {hint ? <div className="mt-0.5 text-xs text-slate-500">{hint}</div> : null}
    </div>
  );
}

/** Bordered row of figures with hairline dividers (wraps on small screens). */
export const stripCls = "grid gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200";

/**
 * The four owner KPIs: students graded, average score (with same-student progress), at risk
 * and awaiting release. Every figure counts students by their latest test.
 */
export function OwnerKpis({
  data,
  onJump,
  canJump,
}: {
  data: OwnerDashboard;
  onJump: (signalKey: string) => void;
  canJump: (signalKey: string) => boolean;
}) {
  const t = data.totals;
  const graded = t.students_graded ?? (data.urgency_counts ? sumCounts(data.urgency_counts) : 0);
  const counts = data.urgency_counts ?? { on_track: 0, needs_attention: 0, at_risk: 0 };
  const sheetCounts = t.sheet_urgency_counts ?? null;
  const progress = data.progress ?? null;
  const release = data.release ?? null;
  const held = data.held_sheets?.length ?? t.human_review ?? 0;
  const pending = [
    held ? `${held} held for review` : null,
    t.processing ? `${t.processing} processing` : null,
    t.failed ? `${t.failed} failed` : null,
  ].filter(Boolean);
  const atRiskShare = shareOf(counts.at_risk, graded);
  const oldest = numOrNull(release?.oldest_days);
  const releaseTone = oldest !== null && oldest >= 7 ? "rose" : oldest !== null && oldest >= 2 ? "amber" : "default";
  const riskTitle =
    `Students by their latest test, one row each (as on the Students page).` +
    (sheetCounts ? ` Counting every graded sheet instead, ${sheetCounts.at_risk} of ${t.completed} sheets were at risk when graded.` : "");

  return (
    <section aria-label="Institution figures" className={cn(stripCls, "grid-cols-2 md:grid-cols-4")}>
      <Figure
        label="Students graded"
        value={
          <>
            {graded}
            <span className="text-sm font-normal text-slate-500"> / {t.students}</span>
          </>
        }
        hint={pending.length ? pending.join(" · ") : "every uploaded student has a graded sheet"}
        title={`${graded} of ${t.students} students have at least one graded sheet`}
      />
      <Figure
        label="Average score"
        value={pct1(t.average_pct)}
        title={`${pct1(t.average_pct)} · mean of each graded student's latest test`}
        hint={
          <>
            <span className="block">{graded} students, latest test each</span>
            {progress && progress.students > 0 ? (
              <span
                className="mt-0.5 block"
                title={`${progress.students} students of a whole-class test against the test each sat before, on comparable papers (${pct1(progress.mean_before)} to ${pct1(progress.mean_after)})${progress.not_comparable ? `; ${progress.not_comparable} more re-tested on a paper that is not comparable` : ""}. It is not the change in the average above.`}
              >
                Re-tested ({progress.students}): <ChangeText value={progress.mean_change} />
              </span>
            ) : progress && progress.not_comparable ? (
              <span className="mt-0.5 block">re-tested ({progress.not_comparable}): not comparable</span>
            ) : progress ? (
              <span className="mt-0.5 block">no repeat test yet</span>
            ) : null}
          </>
        }
      />
      <Figure
        label="At risk"
        tone={counts.at_risk > 0 ? "rose" : "default"}
        title={riskTitle}
        onClick={canJump("at_risk_unactioned") ? () => onJump("at_risk_unactioned") : undefined}
        actionLabel="Show the at-risk students without an action"
        value={
          <>
            {counts.at_risk}
            {atRiskShare !== null ? (
              <span className="text-sm font-normal text-slate-500"> ({fmt(atRiskShare, 0)}%)</span>
            ) : null}
          </>
        }
        hint={
          <>
            <UrgencyBar counts={counts} className="mt-1 h-1.5" decorative={canJump("at_risk_unactioned")} />
            <span className="mt-1 block">
              {counts.needs_attention} need attention · {counts.on_track} on track
            </span>
          </>
        }
      />
      {release ? (
        <Figure
          label="Awaiting release"
          tone={release.students_awaiting > 0 ? releaseTone : "default"}
          onClick={canJump("release_backlog") ? () => onJump("release_backlog") : undefined}
          actionLabel="Show the release backlog by batch"
          title={`Students whose latest report is still provisional. Sheets: ${release.sheets_released} released, ${release.sheets_provisional} provisional.`}
          value={
            <>
              {release.students_awaiting}
              <span className="text-sm font-normal text-slate-500"> / {release.students_graded}</span>
            </>
          }
          hint={
            release.students_awaiting > 0
              ? `students without their latest report · oldest ${ageText(release.oldest_days)}`
              : "every student has their latest report"
          }
        />
      ) : (
        <Figure
          label="Released / provisional"
          value={
            <>
              {t.released}
              <span className="text-sm font-normal text-slate-500"> / {t.provisional}</span>
            </>
          }
          hint="sheets released / awaiting a teacher"
        />
      )}
    </section>
  );
}

function sumCounts(c: { on_track: number; needs_attention: number; at_risk: number }): number {
  return c.on_track + c.needs_attention + c.at_risk;
}

const ORDER: Urgency[] = ["at_risk", "needs_attention", "on_track"];
const FILLS: Record<Urgency, string> = {
  at_risk: "bg-rose-600",
  needs_attention: "bg-amber-400",
  on_track: "bg-brand-lime-600",
};

/** Stacked urgency bar (at risk -> on track) with a text equivalent for screen readers. */
export function UrgencyBar({
  counts,
  className,
  decorative = false,
}: {
  counts: { on_track: number; needs_attention: number; at_risk: number };
  className?: string;
  /** Hide from assistive tech when nearby text already says the same (e.g. inside a button). */
  decorative?: boolean;
}) {
  const total = counts.on_track + counts.needs_attention + counts.at_risk;
  const text = `${counts.at_risk} at risk, ${counts.needs_attention} need attention, ${counts.on_track} on track`;
  return (
    <span
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : text}
      aria-hidden={decorative || undefined}
      title={text}
      className={cn("flex w-full gap-px overflow-hidden rounded-sm bg-slate-100", className)}
    >
      {total > 0
        ? ORDER.filter((u) => counts[u] > 0).map((u) => (
            <span key={u} className={cn("h-full", FILLS[u])} style={{ width: `${shareOf(counts[u], total) ?? 0}%` }} />
          ))
        : null}
    </span>
  );
}
