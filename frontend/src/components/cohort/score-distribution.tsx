import { ChartColumn } from "lucide-react";
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
        icon={ChartColumn}
        title="Score distribution"
        subtitle={`${plural(total, "evaluated sheet")} by score band`}
      />

      {rows.length === 0 ? (
        <p className="mt-6 rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
          No score bands to show yet.
        </p>
      ) : (
        <div className="mt-6 flex flex-1 flex-col justify-end">
          <ol
            className="flex items-end gap-1.5 border-b border-slate-200 pt-6 sm:gap-3"
            aria-label="Submissions per score band"
          >
            {rows.map((b, i) => {
              const height = max > 0 ? (b.count / max) * 100 : 0;
              const share = formatPct(shareOf(b.count, total));
              return (
                <li
                  key={`${i}-${b.label}`}
                  className="group relative flex h-44 flex-1 items-end justify-center lg:h-52"
                  title={`${b.label}: ${plural(b.count, "submission")} (${share})`}
                >
                  <span className="sr-only">
                    {b.label}: {plural(b.count, "submission")}, {share} of evaluated sheets
                  </span>
                  <div
                    aria-hidden
                    className={cn(
                      "relative w-full max-w-11 rounded-t-[4px] transition-[height] duration-700",
                      b === modal ? "bg-brand-cyan" : "bg-brand-cyan/55",
                      "group-hover:bg-brand-cyan-600",
                    )}
                    style={{ height: `${b.count > 0 ? Math.max(height, 3) : 0}%` }}
                  >
                    <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-xs font-semibold tabular-nums text-slate-700">
                      {b.count}
                    </span>
                  </div>
                </li>
              );
            })}
          </ol>
          <div className="mt-2 flex gap-1.5 sm:gap-3" aria-hidden>
            {rows.map((b, i) => (
              <span
                key={`${i}-${b.label}`}
                className="min-w-0 flex-1 text-center text-[11px] leading-tight break-words text-slate-500"
              >
                {b.label}
              </span>
            ))}
          </div>
          {modal ? (
            <p className="mt-4 text-xs text-slate-500">
              Most common band: <span className="font-semibold text-slate-700">{modal.label}</span>{" "}
              ({plural(modal.count, "student")}).
            </p>
          ) : null}
        </div>
      )}
    </Card>
  );
}
