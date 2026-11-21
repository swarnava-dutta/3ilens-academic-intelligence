import { Layers } from "lucide-react";
import type { Cohort } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Card, CardHeader } from "./card";
import { MASTERY_TARGET, TONES, clampPct, formatPct, num, toneFor, type Tone } from "./format";

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
    .map((t) => ({ topic: t.topic, mastery: num(t.mastery) }))
    .sort((a, b) => (a.mastery ?? 101) - (b.mastery ?? 101) || a.topic.localeCompare(b.topic));
  const weakest = rows.find((r) => r.mastery !== null);

  return (
    <Card aria-labelledby="cohort-topic-title" className={cn("flex flex-col", className)}>
      <CardHeader
        id="cohort-topic-title"
        icon={Layers}
        title="Topic mastery across the cohort"
        subtitle="Average mastery per topic, weakest first"
      />

      <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-slate-500" aria-label="Mastery bands">
        {LEGEND_ORDER.map((key) => (
          <li key={key} className="inline-flex items-center gap-1.5">
            <span className={cn("h-2.5 w-2.5 rounded-sm", TONES[key].dot)} aria-hidden />
            <span className="font-medium text-slate-600">{TONES[key].label}</span>
            <span>{TONES[key].range}</span>
          </li>
        ))}
        <li className="inline-flex items-center gap-1.5">
          <span className="h-3 w-px bg-slate-400" aria-hidden />
          <span>Target {MASTERY_TARGET}%</span>
        </li>
      </ul>

      {rows.length === 0 ? (
        <p className="mt-6 rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
          Topic mastery appears once evaluated sheets cover at least one rubric topic.
        </p>
      ) : (
        <ol className="mt-5 space-y-4">
          {rows.map((row, i) => {
            const tone = toneFor(row.mastery);
            const pct = clampPct(row.mastery);
            return (
              <li key={`${i}-${row.topic}`} className="group">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 text-sm font-medium break-words text-slate-700">
                    {row.topic}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span
                      className={cn(
                        "hidden rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset sm:inline-flex",
                        tone.chip,
                      )}
                    >
                      {tone.label}
                    </span>
                    <span className="w-10 text-right text-sm font-semibold tabular-nums text-slate-800">
                      {formatPct(row.mastery)}
                    </span>
                  </span>
                </div>
                <div
                  role="img"
                  aria-label={`${row.topic}: ${formatPct(row.mastery)} average mastery, ${tone.label.toLowerCase()}`}
                  className="relative mt-1.5 h-3 w-full rounded-full bg-slate-100"
                >
                  <div
                    className={cn(
                      "h-full rounded-full transition-[width] duration-700 group-hover:brightness-110",
                      tone.bar,
                    )}
                    style={{ width: `${pct}%` }}
                  />
                  <span
                    className="absolute -top-0.5 -bottom-0.5 w-px bg-slate-400/70"
                    style={{ left: `${MASTERY_TARGET}%` }}
                    aria-hidden
                  />
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {weakest && weakest.mastery !== null ? (
        <p className="mt-auto pt-5 text-xs text-slate-500">
          Weakest topic: <span className="font-semibold text-slate-700">{weakest.topic}</span> at{" "}
          {formatPct(weakest.mastery)} — see the preparation priorities below for the highest-return
          revision plan.
        </p>
      ) : null}
    </Card>
  );
}
