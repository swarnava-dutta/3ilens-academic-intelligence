import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { clampPct } from "@/lib/format";
import { cn } from "@/lib/utils";

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
