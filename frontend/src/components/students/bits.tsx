import type { OutcomeStatus, RosterRow, Trend, Urgency } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmtDelta, fmtDay, OUTCOME_LABELS, OUTCOME_STYLES, TREND_TEXT, URGENCY_DOT } from "./format";
import { URGENCY_LABELS } from "@/components/shared/urgency-badge";

/** Small square urgency marker; the label goes to screen readers. */
export function UrgencyDot({ urgency, className }: { urgency: Urgency; className?: string }) {
  return (
    <span className={cn("inline-flex items-center", className)}>
      <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-sm [print-color-adjust:exact]", URGENCY_DOT[urgency])} />
      <span className="sr-only">{URGENCY_LABELS[urgency]}</span>
    </span>
  );
}

const ARROW: Record<Trend, string> = { improving: "▲", slipping: "▼", steady: "→" };
const WORD: Record<Trend, string> = { improving: "up", slipping: "down", steady: "steady," };

/** "▲ +8.3" / "▼ −7.2" / "→ +1.2": colour always paired with an arrow and a sign. A change
 * against a different kind of test (trend null, delta set) is grey, with "≠" and no arrow. */
export function DeltaChip({
  delta,
  trend,
  title,
  className,
}: {
  delta: number | null;
  trend: Trend | null;
  title?: string;
  className?: string;
}) {
  if (delta !== null && trend === null) {
    return (
      <span
        title={title}
        className={cn("inline-flex items-center gap-1 whitespace-nowrap text-xs tabular-nums text-slate-500", className)}
      >
        <span aria-hidden>≠</span>
        <span aria-hidden>{fmtDelta(delta)}</span>
        <span className="sr-only">
          {fmtDelta(delta).replace("−", "minus ")} points against a different kind of test, not counted as a trend
        </span>
      </span>
    );
  }
  if (delta === null || trend === null) {
    return (
      <span className={cn("text-xs text-slate-500", className)} title={title}>
        —<span className="sr-only">first paper, no change to show</span>
      </span>
    );
  }
  return (
    <span
      title={title}
      className={cn("inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium tabular-nums", TREND_TEXT[trend], className)}
    >
      <span aria-hidden>{ARROW[trend]}</span>
      <span aria-hidden>{fmtDelta(delta)}</span>
      <span className="sr-only">
        {WORD[trend]} {Math.abs(delta).toFixed(1)} points vs the previous paper
      </span>
    </span>
  );
}

/** "Improved +16.7" / "Pending" / "No change" / "Declined −6.0". */
export function OutcomeChip({ status, change, className }: { status: OutcomeStatus; change: number | null; className?: string }) {
  const showChange = change !== null && (status === "improved" || status === "declined");
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-sm border px-1.5 text-[11px] font-medium tabular-nums",
        OUTCOME_STYLES[status],
        className,
      )}
    >
      {OUTCOME_LABELS[status]}
      {showChange ? ` ${fmtDelta(change)}` : ""}
    </span>
  );
}

/** The roster's Action cell: the last action since the latest paper, else "None yet". Amber only
 * for an at-risk student with nothing logged (the rows Act first is about); an older action is
 * shown as quiet context. */
export function ActionStatus({
  row,
  onLog,
  compact = false,
}: {
  row: RosterRow;
  onLog?: () => void;
  compact?: boolean;
}) {
  const last = row.actions.last;
  if (row.actions.since_latest > 0 && last) {
    return (
      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[13px] text-slate-700">
        <span className="min-w-0 truncate" title={`${last.topic} · ${fmtDay(last.applied_at)} · by ${last.applied_by}`}>
          {last.topic} · {fmtDay(last.applied_at)}
        </span>
        <OutcomeChip status={last.outcome_status} change={last.mastery_change} />
      </span>
    );
  }
  if (!row.latest) return <span className="text-slate-500">—</span>;
  if (row.latest.urgency === "on_track") {
    return <span className="text-[13px] text-slate-500">{compact ? "On track, no action needed" : "—"}</span>;
  }
  const urgent = row.latest.urgency === "at_risk";
  const older = row.actions.count > 0 && last ? `Earlier: ${last.topic} · ${fmtDay(last.applied_at)}` : null;
  return (
    <span className="flex flex-col items-start gap-0.5">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className={cn("text-[13px]", urgent ? "font-medium text-amber-800" : "text-slate-600")}
          title={`No action logged since the latest paper (uploaded ${fmtDay(row.latest.date)})`}
        >
          {compact ? "No action since latest paper" : "None yet"}
        </span>
        {onLog ? (
          <button
            type="button"
            onClick={onLog}
            className="inline-flex h-10 items-center rounded-md border border-slate-300 px-2.5 text-xs font-medium text-slate-700 transition-colors duration-150 hover:border-brand-cyan hover:text-brand-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan lg:h-8"
            aria-label={`Log an action for ${row.student_name}`}
          >
            Log
          </button>
        ) : null}
      </span>
      {older ? <span className="text-xs text-slate-500">{older}</span> : null}
    </span>
  );
}

/** Which group gets the inline tag: only the minority of real vs demo records is tagged (the
 * quiet line above the page already says how many are demo). */
export type DemoTag = "demo" | "real" | null;

export function demoTagFor(demoStudents: number, realStudents: number): DemoTag {
  if (demoStudents === 0 || realStudents === 0) return null;
  return realStudents <= demoStudents ? "real" : "demo";
}

/** Inline tags after the batch / ref line: "demo" or "real sheet" (the minority only) and
 * "check name" (a name taken from the file name). */
export function NameTags({ row, tag, fileName }: { row: RosterRow; tag: DemoTag; fileName: boolean }) {
  const demo = tag === "demo" && row.is_demo;
  const real = tag === "real" && !row.is_demo;
  if (!demo && !real && !fileName) return null;
  return (
    <>
      {demo ? (
        <span className="ml-1.5 shrink-0 whitespace-nowrap rounded-sm bg-slate-100 px-1 text-[11px] font-medium text-slate-600" title="Synthetic demo record">
          demo
        </span>
      ) : null}
      {real ? (
        <span
          className="ml-1.5 shrink-0 whitespace-nowrap rounded-sm bg-brand-cyan-50 px-1 text-[11px] font-medium text-brand-navy"
          title="A real uploaded sheet (the other students here are synthetic demo records)"
        >
          real sheet
        </span>
      ) : null}
      {fileName ? (
        <span
          className="ml-1.5 shrink-0 whitespace-nowrap rounded-sm border border-slate-300 px-1 text-[11px] font-medium text-slate-600"
          title="Name was taken from the uploaded file name - fix it on the report"
        >
          check name
        </span>
      ) : null}
    </>
  );
}
