"use client";

import { Empty, fmt, Frame, tipBody, toneColor, useChart, type Tone } from "./core";

const pct = (v: number, max: number) => `${Math.min(100, Math.max(0, (v / (max || 1)) * 100))}%`;

/** Meter list: name, bar, value. Under 32rem of container width the bar drops below the name. */
export function BarList({
  items,
  unit,
}: {
  items: { label: string; value: number; max: number; target?: number; tone?: Tone; valueLabel?: string }[];
  unit?: string;
}) {
  const c = useChart();
  if (!items.length) return <Empty />;
  return (
    <Frame chart={c} className="@container">
      <ul className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-3 @lg:grid-cols-[fit-content(15rem)_1fr_auto] @lg:gap-y-2">
        {items.map((d, i) => {
          const value = d.valueLabel ?? fmt(d.value, unit);
          const rows: [string, string][] = [["Value", `${value} of ${fmt(d.max, unit)}`]];
          if (d.target !== undefined) rows.push(["Target", fmt(d.target, unit)]);
          return (
            <li
              key={i}
              {...c.mark(tipBody(d.label, rows))}
              className="col-span-full grid grid-cols-subgrid items-center gap-y-1.5"
            >
              <span className="min-w-0 truncate text-slate-700">{d.label}</span>
              <span className="text-right text-slate-700 tabular-nums @lg:order-last">{value}</span>
              <span className="relative col-span-full h-2.5 bg-slate-100 @lg:col-span-1">
                <span
                  className="absolute inset-y-0 left-0 rounded-r-[4px]"
                  style={{ width: pct(d.value, d.max), background: toneColor(d.tone) }}
                />
                {d.target !== undefined && (
                  <span
                    className="absolute -inset-y-1 w-0.5 -translate-x-1/2 bg-slate-700"
                    style={{ left: pct(d.target, d.max) }}
                  />
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </Frame>
  );
}
