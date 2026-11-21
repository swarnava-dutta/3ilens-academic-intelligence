import { Loader2, RotateCw, ServerCrash } from "lucide-react";
import { cn } from "@/lib/utils";

function Bone({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-lg bg-slate-200/70", className)} />;
}

export function CohortSkeleton() {
  return (
    <div aria-busy="true" className="space-y-6">
      <span role="status" className="sr-only">
        Loading cohort dashboard…
      </span>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between" aria-hidden>
        <div className="space-y-3">
          <Bone className="h-3 w-28" />
          <Bone className="h-8 w-64" />
          <Bone className="h-4 w-52" />
        </div>
        <div className="flex gap-2">
          <Bone className="h-7 w-48 rounded-full" />
          <Bone className="h-7 w-28 rounded-full" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 xl:grid-cols-6" aria-hidden>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
            <Bone className="h-3 w-20" />
            <Bone className="mt-4 h-7 w-16" />
            <Bone className="mt-3 h-3 w-24" />
          </div>
        ))}
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm" aria-hidden>
        <Bone className="h-4 w-36" />
        <Bone className="mt-3 h-7 w-full rounded-md" />
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5" aria-hidden>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm lg:col-span-3">
          <Bone className="h-5 w-56" />
          <div className="mt-6 space-y-5">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="space-y-2">
                <Bone className="h-3 w-40" />
                <Bone className="h-3 w-full rounded-full" />
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm lg:col-span-2">
          <Bone className="h-5 w-40" />
          <div className="mt-8 flex h-44 items-end gap-3">
            {[35, 60, 90, 70, 45].map((h, i) => (
              <div key={i} className="flex flex-1 justify-center" style={{ height: `${h}%` }}>
                <Bone className="h-full w-full max-w-11 rounded-b-none" />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm" aria-hidden>
        <Bone className="h-5 w-64" />
        <div className="mt-6 space-y-3">
          {Array.from({ length: 4 }, (_, i) => (
            <Bone key={i} className="h-10 w-full" />
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
    <section
      role="alert"
      className="mx-auto max-w-2xl rounded-2xl border border-rose-200 bg-white p-6 text-center shadow-sm sm:p-10"
    >
      <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-50 text-rose-600">
        <ServerCrash className="h-7 w-7" aria-hidden />
      </span>
      <h1 className="mt-5 text-xl font-semibold text-brand-navy">Cohort Dashboard is offline</h1>
      <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-slate-600">{message}</p>
      <p className="mx-auto mt-2 max-w-lg text-xs text-slate-500">
        Start the FastAPI server (start.bat starts both servers; see the README). This page keeps retrying every 10
        seconds and recovers on its own.
      </p>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="mt-6 inline-flex items-center gap-2 rounded-full bg-brand-navy px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-navy-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan disabled:cursor-wait disabled:opacity-70"
      >
        {retrying ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <RotateCw className="h-4 w-4" aria-hidden />
        )}
        {retrying ? "Retrying…" : "Retry now"}
      </button>
    </section>
  );
}
