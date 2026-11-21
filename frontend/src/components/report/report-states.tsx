import Link from "next/link";
import { ArrowLeft, RefreshCw, SearchX, ServerCrash } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

function StateCard({
  icon: Icon,
  iconClass,
  title,
  children,
  actions,
}: {
  icon: LucideIcon;
  iconClass: string;
  title: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <section
      aria-labelledby="report-state-title"
      className="mx-auto mt-6 flex max-w-xl flex-col items-center rounded-2xl border border-slate-200 bg-white px-6 py-12 text-center shadow-sm sm:mt-12"
    >
      <span className={cn("grid h-16 w-16 place-items-center rounded-2xl ring-1 ring-inset", iconClass)}>
        <Icon className="h-8 w-8" aria-hidden />
      </span>
      <h1 id="report-state-title" className="mt-5 text-2xl font-semibold tracking-tight text-brand-navy">
        {title}
      </h1>
      <div className="mt-2 max-w-md text-sm leading-relaxed text-slate-600">{children}</div>
      <div className="mt-7 flex flex-wrap items-center justify-center gap-3">{actions}</div>
    </section>
  );
}

const primaryBtn =
  "inline-flex items-center gap-2 rounded-full bg-brand-navy px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-navy-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan";
const secondaryBtn =
  "inline-flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-medium text-slate-700 ring-1 ring-inset ring-slate-300 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan";

export function ReportNotFound({ id }: { id?: string }) {
  return (
    <StateCard
      icon={SearchX}
      iconClass="bg-brand-cyan-50 text-brand-cyan-600 ring-brand-cyan/30"
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
      icon={ServerCrash}
      iconClass="bg-rose-50 text-rose-600 ring-rose-200"
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
      <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-rose-800 ring-1 ring-inset ring-rose-200">
        {message}
      </p>
    </StateCard>
  );
}
