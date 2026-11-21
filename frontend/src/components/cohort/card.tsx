import type { ComponentProps, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function Card({ className, children, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn("min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6", className)}
      {...props}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  id,
  icon: Icon,
  title,
  subtitle,
  action,
  className,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3", className)}>
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-cyan-50 text-brand-cyan-600">
          <Icon className="h-4.5 w-4.5" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 id={id} className="text-base font-semibold text-brand-navy">
            {title}
          </h2>
          {subtitle ? <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p> : null}
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
