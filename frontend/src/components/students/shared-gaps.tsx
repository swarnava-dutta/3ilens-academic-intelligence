"use client";

import { ShareBar } from "@/components/charts/sparkline";
import type { RosterTopic } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmtMarks, fmtMastery, WEAK_MASTERY } from "./format";

const MAX_ITEMS = 3;
const LINK =
  "inline-flex min-h-10 items-center rounded-sm text-sm font-medium text-brand-cyan-600 hover:text-brand-navy hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan sm:min-h-0";

/** Chapter topics, most students below 60% first (whole-subject rows from untagged papers are
 * left out: "Physics 1 of 1" is not a shared gap). Same order as the Topics tab. */
export function rankGaps(topics: RosterTopic[]): RosterTopic[] {
  return topics
    .filter((t) => t.below_60 > 0 && !t.subject_level)
    .sort(
      (a, b) =>
        b.below_60 - a.below_60 ||
        (a.mean_mastery ?? 101) - (b.mean_mastery ?? 101) ||
        a.topic.localeCompare(b.topic, undefined, { sensitivity: "base" }),
    );
}

/** "Shared gaps": the three topics most students are below 60% in (on their latest paper). */
export function SharedGaps({
  topics,
  graded,
  activeTopic,
  onTopic,
  onAll,
}: {
  topics: RosterTopic[];
  /** Graded students in scope (0 = nothing to rank yet). */
  graded: number;
  activeTopic: string | null;
  onTopic: (topic: string) => void;
  onAll: () => void;
}) {
  const ranked = rankGaps(topics).slice(0, MAX_ITEMS);
  return (
    <section aria-labelledby="shared-gaps-title" className="min-w-0 rounded-md border border-slate-200 bg-white">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-slate-200 px-4 py-3">
        <h2 id="shared-gaps-title" className="text-[15px] font-semibold text-brand-navy">
          Shared gaps
        </h2>
        <p className="text-xs text-slate-600">Most students below {WEAK_MASTERY}% · latest paper each</p>
      </div>
      {graded === 0 ? (
        <p className="px-4 py-5 text-sm text-slate-600">Nothing graded yet.</p>
      ) : ranked.length === 0 ? (
        <p className="px-4 py-5 text-sm text-slate-600">No topic has a student below {WEAK_MASTERY}% in this scope.</p>
      ) : (
        <ol className="divide-y divide-slate-100">
          {ranked.map((t) => {
            const active = activeTopic?.toLocaleLowerCase() === t.topic.toLocaleLowerCase();
            return (
              <li key={t.topic}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => onTopic(t.topic)}
                  className={cn(
                    "block w-full px-4 py-3 text-left transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-cyan",
                    active && "bg-brand-cyan-50",
                  )}
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate font-medium text-slate-800">
                      {t.topic}
                      {t.subject ? <span className="ml-1.5 text-xs font-normal text-slate-500">{t.subject}</span> : null}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-slate-500">mean {fmtMastery(t.mean_mastery)}</span>
                  </span>
                  <span className="mt-1 block text-[13px] tabular-nums text-slate-700">
                    {t.below_60} of {t.tested} students below {WEAK_MASTERY}%
                  </span>
                  <ShareBar value={t.below_60} max={t.tested} className="mt-1.5" />
                  {t.marks_lost > 0 ? (
                    <span className="mt-1 block text-xs tabular-nums text-slate-500">
                      Marks lost to wrong answers: {fmtMarks(t.marks_lost)}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {graded > 0 && topics.length > 0 ? (
        <div className="border-t border-slate-200 px-4 py-1.5 sm:py-2.5">
          <button type="button" onClick={onAll} className={LINK}>
            All {topics.length} topics
          </button>
        </div>
      ) : null}
    </section>
  );
}
