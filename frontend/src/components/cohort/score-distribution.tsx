import type { Cohort } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Card, CardHeader } from "./card";
import { formatPct, plural, shareOf } from "./format";

export function ScoreDistribution({
  buckets,
  className,
}: {
  buckets: Cohort["score_distribution"];
  className?: string;
}) {
  const rows = (buckets ?? [])
    .filter((b) => b && typeof b.label === "string")
    .map((b) => ({
      label: b.label,
      count: typeof b.count === "number" && Number.isFinite(b.count) ? Math.max(0, b.count) : 0,
    }));
  const total = rows.reduce((sum, b) => sum + b.count, 0);
  const max = rows.reduce((m, b) => Math.max(m, b.count), 0);
  const modal = max > 0 ? rows.find((b) => b.count === max) : undefined;

  return (
    <Card aria-labelledby="cohort-dist-title" className={cn("flex flex-col", className)}>
      <CardHeader
        id="cohort-dist-title"
        title="Score distribution"
        subtitle={`${plural(total, "evaluated sheet")} by score band`}
      />

      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">No score bands to show yet.</p>
      ) : (
        <div className="mt-4 flex flex-1 flex-col justify-end">
          <ol className="flex items-end gap-1 border-b border-slate-300 pt-5 sm:gap-2" aria-label="Submissions per score band">
            {rows.map((b, i) => {
              const height = max > 0 ? (b.count / max) * 100 : 0;
              const share = formatPct(shareOf(b.count, total));
              return (
                <li
                  key={`${i}-${b.label}`}
                  className="relative flex h-44 flex-1 items-end justify-center lg:h-48"
                  title={`${b.label}: ${plural(b.count, "submission")} (${share})`}
                >
                  <span className="sr-only">
                    {b.label}: {plural(b.count, "submission")}, {share} of evaluated sheets
                  </span>
                  <div
                    aria-hidden
                    className={cn("relative w-full max-w-10", b === modal ? "bg-brand-navy" : "bg-slate-400")}
                    style={{ height: `${b.count > 0 ? Math.max(height, 2) : 0}%` }}
                  >
                    <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-xs tabular-nums text-slate-700">
                      {b.count}
                    </span>
                  </div>
                </li>
              );
            })}
          </ol>
          <div className="mt-1.5 flex gap-1 sm:gap-2" aria-hidden>
            {rows.map((b, i) => (
              <span
                key={`${i}-${b.label}`}
                className="min-w-0 flex-1 text-center text-[11px] leading-tight break-words tabular-nums text-slate-500"
              >
                {b.label}
              </span>
            ))}
          </div>
          {modal ? (
            <p className="mt-3 text-xs text-slate-500">
              Most common band: <span className="font-medium text-slate-700">{modal.label}</span> (
              {plural(modal.count, "student")}), shown dark.
            </p>
          ) : null}
        </div>
      )}
    </Card>
  );
}
