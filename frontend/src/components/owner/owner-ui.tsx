"use client";

import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, ChevronDown } from "lucide-react";
import { numOrNull } from "@/lib/coerce";
import { MINUS } from "@/lib/format";
import type { BatchSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmt } from "./format";
import { focusRing, tagCls } from "./states";

/** Page-wide "small group" threshold: fewer students than this is never a whole-class figure (backend MIN_TREND_STUDENTS). */
export const SMALL_GROUP = 3;

/** Text colour for links and disclosures: a darker cyan (5.6:1 on white, 5.3:1 on slate-50); cyan-600 stays for fills. */
export const linkText = "text-[#037285]";

/** "3 days" / "2 d" / "10 h" from a fractional day count (half-up, like the backend). */
export function ageText(days: number | null | undefined, short = false): string {
  const d = numOrNull(days);
  if (d === null) return "—";
  if (d < 1) {
    const h = Math.round(d * 24);
    if (h === 0) return short ? "<1 h" : "under an hour";
    return short ? `${h} h` : `${h} hour${h === 1 ? "" : "s"}`;
  }
  const n = Math.round(d);
  return short ? `${n} d` : `${n} day${n === 1 ? "" : "s"}`;
}

/** Signed change, always 1 dp: "+6.1", "+10.0", "−0.4" (typographic minus), "0.0". */
export function signed1(value: number | null | undefined): string {
  const v = numOrNull(value);
  if (v === null) return "—";
  const text = Math.abs(v).toFixed(1);
  if (text === "0.0") return text;
  return v > 0 ? `+${text}` : `${MINUS}${text}`;
}

/** Always 1 dp: "5.0", "3.3" ("—" when unknown). */
export function fixed1(value: number | null | undefined): string {
  const v = numOrNull(value);
  return v === null ? "—" : v.toFixed(1);
}

/** Signed change with an arrow icon; the sign is in the text, colour is secondary. */
export function ChangeText({
  value,
  suffix = " pts",
  className,
  title,
}: {
  value: number | null | undefined;
  suffix?: string;
  className?: string;
  title?: string;
}) {
  const v = numOrNull(value);
  if (v === null) return <span className="text-slate-500">—</span>;
  const up = v > 0.04;
  const down = v < -0.04;
  const Icon = up ? ArrowUpRight : down ? ArrowDownRight : null;
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-0.5 whitespace-nowrap tabular-nums",
        up ? "text-lime-800" : down ? "text-rose-700" : "text-slate-600",
        className,
      )}
    >
      {Icon ? <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
      {signed1(v)}
      {suffix}
    </span>
  );
}

/** Muted "small group" tag for figures from fewer than 3 (or 5) students. */
export function SmallGroupTag({ n, label = "small group" }: { n?: number; label?: string }) {
  return (
    <span
      className={cn(tagCls, "bg-slate-100 font-normal text-slate-600")}
      title={n !== undefined ? `Only ${n} student${n === 1 ? "" : "s"}: read with care` : undefined}
    >
      {label}
    </span>
  );
}

/** "sample" when the whole batch is sample data and its name does not already say so; "mixed" when live and sample rows sit together. */
export function BatchDataTag({ summary }: { summary: BatchSummary }) {
  const demo = summary.demo_count ?? (summary.is_demo ? 1 : 0);
  const live = summary.real_count ?? 0;
  if (demo > 0 && live > 0) {
    return (
      <span
        className={cn(tagCls, "bg-slate-100 text-slate-600")}
        title={`${live} live sheet${live === 1 ? "" : "s"} and ${demo} sample sheet${demo === 1 ? "" : "s"} in this batch`}
      >
        mixed
      </span>
    );
  }
  if (summary.is_demo && !/sample|demo/i.test(summary.batch.name)) {
    return (
      <span title="Sample batch (is_demo) - synthetic records" className={cn(tagCls, "bg-slate-100 text-slate-600")}>
        sample
      </span>
    );
  }
  return null;
}

/** Text button that shows / hides a region (aria-expanded + aria-controls). */
export function Disclosure({
  open,
  onToggle,
  controls,
  children,
  className,
}: {
  open: boolean;
  onToggle: () => void;
  controls: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className={cn(
        "inline-flex min-h-10 items-center gap-1 rounded-md text-sm font-medium hover:underline sm:min-h-8",
        linkText,
        focusRing,
        className,
      )}
    >
      <ChevronDown
        className={cn("h-4 w-4 shrink-0 transition-transform duration-150 motion-reduce:transition-none", open && "rotate-180")}
        aria-hidden
      />
      {children}
    </button>
  );
}

/** Thin mastery bar (0-100) with the value as text next to it. */
export function MasteryBar({ value, barClass }: { value: number; barClass: string }) {
  const width = Math.min(100, Math.max(0, value));
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="h-1.5 w-20 shrink-0 rounded-sm bg-slate-100 sm:w-24" aria-hidden>
        <span className={cn("block h-full rounded-sm", barClass)} style={{ width: `${width}%` }} />
      </span>
      <span className="tabular-nums font-medium text-slate-900">{fmt(value, 0)}%</span>
    </span>
  );
}

/** "28 Oct – 27 Nov 2026" from two ISO dates (year once when both share it). */
export function periodText(first: string | null | undefined, last: string | null | undefined): string | null {
  if (!first || !last) return null;
  const a = new Date(`${first.slice(0, 10)}T00:00:00`);
  const b = new Date(`${last.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  const sameYear = a.getFullYear() === b.getFullYear();
  const left = a.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
  const right = b.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  return first.slice(0, 10) === last.slice(0, 10) ? right : `${left} – ${right}`;
}

/** "06:35" from an ISO datetime. */
export function clockText(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** "27 Nov" from an ISO date or datetime. */
export function dayText(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Table cell / card label classes shared by the owner tables. */
export const tdCls = "px-3 py-2 align-top text-sm text-slate-700";
export const linkCls = `font-medium ${linkText} hover:underline ${focusRing}`;
