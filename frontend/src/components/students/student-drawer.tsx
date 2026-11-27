"use client";

import { ChevronRight, FileDown, Loader2, MessageCircle, MoreHorizontal, PenLine } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { BarList, LineChart } from "@/components/charts";
import { Modal, Notice, btnPrimary, btnSecondary } from "@/components/report/dialog";
import { WhatsAppDialog } from "@/components/report/whatsapp-dialog";
import { IllustrativePill } from "@/components/shared/illustrative-pill";
import { UrgencyBadge } from "@/components/shared/urgency-badge";
import { errorMessage, getInterventions, getStudentHistory, reportPdfUrl } from "@/lib/api";
import type { HistoryEntry, InterventionRecord, RosterRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { OutcomeChip, UrgencyDot } from "./bits";
import {
  fmtDay,
  fmtMarks,
  fmtMastery,
  fmtPct,
  KIND_LABELS,
  looksLikeFileName,
  marksWord,
  masteryFill,
  plural,
  previousKind,
  shortOf,
  shortTest,
  SMALL_TEST_QUESTIONS,
  testLabel,
  WEAK_MASTERY,
} from "./format";
import type { LogTarget } from "./log-action-dialog";
import { menuItem, Popover } from "./popover";

const EFFECT_CAVEAT =
  "Observational: students and topics were not randomised, so a change after an action is indicative, not proof that the action caused it.";
const PRIORITY_PILL: Record<string, string> = {
  high: "bg-red-50 text-red-700",
  medium: "bg-amber-50 text-amber-800",
  low: "bg-slate-100 text-slate-600",
};
const LINK =
  "rounded-sm font-medium text-brand-cyan-600 hover:text-brand-navy hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan";
/** Weak topics listed before "Show all". */
const WEAK_SHOWN = 5;
const VERDICT_TEXT = {
  guessing: "Wrong answers are costing marks",
  skipping: "Skipping is holding the score back",
  ok: "Attempt strategy is working",
} as const;

type Load<T> = { key: string; data: T } | { key: string; error: string };

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-slate-200 pt-4">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-brand-navy">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function InlineError({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm text-rose-800" role="alert">
      Could not load {what}
      <button type="button" onClick={onRetry} className={LINK}>
        Retry
      </button>
    </p>
  );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-md bg-slate-50 px-2.5 py-2">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-base font-semibold tabular-nums text-brand-navy">{value}</dd>
      {sub ? <dd className="text-xs tabular-nums text-slate-500">{sub}</dd> : null}
    </div>
  );
}

/** Unique x labels for the trend chart: "Mock 09 · 3 Nov" (a repeat on the same day gets "#2"). */
function chartLabels(papers: HistoryEntry[]): string[] {
  const seen = new Map<string, number>();
  return papers.map((p) => {
    const base = `${shortTest(p.rubric_name)} · ${fmtDay(p.date)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base} #${n}` : base;
  });
}

function ScoreTrend({
  row,
  history,
  scoped,
  onRetry,
}: {
  row: RosterRow;
  history: Load<HistoryEntry[]> | null;
  scoped: boolean;
  onRetry: () => void;
}) {
  if (!history) {
    return (
      <p className="flex items-center gap-2 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> Loading the trend…
      </p>
    );
  }
  if ("error" in history) return <InlineError what="the trend" onRetry={onRetry} />;
  const all = history.data.filter((h) => h.input_kind !== "voice");
  // The chart ends at the row's latest paper, so it never disagrees with the row; papers after it
  // (outside a batch / test filter) are named below instead of plotted.
  // A graded oral answer can be the latest sheet (an oral test filter): the papers sat before it.
  const latestAt = row.latest?.date ?? null;
  const found = all.findIndex((h) => h.submission_id === row.latest?.submission_id);
  const end = found >= 0 ? found + 1 : latestAt !== null ? all.filter((h) => h.date < latestAt).length : all.length;
  const papers = all.slice(0, end);
  const later = all.slice(end);
  const oral = history.data.filter((h) => h.input_kind === "voice");
  const labels = chartLabels(papers);
  const prev = row.previous;
  return (
    <div className="space-y-3">
      {papers.length >= 2 ? (
        <>
          <LineChart
            series={[{ name: "Score", series: 1, points: papers.map((p, i) => ({ x: labels[i], y: p.pct })) }]}
            yDomain={[0, 100]}
            unit="%"
            band={papers.map((_, i) => ({ x: labels[i], lo: 55, hi: 70 }))}
          />
          <p className="text-xs text-slate-500">
            Shaded: the 55–70% needs-attention band. Each point is one paper
            {scoped && later.length ? ", up to the latest in this filter" : ""}.
          </p>
          {prev && !prev.comparable && row.latest ? (
            <p className="text-xs text-slate-600">
              Not counted as a trend: the paper before ({previousKind(prev)}) is a different kind of test from{" "}
              {shortOf(row.latest)} ({row.latest.questions} Qs, {fmtMarks(row.latest.total_marks)} marks).
            </p>
          ) : null}
        </>
      ) : papers.length === 1 ? (
        <p className="text-sm text-slate-700">
          <Link href={`/report/${papers[0].submission_id}`} className={cn(LINK, "text-lg font-semibold tabular-nums")}>
            {fmtPct(papers[0].pct)}
          </Link>{" "}
          on {papers[0].rubric_name} ({fmtMarks(papers[0].score)}/{fmtMarks(papers[0].total_marks)}, uploaded{" "}
          {fmtDay(papers[0].date)}). <span className="text-slate-500">The trend appears after the next paper.</span>
        </p>
      ) : (
        <p className="text-sm text-slate-500">No graded paper yet.</p>
      )}
      {later.length > 0 ? (
        <Notice tone="info">
          {later.length === 1 ? "A newer paper is" : `${later.length} newer papers are`} outside this filter:{" "}
          {later.map((p, i) => (
            <span key={p.submission_id}>
              {i ? ", " : ""}
              <Link href={`/report/${p.submission_id}`} className={LINK}>
                {shortTest(p.rubric_name)} {fmtPct(p.pct)}
              </Link>{" "}
              (uploaded {fmtDay(p.date)})
            </span>
          ))}
          .
        </Notice>
      ) : null}
      {papers.length > 1 ? (
        <ol className="divide-y divide-slate-100 rounded-md border border-slate-200 text-[13px]" aria-label="Papers, newest first">
          {[...papers].reverse().map((p) => (
            <li key={p.submission_id}>
              <Link
                href={`/report/${p.submission_id}`}
                className="flex min-h-10 items-center gap-2 px-3 py-1.5 hover:bg-slate-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-cyan"
              >
                <UrgencyDot urgency={p.urgency} />
                <span className="w-14 shrink-0 tabular-nums text-slate-500">{fmtDay(p.date)}</span>
                <span className="min-w-0 flex-1 truncate text-slate-800" title={`${p.rubric_name} ${p.rubric_version}`}>
                  {shortTest(p.rubric_name)}
                </span>
                <span className="shrink-0 tabular-nums text-slate-600">
                  {fmtMarks(p.score)}/{fmtMarks(p.total_marks)}
                </span>
                <span className="w-12 shrink-0 text-right font-medium tabular-nums text-slate-800">{fmtPct(p.pct)}</span>
                {p.submission_id === row.latest?.submission_id ? <span className="sr-only">(latest in scope)</span> : null}
                <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
              </Link>
            </li>
          ))}
        </ol>
      ) : null}
      {oral.length > 0 ? (
        <details className="rounded-md border border-slate-200 text-[13px]">
          <summary className="cursor-pointer px-3 py-2 font-medium text-slate-700 hover:text-brand-navy">
            Oral checks ({oral.length}) - not counted in the trend
          </summary>
          <ul className="divide-y divide-slate-100 border-t border-slate-200">
            {oral.map((p) => (
              <li key={p.submission_id} className="flex items-center gap-2 px-3 py-1.5">
                <span className="w-14 shrink-0 tabular-nums text-slate-500">{fmtDay(p.date)}</span>
                <Link href={`/report/${p.submission_id}`} className={cn(LINK, "min-w-0 flex-1 truncate font-normal")}>
                  {p.rubric_name}
                </Link>
                <span className="shrink-0 tabular-nums text-slate-600">
                  {fmtMarks(p.score)}/{fmtMarks(p.total_marks)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function ActionsLogged({
  actions,
  onRetry,
}: {
  actions: Load<InterventionRecord[]> | null;
  onRetry: () => void;
}) {
  if (!actions) {
    return (
      <p className="flex items-center gap-2 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> Loading actions…
      </p>
    );
  }
  if ("error" in actions) return <InlineError what="the actions" onRetry={onRetry} />;
  if (actions.data.length === 0) return <p className="text-sm text-slate-500">No action logged for this student yet.</p>;
  return (
    <>
      <ul className="space-y-2">
        {actions.data.map((a) => (
          <li key={a.id} className="rounded-md border border-slate-200 px-3 py-2 text-[13px]">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium text-slate-800">{a.topic}</span>
              <span className="text-slate-500">{KIND_LABELS[a.kind]}</span>
              <OutcomeChip status={a.outcome_status} change={a.outcome?.mastery_change ?? null} className="ml-auto" />
            </p>
            <p className="mt-0.5 text-slate-600">{a.action}</p>
            <p className="mt-0.5 text-xs text-slate-500">
              {fmtDay(a.applied_at)} · by {a.applied_by}
              {a.hours ? ` · ${fmtMarks(a.hours)} h` : ""}
            </p>
            {a.outcome ? (
              <p className="mt-0.5 text-xs tabular-nums text-slate-600">
                Mastery {fmtMastery(a.outcome.baseline_mastery)} → {fmtMastery(a.outcome.follow_up_mastery)} on{" "}
                {shortTest(a.outcome.follow_up_test)} ({a.outcome.mastery_change > 0 ? "+" : ""}
                {a.outcome.mastery_change.toFixed(1)})
              </p>
            ) : a.outcome_status === "pending" ? (
              <p className="mt-0.5 text-xs text-slate-500">Measured on the next paper that covers {a.topic}.</p>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-slate-500">{EFFECT_CAVEAT}</p>
    </>
  );
}

/** Everything about one student, one click from the roster: why the status, trend, latest paper,
 * weakest topics, nudges, logged actions and the illustrative study focus. */
export function StudentDrawer({
  row,
  scoped,
  versioned,
  onClose,
  onLog,
  refreshKey,
}: {
  row: RosterRow | null;
  /** A batch or test filter is on: the latest paper is the latest in that filter. */
  scoped: boolean;
  /** Test names with 2+ versions in scope (their version is shown). */
  versioned: Set<string>;
  onClose: () => void;
  onLog: (target: LogTarget) => void;
  /** Changes after an action is logged, so the actions list reloads. */
  refreshKey: number;
}) {
  const ref = row?.student_ref ?? "";
  const demo = row?.is_demo ?? false;
  const key = `${demo ? "d" : "r"}:${ref}`;
  const [historyNonce, setHistoryNonce] = useState(0);
  const [actionsNonce, setActionsNonce] = useState(0);
  const historyKey = `${key}#${historyNonce}`;
  const actionsKey = `${key}#${actionsNonce}#${refreshKey}`;
  const [history, setHistory] = useState<Load<HistoryEntry[]> | null>(null);
  const [actions, setActions] = useState<Load<InterventionRecord[]> | null>(null);
  const [whatsApp, setWhatsApp] = useState(false);
  const [allWeakFor, setAllWeakFor] = useState<string | null>(null);

  useEffect(() => {
    if (!ref) return;
    let cancelled = false;
    getStudentHistory(ref, demo)
      .then((data) => !cancelled && setHistory({ key: historyKey, data: Array.isArray(data) ? data : [] }))
      .catch((err) => !cancelled && setHistory({ key: historyKey, error: errorMessage(err) }));
    return () => {
      cancelled = true;
    };
  }, [ref, demo, historyKey]);

  useEffect(() => {
    if (!ref) return;
    let cancelled = false;
    getInterventions({ student_ref: ref })
      .then(
        (data) =>
          !cancelled &&
          setActions({ key: actionsKey, data: (Array.isArray(data) ? data : []).filter((a) => a.is_demo === demo) }),
      )
      .catch((err) => !cancelled && setActions({ key: actionsKey, error: errorMessage(err) }));
    return () => {
      cancelled = true;
    };
  }, [ref, demo, actionsKey]);

  const latest = row?.latest ?? null;
  const currentHistory = history?.key === historyKey ? history : null;
  const currentActions = actions?.key === actionsKey ? actions : null;
  const weakAll = (row?.topics ?? []).filter((t) => t.mastery < WEAK_MASTERY);
  const allWeak = allWeakFor === key;
  const weak = allWeak ? weakAll : weakAll.slice(0, WEAK_SHOWN);
  const nm = row?.negative_marking ?? null;
  const actionCount = currentActions && "data" in currentActions ? currentActions.data.length : row?.actions.count ?? 0;

  return (
    <Modal
      open={row !== null}
      onClose={onClose}
      variant="drawer"
      className="max-w-full sm:max-w-[480px]"
      eyebrow={row ? `${row.batch.name}${row.batch.faculty_lead ? ` · lead ${row.batch.faculty_lead}` : ""}` : undefined}
      title={row?.student_name ?? "Student"}
      description={
        row ? (
          <>
            <span className="font-mono text-xs">
              {row.student_ref}
              {row.is_demo ? <span className="ml-2 font-sans text-slate-500">synthetic demo record</span> : null}
            </span>
            {looksLikeFileName(row.student_name) ? (
              <span className="mt-0.5 block text-xs text-amber-800">
                Name taken from the uploaded file - fix it on the report.
              </span>
            ) : null}
          </>
        ) : undefined
      }
    >
      {row ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {latest ? <UrgencyBadge urgency={latest.urgency} reasons={latest.urgency_reasons} /> : null}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {latest ? (
                <Link href={`/report/${latest.submission_id}`} className={btnPrimary}>
                  Open report
                  <ChevronRight className="h-4 w-4" aria-hidden />
                </Link>
              ) : row.pending ? (
                <Link href={`/report/${row.pending.submission_id}`} className={btnPrimary}>
                  Open the sheet
                </Link>
              ) : null}
              {latest ? (
                <button type="button" className={btnSecondary} onClick={() => onLog({ row })}>
                  <PenLine className="h-4 w-4" aria-hidden />
                  Log action
                </button>
              ) : null}
              {latest ? (
                <Popover
                  label={<span className="sr-only">More</span>}
                  srLabel="More actions"
                  icon={<MoreHorizontal className="h-4 w-4" aria-hidden />}
                  buttonClassName={cn(btnSecondary, "px-2.5")}
                >
                  {(close) => (
                    <>
                      <a href={reportPdfUrl(latest.submission_id)} className={menuItem} onClick={close}>
                        <FileDown className="h-4 w-4 text-slate-500" aria-hidden />
                        Report PDF
                      </a>
                      <button
                        type="button"
                        className={menuItem}
                        onClick={() => {
                          close();
                          setWhatsApp(true);
                        }}
                      >
                        <MessageCircle className="h-4 w-4 text-slate-500" aria-hidden />
                        Send on WhatsApp (simulated)
                      </button>
                    </>
                  )}
                </Popover>
              ) : null}
            </div>
          </div>

          {row.pending ? (
            <Notice tone="warn">
              {latest ? "A newer sheet" : "A sheet"} (uploaded {fmtDay(row.pending.date)}) is{" "}
              {row.pending.status === "HUMAN_REVIEW_REQUIRED" ? "held for review" : row.pending.status === "FAILED" ? "failed" : "being marked"}
              .{" "}
              <Link href={`/report/${row.pending.submission_id}`} className={LINK}>
                Open it
              </Link>
            </Notice>
          ) : null}

          {latest ? (
            <Section title="Why this status">
              <ul className="list-disc space-y-1 pl-5 text-[13px] text-slate-700">
                {latest.urgency_reasons.slice(0, 3).map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              {latest.questions < SMALL_TEST_QUESTIONS ? (
                <p className="mt-1 text-xs text-amber-800">
                  Based on a small test ({latest.questions} questions) - read the status with care.
                </p>
              ) : null}
            </Section>
          ) : null}

          <Section title="Score trend">
            <ScoreTrend row={row} history={currentHistory} scoped={scoped} onRetry={() => setHistoryNonce((n) => n + 1)} />
          </Section>

          {latest ? (
            <Section
              title={scoped ? "Latest paper in this filter" : "Latest paper"}
              aside={
                <span className="text-xs tabular-nums text-slate-500">
                  {fmtMarks(latest.score)}/{fmtMarks(latest.total_marks)} · {fmtPct(latest.pct)}
                </span>
              }
            >
              <p className="mb-2 text-[13px] text-slate-600">
                {testLabel(latest.test_name, latest.test_version, versioned)} · uploaded {fmtDay(latest.date)} ·{" "}
                {latest.questions} questions · {latest.release_status === "RELEASED" ? "released" : "provisional (not released)"}
              </p>
              {row.subjects.length > 0 ? (
                <BarList
                  unit="%"
                  items={row.subjects.map((s) => ({
                    label: `${s.subject} ${fmtMarks(s.score)}/${fmtMarks(s.max_marks)}`,
                    value: s.pct,
                    max: 100,
                  }))}
                />
              ) : null}
              {nm ? (
                <div className="mt-3 space-y-2">
                  <p
                    className={cn(
                      "text-[13px] font-medium",
                      nm.verdict !== "ok"
                        ? "text-amber-800"
                        : nm.risky_topics.length
                          ? "text-slate-800"
                          : "text-lime-800",
                    )}
                  >
                    Exam technique: {nm.headline || VERDICT_TEXT[nm.verdict]}
                  </p>
                  <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Stat label="Attempted" value={`${nm.attempted}/${nm.items}`} />
                    <Stat label="Accuracy" value={nm.accuracy === null ? "—" : fmtPct(nm.accuracy * 100)} />
                    <Stat label="Wrong" value={nm.wrong} sub={`−${marksWord(nm.marks_lost)}`} />
                    <Stat label="Blank" value={nm.blank} sub={nm.verdict === "skipping" ? "too many skipped" : undefined} />
                  </dl>
                  <p className="text-[13px] text-slate-700">{nm.recommendation}</p>
                  <p className="text-xs text-slate-500">
                    Scheme {nm.scheme}, break-even accuracy {Math.round(nm.break_even * 100)}%
                    {nm.risky_topics.length
                      ? ` · risky guessing in ${plural(nm.risky_topics.length, "topic")}: ${nm.risky_topics.join(", ")}`
                      : ""}
                  </p>
                </div>
              ) : null}
            </Section>
          ) : null}

          {latest ? (
            <Section
              title="Weakest topics"
              aside={
                <span className="text-xs tabular-nums text-slate-500">
                  {weakAll.length > weak.length ? `${weak.length} of ${weakAll.length} ` : `${weakAll.length} `}
                  below {WEAK_MASTERY}%
                </span>
              }
            >
              {weak.length === 0 ? (
                <p className="text-sm text-slate-500">No topic below {WEAK_MASTERY}% on the latest paper.</p>
              ) : (
                <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
                  {weak.map((t) => (
                    <li key={t.topic} className="flex items-center gap-2 px-3 py-1.5 text-[13px]">
                      <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-sm", masteryFill(t.mastery))} />
                      <span
                        className="min-w-0 flex-1 truncate text-slate-800"
                        title={t.subject_level ? `${t.subject} - whole-subject score (the paper had no topic tags)` : t.subject}
                      >
                        {t.topic}
                        {t.subject_level ? <span className="ml-1 text-xs text-slate-500">(whole subject)</span> : null}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-slate-500">{t.n} Qs</span>
                      <span className="w-12 shrink-0 text-right font-medium tabular-nums text-slate-800">
                        {fmtMastery(t.mastery)}
                      </span>
                      <button
                        type="button"
                        onClick={() => onLog({ row, topic: t.topic })}
                        className="grid h-10 w-10 shrink-0 place-items-center rounded-md text-slate-500 transition-colors duration-150 hover:bg-slate-100 hover:text-brand-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
                        aria-label={`Log an action on ${t.topic}`}
                        title={`Log an action on ${t.topic}`}
                      >
                        <PenLine className="h-4 w-4" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {weakAll.length > WEAK_SHOWN ? (
                <button
                  type="button"
                  onClick={() => setAllWeakFor(allWeak ? null : key)}
                  className={cn(LINK, "mt-1 inline-flex min-h-10 items-center text-[13px]")}
                  aria-expanded={allWeak}
                >
                  {allWeak ? `Show the weakest ${WEAK_SHOWN}` : `Show all ${weakAll.length}`}
                </button>
              ) : null}
            </Section>
          ) : null}

          {latest && row.nudges.length > 0 ? (
            <Section title="Teaching nudges">
              <ul className="space-y-2">
                {row.nudges.slice(0, 3).map((n, i) => (
                  <li key={`${n.label}-${i}`} className="rounded-md border border-slate-200 px-3 py-2 text-[13px]">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className={cn("rounded-sm px-1 text-[11px] font-medium", PRIORITY_PILL[n.priority])}>
                        {n.priority}
                      </span>
                      <span className="font-medium text-slate-800">{n.label}</span>
                    </p>
                    <p className="mt-0.5 text-slate-600">{n.text}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                      {n.question_refs.slice(0, 4).map((q) => (
                        <Link key={q} href={`/report/${latest.submission_id}#q-${q}`} className={cn(LINK, "text-xs")}>
                          Q{q}
                        </Link>
                      ))}
                      {n.topic ? (
                        <button
                          type="button"
                          onClick={() => onLog({ row, topic: n.topic, nudge: n })}
                          className={cn(LINK, "ml-auto text-xs")}
                        >
                          Log as action
                        </button>
                      ) : null}
                    </p>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          <Section title={`Actions logged (${actionCount})`}>
            <ActionsLogged actions={currentActions} onRetry={() => setActionsNonce((n) => n + 1)} />
          </Section>

          {latest && row.focus.length > 0 ? (
            <section className="border-t border-slate-200 pt-4">
              <details className="group">
                <summary className="flex min-h-10 cursor-pointer list-none flex-wrap items-center gap-2 rounded-sm text-sm font-semibold text-brand-navy hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan [&::-webkit-details-marker]:hidden">
                  <ChevronRight
                    className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
                    aria-hidden
                  />
                  Study focus · top {row.focus.length}
                  <IllustrativePill />
                </summary>
                <p className="mt-1 text-xs text-slate-500">
                  Gains are projected on the full 720-mark NEET exam, not on this test.
                </p>
                <ol className="mt-2 space-y-1 text-[13px] text-slate-700">
                  {row.focus.map((f) => (
                    <li key={f.topic} className="flex items-center gap-2">
                      <span className="w-5 shrink-0 tabular-nums text-slate-500">#{f.rank}</span>
                      <span className="min-w-0 flex-1 truncate">{f.topic}</span>
                      {f.projected_gain_marks !== null ? (
                        <span className="shrink-0 text-xs tabular-nums text-slate-500">
                          up to +{fmtMarks(f.projected_gain_marks)} of 720 NEET marks
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </details>
            </section>
          ) : null}

          {latest ? (
            <WhatsAppDialog
              open={whatsApp}
              onClose={() => setWhatsApp(false)}
              submissionIds={[latest.submission_id]}
              studentName={row.student_name}
              testName={latest.test_name}
            />
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
