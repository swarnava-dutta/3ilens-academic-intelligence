"use client";

import Link from "next/link";
import { pct1 } from "@/lib/format";
import type { RosterRow, RosterSummary } from "@/lib/types";
import { DeltaChip, UrgencyDot } from "./bits";
import { rowKey } from "./format";
import { trendTitle } from "./roster-table";

const PANEL = "min-w-0 rounded-md border border-slate-200 bg-white";
const LINK =
  "inline-flex min-h-10 items-center rounded-sm text-sm font-medium text-brand-cyan-600 hover:text-brand-navy hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan sm:min-h-0";
const MAX_ITEMS = 5;

/** "Act on first": flagged students (tier 1-4) in priority order, at most five. */
export function ActFirst({
  flagged,
  summary,
  firstHeldId,
  onOpen,
  onLog,
  onShowAll,
}: {
  flagged: RosterRow[];
  summary: RosterSummary;
  /** A held / failed sheet to link to when nothing is graded yet. */
  firstHeldId: number | null;
  onOpen: (row: RosterRow, opener: HTMLElement) => void;
  onLog: (row: RosterRow) => void;
  onShowAll: () => void;
}) {
  const shown = flagged.slice(0, MAX_ITEMS);
  const waiting = summary.held + summary.failed + summary.processing;
  return (
    <section aria-labelledby="act-first-title" className={PANEL}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-slate-200 px-4 py-3">
        <h2 id="act-first-title" className="text-[15px] font-semibold text-brand-navy">
          Act on first
        </h2>
        <p className="text-xs text-slate-600">At risk, slipping, or 2+ topics below 40% · no action yet comes first</p>
      </div>
      {summary.graded === 0 ? (
        <p className="px-4 py-5 text-sm text-slate-600">
          Nothing graded yet
          {waiting ? (
            <>
              {" "}- {waiting} sheet{waiting === 1 ? "" : "s"} {summary.held ? "held for review" : "not graded"}.{" "}
              {firstHeldId !== null ? (
                <Link href={`/report/${firstHeldId}`} className={LINK}>
                  Open the sheet
                </Link>
              ) : null}
            </>
          ) : (
            "."
          )}
        </p>
      ) : shown.length === 0 ? (
        <p className="px-4 py-5 text-sm text-slate-600">Nobody is at risk or slipping in this scope.</p>
      ) : (
        <ol className="divide-y divide-slate-100">
          {shown.map((row) => {
            const latest = row.latest;
            return (
              <li key={rowKey(row)} className="flex items-start gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    {latest ? <UrgencyDot urgency={latest.urgency} /> : null}
                    <button
                      type="button"
                      onClick={(e) => onOpen(row, e.currentTarget)}
                      className="inline-flex min-h-10 min-w-0 items-center truncate rounded-sm text-left font-medium text-brand-navy hover:text-brand-cyan-600 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan sm:min-h-0"
                    >
                      {row.student_name}
                    </button>
                    {latest ? (
                      <span className="text-sm font-semibold tabular-nums text-slate-800">{pct1(latest.pct)}</span>
                    ) : null}
                    {row.previous ? <DeltaChip delta={row.delta_pct} trend={row.trend} title={trendTitle(row)} /> : null}
                  </p>
                  <p className="text-[13px] leading-snug text-slate-600">{row.priority.reason}</p>
                </div>
                <button
                  type="button"
                  onClick={() => onLog(row)}
                  className="inline-flex h-10 shrink-0 items-center rounded-md border border-slate-300 px-3 text-[13px] font-medium text-slate-700 transition-colors duration-150 hover:border-brand-cyan hover:text-brand-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
                  aria-label={`Log an action for ${row.student_name}`}
                >
                  Log action
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {flagged.length > MAX_ITEMS ? (
        <div className="border-t border-slate-200 px-4 py-1.5 sm:py-2.5">
          <button type="button" onClick={onShowAll} className={LINK}>
            Show all {flagged.length} flagged students in the roster
          </button>
        </div>
      ) : null}
    </section>
  );
}
