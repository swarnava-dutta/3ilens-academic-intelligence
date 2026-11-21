import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

function Block({ className }: { className?: string }) {
  return <div className={cn("rounded-lg bg-slate-200/70", className)} />;
}

function CardShell({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6", className)}>{children}</div>;
}

/** Layout-matched placeholder for the Student Intelligence Report. No hooks: safe in Server Components. */
export function ReportSkeleton() {
  return (
    <div className="animate-pulse space-y-6" role="status" aria-live="polite">
      <span className="sr-only">Loading the Student Intelligence Report…</span>

      <div className="rounded-2xl bg-brand-navy p-5 sm:p-8" aria-hidden>
        <Block className="h-4 w-36 bg-white/15" />
        <Block className="mt-8 h-3 w-48 bg-brand-cyan/40" />
        <Block className="mt-3 h-9 w-72 max-w-full bg-white/20" />
        <div className="mt-6 flex flex-wrap gap-2">
          <Block className="h-6 w-40 rounded-full bg-white/10" />
          <Block className="h-6 w-48 rounded-full bg-white/10" />
          <Block className="h-6 w-32 rounded-full bg-white/10" />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <CardShell key={i} className="p-5 sm:p-5">
            <Block className="h-4 w-24" />
            <div className="mt-4 flex items-center gap-4">
              <div className="h-24 w-24 shrink-0 rounded-full border-[9px] border-slate-200/70" />
              <div className="flex-1 space-y-2">
                <Block className="h-6 w-16" />
                <Block className="h-3 w-24" />
              </div>
            </div>
          </CardShell>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5" aria-hidden>
        <CardShell className="lg:col-span-3">
          <Block className="h-5 w-40" />
          <div className="mt-6 space-y-6">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="space-y-2">
                <div className="flex justify-between">
                  <Block className="h-4 w-48" />
                  <Block className="h-4 w-10" />
                </div>
                <Block className="h-2.5 w-full rounded-full" />
              </div>
            ))}
          </div>
        </CardShell>
        <CardShell className="lg:col-span-2">
          <Block className="h-5 w-28" />
          <div className="mt-6 space-y-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <Block key={i} className="h-14 w-full rounded-xl" />
            ))}
          </div>
        </CardShell>
      </div>

      <CardShell>
        <Block className="h-5 w-56" />
        <Block className="mt-5 h-20 w-full rounded-xl" />
        <div className="mt-5 space-y-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <Block key={i} className="h-10 w-full" />
          ))}
        </div>
      </CardShell>
    </div>
  );
}
