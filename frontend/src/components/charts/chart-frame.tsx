"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Legend, seriesColor, type Series } from "./core";

export function ChartFrame({
  title,
  takeaway,
  legend,
  table,
  titleClassName,
  className,
  children,
}: {
  title: string;
  takeaway?: string;
  legend?: { label: string; series: Series }[];
  table?: { columns: string[]; rows: (string | number)[][] };
  /** Overrides the title's look (e.g. a quieter caption above a hero chart). */
  titleClassName?: string;
  className?: string;
  children: ReactNode;
}) {
  // Numbers, and number-like text ("55.8%", "−8", "26/45"), are right-aligned.
  const numeric = (j: number) => {
    const v = table?.rows[0]?.[j];
    return typeof v === "number" || (typeof v === "string" && /^[+−-]?\d[\d.,]*(?:%|\/\d+)?(?: \(.*\))?$/.test(v));
  };
  return (
    <figure className={cn("min-w-0 space-y-3", className)}>
      <figcaption>
        <h3 className={cn("text-sm font-semibold text-slate-900", titleClassName)}>{title}</h3>
        {takeaway && <p className="text-sm text-slate-600">{takeaway}</p>}
      </figcaption>
      {legend && legend.length > 0 && (
        <Legend items={legend.map((d) => ({ label: d.label, color: seriesColor(d.series) }))} />
      )}
      {children}
      {table && table.rows.length > 0 && (
        <details className="text-xs print:hidden">
          <summary className="w-fit cursor-pointer rounded-sm text-slate-600 hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1E40AF]">
            Show data
          </summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full tabular-nums">
              <thead>
                <tr className="border-b border-slate-200">
                  {table.columns.map((c, j) => (
                    <th
                      key={j}
                      scope="col"
                      className={cn("py-1.5 pr-3 font-medium text-slate-500", numeric(j) ? "text-right" : "text-left")}
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((r, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    {r.map((v, j) => (
                      <td key={j} className={cn("py-1.5 pr-3 text-slate-700", numeric(j) && "text-right")}>
                        {v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </figure>
  );
}
