import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Fraction 0-1 -> "63%" (null -> "—"). */
export function pct(fraction: number | null | undefined, digits = 0): string {
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) return "—";
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** "+4 / -1" with real minus signs. */
export function realMinus(text: string): string {
  return text.replace(/-(?=\d)/g, "−");
}

/** The patterns.notes line that explains why a profile is null (else the fallback). */
export function noteFor(notes: string[] | null | undefined, pattern: RegExp, fallback: string): string {
  return (notes ?? []).find((n) => pattern.test(n)) ?? fallback;
}

/** Muted explanation shown in place of a profile the backend could not compute. */
export function NullProfile({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-3 py-3 text-sm text-slate-600">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden />
      {text}
    </p>
  );
}

/** Small labelled number tile. */
export function Stat({ label, value, sub, className }: { label: string; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0 rounded-xl bg-slate-50 px-3 py-2 ring-1 ring-inset ring-slate-200", className)}>
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums text-brand-navy">{value}</dd>
      {sub ? <dd className="text-[11px] text-slate-500">{sub}</dd> : null}
    </div>
  );
}

/** Recommendation callout. */
export function Recommendation({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl bg-brand-cyan-50/70 px-3 py-2.5 text-sm leading-relaxed text-slate-800 ring-1 ring-inset ring-brand-cyan/20">
      <span className="font-semibold text-brand-navy">Recommendation: </span>
      {children}
    </p>
  );
}
