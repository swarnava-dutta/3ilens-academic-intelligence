"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Legend, seriesColor, type Series } from "./core";

export function ChartFrame({
  title,
  takeaway,
  legend,
  table,
  children,
}: {
  title: string;
  takeaway?: string;
  legend?: { label: string; series: Series }[];
  table?: { columns: string[]; rows: (string | number)[][] };
  children: ReactNode;
}) {
  const numeric = (j: number) => typeof table?.rows[0]?.[j] === "number";
  return (
    <figure className="min-w-0 space-y-3">
      <figcaption>
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        {takeaway && <p className="text-sm text-slate-600">{takeaway}</p>}
      </figcaption>
      {legend && legend.length > 0 && (
        <Legend items={legend.map((d) => ({ label: d.label, color: seriesColor(d.series) }))} />
      )}
      {children}
      {table && table.rows.length > 0 && (
        <details className="text-xs print:hidden">
          <summary className="w-fit cursor-pointer text-slate-500 hover:text-slate-700">Show data</summary>
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
