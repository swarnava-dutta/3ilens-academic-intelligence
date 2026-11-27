"use client";

import Link from "next/link";
import { pct1 } from "@/lib/format";
import type { OwnerBehaviourRow, OwnerExamBehaviour, OwnerSignal } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmt } from "./format";
import { fixed1, linkCls, SMALL_GROUP, SmallGroupTag } from "./owner-ui";
import { EmptyNote, theadCls, thCls } from "./states";

const SMALL = SMALL_GROUP;

function Previous({ row }: { row: OwnerBehaviourRow }) {
  const prev = row.previous;
  if (!prev || prev.marks_lost_per_student === null || prev.current_marks_lost_per_student === null) {
    return <span className="text-slate-500">—</span>;
  }
  const before = prev.marks_lost_per_student;
  const now = prev.current_marks_lost_per_student;
  const better = now < before - 0.04;
  const worse = now > before + 0.04;
  return (
    <span
      className={cn("whitespace-nowrap tabular-nums", better ? "text-lime-800" : worse ? "text-rose-700" : "text-slate-700")}
      title={`Marks lost to wrong answers per student, same ${prev.students} students: ${prev.test} then the latest test`}
    >
      {fixed1(before)} &rarr; {fixed1(now)}
      <span className="sr-only">{better ? " (fewer marks lost)" : worse ? " (more marks lost)" : ""}</span>
      <span className="ml-1 text-xs text-slate-500">{better ? "fewer lost" : worse ? "more lost" : ""}</span>
    </span>
  );
}

/**
 * Exam behaviour tab (negatively-marked MCQs): how much students attempt, how often an attempt is
 * right, and the marks lost to wrong answers, per batch on each student's latest MCQ test.
 */
export function ExamBehaviourPanel({
  behaviour,
  signals,
}: {
  behaviour: OwnerExamBehaviour | null;
  signals: OwnerSignal[];
}) {
  const rows = behaviour?.by_batch ?? [];
  if (!behaviour || rows.length === 0) {
    return <EmptyNote>No negatively-marked MCQ papers graded yet.</EmptyNote>;
  }
  const overall = behaviour.overall;
  const insight = signals.find((s) => s.key === "under_attempting" || s.key === "over_attempting");
  const scheme = overall?.scheme ?? "+4/-1";
  const be = overall?.break_even;

  return (
    <div className="space-y-3">
      {insight ? (
        <p className="text-sm text-slate-800">
          <span className="font-medium">{insight.title}.</span>{" "}
          <span className="text-slate-600">{insight.detail}</span>
        </p>
      ) : null}
      <p className="text-xs text-slate-500">
        {insight
          ? ""
          : `${scheme.replace("/", " / ")} marking: answering pays once accuracy beats ${be !== null && be !== undefined ? `${fmt(be * 100, 0)}%` : "the break-even"}. `}
        Each student counts once, on their latest MCQ test.
      </p>
      <div className="hidden overflow-x-auto rounded-md border border-slate-200 md:block">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Exam behaviour on negatively-marked MCQs, per batch</caption>
          <thead className={theadCls}>
            <tr>
              <th scope="col" className={thCls}>Batch</th>
              <th scope="col" className={thCls}>Test</th>
              <th scope="col" className={cn(thCls, "text-right")}>Students</th>
              <th scope="col" className={cn(thCls, "text-right")} title="Attempted MCQs as a share of all negatively-marked MCQs">
                Attempted
              </th>
              <th scope="col" className={cn(thCls, "text-right")}>Right when attempted</th>
              <th scope="col" className={cn(thCls, "text-right")} title="Marks lost to wrong answers, per student">
                Marks lost / student
              </th>
              <th scope="col" className={cn(thCls, "text-right")} title="Questions left blank, per student">
                Blank Qs / student
              </th>
              <th scope="col" className={thCls} title="Same students, their previous negatively-marked MCQ test">
                vs previous test
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.batch_id ?? "all"}>
                <th scope="row" className="px-3 py-2 text-left font-medium">
                  {r.batch_id !== null ? (
                    <Link href={`/cohort?batch_id=${r.batch_id}`} className={linkCls}>
                      {r.batch_name}
                    </Link>
                  ) : (
                    r.batch_name
                  )}
                </th>
                <td className="px-3 py-2 text-slate-700">
                  {r.test}
                  {r.tests > 1 ? <span className="ml-1 text-xs text-slate-500">+{r.tests - 1} more</span> : null}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                  {r.students} {r.students < SMALL ? <SmallGroupTag n={r.students} /> : null}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-900" title={`${r.attempted} of ${r.mcqs} MCQs`}>
                  {pct1(r.attempt_rate_pct)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-900" title={`${r.correct} right of ${r.attempted} attempted`}>
                  {pct1(r.accuracy_pct)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-900" title={`${fixed1(r.marks_lost)} marks lost in all`}>
                  {fixed1(r.marks_lost_per_student)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-900" title={`${r.blank} of ${r.mcqs} questions blank in all`}>
                  {fmt(r.blank_per_student, 1)}
                </td>
                <td className="px-3 py-2">
                  <Previous row={r} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 md:hidden">
        {rows.map((r) => (
          <li key={r.batch_id ?? "all"} className="rounded-md border border-slate-200 px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              {r.batch_id !== null ? (
                <Link href={`/cohort?batch_id=${r.batch_id}`} className={cn(linkCls, "inline-flex min-h-10 items-center")}>
                  {r.batch_name}
                </Link>
              ) : (
                <span className="font-medium">{r.batch_name}</span>
              )}
              <span className="text-xs text-slate-600">
                {r.students} student{r.students === 1 ? "" : "s"} {r.students < SMALL ? <SmallGroupTag n={r.students} /> : null}
              </span>
            </div>
            <p className="text-xs text-slate-500">{r.test}</p>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
              <div>
                <dt className="text-slate-500">Attempted</dt>
                <dd className="tabular-nums text-slate-900">{pct1(r.attempt_rate_pct)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Right when attempted</dt>
                <dd className="tabular-nums text-slate-900">{pct1(r.accuracy_pct)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Marks lost / student</dt>
                <dd className="tabular-nums text-slate-900">{fixed1(r.marks_lost_per_student)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Blank Qs / student</dt>
                <dd className="tabular-nums text-slate-900">{fmt(r.blank_per_student, 1)}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-slate-500">vs previous test (marks lost / student)</dt>
                <dd>
                  <Previous row={r} />
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
      {overall ? (
        <p className="text-xs text-slate-500">
          All batches: {overall.students} students · {overall.blank} of {overall.mcqs} questions left blank ·{" "}
          {pct1(overall.attempt_rate_pct)} attempted · {pct1(overall.accuracy_pct)} right when attempted ·{" "}
          {fixed1(overall.marks_lost_per_student)} marks lost per student
          {overall.tests > 1
            ? ` (pooled over ${overall.tests} different tests, so a longer paper weighs more)`
            : ""}
          . Bonus questions are left out (no penalty risk). Student lists are in each batch&apos;s cohort patterns.
        </p>
      ) : null}
    </div>
  );
}
