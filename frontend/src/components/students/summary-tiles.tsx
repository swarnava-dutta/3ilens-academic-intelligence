"use client";

import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import type { RosterSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmtMarks, plural, TREND_PTS } from "./format";

export type TileKey = "at_risk" | "moving" | "technique" | "waiting";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan";

function Tile({
  label,
  value,
  sub,
  pressed,
  onClick,
  tone,
  footer,
}: {
  label: string;
  value: ReactNode;
  sub: ReactNode;
  pressed: boolean;
  onClick: () => void;
  tone?: "risk" | "warn";
  /** A second, smaller action under the tile (a sibling button, never nested). */
  footer?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col rounded-md border bg-white transition-colors duration-150",
        pressed ? "border-brand-cyan ring-1 ring-brand-cyan" : "border-slate-200 hover:border-slate-300",
      )}
    >
      <button
        type="button"
        aria-pressed={pressed}
        onClick={onClick}
        className={cn(
          "flex min-h-[6.5rem] flex-1 flex-col items-start rounded-md px-4 py-3 text-left hover:bg-slate-50/60",
          FOCUS,
        )}
      >
        <span className="text-[13px] text-slate-600">{label}</span>
        <span
          className={cn(
            "mt-1 text-2xl font-semibold tabular-nums text-brand-navy",
            tone === "risk" && "text-red-700",
            tone === "warn" && "text-amber-800",
          )}
        >
          {value}
        </span>
        <span className="mt-auto pt-1 text-xs leading-snug text-slate-600">{sub}</span>
      </button>
      {footer}
    </div>
  );
}

function sheetParts(summary: RosterSummary): string {
  const parts = [
    summary.held ? `${summary.held} held for review` : "",
    summary.failed ? `${summary.failed} failed` : "",
    summary.processing ? `${summary.processing} being marked` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

/** The four things to look at first. Each tile's number is exactly the number of rows its click
 * shows (click again to clear). */
export function SummaryTiles({
  summary,
  active,
  onSelect,
  releaseActive,
  onRelease,
}: {
  summary: RosterSummary;
  active: TileKey | null;
  onSelect: (key: TileKey) => void;
  /** The "not released" filter is on. */
  releaseActive: boolean;
  onRelease: () => void;
}) {
  const nm = summary.negative_marking;
  const atRisk = summary.urgency_counts.at_risk;
  const moving = summary.improving + summary.slipping;
  const waiting = summary.waiting_students;
  const sheets = sheetParts(summary);

  const movingSub =
    summary.with_trend === 0
      ? summary.different_test > 0
        ? summary.different_test === 1
          ? "The earlier paper is a different kind of test - not compared"
          : `${summary.different_test} students' earlier papers are a different kind of test - not compared`
        : "No earlier comparable paper to compare with yet."
      : [
          `±${TREND_PTS} pts vs a comparable earlier paper`,
          `${summary.steady} steady`,
          summary.different_test ? `${summary.different_test} not comparable` : "",
        ]
          .filter(Boolean)
          .join(" · ");

  const techniqueSub =
    nm.profiled === 0
      ? "No negatively marked MCQ paper in scope."
      : nm.flagged === 0
        ? `Attempt strategy working on all ${nm.profiled} negatively marked papers`
        : [
            nm.guessing_risk ? `${nm.guessing_risk} losing marks to wrong answers` : "",
            nm.under_attempting ? `${nm.under_attempting} skipping too many` : "",
            `avg ${fmtMarks(nm.marks_lost_per_paper)} marks lost per paper`,
          ]
            .filter(Boolean)
            .join(" · ");

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" role="group" aria-label="Summary - each tile filters the roster">
      <Tile
        label="At risk"
        value={atRisk}
        tone={atRisk > 0 ? "risk" : undefined}
        sub={
          summary.graded === 0
            ? "Nothing graded yet"
            : atRisk === 0
              ? `None of ${summary.graded} graded students`
              : `${summary.at_risk_without_action} with no action since their latest paper`
        }
        pressed={active === "at_risk"}
        onClick={() => onSelect("at_risk")}
      />
      <Tile
        label="Moved 5+ pts"
        value={
          summary.with_trend === 0 ? (
            "—"
          ) : (
            <span className="whitespace-nowrap">
              <span className={summary.improving ? "text-lime-800" : undefined}>
                {summary.improving}
                <span className="ml-1 text-sm font-medium">up</span>
              </span>
              <span className="mx-1.5 text-base text-slate-500" aria-hidden>
                ·
              </span>
              <span className={summary.slipping ? "text-red-700" : undefined}>
                {summary.slipping}
                <span className="ml-1 text-sm font-medium">down</span>
              </span>
              <span className="sr-only"> - {plural(moving, "student")} listed</span>
            </span>
          )
        }
        sub={movingSub}
        pressed={active === "moving"}
        onClick={() => onSelect("moving")}
      />
      <Tile
        label="Exam technique"
        value={nm.profiled === 0 ? "—" : nm.flagged}
        tone={nm.flagged > 0 ? "warn" : undefined}
        sub={techniqueSub}
        pressed={active === "technique"}
        onClick={() => onSelect("technique")}
      />
      <Tile
        label="Sheets waiting on you"
        value={waiting}
        tone={waiting > 0 ? "warn" : undefined}
        sub={
          waiting === 0
            ? "No sheet held, failed or being marked"
            : `${plural(waiting, "student")} · ${sheets}`
        }
        pressed={active === "waiting"}
        onClick={() => onSelect("waiting")}
        footer={
          summary.graded > 0 && summary.provisional_latest > 0 ? (
            <button
              type="button"
              aria-pressed={releaseActive}
              onClick={onRelease}
              className={cn(
                "flex min-h-10 items-center gap-1 border-t border-slate-100 px-4 py-2 text-left text-xs font-medium tabular-nums hover:bg-slate-50",
                releaseActive ? "bg-brand-cyan-50 text-brand-navy" : "text-brand-cyan-600 hover:text-brand-navy",
                FOCUS,
              )}
            >
              <span className="min-w-0">
                {summary.provisional_latest} of {summary.graded} latest results not released
              </span>
              <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
            </button>
          ) : null
        }
      />
    </div>
  );
}
