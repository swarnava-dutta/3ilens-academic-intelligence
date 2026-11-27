import { numOrNull } from "@/lib/coerce";
import { clampPct } from "@/lib/format";
import type { Cohort } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Card, CardHeader } from "./card";
import { MASTERY_TARGET, TONES, formatPct, toneFor, type Tone } from "./format";

const LEGEND_ORDER: Tone[] = ["weak", "ok", "good"];

export function TopicMastery({
  topics,
  className,
}: {
  topics: Cohort["topic_mastery"];
  className?: string;
}) {
  const rows = (topics ?? [])
    .filter((t) => t && typeof t.topic === "string")
    .map((t) => ({ topic: t.topic, mastery: numOrNull(t.mastery) }))
    .sort((a, b) => (a.mastery ?? 101) - (b.mastery ?? 101) || a.topic.localeCompare(b.topic));
  const weakest = rows.find((r) => r.mastery !== null);

  return (
    <Card aria-labelledby="cohort-topic-title" className={cn("flex flex-col", className)}>
      <CardHeader
        id="cohort-topic-title"
        title="Topic mastery"
        subtitle="Average mastery per topic across the cohort, weakest first"
      />

      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500" aria-label="Mastery bands">
        {LEGEND_ORDER.map((key) => (
          <li key={key} className="inline-flex items-center gap-1.5">
            <span className={cn("h-2 w-2 rounded-sm", TONES[key].dot)} aria-hidden />
            <span className="text-slate-600">{TONES[key].label}</span>
            <span>{TONES[key].range}</span>
          </li>
        ))}
        <li className="inline-flex items-center gap-1.5">
          <span className="h-3 w-px bg-slate-500" aria-hidden />
          <span>Target {MASTERY_TARGET}%</span>
        </li>
      </ul>

      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">
          Chapter mastery appears once graded sheets cover at least one chapter.
        </p>
      ) : (
        <ol className="mt-3 divide-y divide-slate-100">
          {rows.map((row, i) => {
            const tone = toneFor(row.mastery);
            return (
              <li
                key={`${i}-${row.topic}`}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_6.5rem_2.75rem]"
              >
                <span className="min-w-0 text-sm break-words text-slate-800">{row.topic}</span>
                <div
                  role="img"
                  aria-label={`${row.topic}: ${formatPct(row.mastery)} average mastery, ${tone.label.toLowerCase()}`}
                  className="relative col-span-2 row-start-2 h-2 bg-slate-100 sm:col-span-1 sm:row-start-auto"
                >
                  <div className={cn("h-full", tone.bar)} style={{ width: `${clampPct(row.mastery)}%` }} />
                  <span
                    className="absolute -top-1 -bottom-1 w-px bg-slate-500"
                    style={{ left: `${MASTERY_TARGET}%` }}
                    aria-hidden
                  />
                </div>
                <span className="hidden text-xs text-slate-500 sm:block">{tone.label}</span>
                <span className="text-right text-sm font-semibold tabular-nums text-slate-800">
                  {formatPct(row.mastery)}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {weakest && weakest.mastery !== null ? (
        <p className="mt-auto pt-3 text-xs text-slate-500">
          Weakest: <span className="font-medium text-slate-700">{weakest.topic}</span> at{" "}
          <span className="tabular-nums">{formatPct(weakest.mastery)}</span>. See preparation priorities for the revision
          order.
        </p>
      ) : null}
    </Card>
  );
}
