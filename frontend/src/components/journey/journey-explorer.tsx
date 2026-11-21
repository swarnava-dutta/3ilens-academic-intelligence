import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { JOURNEY_STEPS, POC_STATUS_LABEL, type PocStatus } from "./steps";

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan";

const STATUS_LOOK: Record<PocStatus, { chip: string; dot: string }> = {
  implemented: { chip: "bg-brand-lime-50 text-lime-800", dot: "bg-brand-lime-600" },
  stand_in: { chip: "bg-slate-100 text-slate-700", dot: "bg-slate-500" },
  mocked: { chip: "bg-amber-50 text-amber-800", dot: "bg-amber-500" },
  out_of_scope: { chip: "border border-slate-200 text-slate-500", dot: "bg-slate-300" },
};

export function StatusChip({ status, className }: { status: PocStatus; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-sm px-1.5 py-0.5 text-xs font-medium",
        STATUS_LOOK[status].chip,
        className,
      )}
    >
      {POC_STATUS_LABEL[status]}
    </span>
  );
}

function stepHref(id: string): string {
  return `/journey?step=${id}`;
}

/** One row of the step's definition list. */
function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-t border-slate-200 py-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-[13px] text-slate-500">{term}</dt>
      <dd className="min-w-0 text-sm leading-relaxed text-slate-700">{children}</dd>
    </div>
  );
}

const navBtn = `inline-flex h-10 min-w-0 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors duration-150 sm:h-9 ${focusRing}`;

/**
 * The 12-step walkthrough: a numbered step list, the selected step (BRD design + "In this PoC" with a
 * status tag and a deep link) and Prev / Next. Navigation is plain links to ?step=<id>, so it works
 * without JavaScript and in the Suspense fallback.
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
      <header className="border-b border-slate-200 pb-4">
        <h1 className="text-[22px] font-semibold leading-tight text-brand-navy sm:text-2xl">How it works</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          The twelve hand-offs of the V5 design, from onboarding to the learning loop: the actor, input, proposed
          processing, output, API and approval gate from the BRD, and what this proof of concept does today.
        </p>
        <p className="mt-2 text-[13px] tabular-nums text-slate-500" aria-label="Status summary">
          {(Object.keys(counts) as PocStatus[])
            .filter((k) => counts[k] > 0)
            .map((k) => `${counts[k]} ${POC_STATUS_LABEL[k].toLowerCase()}`)
            .join(" · ")}
        </p>
      </header>

      {/* Compact step picker on small screens; the full list sits beside the step on large screens. */}
      <nav aria-label="Journey steps (compact)" className="lg:hidden">
        <ol className="grid grid-cols-6 gap-1">
          {JOURNEY_STEPS.map((s, i) => {
            const active = i === index;
            return (
              <li key={s.id}>
                <Link
                  href={stepHref(s.id)}
                  scroll={false}
                  aria-current={active ? "step" : undefined}
                  title={`${i + 1}. ${s.title} - ${POC_STATUS_LABEL[s.poc.status]}`}
                  className={cn(
                    "flex h-10 flex-col items-center justify-center gap-1 rounded-md border text-sm font-medium tabular-nums transition-colors duration-150",
                    focusRing,
                    active
                      ? "border-brand-navy bg-brand-navy text-white"
                      : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
                  )}
                >
                  {i + 1}
                  <span className={cn("h-0.5 w-4", STATUS_LOOK[s.poc.status].dot)} aria-hidden />
                  <span className="sr-only">
                    {s.title}, {POC_STATUS_LABEL[s.poc.status]}
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      </nav>

      <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)] lg:items-start">
        {/* Numbered step list */}
        <nav aria-label="Journey steps" className="order-last lg:sticky lg:top-4 lg:order-first">
          <h2 className="mb-2 text-[13px] font-medium text-slate-500 lg:sr-only">All 12 steps</h2>
          <ol className="overflow-hidden rounded-md border border-slate-200 bg-white">
            {JOURNEY_STEPS.map((s, i) => {
              const active = i === index;
              return (
                <li key={s.id} className="border-b border-slate-200 last:border-b-0">
                  <Link
                    href={stepHref(s.id)}
                    scroll={false}
                    aria-current={active ? "step" : undefined}
                    className={cn(
                      "grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2 border-l-2 px-3 py-2 transition-colors duration-150 -outline-offset-2 focus-visible:outline-2 focus-visible:outline-brand-cyan",
                      active ? "border-l-brand-cyan bg-brand-cyan-50" : "border-l-transparent hover:bg-slate-50",
                    )}
                  >
                    <span
                      className={cn(
                        "pt-px text-sm tabular-nums",
                        active ? "font-semibold text-brand-navy" : "text-slate-500",
                      )}
                    >
                      {i + 1}
                    </span>
                    <span className="min-w-0">
                      <span className={cn("block text-sm", active ? "font-semibold text-brand-navy" : "text-slate-800")}>
                        {s.title}
                      </span>
                      <span className="mt-0.5 block text-xs text-slate-500">
                        {POC_STATUS_LABEL[s.poc.status]}
                        {s.poc.secondary ? ` · ${POC_STATUS_LABEL[s.poc.secondary]}` : ""}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>
        </nav>

        {/* Selected step */}
        <article aria-labelledby="journey-step-title" className="min-w-0 rounded-md border border-slate-200 bg-white">
          <div className="flex flex-col gap-2 border-b border-slate-200 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:px-5">
            <div className="min-w-0">
              <p className="text-[13px] tabular-nums text-slate-500">
                Step {index + 1} of {JOURNEY_STEPS.length} · {step.person}
              </p>
              <h2 id="journey-step-title" className="mt-0.5 text-lg font-semibold text-brand-navy">
                {step.title}
              </h2>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <StatusChip status={step.poc.status} />
              {step.poc.secondary ? <StatusChip status={step.poc.secondary} /> : null}
            </div>
          </div>

          <div className="px-4 pt-4 sm:px-5">
            <p className="text-[15px] leading-relaxed text-slate-800">{step.summary}</p>

            <section aria-label="In this PoC" className="mt-4 border-l-2 border-brand-cyan pl-3">
              <h3 className="text-[13px] font-semibold text-brand-navy">In this PoC</h3>
              <p className="mt-1 text-sm leading-relaxed text-slate-700">{step.poc.text}</p>
              {step.poc.href ? (
                <Link
                  href={step.poc.href}
                  className={cn("mt-1 inline-flex items-center gap-1 text-sm font-medium text-brand-cyan-600 hover:underline", focusRing)}
                >
                  {step.poc.linkLabel ?? "Open"}
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
              ) : null}
            </section>

            <h3 className="mt-6 text-[13px] font-semibold text-slate-700">Proposed production design</h3>
            <dl className="mt-2">
              <Row term="Input">{step.input}</Row>
              <Row term="Processing">
                <ol className="list-decimal space-y-1 pl-5 marker:text-slate-400">
                  {step.mechanics.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ol>
              </Row>
              <Row term="Output">{step.output}</Row>
              <Row term="API contract">
                <code className="break-words font-mono text-xs text-slate-700">{step.api}</code>
              </Row>
              <Row term="Gate">
                <span className="text-amber-900">{step.gate}</span>
              </Row>
              <Row term="V5 wireframe action">{step.action}</Row>
            </dl>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 sm:px-5">
            {prev ? (
              <Link
                href={stepHref(prev.id)}
                scroll={false}
                className={cn(navBtn, "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50")}
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
                className={cn(navBtn, "bg-brand-navy text-white hover:bg-brand-navy-700")}
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
                className={cn(navBtn, "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50")}
              >
                Back to step 1
              </Link>
            )}
          </div>
        </article>
      </div>
    </div>
  );
}
