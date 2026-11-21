import { TriangleAlert } from "lucide-react";
import { Card, CardHeader } from "@/components/cohort/card";
import { clampPct, toneFor } from "@/components/cohort/format";
import type { TopicPoint } from "@/lib/types";
import { cn } from "@/lib/utils";
import { pct } from "./format";

/** Institution-wide weakest topics (average mastery, 0-100). */
export function WeakestTopics({ topics }: { topics: TopicPoint[] }) {
  const rows = (topics ?? []).slice().sort((a, b) => a.mastery - b.mastery);
  return (
    <Card aria-labelledby="owner-weak-title" className="flex flex-col">
      <CardHeader
        id="owner-weak-title"
        icon={TriangleAlert}
        title="Weakest topics"
        subtitle="Average mastery across completed results (0-100%)"
      />
      {rows.length === 0 ? (
        <p className="mt-4 rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-600">No topic data yet.</p>
      ) : (
        <ol className="mt-4 space-y-3">
          {rows.map((t) => {
            const tone = toneFor(t.mastery);
            return (
              <li key={`${t.subject}-${t.topic}`}>
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="min-w-0 font-medium text-slate-800">
                    {t.topic}
                    {t.subject ? <span className="ml-1 text-xs font-normal text-slate-600">{t.subject}</span> : null}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    <span className="sr-only">{tone.label}: </span>
                    <span className="font-semibold text-slate-800">{pct(t.mastery)}</span>
                  </span>
                </div>
                <div className="mt-1 h-2.5 w-full rounded-full bg-slate-100" aria-hidden title={`${tone.label} (${tone.range})`}>
                  <div className={cn("h-full rounded-full", tone.bar)} style={{ width: `${clampPct(t.mastery)}%` }} />
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
