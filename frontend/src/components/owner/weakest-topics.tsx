import { clampPct, toneFor } from "@/components/cohort/format";
import type { TopicPoint } from "@/lib/types";
import { cn } from "@/lib/utils";
import { pct } from "./format";
import { EmptyNote, Panel } from "./states";

/** Institution-wide weakest topics (average mastery, 0-100). */
export function WeakestTopics({ topics }: { topics: TopicPoint[] }) {
  const rows = (topics ?? []).slice().sort((a, b) => a.mastery - b.mastery);
  return (
    <Panel id="owner-weak-title" title="Weakest topics" subtitle="Average mastery across completed results (0-100%)">
      {rows.length === 0 ? (
        <EmptyNote>No topic data yet.</EmptyNote>
      ) : (
        <ol className="space-y-3">
          {rows.map((t) => {
            const tone = toneFor(t.mastery);
            return (
              <li key={`${t.subject}-${t.topic}`}>
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="min-w-0 text-slate-800">
                    {t.topic}
                    {t.subject ? <span className="ml-1 text-xs text-slate-500">{t.subject}</span> : null}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    <span className="sr-only">{tone.label}: </span>
                    <span className="font-medium text-slate-900">{pct(t.mastery)}</span>
                  </span>
                </div>
                <div className="mt-1 h-1.5 w-full rounded-sm bg-slate-100" aria-hidden title={`${tone.label} (${tone.range})`}>
                  <div className={cn("h-full rounded-sm", tone.bar)} style={{ width: `${clampPct(t.mastery)}%` }} />
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}
