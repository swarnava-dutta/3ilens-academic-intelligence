"use client";

import Link from "next/link";
import { useState } from "react";
import { toneFor } from "@/components/cohort/format";
import type { OwnerHiddenTopic, OwnerTopicGap, TopicPoint } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Disclosure, linkCls, MasteryBar } from "./owner-ui";
import { EmptyNote, theadCls, thCls } from "./states";

const FIRST = 8;

function cohortHref(gap: OwnerTopicGap): string {
  const batch = gap.batch_ids.length === 1 ? `&batch_id=${gap.batch_ids[0]}` : "";
  return `/cohort?topic=${encodeURIComponent(gap.topic)}${batch}`;
}

function hiddenNote(hidden: OwnerHiddenTopic[]): string | null {
  if (!hidden.length) return null;
  const subjects = hidden.filter((h) => h.reason === "subject_only");
  const few = hidden.filter((h) => h.reason === "few_students");
  const parts: string[] = [];
  if (few.length) parts.push(`seen by fewer than 3 students (${few.length})`);
  if (subjects.length) parts.push(`named only by subject (${subjects.map((h) => h.topic).join(", ")})`);
  return `${hidden.length} topic${hidden.length === 1 ? "" : "s"} hidden: ${parts.join(" or ")}.`;
}

/**
 * Topics tab: chapter-level topics seen by 3+ students, weakest first (mean mastery over each
 * student's latest test). Subject-only names and tiny samples are listed in a footnote.
 */
export function TopicsPanel({
  gaps,
  hidden,
  fallback,
}: {
  gaps: OwnerTopicGap[] | null;
  hidden: OwnerHiddenTopic[];
  fallback: TopicPoint[];
}) {
  const [all, setAll] = useState(false);
  if (gaps === null) {
    // Older API: only the five weakest topics, without student counts.
    return fallback.length ? (
      <ul className="space-y-2">
        {fallback.map((t) => (
          <li key={t.topic} className="flex items-center justify-between gap-3 text-sm">
            <span className="text-slate-800">{t.topic}</span>
            <MasteryBar value={t.mastery} barClass={toneFor(t.mastery).bar} />
          </li>
        ))}
      </ul>
    ) : (
      <EmptyNote>Topics appear once at least 3 students have been graded on them.</EmptyNote>
    );
  }
  if (gaps.length === 0) {
    return (
      <div className="space-y-2">
        <EmptyNote>Topics appear once at least 3 students have been graded on them.</EmptyNote>
        {hiddenNote(hidden) ? <p className="text-xs text-slate-500">{hiddenNote(hidden)}</p> : null}
      </div>
    );
  }
  const rows = all ? gaps : gaps.slice(0, FIRST);
  const note = hiddenNote(hidden);

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Mean mastery on each student&apos;s latest test, weakest first. Only topics seen by 3 or more students.
      </p>
      <div id="owner-topics-rows" className="space-y-3">
      <div className="hidden overflow-hidden rounded-md border border-slate-200 md:block">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Topics by mean mastery, weakest first</caption>
          <thead className={theadCls}>
            <tr>
              <th scope="col" className={thCls}>Topic</th>
              <th scope="col" className={thCls}>Mastery</th>
              <th scope="col" className={cn(thCls, "text-right")}>Students</th>
              <th scope="col" className={cn(thCls, "text-right")}>Below 40%</th>
              <th scope="col" className={thCls}>Batches</th>
              <th scope="col" className={thCls}><span className="sr-only">Cohort</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((g) => {
              const tone = toneFor(g.mastery);
              return (
                <tr key={g.topic}>
                  <th scope="row" className="px-3 py-2 text-left font-medium text-slate-900">
                    {g.topic}
                    {g.subject ? <span className="ml-1.5 text-xs font-normal text-slate-500">{g.subject}</span> : null}
                  </th>
                  <td className="px-3 py-2" title={`${tone.label} (${tone.range}) · ${g.mastery.toFixed(1)}%`}>
                    <MasteryBar value={g.mastery} barClass={tone.bar} />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">{g.students}</td>
                  <td className={cn("px-3 py-2 text-right tabular-nums", g.below_40 ? "text-slate-900" : "text-slate-500")}>
                    {g.below_40}
                  </td>
                  <td className="px-3 py-2 text-slate-700">{g.batches.join(", ")}</td>
                  <td className="px-3 py-2 text-right">
                    <Link href={cohortHref(g)} className={cn(linkCls, "whitespace-nowrap")} aria-label={`Open ${g.topic} in cohort`}>
                      Open in cohort
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 md:hidden">
        {rows.map((g) => {
          const tone = toneFor(g.mastery);
          return (
            <li key={g.topic} className="px-3 py-2">
              <div className="flex items-center justify-between gap-3 text-sm">
                <Link href={cohortHref(g)} className={cn(linkCls, "inline-flex min-h-10 min-w-0 items-center")}>
                  {g.topic}
                </Link>
                <span className="shrink-0">
                  <MasteryBar value={g.mastery} barClass={tone.bar} />
                </span>
              </div>
              <p className="text-xs text-slate-600">
                Students {g.students} · below 40%: {g.below_40} · {g.batches.join(", ")}
              </p>
            </li>
          );
        })}
      </ul>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {gaps.length > FIRST ? (
          <Disclosure open={all} onToggle={() => setAll((v) => !v)} controls="owner-topics-rows">
            {all ? "Show the weakest 8" : `Show all ${gaps.length}`}
          </Disclosure>
        ) : (
          <span />
        )}
        {note ? <p className="text-xs text-slate-500">{note}</p> : null}
      </div>
    </div>
  );
}
