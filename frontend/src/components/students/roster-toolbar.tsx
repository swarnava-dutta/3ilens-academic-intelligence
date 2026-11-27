"use client";

import { Search, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Modal, btnPrimary, btnSecondary, inputClass } from "@/components/report/dialog";
import { Popover } from "@/components/shared/popover";
import type { RosterSummary, RosterTopic, Urgency } from "@/lib/types";
import { cn } from "@/lib/utils";
import { WEAK_MASTERY } from "./format";
import { SORT_LABELS, type ReleaseFilter, type RosterParams, type RosterSort, type segmentCounts } from "./roster-logic";

export type ParamUpdate = Record<string, string | null>;

const selectClass =
  "h-10 min-w-0 rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-800 focus-visible:border-brand-cyan sm:h-9";

type Segment = { key: string; label: string; count: number; checked: boolean; apply: ParamUpdate };
export type SegmentCounts = ReturnType<typeof segmentCounts>;

/** Status segments; each count is the rows that segment shows under the other active filters. */
function segments(summary: RosterSummary, counts: SegmentCounts, p: RosterParams): Segment[] {
  const urgency = (u: Urgency, label: string): Segment => ({
    key: u,
    label,
    count: counts[u],
    checked: p.urgency === u,
    apply: { urgency: u, view: p.view === "ungraded" ? null : p.view },
  });
  const out: Segment[] = [
    {
      key: "all",
      label: "All",
      count: counts.all,
      checked: !p.urgency && p.view !== "ungraded",
      apply: { urgency: null, view: p.view === "ungraded" ? null : p.view },
    },
    urgency("at_risk", "At risk"),
    urgency("needs_attention", "Needs attention"),
    urgency("on_track", "On track"),
  ];
  if (summary.ungraded > 0) {
    out.push({
      key: "ungraded",
      label: "Not graded",
      count: counts.ungraded,
      checked: p.view === "ungraded",
      apply: { urgency: null, view: "ungraded" },
    });
  }
  return out;
}

function FilterFields({
  params,
  topics,
  onChange,
  idPrefix,
}: {
  params: RosterParams;
  topics: RosterTopic[];
  onChange: (u: ParamUpdate) => void;
  idPrefix: string;
}) {
  const names = [...topics].map((t) => t.topic).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  if (params.topic && !names.includes(params.topic)) names.unshift(params.topic);
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label htmlFor={`${idPrefix}-topic`} className="text-sm font-medium text-slate-700">
          Weak topic <span className="font-normal text-slate-500">(latest paper below {WEAK_MASTERY}%)</span>
        </label>
        <select
          id={`${idPrefix}-topic`}
          className={cn(inputClass, "h-10")}
          value={params.topic ?? ""}
          onChange={(e) => onChange({ topic: e.target.value || null })}
        >
          <option value="">Any topic</option>
          {names.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <label htmlFor={`${idPrefix}-release`} className="text-sm font-medium text-slate-700">
          Release
        </label>
        <select
          id={`${idPrefix}-release`}
          className={cn(inputClass, "h-10")}
          value={params.release ?? ""}
          onChange={(e) => onChange({ release: (e.target.value as ReleaseFilter) || null })}
        >
          <option value="">All</option>
          <option value="unreleased">Not released</option>
          <option value="released">Released</option>
        </select>
      </div>
    </div>
  );
}

function SortSelect({ params, onChange, id, className }: { params: RosterParams; onChange: (u: ParamUpdate) => void; id: string; className?: string }) {
  return (
    <select
      id={id}
      className={cn(selectClass, className)}
      value={params.sort}
      onChange={(e) => onChange({ sort: e.target.value === "priority" ? null : (e.target.value as RosterSort) })}
    >
      {(Object.keys(SORT_LABELS) as RosterSort[]).map((s) => (
        <option key={s} value={s}>
          {SORT_LABELS[s]}
        </option>
      ))}
    </select>
  );
}

/** Segmented urgency control, name search, sort and the extra filters (a sheet on phones). */
export function RosterToolbar({
  summary,
  counts,
  params,
  topics,
  onChange,
}: {
  summary: RosterSummary;
  counts: SegmentCounts;
  params: RosterParams;
  topics: RosterTopic[];
  onChange: (u: ParamUpdate) => void;
}) {
  const ids = useId();
  const [text, setText] = useState(params.q);
  const [syncedQ, setSyncedQ] = useState(params.q);
  const [sent, setSent] = useState(params.q);
  const [sheet, setSheet] = useState(false);
  if (params.q !== syncedQ) {
    setSyncedQ(params.q);
    // Changed elsewhere (Clear, back button), not by this box's own debounce: show it.
    if (params.q !== sent) {
      setSent(params.q);
      setText(params.q);
    }
  }

  useEffect(() => {
    const value = text.trim() ? text : "";
    if (value === params.q) return;
    const t = setTimeout(() => {
      setSent(value);
      onChange({ q: value || null });
    }, 250);
    return () => clearTimeout(t);
  }, [text, params.q, onChange]);

  const extra = (params.topic ? 1 : 0) + (params.release ? 1 : 0);
  const mobileExtra = extra + (params.sort !== "priority" ? 1 : 0);

  return (
    <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between print:hidden">
      <div>
        <div
          role="group"
          aria-label="Students by status"
          className="inline-flex flex-wrap gap-0.5 rounded-md border border-slate-200 bg-white p-0.5"
        >
          {segments(summary, counts, params).map((s) => (
            <button
              key={s.key}
              type="button"
              aria-pressed={s.checked}
              onClick={() => onChange(s.apply)}
              className={cn(
                "inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-[5px] px-2.5 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-cyan",
                s.checked ? "bg-brand-navy text-white" : "text-slate-600 hover:bg-slate-50 hover:text-brand-navy",
              )}
            >
              {s.label}
              <span className={cn("tabular-nums", s.checked ? "text-white/80" : "text-slate-500")}>{s.count}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <label className="relative min-w-0 flex-1 lg:w-56 lg:flex-none">
          <span className="sr-only">Search by name or roll number</span>
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Name or roll no."
            className="h-10 w-full rounded-md border border-slate-300 bg-white pr-8 pl-8 text-sm text-slate-800 placeholder:text-slate-400 focus:border-brand-cyan focus:ring-2 focus:ring-brand-cyan/30 focus:outline-none sm:h-9"
          />
          {text ? (
            <button
              type="button"
              onClick={() => setText("")}
              aria-label="Clear search"
              className="absolute top-1/2 right-1 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-md text-slate-400 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-brand-cyan"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
        </label>

        <label className="hidden items-center gap-1.5 sm:flex">
          <span className="text-[13px] text-slate-500">Sort</span>
          <SortSelect params={params} onChange={onChange} id={`${ids}-sort`} />
        </label>

        <div className="hidden sm:block">
          <Popover
            label={<span>More filters{extra ? ` (${extra})` : ""}</span>}
            icon={<SlidersHorizontal className="h-4 w-4" aria-hidden />}
            buttonClassName={cn(btnSecondary, "px-3", extra > 0 && "border-brand-cyan text-brand-navy")}
            panelClassName="w-72 p-3"
          >
            <FilterFields params={params} topics={topics} onChange={onChange} idPrefix={`${ids}-pop`} />
          </Popover>
        </div>

        <button
          type="button"
          onClick={() => setSheet(true)}
          className={cn(btnSecondary, "h-10 shrink-0 px-3 sm:hidden", mobileExtra > 0 && "border-brand-cyan text-brand-navy")}
        >
          <SlidersHorizontal className="h-4 w-4" aria-hidden />
          Filters{mobileExtra ? ` (${mobileExtra})` : ""}
        </button>
      </div>

      <Modal open={sheet} onClose={() => setSheet(false)} title="Sort and filter" eyebrow="Students">
        <div className="space-y-3">
          <div className="space-y-1">
            <label htmlFor={`${ids}-msort`} className="text-sm font-medium text-slate-700">
              Sort
            </label>
            <SortSelect params={params} onChange={onChange} id={`${ids}-msort`} className="w-full" />
          </div>
          <FilterFields params={params} topics={topics} onChange={onChange} idPrefix={`${ids}-sheet`} />
          <div className="flex justify-end pt-1">
            <button type="button" className={btnPrimary} onClick={() => setSheet(false)}>
              Show students
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
