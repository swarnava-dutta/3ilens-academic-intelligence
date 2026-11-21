import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { clampPct } from "./format";

/** White bordered panel: title row over a hairline divider. `icon` is accepted but not drawn. `id` is the section anchor (and the heading id prefix). */
export function SectionCard({
  id,
  title,
  description,
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
        "min-w-0 scroll-mt-[11.5rem] rounded-md border border-slate-200 bg-white md:scroll-mt-[8.5rem]",
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-slate-200 px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <h2 id={`${id}-title`} className="text-[15px] font-semibold leading-snug text-brand-navy">
            {title}
          </h2>
          {description ? <p className="mt-0.5 text-[13px] text-slate-500">{description}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

export function Pill({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-xs font-medium tabular-nums",
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
  fillClass = "bg-brand-navy-700",
  trackClass = "bg-slate-100",
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
        "relative w-full rounded-sm [print-color-adjust:exact]",
        size === "sm" ? "h-1.5" : size === "lg" ? "h-2.5" : "h-2",
        trackClass,
        className,
      )}
    >
      <div
        className={cn("h-full rounded-sm", fillClass)}
        style={{ width: `${p}%` }}
      />
      {markerPercent !== undefined ? (
        <div
          aria-hidden
          title={markerLabel}
          className="absolute -top-1 -bottom-1 w-0.5 bg-slate-900"
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
  colorClass = "text-brand-navy-700",
  trackClass = "text-slate-100",
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
            strokeDasharray={c}
            strokeDashoffset={c * (1 - p / 100)}
            className={colorClass}
          />
        ) : null}
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">{children}</div>
    </div>
  );
}

/** Small sentence-case label used inside panels. `icon` is accepted but not drawn. */
export function Eyebrow({ children, className }: { icon?: LucideIcon; children: ReactNode; className?: string }) {
  return <p className={cn("text-[13px] font-medium text-slate-500", className)}>{children}</p>;
}
