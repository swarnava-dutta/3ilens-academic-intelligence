import type { ReactNode } from "react";
import { fmtNumber, fmtPctValue } from "../format";

/** One plain sentence in place of a chart whose data is missing. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="text-sm text-slate-500">{children}</p>;
}

/** The report's one percentage format (1 decimal). */
export const pct = (v: number) => fmtPctValue(v);

export const signedPts = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmtNumber(Math.abs(v))} pts`;

export const round1 = (v: number) => Math.round(v * 10) / 10;
