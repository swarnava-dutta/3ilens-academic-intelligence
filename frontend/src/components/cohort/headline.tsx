import Link from "next/link";
import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { Popover } from "@/components/shared/popover";
import { pct1, plural } from "@/lib/format";
import type { Cohort } from "@/lib/types";
import { cn } from "@/lib/utils";
import { COHORT_URGENCY_RULE, formatNumber, lost, POPOVER_PANEL, shareOf } from "./format";
import type { CohortTab, ParamPatch } from "./url";

type Tone = "good" | "bad" | "neutral";

/** "▲ 5.9 pts" with sr-only up/down; colour only says whether the move is good. */
export function Delta({ value, tone, unit = " pts" }: { value: number; tone: Tone; unit?: string }) {
  if (value === 0) return <span className="text-slate-600">no change</span>;
  const up = value > 0;
  return (
    <span
      className={cn(
        "whitespace-nowrap font-medium tabular-nums",
        tone === "good" ? "text-lime-700" : tone === "bad" ? "text-red-700" : "text-slate-700",
      )}
    >
      <span aria-hidden>{up ? "▲" : "▼"} </span>
      <span className="sr-only">{up ? "up" : "down"} </span>
      {Math.abs(value).toFixed(1)}
      {unit}
    </span>
  );
}

function Tile({
  label,
  value,
  hint,
  delta,
  href,
  tab,
  onReveal,
  info,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  delta?: ReactNode;
  href: string;
  /** The tab the link opens (scrolls the details into view); none for a link off the page. */
  tab?: CohortTab;
  onReveal?: (tab: CohortTab) => void;
  info?: ReactNode;
}) {
  return (
    <div className="relative min-w-0 bg-white px-4 py-3 transition-colors focus-within:bg-slate-50 hover:bg-slate-50">
      <dt className="flex items-center justify-between gap-2 text-[13px] text-slate-600">
        <span>{label}</span>
        {info}
      </dt>
      <dd className="mt-0.5 text-xl font-semibold tabular-nums text-brand-navy sm:text-2xl">
        <Link
          href={href}
          scroll={false}
          onClick={tab && onReveal ? () => onReveal(tab) : undefined}
          className="rounded-sm after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-cyan-700"
        >
          {value}
        </Link>
      </dd>
      {hint ? <dd className="mt-0.5 text-xs text-slate-600">{hint}</dd> : null}
      {delta ? <dd className="mt-1 text-xs text-slate-600">{delta}</dd> : null}
    </div>
  );
}

const SEGMENTS = [
  { key: "at_risk", fill: "bg-red-600" },
  { key: "needs_attention", fill: "bg-amber-500" },
  { key: "on_track", fill: "bg-brand-lime-600" },
] as const;

/** Fewer students than this: a spread (P25-P75) and a histogram say little, so they are hidden. */
export const MIN_SPREAD_N = 5;

/** The urgency rule, readable on tap (a tooltip never shows on a touch screen). */
function RuleButton() {
  return (
    <Popover
      align="right"
      chevron={false}
      panelClassName={POPOVER_PANEL}
      title="How urgency is decided"
      buttonClassName="relative z-10 inline-flex h-6 w-6 items-center justify-center rounded-sm text-slate-500 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-cyan-700"
      label={
        <>
          <Info className="h-3.5 w-3.5" aria-hidden />
          <span className="sr-only">How urgency is decided</span>
        </>
      }
    >
      {() => <p className="text-[13px] leading-snug text-slate-700">{COHORT_URGENCY_RULE}.</p>}
    </Popover>
  );
}

/**
 * The 4 headline figures of the scope: class average, at risk, negative marking and attempts (or
 * spread and top score on a written test; top and lowest score under 5 students). Deltas compare
 * with the previous class sitting of the batch, never across tests in "all tests" mode, and only
 * when the two papers are comparable (backend sittings.comparable) and half the class sat both;
 * with fewer, the change of the students who sat both leads; on papers that are not comparable
 * there is no change at all. Each tile opens its tab.
 */
export function HeadlineTiles({
  cohort,
  href,
  onReveal,
}: {
  cohort: Cohort;
  href: (patch: ParamPatch) => string;
  onReveal: (tab: CohortTab) => void;
}) {
  const scope = cohort.scope;
  const head = cohort.headline;
  if (!scope || !head || head.average_pct === null) return null;
  const n = scope.students;
  const prev = scope.mode === "sitting" ? cohort.previous ?? null : null;
  const paired = prev ? cohort.paired_change ?? null : null;
  const counts = cohort.urgency_counts;
  const attempt = cohort.attempt ?? null;
  const vs = prev ? prev.short_name : "";
  const comparable = prev ? prev.comparable !== false : false;
  const delta = head.delta_pts ?? null;
  const newAtRisk = prev?.newly_at_risk ?? 0;
  const negative = head.negative_scores ?? 0;
  const sameLength = attempt?.same_length !== false;
  const blankRate = attempt?.blank_rate ?? null;
  const mcqQualifier = attempt && attempt.students < n ? ` (${attempt.students} of ${n} had MCQs)` : "";

  let averageDelta: ReactNode = null;
  if (prev && comparable && delta !== null) {
    averageDelta = (
      <>
        <Delta value={delta} tone={delta >= 0 ? "good" : "bad"} /> vs {vs} ({pct1(prev.average_pct)})
      </>
    );
  } else if (prev && !comparable) {
    averageDelta = (
      <>
        {paired && paired.paired > 0 && paired.mean_change !== null ? (
          <>
            <Delta value={paired.mean_change} tone={paired.mean_change >= 0 ? "good" : "bad"} /> for the{" "}
            {paired.paired === 1 ? "1 student" : `${paired.paired} students`} with a comparable earlier test
          </>
        ) : null}
        <span className="block text-slate-500">
          Class averages not compared with {vs}: {prev.note ?? "different paper"}
        </span>
      </>
    );
  }

  const wide = attempt !== null || n >= MIN_SPREAD_N;
  return (
    <dl
      aria-label="Headline figures"
      // No overflow-hidden (the urgency rule popover must not be clipped): the corner tiles round
      // their own corners instead.
      className="grid grid-cols-2 gap-px rounded-md border border-slate-200 bg-slate-200 xl:grid-cols-4 [&>div:nth-child(1)]:rounded-tl-[5px] [&>div:nth-child(2)]:rounded-tr-[5px] [&>div:nth-child(3)]:rounded-bl-[5px] [&>div:nth-child(4)]:rounded-br-[5px] xl:[&>div:nth-child(1)]:rounded-bl-[5px] xl:[&>div:nth-child(2)]:rounded-tr-none xl:[&>div:nth-child(3)]:rounded-bl-none xl:[&>div:nth-child(4)]:rounded-tr-[5px]"
    >
      <Tile
        label="Class average"
        href={href({ tab: "students", urgency: null })}
        tab="students"
        onReveal={onReveal}
        value={pct1(head.average_pct)}
        hint={
          <>
            {head.average_marks !== null && head.total_marks !== null
              ? `${formatNumber(head.average_marks)} / ${formatNumber(head.total_marks)} avg marks · median ${pct1(head.median_pct)}`
              : `median ${pct1(head.median_pct)}`}
            {negative > 0 ? (
              <span className="block text-amber-800">
                {negative === 1 ? "1 student" : `${negative} students`} scored below 0 marks; their % counts as 0
              </span>
            ) : null}
          </>
        }
        delta={averageDelta}
      />
      <Tile
        label="At risk"
        href={href({ tab: "students", urgency: "at_risk" })}
        tab="students"
        onReveal={onReveal}
        info={<RuleButton />}
        value={
          <>
            <span className={counts.at_risk > 0 ? "text-red-700" : undefined}>{counts.at_risk}</span>
            <span className="text-base font-normal text-slate-600"> of {n}</span>
          </>
        }
        hint={
          <span className="block">
            <span className="mb-1 flex h-1.5 w-full gap-px overflow-hidden rounded-sm bg-slate-100" aria-hidden>
              {SEGMENTS.filter((s) => counts[s.key] > 0).map((s) => (
                <span key={s.key} className={s.fill} style={{ width: `${shareOf(counts[s.key], n) ?? 0}%` }} />
              ))}
            </span>
            Needs attention {counts.needs_attention} · On track {counts.on_track}
          </span>
        }
        delta={
          prev ? (
            <>
              {vs}: {prev.urgency_counts.at_risk} of {prev.students}
              {newAtRisk > 0 ? <span className="font-medium text-red-700"> · {newAtRisk} new</span> : null}
            </>
          ) : null
        }
      />
      {attempt ? (
        <>
          <Tile
            label="Negative marking"
            href={href({ tab: "behaviour" })}
            tab="behaviour"
            onReveal={onReveal}
            value={`${lost(attempt.negative_marks_total)} marks`}
            hint={`${plural(attempt.wrong, "wrong answer")} · ${lost(attempt.negative_per_student)} per student${mcqQualifier}`}
            delta={
              prev && prev.negative_per_student != null
                ? `${vs}: ${lost(prev.negative_per_student)} per student`
                : prev && prev.negative_marks_total !== null
                  ? `${vs}: ${lost(prev.negative_marks_total)}`
                  : null
            }
          />
          <Tile
            label="Attempted"
            href={href({ tab: "behaviour" })}
            tab="behaviour"
            onReveal={onReveal}
            value={pct1(attempt.attempt_rate)}
            hint={
              <>
                {pct1(attempt.accuracy_attempted)} right when attempted ·{" "}
                {scope.mode === "sitting" && sameLength
                  ? `${formatNumber(attempt.blanks_per_student)} of ${formatNumber(attempt.questions_per_student, 0)} left blank per student`
                  : `${pct1(blankRate ?? 100 - attempt.attempt_rate)} left blank`}
                {mcqQualifier}
              </>
            }
            delta={prev && prev.attempt_rate !== null ? `${vs}: ${pct1(prev.attempt_rate)}` : null}
          />
        </>
      ) : wide ? (
        <>
          <Tile
            label="Spread"
            href={href({ tab: "students", urgency: null })}
            tab="students"
            onReveal={onReveal}
            value={
              head.p25_pct !== null && head.p75_pct !== null
                ? `${Math.round(head.p25_pct)}–${Math.round(head.p75_pct)}%`
                : "—"
            }
            hint="the middle half of the class"
          />
          <Tile
            label="Top score"
            href={head.top_submission_id ? `/report/${head.top_submission_id}` : href({ tab: "students" })}
            value={pct1(head.top_pct)}
            hint={head.top_student ?? undefined}
          />
        </>
      ) : (
        <>
          <Tile
            label="Top score"
            href={head.top_submission_id ? `/report/${head.top_submission_id}` : href({ tab: "students" })}
            value={pct1(head.top_pct)}
            hint={head.top_student ?? undefined}
          />
          <Tile
            label="Lowest score"
            href={head.lowest_submission_id ? `/report/${head.lowest_submission_id}` : href({ tab: "students" })}
            value={pct1(head.lowest_pct ?? null)}
            hint={head.lowest_student ?? undefined}
          />
        </>
      )}
    </dl>
  );
}
