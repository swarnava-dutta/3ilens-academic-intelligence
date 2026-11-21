"use client";

import Link from "next/link";
import { useState } from "react";
import { AlertOctagon, ArrowRight, ListOrdered } from "lucide-react";
import { UrgencyBadge } from "@/components/shared/urgency-badge";
import type { AtRiskRow, RankingRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Card, CardHeader } from "./card";
import { clampPct, formatNumber, formatPct, plural } from "./format";

const EDGE = 5;

function PctBar({ pct }: { pct: number }) {
  const tone = pct >= 70 ? "bg-brand-lime-600" : pct >= 55 ? "bg-amber-400" : "bg-rose-500";
  return (
    <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-slate-100 sm:block" aria-hidden>
      <span className={cn("block h-full rounded-full", tone)} style={{ width: `${clampPct(pct)}%` }} />
    </span>
  );
}

function RankRow({ row }: { row: RankingRow }) {
  return (
    <li className="flex items-center gap-3 py-2">
      <span
        className={cn(
          "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums",
          row.rank === 1 ? "bg-brand-navy text-white" : "bg-slate-100 text-slate-600",
        )}
        aria-label={`Rank ${row.rank}`}
      >
        {row.rank}
      </span>
      <div className="min-w-0 flex-1">
        <Link
          href={`/report/${row.submission_id}`}
          className="block truncate text-sm font-medium text-slate-800 hover:text-brand-cyan-600 hover:underline"
        >
          {row.student_name}
        </Link>
        <p className="text-xs tabular-nums text-slate-500">
          {formatNumber(row.score)} / {formatNumber(row.total_marks)}
        </p>
      </div>
      <PctBar pct={row.pct} />
      <span className="w-10 text-right text-sm font-semibold tabular-nums text-brand-navy">{formatPct(row.pct)}</span>
      <UrgencyBadge urgency={row.urgency} size="sm" className="hidden sm:inline-flex" />
    </li>
  );
}

/** Batch ranking by percentage: top and bottom five, with a toggle for the full list. */
export function RankingCard({ ranking, mixed }: { ranking: RankingRow[]; mixed: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const rows = ranking ?? [];
  const split = rows.length > EDGE * 2 && !showAll;
  const top = split ? rows.slice(0, EDGE) : rows;
  const bottom = split ? rows.slice(-EDGE) : [];

  return (
    <Card aria-labelledby="cohort-ranking-title">
      <CardHeader
        id="cohort-ranking-title"
        icon={ListOrdered}
        title="Batch ranking"
        subtitle={mixed ? "Ranked by percentage (tests differ)" : `${plural(rows.length, "completed student")} by score`}
        action={
          rows.length > EDGE * 2 ? (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="rounded-full px-3 py-1 text-xs font-medium text-brand-cyan-600 ring-1 ring-inset ring-brand-cyan/30 hover:bg-brand-cyan-50 focus-visible:outline-2 focus-visible:outline-brand-cyan"
            >
              {showAll ? "Top & bottom only" : `Show all ${rows.length}`}
            </button>
          ) : null
        }
      />
      {rows.length === 0 ? (
        <p className="mt-5 text-sm text-slate-500">No completed students in this view.</p>
      ) : (
        <>
          <ol className="mt-4 divide-y divide-slate-100">
            {top.map((row) => (
              <RankRow key={row.submission_id} row={row} />
            ))}
          </ol>
          {split ? (
            <>
              <p className="my-1 text-center text-xs text-slate-400" aria-hidden>
                ⋯ {rows.length - EDGE * 2} more ⋯
              </p>
              <ol className="divide-y divide-slate-100 border-t border-dashed border-slate-200">
                {bottom.map((row) => (
                  <RankRow key={row.submission_id} row={row} />
                ))}
              </ol>
            </>
          ) : null}
        </>
      )}
    </Card>
  );
}

/** Students the urgency rule marks "at risk", with the reasons and their biggest gap. */
export function AtRiskCard({ rows }: { rows: AtRiskRow[] }) {
  const list = rows ?? [];
  return (
    <Card aria-labelledby="cohort-atrisk-title" className={list.length ? "border-rose-200" : undefined}>
      <CardHeader
        id="cohort-atrisk-title"
        icon={AlertOctagon}
        title="At-risk students"
        subtitle={list.length ? `${plural(list.length, "student")} below 55% or with several weak topics` : "Nobody is at risk in this view"}
      />
      {list.length === 0 ? (
        <p className="mt-5 rounded-xl bg-brand-lime-50 px-4 py-4 text-center text-sm text-lime-800">
          No student meets the at-risk rule here.
        </p>
      ) : (
        <ul className="mt-4 space-y-2.5">
          {list.map((row) => (
            <li key={row.submission_id} className="rounded-xl border border-rose-100 bg-rose-50/40 px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <Link
                  href={`/report/${row.submission_id}`}
                  className="inline-flex min-w-0 items-center gap-1 text-sm font-semibold text-slate-800 hover:text-brand-cyan-600 hover:underline"
                >
                  <span className="truncate">{row.student_name}</span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
                </Link>
                <span className="text-sm font-bold tabular-nums text-rose-700">{formatPct(row.pct)}</span>
              </div>
              {row.top_gap ? (
                <p className="mt-0.5 text-xs text-slate-600">
                  Biggest gap: <span className="font-medium text-slate-800">{row.top_gap}</span>
                </p>
              ) : null}
              {(row.reasons ?? []).length ? (
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-rose-800/90">
                  {row.reasons.map((reason, i) => (
                    <li key={i}>{reason}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
