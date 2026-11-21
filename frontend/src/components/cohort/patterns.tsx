import Link from "next/link";
import type { ReactNode } from "react";
import { BLOOM_LABELS, BloomBadge } from "@/components/shared/bloom-badge";
import { RiskBadge } from "@/components/shared/risk-badge";
import { fmt, pct, THRESHOLD_NOTE } from "@/components/owner/format";
import type { BloomBucket, CohortPatterns, StudentRiskRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Card, CardHeader, TD, TH } from "./card";
import { clampPct } from "./format";

/** Accuracy as 0-100: the API reports fractions (0-1); values already in points pass through. */
function accPct(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return value <= 1 ? value * 100 : value;
}

const TABLE_WRAP = "mt-2 overflow-x-auto rounded-md border border-slate-200";
const THEAD = "border-b border-slate-200 bg-slate-50";

function SubHeading({ children, count }: { children: ReactNode; count?: ReactNode }) {
  return (
    <h3 className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold text-brand-navy">
      {children}
      {count ? <span className="text-xs font-normal tabular-nums text-slate-500">{count}</span> : null}
    </h3>
  );
}

function Notes({ notes, fallback }: { notes: string[]; fallback: string }) {
  const list = notes.length ? notes : [fallback];
  return (
    <ul className="mt-1 space-y-0.5 text-sm text-slate-600">
      {list.map((n, i) => (
        <li key={i}>{n}</li>
      ))}
    </ul>
  );
}

function StudentRows({
  rows,
  unit,
  unitLabel,
  empty,
}: {
  rows: StudentRiskRow[];
  unit: (r: StudentRiskRow) => string;
  unitLabel: string;
  empty: string;
}) {
  if (!rows.length) return <p className="mt-1 text-sm text-slate-600">{empty}</p>;
  // A student with several tests in this view is listed once per test: show which report each row is.
  const seen = new Map<string, number>();
  rows.forEach((r) => seen.set(r.student_name, (seen.get(r.student_name) ?? 0) + 1));
  return (
    <div className={TABLE_WRAP}>
      <table className="w-full min-w-[520px] border-collapse">
        <thead className={THEAD}>
          <tr>
            <th scope="col" className={TH}>
              Student
            </th>
            <th scope="col" className={TH}>
              Risk
            </th>
            <th scope="col" className={cn(TH, "text-right")}>
              {unitLabel}
            </th>
            <th scope="col" className={TH}>
              Detail
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.submission_id}>
              <th scope="row" className={cn(TD, "text-left font-normal whitespace-nowrap")}>
                <Link
                  href={`/report/${r.submission_id}`}
                  className="rounded-sm font-medium text-slate-800 hover:text-brand-cyan-600 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
                >
                  {r.student_name}
                </Link>
                {(seen.get(r.student_name) ?? 0) > 1 ? (
                  <span
                    className="ml-1 font-mono text-[11px] text-slate-500"
                    title="This student has more than one test in this view; filter by test to see one at a time"
                  >
                    #{r.submission_id}
                  </span>
                ) : null}
              </th>
              <td className={TD}>
                <RiskBadge risk={r.severity} size="sm" />
              </td>
              <td className={cn(TD, "text-right font-semibold whitespace-nowrap text-slate-800")}>{unit(r)}</td>
              <td className={cn(TD, "text-xs text-slate-600")}>{r.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const NOTE_TOPICS = {
  negative: /negative|mcq/i,
  fatigue: /fatigue|question/i,
  transfer: /transfer|recall|concept|application/i,
};

/** Notes that mention a section (e.g. "No negatively-marked MCQs ...") when that section is null. */
function notesFor(notes: string[], words: RegExp): string[] {
  return notes.filter((n) => words.test(n));
}

function BloomProfile({ buckets }: { buckets: BloomBucket[] }) {
  const rows = buckets.filter((b) => b.questions > 0);
  if (!rows.length) return <p className="mt-1 text-sm text-slate-600">No Bloom levels on these papers.</p>;
  return (
    <div className={TABLE_WRAP}>
      <table className="w-full min-w-[520px] border-collapse">
        <caption className="sr-only">Accuracy by Bloom level</caption>
        <thead className={THEAD}>
          <tr>
            <th scope="col" className={TH}>
              Level
            </th>
            <th scope="col" className={cn(TH, "w-2/5")}>
              Accuracy
            </th>
            <th scope="col" className={cn(TH, "text-right")}>
              Questions
            </th>
            <th scope="col" className={cn(TH, "text-right")}>
              Marks
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((b) => {
            const a = accPct(b.accuracy);
            return (
              <tr key={b.level}>
                <th scope="row" className={cn(TD, "text-left font-normal")}>
                  <BloomBadge level={b.level} size="sm" />
                </th>
                <td className={TD}>
                  <span className="flex items-center gap-2">
                    <span className="h-2 flex-1 bg-slate-100" aria-hidden>
                      <span className="block h-full bg-brand-navy" style={{ width: `${clampPct(a)}%` }} />
                    </span>
                    <span className="w-10 text-right">{pct(a)}</span>
                  </span>
                </td>
                <td className={cn(TD, "text-right")}>{b.questions}</td>
                <td className={cn(TD, "text-right whitespace-nowrap")}>
                  {fmt(b.marks)} / {fmt(b.max_marks)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * "Exam behaviour (class)" (FR-4.8 negative marking, FR-4.10 fatigue, FR-4.11 memorisation vs transfer,
 * FR-3.9 Bloom profile) from Cohort.patterns. Thresholds are defaults until the academic lead confirms them.
 */
export function ExamBehaviourCard({ patterns }: { patterns: CohortPatterns | null | undefined }) {
  const p = patterns ?? { negative_marking: null, fatigue: null, transfer: null, bloom_profile: [], notes: [] };
  const notes = p.notes ?? [];
  const nm = p.negative_marking;
  const fat = p.fatigue;
  const tr = p.transfer;
  const nothing = !nm && !fat && !tr && !(p.bloom_profile ?? []).length;
  const otherNotes = notes.filter((n) => !Object.values(NOTE_TOPICS).some((re) => re.test(n)));

  return (
    <Card aria-labelledby="cohort-behaviour-title">
      <CardHeader
        id="cohort-behaviour-title"
        title="Exam behaviour (class)"
        subtitle={
          <>
            Negative marking, fatigue and memorisation vs transfer across the completed students. Thresholds:{" "}
            <span className="text-slate-700">{THRESHOLD_NOTE}</span>.
          </>
        }
      />

      {nothing ? (
        <div className="mt-3">
          <Notes notes={notes} fallback="No exam-behaviour patterns for this selection yet." />
        </div>
      ) : (
        <div className="mt-4 space-y-6">
          {/* Negative marking (FR-4.8) */}
          <section aria-label="Negative marking">
            <SubHeading
              count={nm ? `${nm.students_profiled} students profiled · ${fmt(nm.marks_lost_total)} marks lost to wrong MCQs` : undefined}
            >
              Negative marking
            </SubHeading>
            {nm ? (
              <>
                {nm.topics.length ? (
                  <div className={TABLE_WRAP}>
                    <table className="w-full min-w-[640px] border-collapse">
                      <caption className="sr-only">Negative-marking risk per topic</caption>
                      <thead className={THEAD}>
                        <tr>
                          <th scope="col" className={TH}>Topic</th>
                          <th scope="col" className={cn(TH, "text-right")}>Over-attempting / profiled</th>
                          <th scope="col" className={cn(TH, "text-right")}>Mean accuracy</th>
                          <th scope="col" className={cn(TH, "text-right")}>Marks lost</th>
                          <th scope="col" className={TH}>Skip threshold</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {nm.topics.map((t) => (
                          <tr key={t.topic}>
                            <th scope="row" className={cn(TD, "text-left font-medium text-slate-800")}>{t.topic}</th>
                            <td className={cn(TD, "text-right")}>
                              {t.students_over_attempting} / {t.students_profiled}
                            </td>
                            <td className={cn(TD, "text-right")}>{pct(accPct(t.mean_accuracy))}</td>
                            <td className={cn(TD, "text-right font-semibold", t.marks_lost > 0 && "text-red-700")}>
                              {t.marks_lost > 0 ? `−${fmt(t.marks_lost)}` : "0"}
                            </td>
                            <td className={TD} title={THRESHOLD_NOTE}>
                              attempt if &ge; {Math.round(t.skip_threshold * 100)}% sure
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
                <h4 className="mt-3 text-[13px] font-medium text-slate-600">High-risk students</h4>
                <StudentRows
                  rows={nm.students}
                  unit={(r) => `−${fmt(r.value)}`}
                  unitLabel="Marks lost"
                  empty="No student is over-attempting at high risk."
                />
              </>
            ) : (
              <Notes notes={notesFor(notes, NOTE_TOPICS.negative)} fallback="No negatively-marked MCQs in these tests." />
            )}
          </section>

          {/* Fatigue (FR-4.10) */}
          <section aria-label="Fatigue" className="border-t border-slate-200 pt-4">
            <SubHeading count={fat ? `${fat.flagged_count} flagged of ${fat.students_profiled} profiled` : undefined}>
              End-of-paper fatigue
            </SubHeading>
            {fat ? (
              <>
                <p className="mt-1 text-sm text-slate-700">
                  Class accuracy <span className="font-semibold tabular-nums">{pct(accPct(fat.early_accuracy))}</span> in
                  the first two thirds vs <span className="font-semibold tabular-nums">{pct(accPct(fat.late_accuracy))}</span>{" "}
                  in the final third.
                </p>
                <StudentRows
                  rows={fat.students}
                  unit={(r) => `${fmt(r.value)} pts`}
                  unitLabel="Accuracy drop"
                  empty="No student is flagged for fatigue."
                />
              </>
            ) : (
              <Notes notes={notesFor(notes, NOTE_TOPICS.fatigue)} fallback="Fatigue needs at least 6 questions per test." />
            )}
          </section>

          {/* Transfer (FR-4.11) */}
          <section aria-label="Memorisation vs transfer" className="border-t border-slate-200 pt-4">
            <SubHeading count={tr ? `${tr.students_profiled} students profiled` : undefined}>
              Memorisation vs transfer
            </SubHeading>
            {tr ? (
              <>
                {tr.concepts.length ? (
                  <div className={TABLE_WRAP}>
                    <table className="w-full min-w-[560px] border-collapse">
                      <caption className="sr-only">Recall vs application per concept</caption>
                      <thead className={THEAD}>
                        <tr>
                          <th scope="col" className={TH}>Concept</th>
                          <th scope="col" className={cn(TH, "text-right")}>Students</th>
                          <th scope="col" className={cn(TH, "text-right")}>Memorising</th>
                          <th scope="col" className={cn(TH, "text-right")}>Transferable</th>
                          <th scope="col" className={cn(TH, "text-right")}>Foundational gap</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {tr.concepts.map((c) => (
                          <tr key={c.concept}>
                            <th scope="row" className={cn(TD, "text-left font-medium text-slate-800")}>{c.concept}</th>
                            <td className={cn(TD, "text-right")}>{c.students}</td>
                            <td className={cn(TD, "text-right", c.memorisation > 0 && "font-semibold text-amber-700")}>
                              {c.memorisation}
                            </td>
                            <td className={cn(TD, "text-right")}>{c.transferable}</td>
                            <td className={cn(TD, "text-right", c.foundational_gap > 0 && "font-semibold text-red-700")}>
                              {c.foundational_gap}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
                <p className="mt-2 text-xs text-slate-500">
                  Memorising = recall questions ({BLOOM_LABELS.K1} / {BLOOM_LABELS.K2}) right but application questions (K3+)
                  on the same concept wrong.
                </p>
                <h4 className="mt-3 text-[13px] font-medium text-slate-600">Memorising in 2+ concepts</h4>
                <StudentRows
                  rows={tr.students}
                  unit={(r) => fmt(r.value, 0)}
                  unitLabel="Concepts"
                  empty="No student is memorising in two or more concepts."
                />
              </>
            ) : (
              <Notes
                notes={notesFor(notes, NOTE_TOPICS.transfer)}
                fallback="No concept is tested at both recall and application levels."
              />
            )}
          </section>

          {/* Bloom profile (FR-3.9) */}
          <section aria-label="Bloom profile" className="border-t border-slate-200 pt-4">
            <SubHeading>Accuracy by Bloom level</SubHeading>
            <BloomProfile buckets={p.bloom_profile ?? []} />
          </section>

          {otherNotes.length ? (
            <section aria-label="Other notes" className="border-t border-slate-200 pt-4">
              <SubHeading>Notes</SubHeading>
              <Notes notes={otherNotes} fallback="" />
            </section>
          ) : null}
        </div>
      )}
    </Card>
  );
}
