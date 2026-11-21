import { Loader2, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { btnPrimary } from "./dialog";

function Bone({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-sm bg-slate-200/70 motion-reduce:animate-none", className)} />;
}

const PANEL = "rounded-md border border-slate-200 bg-white p-4 sm:p-5";

export function CohortSkeleton() {
  return (
    <div aria-busy="true" className="space-y-6">
      <span role="status" className="sr-only">
        Loading cohort dashboard…
      </span>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between" aria-hidden>
        <div className="space-y-2">
          <Bone className="h-7 w-56" />
          <Bone className="h-4 w-48" />
        </div>
        <Bone className="h-6 w-64" />
      </div>
      <div className={cn(PANEL, "h-14")} aria-hidden />
      <div
        className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 sm:grid-cols-3 xl:grid-cols-6"
        aria-hidden
      >
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="bg-white px-4 py-3">
            <Bone className="h-3 w-20" />
            <Bone className="mt-2 h-6 w-14" />
            <Bone className="mt-2 h-3 w-24" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5" aria-hidden>
        <div className={cn(PANEL, "lg:col-span-3")}>
          <Bone className="h-4 w-48" />
          <div className="mt-5 space-y-4">
            {Array.from({ length: 5 }, (_, i) => (
              <Bone key={i} className="h-3 w-full" />
            ))}
          </div>
        </div>
        <div className={cn(PANEL, "lg:col-span-2")}>
          <Bone className="h-4 w-40" />
          <div className="mt-6 flex h-40 items-end gap-2">
            {[35, 60, 90, 70, 45].map((h, i) => (
              <div key={i} className="flex flex-1 justify-center" style={{ height: `${h}%` }}>
                <Bone className="h-full w-full max-w-10" />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className={PANEL} aria-hidden>
        <Bone className="h-4 w-56" />
        <div className="mt-4 space-y-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Bone key={i} className="h-8 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function CohortErrorCard({
  message,
  onRetry,
  retrying,
}: {
  message: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <section role="alert" className="mx-auto max-w-2xl rounded-md border border-red-200 bg-white p-5 sm:p-6">
      <h1 className="text-lg font-semibold text-brand-navy">Cohort dashboard is offline</h1>
      <p className="mt-1 text-sm text-slate-700">{message}</p>
      <p className="mt-2 text-xs text-slate-500">
        Start the FastAPI server (start.bat starts both servers; see the README). This page retries every 10 seconds and
        recovers on its own.
      </p>
      <button type="button" onClick={onRetry} disabled={retrying} className={cn(btnPrimary, "mt-4")}>
        {retrying ? (
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
        ) : (
          <RotateCw className="h-4 w-4" aria-hidden />
        )}
        {retrying ? "Retrying…" : "Retry now"}
      </button>
    </section>
  );
}
