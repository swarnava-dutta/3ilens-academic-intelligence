import Link from "next/link";
import { ArrowLeft, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { btnPrimary as primaryBtn, btnSecondary as secondaryBtn } from "./dialog";

function StateCard({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <section
      aria-labelledby="report-state-title"
      className="mt-6 max-w-xl rounded-md border border-slate-200 bg-white px-6 py-8 sm:mt-10"
    >
      <h1 id="report-state-title" className="text-xl font-semibold text-brand-navy">
        {title}
      </h1>
      <div className="mt-2 text-sm leading-relaxed text-slate-600">{children}</div>
      <div className="mt-6 flex flex-wrap items-center gap-2">{actions}</div>
    </section>
  );
}

export function ReportNotFound({ id }: { id?: string }) {
  return (
    <StateCard
      title="Report not found"
      actions={
        <Link href="/" className={primaryBtn}>
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to workspace
        </Link>
      }
    >
      {id ? (
        <p>
          There is no submission with ID <span className="font-mono font-semibold text-slate-800">{id}</span>. It may
          have been removed, or the link may be incorrect.
        </p>
      ) : (
        <p>This report link is not valid.</p>
      )}
      <p className="mt-2">Pick a student from the processing queue in the Faculty Workspace to open their report.</p>
    </StateCard>
  );
}

export function ReportLoadError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <StateCard
      title="Couldn’t load this report"
      actions={
        <>
          {onRetry ? (
            <button type="button" onClick={onRetry} className={primaryBtn}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              Try again
            </button>
          ) : null}
          <Link href="/" className={secondaryBtn}>
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Back to workspace
          </Link>
        </>
      }
    >
      <p role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-rose-800">
        {message}
      </p>
    </StateCard>
  );
}
