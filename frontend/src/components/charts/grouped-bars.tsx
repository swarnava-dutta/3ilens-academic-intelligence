"use client";

import { Empty, Legend } from "./core";

const pct = (v: number, max: number) => Math.min(100, Math.max(0, max > 0 ? (v / max) * 100 : 0));

/**
 * Grouped horizontal bars: one group per category (a subject), one bar per series, the value printed
 * at the end of each bar with the series' short name, so colour is never the only cue. Bars share one
 * 0-`max` scale. Wrap in ChartFrame for the title and the "Show data" table.
 */
export function GroupedBars({
  groups,
  series,
  max = 100,
  label,
}: {
  groups: { label: string; values: { value: number | null; text: string }[] }[];
  series: { label: string; short: string; color: string }[];
  max?: number;
  /** Spoken summary of the whole chart. */
  label: string;
}) {
  if (!groups.length) return <Empty />;
  return (
    <div className="space-y-3">
      <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
      <ul role="img" aria-label={label} className="space-y-3 [print-color-adjust:exact]">
        {groups.map((g) => (
          <li key={g.label} className="space-y-1" aria-hidden>
            <p className="text-[13px] font-medium text-slate-800">{g.label}</p>
            {series.map((s, i) => {
              const d = g.values[i];
              const w = d && d.value !== null ? pct(d.value, max) : 0;
              return (
                <div key={s.label} className="grid grid-cols-[6.5rem_1fr] items-center gap-2 sm:grid-cols-[9.5rem_1fr]">
                  <span className="text-xs leading-tight text-slate-600">{s.short}</span>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="relative h-3.5 min-w-0 flex-1 rounded-[2px] bg-slate-100">
                      <span
                        className="absolute inset-y-0 left-0 rounded-r-[2px] motion-safe:transition-[width] motion-safe:duration-300 motion-safe:ease-out"
                        style={{ width: `${w}%`, background: s.color }}
                      />
                    </span>
                    <span className="w-24 shrink-0 font-mono text-xs tabular-nums text-slate-800">{d?.text ?? "—"}</span>
                  </span>
                </div>
              );
            })}
          </li>
        ))}
      </ul>
    </div>
  );
}
