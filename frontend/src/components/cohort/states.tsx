import Link from "next/link";
import { Loader2, RotateCw, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { btnPrimary, btnSecondary } from "./dialog";

function Bone({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-sm bg-slate-200/70 motion-reduce:animate-none", className)} />;
}

const PANEL = "rounded-md border border-slate-200 bg-white p-4";

/** First load: the shape of the page (header, scope bar, 4 tiles, 3 cards, tabs, one panel). */
export function CohortSkeleton() {
  return (
    <div aria-busy="true" className="space-y-5">
      <span role="status" className="sr-only">
        Loading cohort…
      </span>
      <div className="space-y-2" aria-hidden>
        <Bone className="h-7 w-32" />
        <Bone className="h-4 w-80 max-w-full" />
        <Bone className="h-4 w-[28rem] max-w-full" />
      </div>
      <div className={cn(PANEL, "flex flex-col gap-2 sm:flex-row")} aria-hidden>
        <Bone className="h-9 w-full sm:w-40" />
        <Bone className="h-9 w-full sm:w-72" />
      </div>
      <div
        className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 xl:grid-cols-4"
        aria-hidden
      >
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="bg-white px-4 py-3">
            <Bone className="h-3 w-20" />
            <Bone className="mt-2 h-7 w-16" />
            <Bone className="mt-2 h-3 w-28" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3" aria-hidden>
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className={PANEL}>
            <Bone className="h-4 w-40" />
            <div className="mt-4 space-y-3">
              {Array.from({ length: 3 }, (_, j) => (
                <Bone key={j} className="h-8 w-full" />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="rounded-md border border-slate-200 bg-white" aria-hidden>
        <div className="flex gap-4 border-b border-slate-200 px-4 py-3">
          {Array.from({ length: 5 }, (_, i) => (
            <Bone key={i} className="h-4 w-20" />
          ))}
        </div>
        <div className="space-y-2 p-4">
          {Array.from({ length: 5 }, (_, i) => (
            <Bone key={i} className="h-6 w-full" />
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
      <h1 className="text-lg font-semibold text-brand-navy">Cohort data is unavailable</h1>
      <p className="mt-1 text-sm text-slate-700">{message}</p>
      <p className="mt-2 text-xs text-slate-600">
        The page keeps retrying on its own. If it stays down, ask your admin to check the server.
      </p>
      <button type="button" onClick={onRetry} disabled={retrying} className={cn(btnPrimary, "mt-4")}>
        {retrying ? (
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
        ) : (
          <RotateCw className="h-4 w-4" aria-hidden />
        )}
        {retrying ? "Retrying…" : "Retry"}
      </button>
    </section>
  );
}

/** No graded sheet anywhere in scope yet. */
export function CohortEmpty({ reading }: { reading: number }) {
  return (
    <section aria-labelledby="cohort-empty-title" className="rounded-md border border-slate-200 bg-white p-5 sm:p-6">
      <h2 id="cohort-empty-title" className="text-base font-semibold text-brand-navy">
        No graded sheets yet
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-slate-600">
        Upload the question paper and the ticked answer sheets in Intake - each student&apos;s report and this class view
        appear when they are read.
        {reading > 0 ? ` ${reading === 1 ? "1 sheet is" : `${reading} sheets are`} being read now; this page updates on its own.` : ""}
      </p>
      <Link href="/" className={cn(btnPrimary, "mt-4")}>
        <Upload className="h-4 w-4" aria-hidden />
        Go to Intake
      </Link>
    </section>
  );
}

/** The test (or batch) in the link no longer exists: a scope problem, not an outage. */
export function ScopeGone({
  kind,
  onLatest,
  onAllBatches,
}: {
  kind: "test" | "batch";
  onLatest: () => void;
  onAllBatches: () => void;
}) {
  return (
    <section role="alert" className="rounded-md border border-slate-200 bg-white p-5 sm:p-6">
      <h2 className="text-base font-semibold text-brand-navy">
        {kind === "test" ? "This test is no longer available" : "This batch is no longer available"}
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-slate-600">
        {kind === "test"
          ? "The link points to a test that was removed or replaced. Open the batch's latest test instead."
          : "The link points to a batch that was removed. Open all batches instead."}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {kind === "test" ? (
          <button type="button" onClick={onLatest} className={btnPrimary}>
            Open the latest test
          </button>
        ) : null}
        <button type="button" onClick={onAllBatches} className={kind === "test" ? btnSecondary : btnPrimary}>
          All batches
        </button>
      </div>
    </section>
  );
}
