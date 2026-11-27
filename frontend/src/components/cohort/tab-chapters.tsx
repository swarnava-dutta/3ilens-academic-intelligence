"use client";

import { Fragment, useState } from "react";
import { BarList, ChartFrame } from "@/components/charts";
import { IllustrativePill } from "@/components/shared/illustrative-pill";
import type { Cohort, CohortChapter } from "@/lib/types";
import { cn, formatWeight } from "@/lib/utils";
import { MeanBar } from "./action-cards";
import { TD, TH } from "./card";
import {
  CHAPTER_TONES,
  chapterTone,
  FOCUS_RING,
  formatHours,
  formatRoi,
  LINK_TEXT,
  neetWeight,
  pct1,
  plural,
  RETEACH_LINE,
  RETEACH_RULE,
  signed1,
  type ChapterTone,
} from "./format";

const SUMMARY = cn("cursor-pointer rounded-sm text-sm font-semibold text-slate-900 hover:text-brand-navy", FOCUS_RING);
const NOT_IN_TABLE = "Not in the NEET chapter table";

function Change({ value }: { value: number | null }) {
  if (value === null) return <span className="text-slate-500">—</span>;
  return (
    <span className={cn("tabular-nums", value > 0 ? "text-lime-700" : value < 0 ? "text-red-700" : "text-slate-600")}>
      {signed1(value)}
    </span>
  );
}

/** Why a chapter's figure is thin: one question, or very few students. */
function thinNote(c: CohortChapter): string {
  if (c.questions < 2) return c.questions === 1 ? "1 question" : "no question";
  return plural(c.students, "student");
}

function Weight({ value }: { value: number | null | undefined }) {
  return value == null ? (
    <span className="text-slate-500" title={NOT_IN_TABLE}>
      —<span className="sr-only">{NOT_IN_TABLE}</span>
    </span>
  ) : (
    <>{neetWeight(value)}</>
  );
}

function groups(chapters: CohortChapter[]) {
  const out: { subject: string; level: CohortChapter | null; rows: CohortChapter[] }[] = [];
  for (const c of chapters) {
    const key = c.subject || "Other";
    let group = out.find((g) => g.subject === key);
    if (!group) {
      group = { subject: key, level: null, rows: [] };
      out.push(group);
    }
    if (c.subject_level) group.level = c;
    else group.rows.push(c);
  }
  return out;
}

function ReteachTag({ c }: { c: CohortChapter }) {
  if (c.reteach_rank === null || c.reteach_rank > 3) return null;
  return (
    <span className="ml-1.5 rounded-sm bg-amber-50 px-1 text-[11px] font-medium text-amber-900">
      re-teach #{c.reteach_rank}
      {c.hint ? " · hint" : ""}
    </span>
  );
}

function SubjectBars({ cohort }: { cohort: Cohort }) {
  const subjects = cohort.subjects ?? [];
  if (subjects.length < 2) return null;
  const prev = cohort.scope?.mode === "sitting" ? cohort.previous?.short_name : null;
  const weakest = [...subjects].sort((a, b) => a.mean - b.mean)[0];
  return (
    <ChartFrame
      title="By subject"
      takeaway={`${weakest.subject} is the weakest subject at ${pct1(weakest.mean)}${prev ? ` (▲▼ = change in points since ${prev})` : ""}`}
      table={{
        columns: ["Subject", "Class %", "Students", ...(prev ? [`Change since ${prev}`] : [])],
        rows: subjects.map((s) => [
          s.subject,
          pct1(s.mean),
          s.students,
          ...(prev ? [s.change === null ? "—" : `${signed1(s.change)} pts`] : []),
        ]),
      }}
    >
      <BarList
        unit="%"
        items={subjects.map((s) => ({
          label: s.subject,
          value: s.mean,
          max: 100,
          target: RETEACH_LINE,
          // Same rule as the chapter bars: below the re-teach line reads as a warning.
          tone: s.mean < RETEACH_LINE ? "warning" : "default",
          valueLabel:
            s.change !== null && prev
              ? `${pct1(s.mean)} · ${s.change > 0 ? "▲" : s.change < 0 ? "▼" : ""}${Math.abs(s.change).toFixed(1)}`
              : pct1(s.mean),
        }))}
      />
    </ChartFrame>
  );
}

const LEGEND: ChapterTone[] = ["low", "under", "ok"];

function Legend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600" aria-label="Colours">
      {LEGEND.map((key) => (
        <li key={key} className="inline-flex items-center gap-1.5">
          <span className={cn("h-2.5 w-2.5 rounded-sm", CHAPTER_TONES[key].bar)} aria-hidden />
          {CHAPTER_TONES[key].label}
        </li>
      ))}
      <li className="inline-flex items-center gap-1.5">
        <span className="h-3 w-px bg-slate-600" aria-hidden />
        {RETEACH_LINE}% re-teach line
      </li>
    </ul>
  );
}

function ChapterTable({ cohort }: { cohort: Cohort }) {
  const chapters = cohort.chapters ?? [];
  const hasPrev = cohort.scope?.mode === "sitting" && cohort.previous != null;
  const subjects = new Map((cohort.subjects ?? []).map((s) => [s.subject, s]));
  const grouped = groups(chapters);
  const sitting = cohort.scope?.mode === "sitting";
  return (
    <div className="min-w-0 space-y-2">
      <div>
        <h3 className="text-sm font-semibold text-slate-900">Chapters</h3>
        <p className="mt-0.5 text-[13px] text-slate-600">
          Class mean per chapter, weakest first in each subject. A chapter resting on one question is a hint, not a verdict.
        </p>
      </div>
      <Legend />
      {/* Desktop */}
      <table className="hidden w-full border-collapse sm:table">
        <caption className="sr-only">Chapters grouped by subject</caption>
        <thead className="border-b border-slate-200">
          <tr>
            <th scope="col" className={TH}>
              Chapter
            </th>
            <th scope="col" className={cn(TH, "text-right")}>
              {sitting ? "Questions" : "Qs"}
            </th>
            <th scope="col" className={cn(TH, "w-60")}>
              Class mean
            </th>
            <th scope="col" className={cn(TH, "text-right")}>
              Below {RETEACH_LINE}%
            </th>
            {hasPrev ? (
              <th scope="col" className={cn(TH, "text-right")}>
                Δ pts
              </th>
            ) : null}
            <th scope="col" className={cn(TH, "text-right")}>
              <span className="inline-flex items-center gap-1.5" title="Average marks of this chapter in NEET, out of 720 (sample chapter table)">
                NEET weight <IllustrativePill label="sample" />
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {grouped.map((g) => {
            const subject = subjects.get(g.subject);
            return (
              <Fragment key={g.subject}>
                <tr className="border-t border-slate-200 bg-slate-50">
                  <th scope="rowgroup" colSpan={hasPrev ? 6 : 5} className="px-3 py-1.5 text-left text-xs font-semibold text-slate-800">
                    {g.subject}
                    {subject ? (
                      <span className="ml-2 font-normal tabular-nums text-slate-600">
                        class {pct1(subject.mean)}
                        {hasPrev && subject.change !== null ? ` · ${signed1(subject.change)} pts` : ""}
                      </span>
                    ) : null}
                    {g.level ? (
                      <span className="ml-2 font-normal text-slate-600">
                        · {plural(g.level.questions, "question")} tagged by subject only
                      </span>
                    ) : null}
                  </th>
                </tr>
                {g.rows.map((c) => (
                  <tr key={c.topic} className="border-t border-slate-100">
                    <th scope="row" className={cn(TD, "text-left font-normal text-slate-800")}>
                      {c.topic}
                      <ReteachTag c={c} />
                      {c.thin ? <span className="ml-1.5 text-xs text-slate-600">({thinNote(c)})</span> : null}
                    </th>
                    <td className={cn(TD, "text-right")}>{c.questions}</td>
                    <td className={TD}>
                      <MeanBar mean={c.mean} label={`${c.topic}: class mean ${pct1(c.mean)}`} />
                    </td>
                    <td className={cn(TD, "text-right whitespace-nowrap")}>
                      <span className="font-semibold text-slate-900">{c.below_60}</span> of {c.students}
                    </td>
                    {hasPrev ? (
                      <td className={cn(TD, "text-right")}>
                        <Change value={c.change} />
                      </td>
                    ) : null}
                    <td className={cn(TD, "text-right")}>
                      <Weight value={c.neet_weight} />
                    </td>
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {/* Phone */}
      <div className="space-y-3 sm:hidden">
        {grouped.map((g) => {
          const subject = subjects.get(g.subject);
          return (
            <section key={g.subject} aria-label={g.subject}>
              <p className="bg-slate-50 px-2 py-1 text-xs font-semibold text-slate-800">
                {g.subject}
                {subject ? <span className="ml-2 font-normal tabular-nums text-slate-600">class {pct1(subject.mean)}</span> : null}
                {g.level ? <span className="ml-1 font-normal text-slate-600">· tagged by subject only</span> : null}
              </p>
              <ul className="divide-y divide-slate-100">
                {g.rows.map((c) => (
                  <li key={c.topic} className="py-2">
                    <p className="text-sm font-medium text-slate-800">
                      {c.topic}
                      <ReteachTag c={c} />
                      {c.thin ? <span className="ml-1 text-xs font-normal text-slate-600">({thinNote(c)})</span> : null}
                    </p>
                    <div className="mt-1">
                      <MeanBar mean={c.mean} label={`${c.topic}: class mean ${pct1(c.mean)}`} />
                    </div>
                    <p className="mt-0.5 text-xs tabular-nums text-slate-600">
                      {c.below_60} of {c.students} below {RETEACH_LINE}% · {plural(c.questions, "question")}
                      {hasPrev && c.change !== null ? ` · ${signed1(c.change)} pts` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function WeakWhere({ cohort }: { cohort: Cohort }) {
  const chapters = (cohort.chapters ?? []).filter((c) => !c.subject_level).sort((a, b) => a.mean - b.mean);
  const students = [...(cohort.students_view ?? [])].sort((a, b) => a.pct - b.pct);
  if (!chapters.length || students.length < 2) return null;
  return (
    <details className="group rounded-md border border-slate-200 px-3 py-2.5">
      <summary className={SUMMARY}>
        Who is weak where{" "}
        <span className="font-normal text-slate-600">
          · {plural(students.length, "student")} × {plural(chapters.length, "chapter")}, for planning remedial groups
        </span>
      </summary>
      <div className="mt-3">
        <Legend />
      </div>
      <div className="mt-2 max-h-[28rem] overflow-auto">
        <table className="border-collapse text-xs tabular-nums">
          <caption className="sr-only">Chapter mastery per student, weakest students and chapters first</caption>
          <thead className="sticky top-0 bg-white">
            <tr>
              <th scope="col" className="sticky left-0 z-10 bg-white px-2 py-1 text-left font-medium text-slate-600">
                Student
              </th>
              {chapters.map((c) => (
                <th key={c.topic} scope="col" className="max-w-20 px-1 py-1 align-bottom font-medium text-slate-600">
                  <span className="line-clamp-3 block w-20 text-left leading-tight" title={c.topic}>
                    {c.topic}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {students.map((s) => {
              const byTopic = new Map(s.topics.map((t) => [t.topic, t]));
              return (
                <tr key={s.submission_id}>
                  <th scope="row" className="sticky left-0 z-10 max-w-36 truncate bg-white px-2 py-0.5 text-left font-normal text-slate-700">
                    {s.student_name}
                  </th>
                  {chapters.map((c) => {
                    const t = byTopic.get(c.topic);
                    if (!t) {
                      return (
                        <td key={c.topic} className="px-0.5 py-0.5 text-center text-slate-500">
                          <span className="sr-only">not in this test</span>·
                        </td>
                      );
                    }
                    const title = `${s.student_name} · ${c.topic} ${pct1(t.mastery)}${t.questions ? ` (${t.right} of ${t.questions} right)` : ""}`;
                    return (
                      <td key={c.topic} className="px-0.5 py-0.5" title={title}>
                        <span className={cn("block w-full min-w-9 rounded-sm px-1 py-0.5 text-center ring-1 ring-inset", chapterTone(t.mastery).chip)}>
                          {Math.round(t.mastery)}
                          <span className="sr-only">%</span>
                        </span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function Confusions({ cohort }: { cohort: Cohort }) {
  const [open, setOpen] = useState(false);
  const list = (cohort.confusion_clusters ?? []).filter((c) => c.count >= 2);
  const n = cohort.scope?.students ?? 0;
  if (!list.length) return null;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-900">Concept confusions</h3>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={cn("rounded-sm text-[13px] font-medium hover:underline", LINK_TEXT, FOCUS_RING)}
        >
          {open ? "Hide names" : "Show names"}
        </button>
      </div>
      <p className="mt-0.5 text-[13px] text-slate-600">Out of the students who sat a test where the pair came up.</p>
      <ul className="mt-1.5 divide-y divide-slate-100">
        {list.slice(0, 6).map((c) => (
          <li key={`${c.concept_a}-${c.concept_b}`} className="py-1.5 text-sm">
            <p className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="text-slate-800">
                {c.concept_a} <span aria-label="confused with" className="text-slate-500">↔</span> {c.concept_b}
              </span>
              <span className="text-xs tabular-nums text-slate-600">
                {c.count} of {c.denominator ?? n}
              </span>
            </p>
            {open ? <p className="mt-0.5 text-xs text-slate-600">{c.students.join(", ")}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The real re-teach order (the same as the card): students below 60%, then NEET weight, then mean. */
function HowRanked({ cohort }: { cohort: Cohort }) {
  const ranked = (cohort.chapters ?? [])
    .filter((c) => c.reteach_rank !== null)
    .sort((a, b) => (a.reteach_rank ?? 0) - (b.reteach_rank ?? 0));
  return (
    <details className="rounded-md border border-slate-200 px-3 py-2.5">
      <summary className={SUMMARY}>
        How re-teach is ranked{" "}
        <span className="font-normal text-slate-600">· {ranked.length ? plural(ranked.length, "chapter") : "no chapter"} qualify</span>
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-[13px] text-slate-700">
          A chapter qualifies with {RETEACH_RULE}, on two or more questions (on a short paper where every chapter has one
          question, three or more students below {RETEACH_LINE}%, as a hint). Order: most students below {RETEACH_LINE}%,
          then the NEET chapter weight, then the lowest class mean.
        </p>
        {ranked.length ? (
          <table className="w-full border-collapse text-[13px] tabular-nums">
            <caption className="sr-only">Re-teach order</caption>
            <thead className="border-b border-slate-200 text-xs text-slate-600">
              <tr>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">#</th>
                <th scope="col" className="py-1.5 pr-3 text-left font-medium">Chapter</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">Below {RETEACH_LINE}%</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">NEET weight</th>
                <th scope="col" className="py-1.5 text-right font-medium">Mean</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((c) => (
                <tr key={c.topic} className="border-b border-slate-100">
                  <td className="py-1.5 pr-3 text-right text-slate-600">{c.reteach_rank}</td>
                  <th scope="row" className="py-1.5 pr-3 text-left font-normal text-slate-800">
                    {c.topic}
                    {c.hint ? <span className="ml-1 text-xs text-slate-600">(1 question)</span> : null}
                  </th>
                  <td className="py-1.5 pr-3 text-right">
                    {c.below_60} of {c.students}
                  </td>
                  <td className="py-1.5 pr-3 text-right">
                    <Weight value={c.neet_weight} />
                  </td>
                  <td className="py-1.5 text-right">{pct1(c.mean)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-slate-600">No chapter qualifies in this view.</p>
        )}
        <p className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          NEET weight = average marks of the chapter in NEET out of 720, from a sample chapter table. <IllustrativePill />
        </p>
      </div>
    </details>
  );
}

/** Study-plan priority (ROI): a different ranking from re-teach, for planning revision hours. */
function StudyPriority({ cohort }: { cohort: Cohort }) {
  const rows = cohort.top_priorities ?? [];
  if (!rows.length) return null;
  return (
    <details className="rounded-md border border-slate-200 px-3 py-2.5">
      <summary className={SUMMARY}>
        Study-plan priority <span className="font-normal text-slate-600">· marks returned per revision hour</span>
      </summary>
      <div className="mt-3 space-y-3">
        <p className="flex flex-wrap items-center gap-2 text-[13px] text-slate-700">
          A different ranking from re-teach: where an hour of revision returns the most marks, for the students&apos; own
          study plans. <IllustrativePill />
        </p>
        <ol className="divide-y divide-slate-100 rounded-md border border-slate-200">
          {rows.map((p, i) => (
            <li key={p.topic} className="grid gap-1 px-3 py-2 sm:grid-cols-[1.5rem_minmax(0,14rem)_repeat(4,minmax(0,1fr))] sm:items-baseline sm:gap-3">
              <span className="hidden text-xs tabular-nums text-slate-600 sm:block">{i + 1}</span>
              <span className="text-sm font-semibold text-brand-navy">
                <span className="mr-1 text-xs font-normal text-slate-600 sm:hidden">{i + 1}.</span>
                {p.topic} <span className="text-xs font-normal text-slate-600">{p.subject}</span>
              </span>
              <span className="text-xs tabular-nums text-slate-700">Mastery {pct1(p.mastery)}</span>
              <span className="text-xs tabular-nums text-slate-700">Weight {formatWeight(p.weightage)}</span>
              <span className="text-xs tabular-nums text-slate-700">Effort {formatHours(p.effort_hours)}</span>
              <span className="text-xs tabular-nums font-semibold text-slate-900">ROI {formatRoi(p.roi)}</span>
            </li>
          ))}
        </ol>
        <p className="text-xs text-slate-600">
          <span className="font-mono text-[11px] text-slate-800">ROI = (weightage × gain potential) ÷ effort hours</span>.
          Gain potential = 100 − class mastery; weightage = the subject&apos;s NEET share × the chapter&apos;s share of that
          subject&apos;s marks in this paper. Effort hours come from a sample chapter table, so this is a teaching aid, not a
          score forecast.
        </p>
      </div>
    </details>
  );
}

/** Chapters tab: subject bars, the chapter table, confusions, who is weak where, how re-teach is ranked. */
export function ChaptersTab({ cohort }: { cohort: Cohort }) {
  if (!(cohort.chapters ?? []).length) {
    return <p className="text-sm text-slate-600">No chapter tags on the graded sheets in this view.</p>;
  }
  return (
    <div className="space-y-6">
      <SubjectBars cohort={cohort} />
      <ChapterTable cohort={cohort} />
      <Confusions cohort={cohort} />
      <div className="space-y-2">
        <WeakWhere cohort={cohort} />
        <HowRanked cohort={cohort} />
        <StudyPriority cohort={cohort} />
      </div>
    </div>
  );
}
