"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { URGENCY_RULE } from "@/components/shared/urgency-badge";
import type { Cohort, Urgency } from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatPct, shareOf } from "./format";

const SEGMENTS: { key: Urgency; label: string; fill: string; text: string }[] = [
  { key: "at_risk", label: "At risk", fill: "bg-red-600", text: "text-red-700" },
  { key: "needs_attention", label: "Needs attention", fill: "bg-amber-500", text: "text-amber-700" },
  { key: "on_track", label: "On track", fill: "bg-brand-lime-600", text: "text-brand-navy" },
];

/**
 * Urgency split of the completed students. Each count links to the same dashboard filtered by
 * that urgency (?urgency=), or back to all when it is already selected.
 */
export function UrgencyStrip({ cohort }: { cohort: Cohort }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const counts = cohort.urgency_counts ?? { on_track: 0, needs_attention: 0, at_risk: 0 };
  const total = counts.on_track + counts.needs_attention + counts.at_risk;
  const selected = cohort.filters?.urgency ?? null;

  function hrefFor(urgency: Urgency): string {
    const next = new URLSearchParams(searchParams.toString());
    if (selected === urgency) next.delete("urgency");
    else next.set("urgency", urgency);
    const qs = next.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  return (
    <section aria-labelledby="cohort-urgency-title" className="min-w-0 rounded-md border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="cohort-urgency-title" className="text-[15px] font-semibold text-brand-navy">
          Urgency split <span className="font-normal tabular-nums text-slate-500">· {total} completed</span>
        </h2>
        <p className="text-xs text-slate-500" title={URGENCY_RULE}>
          &ge;70% on track · 55-70% needs attention · &lt;55% at risk · one level worse with 2+ topics &lt;40%
        </p>
      </div>
      <div className="mt-3 flex h-2 w-full gap-px overflow-hidden rounded-sm bg-slate-100" aria-hidden>
        {total > 0
          ? SEGMENTS.filter((s) => counts[s.key] > 0).map((s) => (
              <span key={s.key} className={cn("h-full", s.fill)} style={{ width: `${shareOf(counts[s.key], total) ?? 0}%` }} />
            ))
          : null}
      </div>
      <ul className="mt-3 grid grid-cols-3 divide-x divide-slate-200 rounded-md border border-slate-200">
        {SEGMENTS.map(({ key, label, fill, text }) => {
          const active = selected === key;
          return (
            <li key={key} className="min-w-0">
              <Link
                href={hrefFor(key)}
                scroll={false}
                aria-current={active ? "true" : undefined}
                title={active ? "Show every urgency" : `Show only "${label}" students`}
                className={cn(
                  "flex min-h-10 flex-col px-3 py-2 transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-cyan",
                  active && "bg-brand-cyan-50 hover:bg-brand-cyan-50",
                )}
              >
                <span className="flex items-center gap-1.5 text-xs text-slate-600">
                  <span className={cn("h-2 w-2 shrink-0 rounded-sm", fill)} aria-hidden />
                  <span className="truncate">{label}</span>
                </span>
                <span className="mt-0.5 flex items-baseline gap-1.5 tabular-nums">
                  <span className={cn("text-lg font-semibold", text)}>{counts[key]}</span>
                  <span className="text-xs text-slate-500">{formatPct(shareOf(counts[key], total))}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
