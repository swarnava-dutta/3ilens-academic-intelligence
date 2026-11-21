import Link from "next/link";
import type { ReactNode } from "react";
import { BatteryLow, Brain, GraduationCap, Info, MinusCircle, Repeat, type LucideIcon } from "lucide-react";
import { BLOOM_LABELS, BloomBadge } from "@/components/shared/bloom-badge";
import { RiskBadge } from "@/components/shared/risk-badge";
import { fmt, pct, THRESHOLD_NOTE } from "@/components/owner/format";
import type { BloomBucket, CohortPatterns, StudentRiskRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Card, CardHeader } from "./card";
import { clampPct } from "./format";

/** Accuracy as 0-100: the API reports fractions (0-1); values already in points pass through. */
function accPct(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return value <= 1 ? value * 100 : value;
}

function SubHeading({ icon: Icon, children, count }: { icon: LucideIcon; children: ReactNode; count?: ReactNode }) {
  return (
    <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-brand-navy">
      <Icon className="h-4 w-4 text-brand-cyan-600" aria-hidden />
      {children}
      {count ? <span className="text-xs font-normal text-slate-600">{count}</span> : null}
    </h3>
  );
}

function Notes({ notes, fallback }: { notes: string[]; fallback: string }) {
  const list = notes.length ? notes : [fallback];
  return (
    <ul className="mt-2 space-y-1">
      {list.map((n, i) => (
        <li key={i} className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden />
          {n}
        </li>
      ))}
    </ul>
  );
}

function StudentRows({ rows, unit, empty }: { rows: StudentRiskRow[]; unit: (r: StudentRiskRow) => string; empty: string }) {
  if (!rows.length) return <p className="mt-2 text-sm text-slate-600">{empty}</p>;
  return (
    <ul className="mt-2 divide-y divide-slate-100 rounded-xl ring-1 ring-slate-200">
      {rows.map((r) => (
        <li key={r.submission_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
          <Link
            href={`/report/${r.submission_id}`}
            className="font-medium text-brand-navy hover:underline focus-visible:outline-2 focus-visible:outline-brand-cyan"
          >
            {r.student_name}
          </Link>
          <RiskBadge risk={r.severity} size="sm" />
          <span className="font-semibold tabular-nums text-slate-800">{unit(r)}</span>
          <span className="min-w-0 flex-1 basis-48 text-xs text-slate-600">{r.detail}</span>
        </li>
      ))}
    </ul>
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
  if (!rows.length) return <p className="mt-2 text-sm text-slate-600">No Bloom levels on these papers.</p>;
  return (
    <ul className="mt-2 space-y-2">
      {rows.map((b) => {
        const a = accPct(b.accuracy);
        return (
          <li key={b.level} className="grid grid-cols-[7.5rem_1fr] items-center gap-x-3 gap-y-1 text-sm sm:grid-cols-[7.5rem_1fr_auto]">
            <BloomBadge level={b.level} size="sm" />
            <span className="h-2.5 rounded-full bg-slate-100" aria-hidden>
              <span className="block h-full rounded-full bg-indigo-500" style={{ width: `${clampPct(a)}%` }} />
            </span>
            <span className="col-span-2 text-xs tabular-nums text-slate-700 sm:col-span-1 sm:whitespace-nowrap sm:text-right">
              {pct(a)} accuracy · {b.questions} q · {fmt(b.marks)} / {fmt(b.max_marks)} marks
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * "Exam behaviour (class)" (FR-4.8 negative marking, FR-4.10 fatigue, FR-4.11 memorisation vs transfer,
 * FR-3.9 Bloom profile) from Cohort.patterns. Thresholds are defaults pending the academic lead.
 */
export function ExamBehaviourCard({ patterns }: { patterns: CohortPatterns | null | undefined }) {
  const p = patterns ?? { negative_marking: null, fatigue: null, transfer: null, bloom_profile: [], notes: [] };
  const notes = p.notes ?? [];
  const nm = p.negative_marking;
  const fat = p.fatigue;
  const tr = p.transfer;
  const nothing = !nm && !fat && !tr && !(p.bloom_profile ?? []).length;
  const otherNotes = notes.filter((n) => !Object.values(NOTE_TOPICS).some((re) => re.test(n)));
  const th = "px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-600 whitespace-nowrap";
  const td = "px-3 py-2 text-sm text-slate-700 tabular-nums";

  return (
    <Card aria-labelledby="cohort-behaviour-title">
      <CardHeader
        id="cohort-behaviour-title"
        icon={Brain}
        title="Exam behaviour (class)"
        subtitle={
          <>
            Negative marking, fatigue and memorisation vs transfer across the completed students. Thresholds:{" "}
            <span className="font-medium text-slate-700">{THRESHOLD_NOTE}</span>.
          </>
        }
      />

      {nothing ? (
        <Notes notes={notes} fallback="No exam-behaviour patterns for this selection yet." />
      ) : (
        <div className="mt-5 space-y-7">
          {/* Negative marking (FR-4.8) */}
          <section aria-label="Negative marking">
            <SubHeading
              icon={MinusCircle}
              count={nm ? `${nm.students_profiled} students profiled · ${fmt(nm.marks_lost_total)} marks lost to wrong MCQs` : undefined}
            >
              Negative marking
            </SubHeading>
            {nm ? (
              <>
                {nm.topics.length ? (
                  <div className="relative mt-2 overflow-x-auto rounded-xl ring-1 ring-slate-200">
                    <table className="w-full min-w-[640px] border-collapse">
                      <caption className="sr-only">Negative-marking risk per topic</caption>
                      <thead className="bg-slate-50">
                        <tr>
                          <th scope="col" className={th}>Topic</th>
                          <th scope="col" className={cn(th, "text-right")}>Over-attempting / profiled</th>
                          <th scope="col" className={cn(th, "text-right")}>Mean accuracy</th>
                          <th scope="col" className={cn(th, "text-right")}>Marks lost</th>
                          <th scope="col" className={th}>Recommended skip threshold</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {nm.topics.map((t) => (
                          <tr key={t.topic}>
                            <th scope="row" className={cn(td, "text-left font-medium text-slate-800")}>{t.topic}</th>
                            <td className={cn(td, "text-right")}>
                              {t.students_over_attempting} / {t.students_profiled}
                            </td>
                            <td className={cn(td, "text-right")}>{pct(accPct(t.mean_accuracy))}</td>
                            <td className={cn(td, "text-right font-semibold text-rose-700")}>
                              {t.marks_lost > 0 ? `−${fmt(t.marks_lost)}` : "0"}
                            </td>
                            <td className={td} title={THRESHOLD_NOTE}>
                              attempt if &ge; {Math.round(t.skip_threshold * 100)}% sure
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
                <h4 className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-600">High-risk students</h4>
                <StudentRows
                  rows={nm.students}
                  unit={(r) => `−${fmt(r.value)} marks`}
                  empty="No student is over-attempting at high risk."
                />
              </>
            ) : (
              <Notes notes={notesFor(notes, NOTE_TOPICS.negative)} fallback="No negatively-marked MCQs in these tests." />
            )}
          </section>

          {/* Fatigue (FR-4.10) */}
          <section aria-label="Fatigue">
            <SubHeading
              icon={BatteryLow}
              count={fat ? `${fat.flagged_count} flagged of ${fat.students_profiled} profiled` : undefined}
            >
              End-of-paper fatigue
            </SubHeading>
            {fat ? (
              <>
                <p className="mt-2 text-sm text-slate-700">
                  Class accuracy: <span className="font-semibold tabular-nums">{pct(accPct(fat.early_accuracy))}</span> in
                  the first two thirds vs <span className="font-semibold tabular-nums">{pct(accPct(fat.late_accuracy))}</span>{" "}
                  in the final third.
                </p>
                <StudentRows
                  rows={fat.students}
                  unit={(r) => `${fmt(r.value)} pts drop`}
                  empty="No student is flagged for fatigue."
                />
              </>
            ) : (
              <Notes notes={notesFor(notes, NOTE_TOPICS.fatigue)} fallback="Fatigue needs at least 6 questions per test." />
            )}
          </section>

          {/* Transfer (FR-4.11) */}
          <section aria-label="Memorisation vs transfer">
            <SubHeading icon={Repeat} count={tr ? `${tr.students_profiled} students profiled` : undefined}>
              Memorisation vs transfer
            </SubHeading>
            {tr ? (
              <>
                {tr.concepts.length ? (
                  <div className="relative mt-2 overflow-x-auto rounded-xl ring-1 ring-slate-200">
                    <table className="w-full min-w-[560px] border-collapse">
                      <caption className="sr-only">Recall vs application per concept</caption>
                      <thead className="bg-slate-50">
                        <tr>
                          <th scope="col" className={th}>Concept</th>
                          <th scope="col" className={cn(th, "text-right")}>Students</th>
                          <th scope="col" className={cn(th, "text-right")}>Memorising</th>
                          <th scope="col" className={cn(th, "text-right")}>Transferable</th>
                          <th scope="col" className={cn(th, "text-right")}>Foundational gap</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {tr.concepts.map((c) => (
                          <tr key={c.concept}>
                            <th scope="row" className={cn(td, "text-left font-medium text-slate-800")}>{c.concept}</th>
                            <td className={cn(td, "text-right")}>{c.students}</td>
                            <td className={cn(td, "text-right", c.memorisation > 0 && "font-semibold text-amber-800")}>
                              {c.memorisation}
                            </td>
                            <td className={cn(td, "text-right")}>{c.transferable}</td>
                            <td className={cn(td, "text-right", c.foundational_gap > 0 && "font-semibold text-rose-700")}>
                              {c.foundational_gap}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
                <p className="mt-2 text-xs text-slate-600">
                  Memorising = recall questions ({BLOOM_LABELS.K1} / {BLOOM_LABELS.K2}) right but application questions (K3+)
                  on the same concept wrong.
                </p>
                <h4 className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Memorising in 2+ concepts
                </h4>
                <StudentRows
                  rows={tr.students}
                  unit={(r) => `${fmt(r.value, 0)} concepts`}
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
          <section aria-label="Bloom profile">
            <SubHeading icon={GraduationCap}>Accuracy by Bloom level</SubHeading>
            <BloomProfile buckets={p.bloom_profile ?? []} />
          </section>

          {otherNotes.length ? (
            <section aria-label="Other notes">
              <SubHeading icon={Info}>Notes</SubHeading>
              <Notes notes={otherNotes} fallback="" />
            </section>
          ) : null}
        </div>
      )}
    </Card>
  );
}
