import Link from "next/link";
import type { ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Cog,
  FileInput,
  FileOutput,
  ShieldCheck,
  Terminal,
  UserRound,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { JOURNEY_STEPS, POC_STATUS_LABEL, type PocStatus } from "./steps";

const STATUS_LOOK: Record<PocStatus, { chip: string; dot: string }> = {
  implemented: { chip: "bg-brand-lime-50 text-lime-800 ring-brand-lime/50", dot: "bg-brand-lime-600" },
  stand_in: { chip: "bg-brand-cyan-50 text-brand-cyan-600 ring-brand-cyan/30", dot: "bg-brand-cyan" },
  mocked: { chip: "bg-amber-50 text-amber-800 ring-amber-300", dot: "bg-amber-400" },
  out_of_scope: { chip: "bg-slate-100 text-slate-600 ring-slate-200", dot: "bg-slate-400" },
};

export function StatusChip({ status, className }: { status: PocStatus; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset",
        STATUS_LOOK[status].chip,
        className,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", STATUS_LOOK[status].dot)} aria-hidden />
      {POC_STATUS_LABEL[status]}
    </span>
  );
}

function stepHref(id: string): string {
  return `/journey?step=${id}`;
}

function Block({
  icon: Icon,
  title,
  children,
  className,
}: {
  icon: typeof Cog;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 rounded-xl bg-slate-50 px-4 py-3 ring-1 ring-inset ring-slate-200", className)}>
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {title}
      </p>
      <div className="mt-1.5 text-sm text-slate-700">{children}</div>
    </div>
  );
}

/**
 * The 12-step walkthrough: a numbered stepper, the selected step (BRD design + "In this PoC" with a
 * status chip and a deep link), Prev / Next, and an at-a-glance list of all steps. Navigation is
 * plain links to ?step=<id>, so it works without JavaScript and in the Suspense fallback.
 */
export function JourneyExplorer({ activeIndex }: { activeIndex: number }) {
  const index = Math.min(Math.max(activeIndex, 0), JOURNEY_STEPS.length - 1);
  const step = JOURNEY_STEPS[index];
  const prev = index > 0 ? JOURNEY_STEPS[index - 1] : null;
  const next = index < JOURNEY_STEPS.length - 1 ? JOURNEY_STEPS[index + 1] : null;
  const counts = JOURNEY_STEPS.reduce<Record<PocStatus, number>>(
    (acc, s) => {
      acc[s.poc.status] += 1;
      return acc;
    },
    { implemented: 0, stand_in: 0, mocked: 0, out_of_scope: 0 },
  );

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-cyan-600">Guided walkthrough</p>
        <h1 className="text-2xl font-bold tracking-tight text-brand-navy sm:text-3xl">How it works</h1>
        <p className="max-w-3xl text-sm leading-relaxed text-slate-600">
          The twelve hand-offs of the V5 design, from onboarding to the learning loop. Each stop shows the actor, input,
          proposed processing, output, API and approval gate from the BRD, and what this proof of concept actually does
          today.
        </p>
        <p className="flex flex-wrap gap-2" aria-label="Status summary">
          {(Object.keys(counts) as PocStatus[])
            .filter((k) => counts[k] > 0)
            .map((k) => (
              <span key={k} className="inline-flex items-center gap-1.5 text-xs text-slate-600">
                <StatusChip status={k} />
                <span className="tabular-nums">×{counts[k]}</span>
              </span>
            ))}
        </p>
      </header>

      {/* Stepper */}
      <nav aria-label="Journey steps">
        <ol className="grid grid-cols-6 gap-1.5 lg:grid-cols-12">
          {JOURNEY_STEPS.map((s, i) => {
            const active = i === index;
            return (
              <li key={s.id} className="min-w-0">
                <Link
                  href={stepHref(s.id)}
                  scroll={false}
                  aria-current={active ? "step" : undefined}
                  title={`${i + 1}. ${s.title} - ${POC_STATUS_LABEL[s.poc.status]}`}
                  className={cn(
                    "flex h-full flex-col items-center gap-1 rounded-xl px-1 py-2 text-center ring-1 ring-inset transition focus-visible:outline-2 focus-visible:outline-brand-cyan",
                    active
                      ? "bg-brand-navy text-white ring-brand-navy"
                      : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50 hover:text-brand-navy",
                  )}
                >
                  <span className="text-sm font-bold tabular-nums">{i + 1}</span>
                  <span className={cn("h-1.5 w-1.5 rounded-full", STATUS_LOOK[s.poc.status].dot)} aria-hidden />
                  <span className={cn("hidden truncate text-[10px] leading-tight lg:block", active ? "text-white/80" : "text-slate-500")}>
                    {s.id}
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      </nav>

      {/* Selected step */}
      <article aria-labelledby="journey-step-title" className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-6">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Step {index + 1} of {JOURNEY_STEPS.length}
            </p>
            <h2 id="journey-step-title" className="mt-0.5 text-xl font-semibold text-brand-navy">
              {step.title}
            </h2>
            <p className="mt-1 flex items-center gap-1.5 text-sm text-slate-500">
              <UserRound className="h-4 w-4 shrink-0" aria-hidden />
              {step.person}
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <StatusChip status={step.poc.status} />
            {step.poc.secondary ? <StatusChip status={step.poc.secondary} /> : null}
          </div>
        </div>

        <div className="space-y-5 px-5 py-5 sm:px-6">
          <p className="text-base leading-relaxed text-slate-700">{step.summary}</p>

          <section
            aria-label="In this PoC"
            className="rounded-xl border border-brand-cyan/30 bg-brand-cyan-50/60 px-4 py-3"
          >
            <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-cyan-600">In this PoC</p>
            <p className="mt-1 text-sm leading-relaxed text-slate-800">{step.poc.text}</p>
            {step.poc.href ? (
              <Link
                href={step.poc.href}
                className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-brand-cyan-600 hover:text-brand-navy hover:underline"
              >
                {step.poc.linkLabel ?? "Open"}
                <ArrowUpRight className="h-4 w-4" aria-hidden />
              </Link>
            ) : null}
          </section>

          <div className="grid gap-3 md:grid-cols-2">
            <Block icon={FileInput} title="Input">
              {step.input}
            </Block>
            <Block icon={FileOutput} title="Output">
              {step.output}
            </Block>
          </div>

          <Block icon={Cog} title="Processing (proposed production design)" className="bg-white">
            <ul className="list-disc space-y-1 pl-5">
              {step.mechanics.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </Block>

          <div className="grid gap-3 md:grid-cols-2">
            <Block icon={Terminal} title="API contract">
              <code className="break-words font-mono text-xs text-slate-700">{step.api}</code>
            </Block>
            <Block icon={ShieldCheck} title="Gate" className="bg-amber-50/60 ring-amber-200">
              {step.gate}
            </Block>
          </div>
          <p className="text-xs text-slate-500">
            <span className="font-medium text-slate-600">V5 wireframe action:</span> {step.action}
          </p>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-5 py-3 sm:px-6">
          {prev ? (
            <Link
              href={stepHref(prev.id)}
              scroll={false}
              className="inline-flex min-w-0 items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-brand-cyan"
            >
              <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden />
              <span className="truncate">
                Prev<span className="hidden sm:inline">: {prev.title}</span>
              </span>
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link
              href={stepHref(next.id)}
              scroll={false}
              className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-brand-navy px-3 py-2 text-sm font-semibold text-white hover:bg-brand-navy-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
            >
              <span className="truncate">
                Next<span className="hidden sm:inline">: {next.title}</span>
              </span>
              <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
            </Link>
          ) : (
            <Link
              href={stepHref(JOURNEY_STEPS[0].id)}
              scroll={false}
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-brand-cyan"
            >
              Back to step 1
            </Link>
          )}
        </div>
      </article>

      {/* All steps at a glance */}
      <section aria-labelledby="journey-overview-title" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <h2 id="journey-overview-title" className="text-base font-semibold text-brand-navy">
          All 12 steps at a glance
        </h2>
        <ol className="mt-3 divide-y divide-slate-100">
          {JOURNEY_STEPS.map((s, i) => (
            <li key={s.id} className={cn("py-2.5", i === index && "rounded-lg bg-brand-cyan-50/50")}>
              <Link
                href={stepHref(s.id)}
                scroll={false}
                className="group grid grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-x-3 gap-y-1 rounded-lg px-1 focus-visible:outline-2 focus-visible:outline-brand-cyan sm:grid-cols-[1.75rem_minmax(0,1fr)_auto]"
              >
                <span className="pt-0.5 text-sm font-bold tabular-nums text-slate-400">{i + 1}</span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-slate-800 group-hover:text-brand-cyan-600">{s.title}</span>
                  <span className="block text-xs text-slate-500">{s.poc.text}</span>
                </span>
                <span className="col-start-2 flex flex-wrap gap-1 sm:col-start-3 sm:justify-end">
                  <StatusChip status={s.poc.status} />
                  {s.poc.secondary ? <StatusChip status={s.poc.secondary} /> : null}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
