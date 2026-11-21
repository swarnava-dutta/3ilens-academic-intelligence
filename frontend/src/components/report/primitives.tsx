import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { clampPct } from "./format";

/** White report card with a navy heading row. `id` is the section anchor (and the heading id prefix). */
export function SectionCard({
  id,
  title,
  description,
  icon: Icon,
  action,
  className,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  icon?: LucideIcon;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cn(
        "min-w-0 scroll-mt-[11.5rem] rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 md:scroll-mt-[8.5rem] print:shadow-none",
        className,
      )}
    >
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {Icon ? (
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-cyan-50 text-brand-cyan-600 ring-1 ring-inset ring-brand-cyan/20">
              <Icon className="h-5 w-5" aria-hidden />
            </span>
          ) : null}
          <div className="min-w-0">
            <h2 id={`${id}-title`} className="text-lg font-semibold tracking-tight text-brand-navy">
              {title}
            </h2>
            {description ? <p className="mt-0.5 text-sm text-slate-500">{description}</p> : null}
          </div>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function Pill({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Horizontal CSS meter (0-100). Optional threshold marker. */
export function MeterBar({
  percent,
  label,
  valueText,
  fillClass = "bg-brand-cyan",
  trackClass = "bg-brand-cyan-50",
  markerPercent,
  markerLabel,
  className,
  size = "md",
}: {
  percent: number;
  label: string;
  valueText?: string;
  fillClass?: string;
  trackClass?: string;
  markerPercent?: number;
  markerLabel?: string;
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const p = clampPct(percent);
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(p)}
      aria-valuetext={valueText ?? `${Math.round(p)}%`}
      className={cn(
        "relative w-full rounded-full [print-color-adjust:exact]",
        size === "sm" ? "h-1.5" : size === "lg" ? "h-3" : "h-2.5",
        trackClass,
        className,
      )}
    >
      <div
        className={cn("h-full rounded-full transition-[width] duration-700 ease-out", fillClass)}
        style={{ width: `${p}%` }}
      />
      {markerPercent !== undefined ? (
        <div
          aria-hidden
          title={markerLabel}
          className="absolute -top-1 -bottom-1 w-0.5 rounded-full bg-brand-navy"
          style={{ left: `calc(${clampPct(markerPercent)}% - 1px)` }}
        />
      ) : null}
    </div>
  );
}

/** Single-value radial gauge drawn with SVG strokes (no chart library). */
export function RadialGauge({
  percent,
  label,
  size = 112,
  strokeWidth = 10,
  colorClass = "text-brand-cyan",
  trackClass = "text-brand-cyan-50",
  children,
}: {
  percent: number;
  label: string;
  size?: number;
  strokeWidth?: number;
  colorClass?: string;
  trackClass?: string;
  children?: ReactNode;
}) {
  const p = clampPct(percent);
  const r = (size - strokeWidth) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div
      role="img"
      aria-label={label}
      className="relative grid shrink-0 place-items-center [print-color-adjust:exact]"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          className={trackClass}
        />
        {p > 0 ? (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - p / 100)}
            className={cn("transition-[stroke-dashoffset] duration-700 ease-out", colorClass)}
          />
        ) : null}
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">{children}</div>
    </div>
  );
}

/** Small uppercase label used inside cards. */
export function Eyebrow({ icon: Icon, children, className }: { icon?: LucideIcon; children: ReactNode; className?: string }) {
  return (
    <p className={cn("flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500", className)}>
      {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden /> : null}
      {children}
    </p>
  );
}
