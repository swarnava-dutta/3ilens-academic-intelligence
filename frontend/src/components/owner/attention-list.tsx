"use client";

import Link from "next/link";
import { forwardRef, useImperativeHandle, useRef, useState, type ComponentType, type ReactNode } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, Eye, Info, TrendingUp } from "lucide-react";
import { pct1 } from "@/lib/format";
import type { OwnerAtRiskStudent, OwnerRelease, OwnerSignal, OwnerSignalSeverity } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmt } from "./format";
import { ageText, ChangeText, clockText, dayText, Disclosure, linkCls, linkText } from "./owner-ui";
import { btnQuiet, focusRing, theadCls, thCls } from "./states";
import type { OwnerTab } from "./owner-tabs";

const SEVERITY: Record<OwnerSignalSeverity, { label: string; border: string; icon: ComponentType<{ className?: string }>; text: string }> = {
  act: { label: "Act now", border: "border-l-rose-600", icon: AlertTriangle, text: "text-rose-700" },
  check: { label: "Check", border: "border-l-amber-500", icon: Eye, text: "text-amber-800" },
  good: { label: "Good news", border: "border-l-brand-lime-600", icon: TrendingUp, text: "text-lime-800" },
  info: { label: "For info", border: "border-l-slate-300", icon: Info, text: "text-slate-600" },
};
const VISIBLE_URGENT = 4;
/** Signals whose call to action switches a tab on this page instead of leaving it. */
const TAB_CTA: Record<string, { tab: OwnerTab; label: string }> = {
  progress: { tab: "progress", label: "See progress" },
  under_attempting: { tab: "behaviour", label: "See exam behaviour" },
  over_attempting: { tab: "behaviour", label: "See exam behaviour" },
  cost: { tab: "cost", label: "See cost" },
};

export interface AttentionHandle {
  /** Reveal, expand and scroll to a signal row (used by the KPI tiles). */
  open: (key: string) => void;
}

/** First 4 act/check rows plus the best good-news row; the rest behind "Show N more". */
function split(signals: OwnerSignal[]): { visible: OwnerSignal[]; rest: OwnerSignal[] } {
  const urgent = signals.filter((s) => s.severity === "act" || s.severity === "check");
  const good = signals.find((s) => s.severity === "good");
  const shown = new Set([...urgent.slice(0, VISIBLE_URGENT), ...(good ? [good] : [])].map((s) => s.key));
  return { visible: signals.filter((s) => shown.has(s.key)), rest: signals.filter((s) => !shown.has(s.key)) };
}

function rowId(key: string) {
  return `attention-${key.replace(/[^a-z0-9_-]/gi, "-")}`;
}

/** "last action 6 Nov" for a student whose only actions predate their latest test. */
function LastAction({ at }: { at: string | null }) {
  if (!at) return null;
  return (
    <span className="whitespace-nowrap text-xs text-slate-500" title="Their most recent logged action is older than their latest test">
      last action {dayText(at)}
    </span>
  );
}

function AtRiskTable({ students, signal }: { students: OwnerAtRiskStudent[]; signal: OwnerSignal }) {
  const rows = students.filter((s) => !s.actioned).slice(0, 10);
  const actioned = students.filter((s) => s.actioned).length;
  return (
    <div className="space-y-2">
      <div className="hidden overflow-hidden rounded-md border border-slate-200 md:block">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">At-risk students with no action since their latest test</caption>
          <thead className={theadCls}>
            <tr>
              <th scope="col" className={thCls}>Student</th>
              <th scope="col" className={thCls}>Batch</th>
              <th scope="col" className={cn(thCls, "text-right")}>Latest</th>
              <th scope="col" className={cn(thCls, "text-right")} title="Same student, previous vs latest whole-class test">
                Change
              </th>
              <th scope="col" className={thCls}>Weakest topic (latest test)</th>
              <th scope="col" className={thCls}><span className="sr-only">Report</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((s) => (
              <tr key={s.submission_id}>
                <th scope="row" className="px-3 py-1.5 text-left font-medium text-slate-900">
                  {s.student_name}
                  {s.last_action_at ? (
                    <span className="ml-2 font-normal">
                      <LastAction at={s.last_action_at} />
                    </span>
                  ) : null}
                </th>
                <td className="px-3 py-1.5 text-slate-700">{s.batch_name}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-slate-900" title={`${pct1(s.pct)} · ${s.test_name}`}>
                  {fmt(s.pct, 0)}%
                </td>
                <td className="px-3 py-1.5 text-right">
                  <ChangeText value={s.change} suffix="" />
                </td>
                <td className="px-3 py-1.5 text-slate-700">
                  {s.weakest_topic ? (
                    <>
                      {s.weakest_topic}{" "}
                      <span className="tabular-nums text-slate-500">{s.weakest_mastery === null ? "" : `${fmt(s.weakest_mastery, 0)}%`}</span>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-3 py-1.5 text-right">
                  <Link
                    href={`/report/${s.submission_id}`}
                    className={cn(linkCls, "whitespace-nowrap")}
                    aria-label={`Open ${s.student_name}'s report`}
                  >
                    Open report
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 md:hidden">
        {rows.map((s) => (
          <li key={s.submission_id} className="px-3 py-2 text-sm">
            <div className="flex items-baseline justify-between gap-2">
              <Link href={`/report/${s.submission_id}`} className={cn(linkCls, "inline-flex min-h-10 items-center")}>
                {s.student_name}
              </Link>
              <span className="shrink-0 tabular-nums text-slate-900">
                {fmt(s.pct, 0)}% <ChangeText value={s.change} suffix="" className="ml-1 text-xs" />
              </span>
            </div>
            <p className="text-xs text-slate-600">
              {s.batch_name}
              {s.weakest_topic ? ` · weakest: ${s.weakest_topic} ${s.weakest_mastery === null ? "" : `${fmt(s.weakest_mastery, 0)}%`}` : ""}
              {s.last_action_at ? <> · <LastAction at={s.last_action_at} /></> : null}
            </p>
          </li>
        ))}
      </ul>
      <p className="text-xs text-slate-600">
        To act: open the report and log a nudge or study focus (Actions), or log it from the Students page. The row
        leaves this list once an action is logged.
      </p>
      {signal.href ? (
        <p className="text-xs text-slate-600">
          <Link href={signal.href} className={linkCls}>
            All at-risk students on Students
          </Link>{" "}
          (one row per student, latest test{actioned ? `; includes the ${actioned} already actioned` : ""})
        </p>
      ) : null}
    </div>
  );
}

function ReleaseList({ release }: { release: OwnerRelease }) {
  const rows = release.by_batch.filter((b) => b.awaiting > 0);
  return (
    <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 text-sm">
      {rows.map((b) => (
        <li key={b.batch_id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2">
          <Link href={`/students?batch_id=${b.batch_id}`} className={cn(linkCls, "inline-flex min-h-10 items-center sm:min-h-0")}>
            {b.batch_name}
          </Link>
          <span className="min-w-0 flex-1 text-slate-600">{b.lead ?? "no faculty lead set"}</span>
          <span className="tabular-nums text-slate-900">
            <span className="font-medium">{b.awaiting}</span> awaiting{" "}
            <span className={cn("text-xs", (b.oldest_days ?? 0) >= 2 ? "text-amber-800" : "text-slate-500")}>
              (oldest {ageText(b.oldest_days, true)})
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function ItemsList({ signal }: { signal: OwnerSignal }) {
  return (
    <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 text-sm">
      {signal.items.map((item, i) => (
        <li key={`${item.label}-${i}`} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3 py-2">
          {item.href ? (
            <Link href={item.href} className={linkCls}>
              {item.label}
            </Link>
          ) : (
            <span className="font-medium text-slate-900">{item.label}</span>
          )}
          {item.detail ? <span className="min-w-0 flex-1 text-xs text-slate-600">{item.detail}</span> : null}
          {item.value ? <span className="tabular-nums text-slate-900">{item.value}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function SignalRow({
  signal,
  expanded,
  onToggle,
  atRisk,
  release,
  onOpenTab,
}: {
  signal: OwnerSignal;
  expanded: boolean;
  onToggle: () => void;
  atRisk: OwnerAtRiskStudent[];
  release: OwnerRelease | null;
  onOpenTab: (tab: OwnerTab) => void;
}) {
  const sev = SEVERITY[signal.severity] ?? SEVERITY.info;
  const Icon = sev.icon;
  const id = rowId(signal.key);
  const tabCta = TAB_CTA[signal.key] ?? null;

  let body: ReactNode = null;
  let expandLabel: string | null = null;
  if (signal.key === "at_risk_unactioned" && atRisk.some((s) => !s.actioned)) {
    const n = Math.min(10, atRisk.filter((s) => !s.actioned).length);
    expandLabel = `Show ${n} student${n === 1 ? "" : "s"}`;
    body = <AtRiskTable students={atRisk} signal={signal} />;
  } else if (signal.key === "release_backlog" && release && release.by_batch.some((b) => b.awaiting > 0)) {
    expandLabel = "Show by batch";
    body = <ReleaseList release={release} />;
  } else if (!tabCta && signal.items.length > 1) {
    expandLabel = `Show ${signal.items.length}`;
    body = <ItemsList signal={signal} />;
  }

  let cta: ReactNode = null;
  if (expandLabel) {
    cta = (
      <Disclosure open={expanded} onToggle={onToggle} controls={`${id}-detail`} className="w-full justify-center sm:w-auto">
        {expanded ? "Hide" : expandLabel}
      </Disclosure>
    );
  } else if (tabCta) {
    cta = (
      <button type="button" onClick={() => onOpenTab(tabCta.tab)} className={cn(btnQuiet, "h-10 w-full sm:h-8 sm:w-auto")}>
        {signal.cta ?? tabCta.label}
        <ArrowRight className="h-3.5 w-3.5" aria-hidden />
      </button>
    );
  } else if (signal.href) {
    cta = (
      <Link href={signal.href} className={cn(btnQuiet, "h-10 w-full sm:h-8 sm:w-auto")}>
        {signal.cta ?? "Open"}
        <ArrowRight className="h-3.5 w-3.5" aria-hidden />
      </Link>
    );
  }

  return (
    <li id={id} className={cn("scroll-mt-20 border-l-[3px] bg-white", sev.border)}>
      <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", sev.text)} aria-hidden />
          <div className="min-w-0">
            <p className={cn("text-[11px] font-semibold uppercase tracking-wide", sev.text)}>{sev.label}</p>
            <p className="text-sm font-medium text-slate-900">{signal.title}</p>
            {signal.detail ? <p className="mt-0.5 text-xs text-slate-600">{signal.detail}</p> : null}
          </div>
        </div>
        {cta ? <div className="shrink-0 sm:pl-2">{cta}</div> : null}
      </div>
      {expandLabel ? (
        <div id={`${id}-detail`} hidden={!expanded} className="px-4 pb-3 sm:pl-11">
          {expanded ? body : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * "Needs your attention": the deterministic signals from the owner payload, most urgent first.
 * Each row says what happened (title), where (detail) and offers one next step.
 */
export const AttentionList = forwardRef<
  AttentionHandle,
  {
    signals: OwnerSignal[];
    atRisk: OwnerAtRiskStudent[];
    release: OwnerRelease | null;
    generatedAt: string;
    onOpenTab: (tab: OwnerTab) => void;
  }
>(function AttentionList({ signals, atRisk, release, generatedAt, onOpenTab }, ref) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const listId = "owner-attention-list";
  const announce = useRef<HTMLSpanElement>(null);

  const { visible, rest } = split(signals);
  // The extra rows appear after the visible ones (next to the button), never in between.
  const shown = showAll ? [...visible, ...rest] : visible;

  function toggleAll() {
    const next = !showAll;
    setShowAll(next);
    if (announce.current) announce.current.textContent = next ? `${rest.length} more shown` : `${rest.length} hidden`;
    if (next && rest[0]) {
      const key = rest[0].key;
      window.requestAnimationFrame(() => {
        document.getElementById(rowId(key))?.querySelector<HTMLElement>("button, a")?.focus({ preventScroll: false });
      });
    }
  }

  useImperativeHandle(ref, () => ({
    open(key: string) {
      if (!signals.some((s) => s.key === key)) return;
      if (!visible.some((s) => s.key === key)) setShowAll(true);
      setExpanded(key);
      window.requestAnimationFrame(() => {
        const el = document.getElementById(rowId(key));
        if (!el) return;
        const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
        el.querySelector<HTMLElement>("button, a")?.focus({ preventScroll: true });
      });
    },
  }));

  return (
    <section aria-labelledby="owner-attention-title" className="min-w-0 rounded-md border border-slate-200 bg-white">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-slate-200 px-4 py-3 sm:px-5">
        <h2 id="owner-attention-title" className="text-[15px] font-semibold text-brand-navy">
          Needs your attention
        </h2>
        <p className="text-xs text-slate-500">checked {clockText(generatedAt)} · students counted by their latest test</p>
      </div>
      {signals.length === 0 ? (
        <p className="flex items-center gap-2 px-4 py-5 text-sm text-slate-700 sm:px-5">
          <CheckCircle2 className="h-5 w-5 shrink-0 text-lime-800" aria-hidden />
          Nothing needs your attention right now
          <span className="text-xs text-slate-500">· checked {clockText(generatedAt)}</span>
        </p>
      ) : (
        <>
          <ul id={listId} className="divide-y divide-slate-200">
            {shown.map((s) => (
              <SignalRow
                key={s.key}
                signal={s}
                expanded={expanded === s.key}
                onToggle={() => setExpanded((k) => (k === s.key ? null : s.key))}
                atRisk={atRisk}
                release={release}
                onOpenTab={onOpenTab}
              />
            ))}
          </ul>
          {rest.length ? (
            <div className="border-t border-slate-200 px-4 py-1 sm:px-5">
              <button
                type="button"
                aria-expanded={showAll}
                aria-controls={listId}
                onClick={toggleAll}
                className={cn("inline-flex min-h-10 items-center text-sm font-medium hover:underline", linkText, focusRing)}
              >
                {showAll ? "Show fewer" : `Show ${rest.length} more`}
              </button>
              <span ref={announce} aria-live="polite" className="sr-only" />
            </div>
          ) : null}
        </>
      )}
    </section>
  );
});
