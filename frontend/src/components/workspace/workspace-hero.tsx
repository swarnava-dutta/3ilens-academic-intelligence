import Link from "next/link";
import { AlertTriangle, ArrowUpRight, Building2, CalendarClock, CheckCircle2, GraduationCap, Loader2 } from "lucide-react";
import type { Health } from "@/lib/types";
import { cn } from "@/lib/utils";
import { batchLabel, FALLBACK_BATCH, FALLBACK_INSTITUTION, type QueueFilter } from "./format";

interface WorkspaceHeroProps {
  health: Health | null;
  counts: Record<QueueFilter, number> | null;
}

export function WorkspaceHero({ health, counts }: WorkspaceHeroProps) {
  const institution = health?.institution?.name || FALLBACK_INSTITUTION;
  const batch = batchLabel(health?.batch) ?? FALLBACK_BATCH;
  const exam = health?.batch?.exam || "NEET";
  const days = health?.batch?.days_to_exam;
  const assumed = health?.batch?.exam_date_assumed ?? false;

  const stats = [
    {
      label: "In pipeline",
      value: counts?.PROCESSING,
      Icon: Loader2,
      iconClass: "text-brand-cyan",
    },
    {
      label: "Completed",
      value: counts?.COMPLETED,
      Icon: CheckCircle2,
      iconClass: "text-brand-lime",
    },
    {
      label: "Human review",
      value: counts?.HUMAN_REVIEW_REQUIRED,
      Icon: AlertTriangle,
      iconClass: "text-amber-300",
    },
  ];

  return (
    <section
      aria-labelledby="workspace-title"
      className="relative overflow-hidden rounded-2xl bg-brand-navy text-white shadow-sm ring-1 ring-brand-navy-700"
    >
      {/* Decorative lens rings */}
      <svg
        className="pointer-events-none absolute -right-16 -top-24 h-80 w-80 text-brand-cyan/20"
        viewBox="0 0 200 200"
        aria-hidden
      >
        <circle cx="100" cy="100" r="90" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="100" cy="100" r="64" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="100" cy="100" r="38" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(5,167,197,0.28),transparent_55%)]"
        aria-hidden
      />

      <div className="relative flex flex-col gap-6 p-6 sm:p-8 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0 space-y-4">
          <p className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-brand-cyan">
            <Building2 className="h-4 w-4" aria-hidden />
            {institution}
          </p>
          <div className="space-y-2">
            <h1 id="workspace-title" className="text-3xl font-bold tracking-tight sm:text-4xl">
              Faculty Workspace
            </h1>
            <p className="max-w-2xl text-sm leading-relaxed text-slate-300 sm:text-base">
              Upload handwritten answer sheets one at a time or as a whole folder, watch the AI pipeline work in
              real time, and open each student&apos;s Intelligence Report.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-full bg-white/10 py-1.5 pl-2 pr-4 text-sm ring-1 ring-inset ring-white/15">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-lime text-brand-navy">
                <GraduationCap className="h-4 w-4" aria-hidden />
              </span>
              <span className="text-slate-300">Active Batch:</span>
              <span className="font-semibold text-white">{batch}</span>
            </span>
            {typeof days === "number" ? (
              <span
                className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-sm ring-1 ring-inset ring-white/15"
                title={`${exam} ${health?.batch?.exam_date ?? ""}${assumed ? " - assumed date (NEET_EXAM_DATE); set the real date on the Cohort page" : ""}`}
              >
                <CalendarClock className="h-4 w-4 text-brand-lime" aria-hidden />
                <span className="font-semibold text-white">
                  {exam} in {days} {days === 1 ? "day" : "days"}
                </span>
                {assumed ? <span className="text-xs text-slate-300">(assumed date)</span> : null}
              </span>
            ) : null}
            <Link
              href="/cohort"
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium text-brand-cyan transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan"
            >
              Cohort Dashboard
              <ArrowUpRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
        </div>

        <dl className="grid shrink-0 grid-cols-3 gap-3 sm:gap-4">
          {stats.map(({ label, value, Icon, iconClass }) => (
            <div
              key={label}
              className="min-w-[6.5rem] rounded-xl bg-white/[0.07] px-4 py-3 ring-1 ring-inset ring-white/10"
            >
              <dt className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-300">
                <Icon className={cn("h-3.5 w-3.5", iconClass)} aria-hidden />
                {label}
              </dt>
              <dd className="mt-1 text-2xl font-bold tabular-nums">{value ?? "—"}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
