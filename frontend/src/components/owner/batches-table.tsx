"use client";

import Link from "next/link";
import { Fragment, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Loader2, Pencil, X } from "lucide-react";
import { errorMessage } from "@/lib/api";
import { inr, pct1 } from "@/lib/format";
import type { BatchSummary, OwnerSittingRef, SamePaperComparison } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmt, fmtDate, pct } from "./format";
import { UrgencyBar } from "./kpis";
import { ageText, BatchDataTag, ChangeText, dayText, linkCls, SMALL_GROUP, SmallGroupTag } from "./owner-ui";
import { btnQuiet, EmptyNote, focusRing, Panel, theadCls, thCls } from "./states";

const CHANGE_TOOLTIP =
  "Students of the latest whole-class test against the test each sat before, when the papers are comparable (the same test, or full papers over the same subjects). Not the change in the batch average.";
/** The cohort view a batch row describes: every student's latest test in the batch. */
const cohortHref = (s: BatchSummary) => `/cohort?view=all&batch_id=${s.batch.id}`;
const SMALL = SMALL_GROUP;

function FacultyLeadCell({
  summary,
  onSave,
}: {
  summary: BatchSummary;
  onSave: (batchId: number, lead: string | null) => Promise<void>;
}) {
  const lead = summary.batch.faculty_lead;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = `lead-${summary.batch.id}`;

  function start() {
    setValue(lead ?? "");
    setError(null);
    setEditing(true);
  }

  async function save() {
    const next = value.replace(/\s+/g, " ").trim();
    setSaving(true);
    setError(null);
    setEditing(false); // optimistic: the parent shows the new name right away
    try {
      await onSave(summary.batch.id, next ? next : null);
    } catch (err) {
      setError(`Not saved (restored): ${errorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setEditing(false);
    }
  }

  if (editing) {
    return (
      <div className="flex min-w-48 items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <label htmlFor={inputId} className="sr-only">
          Faculty lead for {summary.batch.name}
        </label>
        <input
          id={inputId}
          autoFocus
          maxLength={120}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKey}
          placeholder="e.g. Dr. A. Rao"
          className={cn("h-8 w-full min-w-0 rounded-md border border-slate-300 px-2 text-sm", focusRing)}
        />
        <button
          type="button"
          onClick={() => void save()}
          className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-md text-slate-700 hover:bg-slate-100", focusRing)}
          aria-label={`Save faculty lead for ${summary.batch.name}`}
        >
          <Check className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-md text-slate-500 hover:bg-slate-100", focusRing)}
          aria-label="Cancel"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <div onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-1">
        <span className={cn("min-w-0", lead ? "text-slate-800" : "italic text-slate-500")}>{lead || "Not set"}</span>
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-500" aria-label="Saving" /> : null}
        <button
          type="button"
          onClick={start}
          className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-brand-navy", focusRing)}
          aria-label={`Edit faculty lead for ${summary.batch.name}`}
          title="Edit faculty lead"
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-1 max-w-56 text-xs text-rose-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}


function graded(s: BatchSummary): number {
  return s.students_graded ?? s.students;
}

/** Same-student change with its n, or why there is none. */
function BatchChange({ s, compact = false }: { s: BatchSummary; compact?: boolean }) {
  const p = s.progress;
  const none = <span className="text-xs text-slate-500">{compact ? "no repeat test" : "— no repeat test"}</span>;
  if (p) {
    if ((p.students === 0 || p.mean_change === null) && p.not_comparable) {
      return (
        <span className="text-xs text-slate-500" title={CHANGE_TOOLTIP}>
          {p.not_comparable} re-tested · not comparable
        </span>
      );
    }
    if (p.students === 0 || p.mean_change === null) return none;
    if (p.students < SMALL) {
      return (
        <span className="inline-flex flex-wrap items-center gap-1 text-xs text-slate-500" title={CHANGE_TOOLTIP}>
          <SmallGroupTag n={p.students} /> {p.students} of {graded(s)} re-tested
        </span>
      );
    }
  } else if (s.trend_delta_pct === null) {
    return none;
  }
  return (
    <span title={CHANGE_TOOLTIP}>
      <ChangeText value={p ? p.mean_change : s.trend_delta_pct} suffix="" className="font-medium" />
      {p ? (
        <span className={cn("text-xs text-slate-500", compact && "block")}>
          {compact ? "" : " · "}
          {p.students} of {graded(s)}
        </span>
      ) : null}
      <span className="sr-only"> ({CHANGE_TOOLTIP})</span>
    </span>
  );
}

function Awaiting({ s }: { s: BatchSummary }) {
  if (s.awaiting_release === undefined) {
    return (
      <span className="tabular-nums" title={`${s.released} released of ${s.completed} graded sheets`}>
        {s.provisional}
      </span>
    );
  }
  const old = s.oldest_awaiting_days ?? null;
  return (
    <span className="whitespace-nowrap tabular-nums" title="Students whose latest report is not released yet">
      {s.awaiting_release}
      {s.awaiting_release > 0 && old !== null ? (
        <span className={cn("ml-1 text-xs", old >= 2 ? "text-amber-800" : "text-slate-500")}>(oldest {ageText(old, true)})</span>
      ) : null}
    </span>
  );
}

function Weakest({ s }: { s: BatchSummary }) {
  if (!s.top_gap_topic) return <span className="text-slate-500">—</span>;
  return (
    <span title={s.top_gap_students ? `${s.top_gap_students} students, latest test each` : undefined}>
      {s.top_gap_topic}
      {s.top_gap_mastery !== null && s.top_gap_mastery !== undefined ? (
        <span className="ml-1 tabular-nums text-slate-500">{pct(s.top_gap_mastery)}</span>
      ) : null}
    </span>
  );
}

function Avg({ s, start = false }: { s: BatchSummary; start?: boolean }) {
  const n = graded(s);
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", start ? "justify-start" : "justify-end")}>
      <span
        className="font-medium tabular-nums text-slate-900"
        title={`${pct1(s.average_pct)} · ${n} student${n === 1 ? "" : "s"}, latest test each`}
      >
        {pct1(s.average_pct)}
      </span>
      {n > 0 && n < SMALL ? <SmallGroupTag n={n} /> : null}
    </span>
  );
}

/** "NEET Mixed - Mock 08 (11 Nov)" for the sittings one side of the progress pairs comes from. */
function sittingsText(list: OwnerSittingRef[] | undefined): string | null {
  if (!list || list.length === 0) return null;
  return list
    .map((r) => `${r.test_name} (${dayText(r.date)}${list.length > 1 ? `, ${r.students}` : ""})`)
    .join(" + ");
}

function PreviousSitting({ s }: { s: BatchSummary }) {
  const prev = s.previous_test;
  if (!prev) return <p className="text-slate-800">none yet</p>;
  const shared = prev.shared_students;
  return (
    <>
      <p className="text-slate-800">
        {prev.test_name} · {prev.students} students · {dayText(prev.date)} ·{" "}
        <span className="tabular-nums">{pct1(prev.average_pct)}</span>
      </p>
      {shared === 0 ? (
        <p className="mt-0.5 text-xs text-amber-800">Different students from the main test, so not like for like.</p>
      ) : typeof shared === "number" && shared < prev.students ? (
        <p className="mt-0.5 text-xs text-slate-500">
          {shared} of its {prev.students} students also sat the main test.
        </p>
      ) : null}
    </>
  );
}

function Details({ s, id }: { s: BatchSummary; id: string }) {
  const main = s.latest_test;
  const exam = s.batch.exam_date ? fmtDate(s.batch.exam_date) : "—";
  const p = s.progress;
  const from = sittingsText(p?.before_sittings);
  const to = sittingsText(p?.after_sittings);
  return (
    <div id={id} className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
      <div className="min-w-0">
        <p className="text-xs text-slate-500">{s.latest_test_main === false ? "Newest test (no whole-class sitting yet)" : "Main test"}</p>
        {main ? (
          <p className="text-slate-800">
            {main.name} · {s.latest_test_students ?? "—"} of {s.students} students · {dayText(s.latest_test_date)} ·{" "}
            <span className="tabular-nums">{pct1(s.latest_test_avg_pct)}</span>
          </p>
        ) : (
          <p className="text-slate-500">—</p>
        )}
        {s.newer_small_sitting ? (
          <p className="mt-0.5 text-xs text-slate-500">
            Newer: {s.newer_small_sitting.test_name}, {s.newer_small_sitting.students} student
            {s.newer_small_sitting.students === 1 ? "" : "s"}, {dayText(s.newer_small_sitting.date)}
          </p>
        ) : null}
      </div>
      <div className="min-w-0">
        <p className="text-xs text-slate-500">Previous whole-class sitting</p>
        <PreviousSitting s={s} />
      </div>
      <div className="min-w-0">
        <p className="text-xs text-slate-500">Re-tested students (each against the test they sat before)</p>
        {p && p.students > 0 ? (
          <>
            <p className="text-slate-800">
              {p.students} of {graded(s)} · <span className="tabular-nums">{pct1(p.mean_before)}</span> &rarr;{" "}
              <span className="tabular-nums">{pct1(p.mean_after)}</span> (<ChangeText value={p.mean_change} suffix=" pts" />) ·{" "}
              {p.improved} up 5+ · {p.declined} down 5+ · {p.steady} steady
            </p>
            {from || to ? (
              <p className="mt-0.5 text-xs text-slate-500">
                {from ? `From ${from}` : ""}
                {from && to ? " to " : ""}
                {to ?? ""}.
              </p>
            ) : null}
            {p.not_comparable ? (
              <p className="mt-0.5 text-xs text-slate-500">{p.not_comparable} more re-tested on a paper that is not comparable.</p>
            ) : null}
          </>
        ) : p && p.not_comparable ? (
          <p className="text-slate-500">
            {p.not_comparable} of {graded(s)} re-tested, on a paper that is not comparable with their previous one (a
            different test, not full papers over the same subjects), so no change is shown.
          </p>
        ) : (
          <p className="text-slate-500">nobody has sat two whole-class tests yet</p>
        )}
      </div>
      <div className="min-w-0">
        <p className="text-xs text-slate-500">Sheets</p>
        <p className="tabular-nums text-slate-800">
          {s.completed} graded · {s.released} released · {s.provisional} provisional
          {s.review_backlog ? ` · ${s.review_backlog} held` : ""}
          {s.failed ? ` · ${s.failed} failed` : ""}
        </p>
      </div>
      <div className="min-w-0">
        <p className="text-xs text-slate-500">At risk with no action since their latest test</p>
        <p className={cn("tabular-nums", (s.at_risk_unactioned ?? 0) > 0 ? "font-medium text-rose-700" : "text-slate-800")}>
          {s.at_risk_unactioned ?? "—"} of {s.urgency_counts.at_risk}
        </p>
      </div>
      <div className="min-w-0">
        <p className="text-xs text-slate-500">AI grading spend</p>
        <p className="tabular-nums text-slate-800">{inr(s.cost_inr)}</p>
      </div>
      <div className="min-w-0">
        <p className="text-xs text-slate-500">Exam date</p>
        <p className="text-slate-800">
          {exam}
          {s.batch.exam_date_assumed ? <span className="text-slate-500"> (default, not set for this batch)</span> : null}
        </p>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 sm:col-span-2 lg:col-span-3">
        <Link href={cohortHref(s)} className={cn(linkCls, "inline-flex min-h-10 items-center sm:min-h-0")}>
          Open cohort
        </Link>
        <Link
          href={`/students?batch_id=${s.batch.id}&urgency=at_risk`}
          className={cn(linkCls, "inline-flex min-h-10 items-center sm:min-h-0")}
        >
          At-risk students
        </Link>
      </div>
    </div>
  );
}

function NoGraded() {
  return (
    <span className="text-sm text-slate-500">
      — No graded sheets yet ·{" "}
      <Link href="/" className={linkCls}>
        Intake
      </Link>
    </span>
  );
}

function SamePaperLine({ papers }: { papers: SamePaperComparison[] }) {
  if (!papers.length) return null;
  return (
    <div className="space-y-1 text-xs text-slate-600">
      {papers.map((p) => (
        <p key={p.rubric_id}>
          <span className="font-medium text-slate-700">Same paper, like for like:</span> {p.test_name} &rarr;{" "}
          {p.rows.map((r, i) => (
            <span key={r.batch_id}>
              {i > 0 ? " · " : ""}
              {r.batch_name} <span className="font-medium tabular-nums text-slate-900" title={pct1(r.avg_pct)}>{pct1(r.avg_pct)}</span> (
              {r.students} student{r.students === 1 ? "" : "s"}, {dayText(r.date)}
              {r.students < SMALL ? ", small group" : ""})
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}

/**
 * Batches: each student counted once, in the batch of their latest test. Desktop: a table with
 * a details row per batch; below md: one card per batch.
 */
export function BatchesTable({
  batches,
  samePaper = [],
  onSaveLead,
}: {
  batches: BatchSummary[];
  samePaper?: SamePaperComparison[];
  onSaveLead: (batchId: number, lead: string | null) => Promise<void>;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const td = "px-3 py-2.5 align-top text-sm text-slate-700";
  const toggle = (id: number) => setOpen((v) => (v === id ? null : id));

  return (
    <Panel
      id="owner-batches-title"
      title="Batches"
      subtitle="Latest test per student. Select a batch to open its cohort dashboard."
    >
      {batches.length === 0 ? (
        <EmptyNote>No batches yet.</EmptyNote>
      ) : (
        <>
          <div className="relative -mx-4 -mt-4 hidden overflow-x-auto sm:-mx-5 md:block">
            <table className="w-full border-collapse">
              <caption className="sr-only">Batches: graded students, average, change, urgency, release backlog, weakest topic</caption>
              <thead className={theadCls}>
                <tr>
                  <th scope="col" className={cn(thCls, "pl-4 sm:pl-5")}>Batch</th>
                  <th scope="col" className={cn(thCls, "text-right")} title="Students with a graded sheet / all students">Graded</th>
                  <th scope="col" className={cn(thCls, "text-right")}>Avg %</th>
                  <th scope="col" className={thCls} title={CHANGE_TOOLTIP}>Re-tested change</th>
                  <th scope="col" className={thCls}>Urgency</th>
                  <th scope="col" className={thCls} title="Students whose latest report is not released">Awaiting release</th>
                  <th scope="col" className={thCls}>Weakest topic</th>
                  <th scope="col" className={cn(thCls, "pr-4 sm:pr-5")}><span className="sr-only">Details</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {batches.map((s) => {
                  const href = cohortHref(s);
                  const detailId = `batch-details-${s.batch.id}`;
                  const expanded = open === s.batch.id;
                  const none = graded(s) === 0;
                  return (
                    <Fragment key={s.batch.id}>
                      <tr className={cn(expanded && "bg-slate-50")}>
                        <th scope="row" className={cn(td, "pl-4 text-left font-normal sm:pl-5")}>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Link href={href} className={linkCls}>
                              {s.batch.name}
                            </Link>
                            <BatchDataTag summary={s} />
                          </div>
                          <div className="mt-0.5 text-xs text-slate-600">
                            <FacultyLeadCell summary={s} onSave={onSaveLead} />
                          </div>
                        </th>
                        {none ? (
                          <td className={td} colSpan={6}>
                            <NoGraded />
                          </td>
                        ) : (
                          <>
                            <td className={cn(td, "text-right tabular-nums")}>
                              {graded(s)}
                              <span className="text-slate-500"> / {s.students}</span>
                            </td>
                            <td className={cn(td, "text-right")}>
                              <Avg s={s} />
                            </td>
                            <td className={td}>
                              <BatchChange s={s} />
                            </td>
                            <td className={cn(td, "min-w-36")}>
                              <UrgencyBar counts={s.urgency_counts} className="mt-1.5 h-1.5" />
                              <p className="mt-1 text-xs tabular-nums text-slate-600">
                                {s.urgency_counts.at_risk} at risk · {s.urgency_counts.needs_attention} attention
                              </p>
                            </td>
                            <td className={td}>
                              <Awaiting s={s} />
                            </td>
                            <td className={td}>
                              <Weakest s={s} />
                            </td>
                          </>
                        )}
                        <td className={cn(td, "pr-4 text-right sm:pr-5")}>
                          <button
                            type="button"
                            aria-expanded={expanded}
                            aria-controls={detailId}
                            onClick={() => toggle(s.batch.id)}
                            className={cn(btnQuiet, "px-2")}
                          >
                            Details
                            <ChevronDown className={cn("h-4 w-4 transition-transform motion-reduce:transition-none", expanded && "rotate-180")} aria-hidden />
                          </button>
                        </td>
                      </tr>
                      <tr className="bg-slate-50" hidden={!expanded}>
                        <td colSpan={8} className="px-4 pb-4 pt-1 sm:px-5">
                          {/* w-0 min-w-full: the details take the table's width but never widen its columns. */}
                          <div className="w-0 min-w-full">
                            <Details s={s} id={detailId} />
                          </div>
                        </td>
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          <ul className="space-y-3 md:hidden">
            {batches.map((s) => {
              const detailId = `batch-card-details-${s.batch.id}`;
              const expanded = open === s.batch.id;
              const none = graded(s) === 0;
              return (
                <li key={s.batch.id} className="rounded-md border border-slate-200 px-3 py-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Link href={cohortHref(s)} className={cn(linkCls, "text-[15px]")}>
                      {s.batch.name}
                    </Link>
                    <BatchDataTag summary={s} />
                  </div>
                  <div className="text-xs text-slate-600">
                    <FacultyLeadCell summary={s} onSave={onSaveLead} />
                  </div>
                  {none ? (
                    <p className="mt-2">
                      <NoGraded />
                    </p>
                  ) : (
                    <>
                      <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
                        <div>
                          <dt className="text-xs text-slate-500">Avg</dt>
                          <dd>
                            <Avg s={s} start />
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs text-slate-500">Re-tested</dt>
                          <dd>
                            <BatchChange s={s} compact />
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs text-slate-500">At risk</dt>
                          <dd className="tabular-nums">
                            <span className={cn("font-medium", s.urgency_counts.at_risk ? "text-rose-700" : "text-slate-900")}>
                              {s.urgency_counts.at_risk}
                            </span>
                            <span className="text-xs text-slate-500"> of {graded(s)}</span>
                          </dd>
                        </div>
                      </dl>
                      <UrgencyBar counts={s.urgency_counts} className="mt-2 h-1.5" />
                      <p className="mt-2 text-xs text-slate-600">
                        Awaiting release <Awaiting s={s} /> · Weakest: <Weakest s={s} />
                      </p>
                    </>
                  )}
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <Link href={cohortHref(s)} className={cn(btnQuiet, "h-10")}>
                      Open cohort
                    </Link>
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-controls={detailId}
                      onClick={() => toggle(s.batch.id)}
                      className={cn(btnQuiet, "h-10")}
                    >
                      Details
                      <ChevronDown className={cn("h-4 w-4 transition-transform motion-reduce:transition-none", expanded && "rotate-180")} aria-hidden />
                    </button>
                  </div>
                  <div className="mt-3 border-t border-slate-200 pt-3" hidden={!expanded}>
                    <Details s={s} id={detailId} />
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <SamePaperLine papers={samePaper} />
      <p className="text-xs text-slate-500">
        Avg = each student&apos;s latest test as % of max marks (net of negative marking). Re-tested change = the latest
        whole-class test against the test each student sat before, only on comparable papers (the same test, or full
        papers over the same subjects). {fmt(SMALL, 0)}+ students make a whole-class test.
      </p>
    </Panel>
  );
}
