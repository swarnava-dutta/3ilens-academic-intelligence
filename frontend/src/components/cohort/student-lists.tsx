"use client";

import Link from "next/link";
import { useState } from "react";
import { UrgencyBadge } from "@/components/shared/urgency-badge";
import { plural } from "@/lib/format";
import type { AtRiskRow, RankingRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Card, CardHeader, TD, TH } from "./card";
import { formatNumber, formatPct } from "./format";

const EDGE = 5;
const TOGGLE =
  "h-8 rounded-md px-2 text-[13px] font-medium text-cyan-700 transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700";
const LINK =
  "rounded-sm font-medium text-slate-800 hover:text-cyan-700 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700";

function RankRow({ row }: { row: RankingRow }) {
  return (
    <tr>
      <td className={cn(TD, "w-10 text-right text-slate-500")}>{row.rank}</td>
      <th scope="row" className={cn(TD, "max-w-48 truncate text-left font-normal")}>
        <Link href={`/report/${row.submission_id}`} className={LINK}>
          {row.student_name}
        </Link>
      </th>
      <td className={cn(TD, "text-right whitespace-nowrap text-slate-500")}>
        {formatNumber(row.score)} / {formatNumber(row.total_marks)}
      </td>
      <td className={cn(TD, "text-right font-semibold text-brand-navy")}>{formatPct(row.pct)}</td>
      <td className={TD}>
        <UrgencyBadge urgency={row.urgency} size="sm" />
      </td>
    </tr>
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
        title="Batch ranking"
        subtitle={mixed ? "Ranked by percentage (tests differ)" : `${plural(rows.length, "completed student")} by score`}
        action={
          rows.length > EDGE * 2 ? (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className={TOGGLE}
            >
              {showAll ? "Top and bottom only" : `Show all ${rows.length}`}
            </button>
          ) : null
        }
      />
      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">No completed students in this view.</p>
      ) : (
        <div className="relative -mx-3 mt-2 overflow-x-auto">
          <table className="w-full min-w-[420px] border-collapse">
            <caption className="sr-only">Batch ranking</caption>
            <thead className="border-b border-slate-200">
              <tr>
                <th scope="col" className={cn(TH, "text-right")}>
                  Rank
                </th>
                <th scope="col" className={TH}>
                  Student
                </th>
                <th scope="col" className={cn(TH, "text-right")}>
                  Score
                </th>
                <th scope="col" className={cn(TH, "text-right")}>
                  %
                </th>
                <th scope="col" className={TH}>
                  Urgency
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {top.map((row) => (
                <RankRow key={row.submission_id} row={row} />
              ))}
              {split ? (
                <tr>
                  <td colSpan={5} className="bg-slate-50 px-3 py-1 text-center text-xs tabular-nums text-slate-500">
                    {rows.length - EDGE * 2} more
                  </td>
                </tr>
              ) : null}
              {bottom.map((row) => (
                <RankRow key={row.submission_id} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** Students the urgency rule marks "at risk", with the reasons and their biggest gap. */
export function AtRiskCard({ rows }: { rows: AtRiskRow[] }) {
  const [showAll, setShowAll] = useState(false);
  const list = rows ?? [];
  const shown = showAll ? list : list.slice(0, EDGE * 2);
  return (
    <Card aria-labelledby="cohort-atrisk-title">
      <CardHeader
        id="cohort-atrisk-title"
        title="At-risk students"
        subtitle={
          list.length ? `${plural(list.length, "student")} below 55% or with several weak topics` : "Nobody is at risk in this view"
        }
        action={
          list.length > EDGE * 2 ? (
            <button type="button" onClick={() => setShowAll((v) => !v)} className={TOGGLE}>
              {showAll ? `Lowest ${EDGE * 2} only` : `Show all ${list.length}`}
            </button>
          ) : null
        }
      />
      {list.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">No student meets the at-risk rule here.</p>
      ) : (
        <div className="relative -mx-3 mt-2 overflow-x-auto">
          <table className="w-full min-w-[480px] border-collapse">
            <caption className="sr-only">At-risk students</caption>
            <thead className="border-b border-slate-200">
              <tr>
                <th scope="col" className={TH}>
                  Student
                </th>
                <th scope="col" className={cn(TH, "text-right")}>
                  %
                </th>
                <th scope="col" className={TH}>
                  Biggest gap
                </th>
                <th scope="col" className={TH}>
                  Reasons
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {shown.map((row) => (
                <tr key={row.submission_id}>
                  <th scope="row" className={cn(TD, "text-left font-normal whitespace-nowrap")}>
                    <Link href={`/report/${row.submission_id}`} className={LINK}>
                      {row.student_name}
                    </Link>
                  </th>
                  <td className={cn(TD, "text-right font-semibold text-red-700")}>{formatPct(row.pct)}</td>
                  <td className={TD}>{row.top_gap || "—"}</td>
                  <td className={cn(TD, "min-w-56 text-xs text-slate-600")}>
                    {(row.reasons ?? []).length ? (
                      <ul className="space-y-0.5" title={row.reasons.join("; ")}>
                        {row.reasons.map((reason, i) => (
                          <li key={i} className="line-clamp-2">
                            {reason}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
