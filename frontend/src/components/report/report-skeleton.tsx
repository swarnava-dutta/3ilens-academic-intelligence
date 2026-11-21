import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

function Block({ className }: { className?: string }) {
  return <div className={cn("rounded-sm bg-slate-200/70", className)} />;
}

function CardShell({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-md border border-slate-200 bg-white p-5 sm:p-6", className)}>{children}</div>;
}

/** Layout-matched placeholder for the Student Intelligence Report. No hooks: safe in Server Components. */
export function ReportSkeleton() {
  return (
    <div className="space-y-6 motion-safe:animate-pulse" role="status" aria-live="polite">
      <span className="sr-only">Loading the Student Intelligence Report…</span>

      <CardShell>
        <Block className="h-3 w-48" />
        <Block className="mt-4 h-3 w-56" />
        <Block className="mt-2 h-7 w-72 max-w-full" />
        <div className="mt-5 flex flex-wrap gap-8 border-t border-slate-200 pt-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="space-y-1.5">
              <Block className="h-3 w-16" />
              <Block className="h-4 w-32" />
            </div>
          ))}
        </div>
      </CardShell>

      <div
        className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 md:grid-cols-3 xl:grid-cols-6"
        aria-hidden
      >
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="space-y-2 bg-white px-4 py-3">
            <Block className="h-3 w-20" />
            <Block className="h-6 w-16" />
            <Block className="h-3 w-24" />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5" aria-hidden>
        <CardShell className="lg:col-span-3">
          <Block className="h-4 w-40" />
          <div className="mt-6 space-y-5">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="space-y-2">
                <div className="flex justify-between">
                  <Block className="h-3 w-48" />
                  <Block className="h-3 w-10" />
                </div>
                <Block className="h-2 w-full" />
              </div>
            ))}
          </div>
        </CardShell>
        <CardShell className="lg:col-span-2">
          <Block className="h-4 w-28" />
          <div className="mt-6 space-y-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <Block key={i} className="h-4 w-full" />
            ))}
          </div>
        </CardShell>
      </div>
    </div>
  );
}
