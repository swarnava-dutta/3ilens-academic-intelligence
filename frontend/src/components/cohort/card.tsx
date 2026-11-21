import type { ComponentProps, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Table cell classes shared by the cohort tables. */
export const TH = "whitespace-nowrap px-3 py-2 text-left text-xs font-medium text-slate-500";
export const TD = "px-3 py-2 align-top text-sm tabular-nums text-slate-700";

export function Card({ className, children, ...props }: ComponentProps<"section">) {
  return (
    <section className={cn("min-w-0 rounded-md border border-slate-200 bg-white p-4 sm:p-5", className)} {...props}>
      {children}
    </section>
  );
}

export function CardHeader({
  id,
  title,
  subtitle,
  action,
  className,
}: {
  id: string;
  /** Accepted for older callers; headings no longer carry an icon. */
  icon?: LucideIcon;
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-3", className)}>
      <div className="min-w-0">
        <h2 id={id} className="text-[15px] font-semibold text-brand-navy">
          {title}
        </h2>
        {subtitle ? <p className="mt-0.5 text-[13px] text-slate-500">{subtitle}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
