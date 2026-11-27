import { num } from "@/components/cohort/format";
import type { OwnerDashboard } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmt, inr } from "./format";
import { Figure, stripCls } from "./kpis";
import { ageText } from "./owner-ui";

/**
 * Cost & operations tab: AI spend (this institution's sheets, other calls tagged with it, and
 * calls recorded without any institution), latency, tick-reading confidence, sheet and release
 * counts. The only place on the page that counts sheets rather than students.
 */
export function CostPanel({ data }: { data: OwnerDashboard }) {
  const t = data.totals;
  const ops = data.operations;
  const spend = data.spend ?? null;
  const release = data.release ?? null;
  const target = num(spend?.target_inr ?? ops?.target_inr) ?? 5;
  const perSheet = num(spend ? spend.per_graded_sheet_inr : ops?.avg_cost_per_student_inr);
  const over = perSheet !== null && perSheet > target;
  const latencyTarget = num(ops?.target_latency_seconds) ?? 300;
  const p95 = num(ops?.p95_latency_seconds);
  const scope = data.operations_scope ?? null;
  // Prefer live sheets for confidence (latency already is live-only); say how many sheets each tile covers.
  const liveConfidence = scope && scope.live_confidence_sheets > 0 ? num(scope.live_confidence) : null;
  const confidence = liveConfidence ?? num(ops?.mean_ocr_confidence);
  const latencyN = scope?.latency_sheets ?? null;
  const sheetsText = (n: number, live = true) => `${n} ${live ? "live " : ""}sheet${n === 1 ? "" : "s"}`;
  const confidenceHint =
    liveConfidence !== null && scope
      ? `mean over ${sheetsText(scope.live_confidence_sheets)}` +
        (scope.confidence_sample_sheets > 0 && num(ops?.mean_ocr_confidence) !== null
          ? ` · ${fmt((num(ops?.mean_ocr_confidence) ?? 0) * 100, 0)}% incl. ${scope.confidence_sample_sheets} sample`
          : "")
      : scope && scope.confidence_sheets > 0
        ? `mean over ${sheetsText(scope.confidence_sheets, false)}${scope.confidence_sample_sheets ? ` (${scope.confidence_sample_sheets} sample)` : ""}`
        : "mean over graded sheets";
  const latencyHint =
    latencyN !== null && latencyN < 5
      ? `average of ${sheetsText(latencyN)} · target ${fmt(latencyTarget, 0)} s`
      : `average · p95 ${p95 === null ? "—" : `${fmt(p95, 0)} s`}${latencyN !== null ? ` · ${sheetsText(latencyN)}` : ""} · target ${fmt(latencyTarget, 0)} s`;
  const superseded = release ? Math.max(0, release.sheets_provisional - release.students_awaiting) : 0;

  return (
    <div className="space-y-4">
      <div className={cn(stripCls, "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3")}>
        <Figure
          label="AI spend for this institution"
          value={inr(spend ? spend.grading_inr + spend.institution_other_inr : ops?.total_cost_inr)}
          hint={
            spend
              ? `grading, ${spend.grading_calls} call${spend.grading_calls === 1 ? "" : "s"}` +
                (spend.institution_other_inr > 0
                  ? ` · ${spend.institution_other_by_purpose.map((p) => `${p.label} ${inr(p.cost_inr)}`).join(" · ")}`
                  : "")
              : `${ops?.calls ?? 0} calls`
          }
        />
        <Figure
          label="Per graded live sheet"
          tone={over ? "rose" : "default"}
          value={perSheet === null ? "—" : inr(perSheet)}
          hint={
            perSheet === null ? (
              `no traced live sheet yet · target ${inr(target)}`
            ) : (
              <span className={over ? "font-medium text-rose-700" : "text-lime-800"}>
                {spend ? `${spend.live_graded_sheets} sheet${spend.live_graded_sheets === 1 ? "" : "s"} · ` : ""}
                {over ? "over" : "within"} the {inr(target)} target
              </span>
            )
          }
        />
        {spend ? (
          <Figure
            label="Not linked to any institution"
            value={inr(spend.unlinked_inr)}
            hint={
              spend.unlinked_by_purpose.length
                ? `${spend.unlinked_by_purpose.map((p) => `${p.label} ${inr(p.cost_inr)}`).join(" · ")} · recorded without an institution`
                : "nothing recorded without an institution"
            }
          />
        ) : null}
        <Figure
          label="Grading time per sheet"
          tone={p95 !== null && p95 > latencyTarget ? "amber" : "default"}
          value={ops?.avg_latency_seconds === null || ops?.avg_latency_seconds === undefined ? "—" : `${fmt(ops.avg_latency_seconds, 0)} s`}
          hint={latencyHint}
        />
        <Figure
          label="Tick-reading confidence"
          value={confidence === null ? "—" : `${fmt(confidence * 100, 0)}%`}
          hint={confidenceHint}
        />
        <Figure
          label="Sheets"
          value={
            <>
              {t.completed}
              <span className="text-sm font-normal text-slate-500"> graded / {t.submissions}</span>
            </>
          }
          hint={`${t.human_review} held · ${t.failed} failed · ${t.processing} processing`}
        />
      </div>
      {spend ? (
        <p className="text-sm text-slate-700">
          <span className="font-medium text-slate-900">All recorded AI spend: {inr(spend.total_inr)}</span>{" "}
          <span className="text-slate-600">
            = this institution {inr(spend.grading_inr + spend.institution_other_inr)} + not linked {inr(spend.unlinked_inr)}
            {(data.institutions?.length ?? 1) <= 1 ? " (the same total as the operations cost page)" : ""}
          </span>
        </p>
      ) : null}
      <p className="text-sm text-slate-700">
        <span className="font-medium text-slate-900">Releases: </span>
        {release ? (
          <>
            {release.sheets_released} released · {release.sheets_provisional} provisional sheets
            {release.sheets_provisional > 0 ? (
              <span className="text-slate-600">
                {" "}
                ({release.students_awaiting} are students&apos; latest reports, oldest waiting {ageText(release.oldest_days)}
                {superseded > 0 ? `; ${superseded} are older sheets superseded by a newer test, not waiting` : ""})
              </span>
            ) : null}
          </>
        ) : (
          <>
            {t.released} released · {t.provisional} provisional sheets
          </>
        )}
      </p>
      {data.is_demo ? (
        <p className="text-xs text-slate-500">
          Sample sheets are generated locally and cost nothing. Spend is from the provider calls recorded for live sheets
          and answer keys.
        </p>
      ) : null}
    </div>
  );
}
