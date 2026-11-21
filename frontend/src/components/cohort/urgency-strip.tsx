"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { AlertOctagon, AlertTriangle, CheckCircle2, type LucideIcon } from "lucide-react";
import { URGENCY_RULE } from "@/components/shared/urgency-badge";
import type { Cohort, Urgency } from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatPct, shareOf } from "./format";

const SEGMENTS: { key: Urgency; label: string; Icon: LucideIcon; fill: string; card: string; text: string }[] = [
  {
    key: "at_risk",
    label: "At risk",
    Icon: AlertOctagon,
    fill: "bg-rose-500",
    card: "ring-rose-200 hover:bg-rose-50",
    text: "text-rose-700",
  },
  {
    key: "needs_attention",
    label: "Needs attention",
    Icon: AlertTriangle,
    fill: "bg-amber-400",
    card: "ring-amber-200 hover:bg-amber-50",
    text: "text-amber-800",
  },
  {
    key: "on_track",
    label: "On track",
    Icon: CheckCircle2,
    fill: "bg-brand-lime-600",
    card: "ring-brand-lime/40 hover:bg-brand-lime-50",
    text: "text-lime-700",
  },
];

/**
 * Urgency split of the completed students (KPI row). Each count links to the same dashboard
 * filtered by that urgency (?urgency=), or back to all when it is already selected.
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
    <section
      aria-labelledby="cohort-urgency-title"
      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="cohort-urgency-title" className="text-sm font-semibold text-brand-navy">
          Urgency split <span className="font-normal text-slate-500">· {total} completed</span>
        </h2>
        <p className="text-xs text-slate-500" title={URGENCY_RULE}>
          &ge;70% on track · 55-70% needs attention · &lt;55% at risk · one level worse with 2+ topics &lt;40%
        </p>
      </div>
      <div className="mt-3 flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-slate-100" aria-hidden>
        {total > 0
          ? SEGMENTS.filter((s) => counts[s.key] > 0).map((s) => (
              <span key={s.key} className={cn("h-full", s.fill)} style={{ width: `${shareOf(counts[s.key], total) ?? 0}%` }} />
            ))
          : null}
      </div>
      <ul className="mt-3 grid grid-cols-3 gap-2">
        {SEGMENTS.map(({ key, label, Icon, card, text }) => {
          const active = selected === key;
          return (
            <li key={key} className="min-w-0">
              <Link
                href={hrefFor(key)}
                scroll={false}
                aria-current={active ? "true" : undefined}
                title={active ? "Show every urgency" : `Show only "${label}" students`}
                className={cn(
                  "flex h-full flex-col rounded-xl px-3 py-2 ring-1 ring-inset transition focus-visible:outline-2 focus-visible:outline-brand-cyan",
                  card,
                  active && "bg-slate-50 ring-2",
                )}
              >
                <span className={cn("flex items-center gap-1.5 text-xs font-medium", text)}>
                  <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="truncate">{label}</span>
                </span>
                <span className="mt-0.5 flex items-baseline gap-1.5">
                  <span className="text-2xl font-bold tabular-nums text-brand-navy">{counts[key]}</span>
                  <span className="text-xs tabular-nums text-slate-400">{formatPct(shareOf(counts[key], total))}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
