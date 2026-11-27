import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight, ClipboardList } from "lucide-react";
import { clampPct, pct1, plural } from "@/lib/format";
import type { Cohort, CohortChapter, CohortItem, CohortStudentRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { chapterTone, FOCUS_RING, LINK_TEXT, nOf, RETEACH_LINE, signed1 } from "./format";
import type { CohortTab, ParamPatch } from "./url";

const MAX_ROWS = 5;
const LINK = cn("rounded-sm font-medium text-slate-800 hover:text-cyan-700 hover:underline", FOCUS_RING);
const FOOT = cn("inline-flex items-center gap-1 rounded-sm text-[13px] font-medium hover:underline", LINK_TEXT, FOCUS_RING);

function ActionCard({
  id,
  title,
  count,
  footer,
  children,
}: {
  id: string;
  title: string;
  count?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col rounded-md border border-slate-200 bg-white p-4">
      <h2 id={id} className="text-[15px] font-semibold text-brand-navy">
        {title}
      </h2>
      {count ? <p className="mt-0.5 text-[13px] tabular-nums text-slate-600">{count}</p> : null}
      <div className="mt-3 flex-1">{children}</div>
      {footer ? <div className="mt-3 border-t border-slate-100 pt-2.5">{footer}</div> : null}
    </section>
  );
}

/** A card footer link that opens a tab below and scrolls it into view. */
function FootLink({
  href,
  tab,
  onReveal,
  children,
}: {
  href: string;
  tab: CohortTab;
  onReveal: (tab: CohortTab) => void;
  children: ReactNode;
}) {
  return (
    <Link href={href} scroll={false} onClick={() => onReveal(tab)} className={FOOT}>
      {children}
      <ArrowRight className="h-3.5 w-3.5" aria-hidden />
    </Link>
  );
}

/** Row i of a card: rows 4-5 are hidden on phones (at most 3 per card there). */
const rowClass = (i: number) => cn("py-2", i >= 3 && "max-sm:hidden");

/** Chapter mean as a small bar with the 60% re-teach line (coloured against that line). */
export function MeanBar({ mean, label }: { mean: number; label?: string }) {
  const tone = chapterTone(mean);
  return (
    <span className="flex items-center gap-2">
      <span
        role="img"
        aria-label={label ?? `Class mean ${pct1(mean)}`}
        className="relative h-2 min-w-16 flex-1 bg-slate-100"
      >
        <span className={cn("block h-full", tone.bar)} style={{ width: `${clampPct(mean)}%` }} />
        <span className="absolute -top-0.5 -bottom-0.5 w-px bg-slate-600" style={{ left: `${RETEACH_LINE}%` }} aria-hidden />
      </span>
      <span className="w-12 text-right text-sm font-semibold tabular-nums text-slate-800">{pct1(mean)}</span>
    </span>
  );
}

function reasonText(row: CohortStudentRow): string {
  if (row.short_reason === "below_55") return "Below 55%";
  if (row.short_reason === "below_70") return "Below 70%";
  if (row.short_reason === "low_chapters") return `${row.low_chapters} chapters below 40%`;
  return "";
}

/** Change since the previous test, in visible words (no tooltip-only meaning). */
function ChangeCell({ row, prevName }: { row: CohortStudentRow; prevName: string | null }) {
  if (!prevName) return null;
  if (row.change_pts === null) {
    return (
      <span className="w-16 text-right text-xs text-slate-600">
        {row.prev_pct === null ? "not sat" : "not comparable"}
        <span className="sr-only"> {prevName}</span>
      </span>
    );
  }
  const v = row.change_pts;
  return (
    <span
      className={cn("w-16 text-right text-xs tabular-nums", v > 0 ? "text-lime-700" : v < 0 ? "text-red-700" : "text-slate-600")}
    >
      <span aria-hidden>{v > 0 ? "▲" : v < 0 ? "▼" : ""}</span>
      <span className="sr-only">{v > 0 ? "up " : v < 0 ? "down " : ""}</span>
      {Math.abs(v).toFixed(1)}
      <span className="sr-only"> points since {prevName}</span>
    </span>
  );
}

/** 5a: the at-risk students, lowest first, plus anyone not at risk who dropped 10+ points. */
export function StudentsCard({
  cohort,
  href,
  onReveal,
}: {
  cohort: Cohort;
  href: (patch: ParamPatch) => string;
  onReveal: (tab: CohortTab) => void;
}) {
  const rows = cohort.students_view ?? [];
  // Only when some student has a comparable change: never a column of "not comparable".
  const prevName =
    cohort.scope?.mode === "sitting" && rows.some((r) => r.change_pts !== null) ? cohort.previous?.short_name ?? null : null;
  const atRisk = rows.filter((r) => r.urgency === "at_risk").sort((a, b) => a.pct - b.pct || a.student_name.localeCompare(b.student_name));
  const fresh = cohort.previous?.newly_at_risk ?? atRisk.filter((r) => r.newly_at_risk).length;
  const watch = rows
    .filter((r) => r.urgency !== "at_risk" && r.change_pts !== null && r.change_pts <= -10)
    .sort((a, b) => (a.change_pts ?? 0) - (b.change_pts ?? 0))
    .slice(0, 2);
  const more = atRisk.length - MAX_ROWS;
  const scopeWord = cohort.scope?.mode === "sitting" ? "on this test" : "in this view";

  return (
    <ActionCard
      id="card-students"
      title="Students who need you"
      count={
        atRisk.length ? (
          <span className="flex flex-wrap items-baseline justify-between gap-x-2">
            <span>
              <span className="font-medium text-red-700">{atRisk.length} at risk</span>
              {prevName && fresh ? ` · ${fresh} new since ${prevName}` : ""}
            </span>
            {prevName ? <span className="text-xs text-slate-600">change since {prevName}</span> : null}
          </span>
        ) : null
      }
      footer={
        <FootLink
          href={href({ tab: "students", urgency: atRisk.length ? "at_risk" : null })}
          tab="students"
          onReveal={onReveal}
        >
          {more > 0 ? `+${more} more · ` : atRisk.length > 3 ? <span className="sm:hidden">+{atRisk.length - 3} more · </span> : null}
          {atRisk.length ? "All at-risk students" : "All students"}
        </FootLink>
      }
    >
      {atRisk.length === 0 ? (
        <p className="text-sm text-slate-600">No student is at risk {scopeWord}.</p>
      ) : (
        <ul className="-my-2 divide-y divide-slate-100">
          {atRisk.slice(0, MAX_ROWS).map((row, i) => (
            <li key={row.submission_id} className={rowClass(i)}>
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate">
                  <Link href={`/report/${row.submission_id}`} className={LINK}>
                    {row.student_name}
                  </Link>
                  {row.newly_at_risk ? (
                    <span className="ml-1.5 rounded-sm bg-red-50 px-1 text-[11px] font-medium text-red-700">New</span>
                  ) : null}
                </span>
                <span className="text-sm font-semibold tabular-nums text-red-700">{pct1(row.pct)}</span>
                <ChangeCell row={row} prevName={prevName} />
              </div>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-600">
                <span className="rounded-sm bg-slate-100 px-1 text-slate-700">{reasonText(row)}</span>
                {row.weakest_topic ? <span className="truncate">Weakest: {row.weakest_topic}</span> : null}
              </p>
            </li>
          ))}
        </ul>
      )}
      {watch.length ? (
        <div className="mt-3 rounded-sm bg-slate-50 px-2.5 py-2">
          <p className="text-xs font-medium text-slate-700">Also watch · dropped 10+ pts since {prevName}</p>
          <ul className="mt-1 space-y-0.5 text-[13px]">
            {watch.map((row) => (
              <li key={row.submission_id} className="flex items-baseline justify-between gap-2">
                <Link href={`/report/${row.submission_id}`} className={cn(LINK, "truncate font-normal")}>
                  {row.student_name}
                </Link>
                <span className="tabular-nums text-slate-700">
                  {pct1(row.pct)} <span className="text-red-700">({signed1(row.change_pts)})</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </ActionCard>
  );
}

/** "Hardest: Q16 - 5 of 12 right" (MCQ) or "Hardest: Q3 - 41% of the marks · 0 of 12 full marks";
 * a one-question chapter names its question ("Q3 - 41% of the marks ..."). */
function hardestLine(c: CohortChapter): string {
  const h = c.hardest_question;
  if (!h) return plural(c.questions, "question");
  const lead = c.questions < 2 ? `Q${h.question}` : `Hardest: Q${h.question}`;
  if (h.type && h.type !== "mcq" && typeof h.p === "number") {
    return `${lead} - ${Math.round(h.p * 100)}% of the marks · ${h.correct} of ${h.n} full marks`;
  }
  return `${lead} - ${h.correct} of ${h.n} right`;
}

/** 5b: the top 3 chapters to re-teach (backend rank: most students below 60%, then NEET weight). */
export function ReteachCard({
  cohort,
  href,
  onLog,
  onReveal,
}: {
  cohort: Cohort;
  href: (patch: ParamPatch) => string;
  onLog: (chapter: CohortChapter) => void;
  onReveal: (tab: CohortTab) => void;
}) {
  const chapters = cohort.chapters ?? [];
  const ranked = chapters
    .filter((c) => c.reteach_rank !== null)
    .sort((a, b) => (a.reteach_rank ?? 0) - (b.reteach_rank ?? 0));
  const canLog = cohort.scope?.batch_id != null;
  const allHints = ranked.length > 0 && ranked.slice(0, 3).every((c) => c.hint);
  const weakest = chapters
    .filter((c) => !c.subject_level && c.below_60 > 0)
    .sort((a, b) => b.below_60 - a.below_60 || Number(b.questions >= 2) - Number(a.questions >= 2) || a.mean - b.mean)[0];
  const few = (cohort.scope?.students ?? 0) < 3;

  let empty: ReactNode = null;
  if (!ranked.length) {
    if (chapters.length > 0 && chapters.every((c) => c.subject_level)) {
      const subject = [...(cohort.subjects ?? [])].sort((a, b) => a.mean - b.mean)[0];
      empty = (
        <p className="text-sm text-slate-600">
          This paper&apos;s questions are tagged by subject only, so no chapter can be picked.
          {subject ? ` Weakest subject: ${subject.subject} at ${pct1(subject.mean)}.` : ""}
        </p>
      );
    } else if (weakest) {
      empty = (
        <>
          <p className="text-sm text-slate-600">
            {few
              ? `With ${plural(cohort.scope?.students ?? 0, "student")}, no chapter is flagged for a class re-teach (that needs 3 or more).`
              : `No chapter has a third of the class below ${RETEACH_LINE}% on two or more questions, so none is flagged for a class re-teach.`}
          </p>
          <p className="mt-2 text-sm text-slate-700">
            Most students below {RETEACH_LINE}%: <span className="font-medium">{weakest.topic}</span> -{" "}
            {nOf(weakest.below_60, weakest.students)}
            {weakest.questions < 2 ? " (1 question)" : ""}.
          </p>
        </>
      );
    } else {
      empty = <p className="text-sm text-slate-600">Every student is at {RETEACH_LINE}% or more in every chapter.</p>;
    }
  }

  return (
    <ActionCard
      id="card-reteach"
      title="Re-teach next"
      count={
        ranked.length ? (
          <>
            Chapters where a third of the class or more is below {RETEACH_LINE}%
            {allHints ? (
              <span className="mt-1 block w-fit rounded-sm bg-amber-50 px-1 text-xs font-medium text-amber-900">
                Short paper: each rests on one question - treat as a hint
              </span>
            ) : null}
          </>
        ) : null
      }
      footer={
        <FootLink href={href({ tab: "chapters" })} tab="chapters" onReveal={onReveal}>
          All chapters
        </FootLink>
      }
    >
      {empty ?? (
        <ol className="-my-2 divide-y divide-slate-100">
          {ranked.slice(0, 3).map((c, i) => (
            <li key={c.topic} className={rowClass(i)}>
              <div className="flex items-baseline justify-between gap-2">
                <p className="min-w-0 truncate text-sm font-semibold text-brand-navy">
                  {c.topic}
                  {c.subject ? <span className="ml-1.5 text-xs font-normal text-slate-600">{c.subject}</span> : null}
                </p>
                <span className="shrink-0 text-xs tabular-nums text-slate-700">
                  <span className="font-semibold text-slate-900">{c.below_60}</span> of {c.students} below {RETEACH_LINE}%
                </span>
              </div>
              <div className="mt-1">
                <MeanBar mean={c.mean} label={`${c.topic}: class mean ${pct1(c.mean)}, re-teach line ${RETEACH_LINE}%`} />
              </div>
              <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs tabular-nums text-slate-600">
                  {c.hint && !allHints ? (
                    <span className="mr-1.5 rounded-sm bg-amber-50 px-1 font-medium text-amber-900">1 question - a hint</span>
                  ) : null}
                  {hardestLine(c)}
                </span>
                {canLog ? (
                  <button
                    type="button"
                    onClick={() => onLog(c)}
                    className={cn(
                      "inline-flex h-7 items-center gap-1 rounded-md border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50",
                      FOCUS_RING,
                    )}
                  >
                    <ClipboardList className="h-3.5 w-3.5" aria-hidden />
                    Log class intervention
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
      {ranked.length && !canLog ? (
        <p className="mt-3 text-xs text-slate-600">Pick a batch to log a class intervention.</p>
      ) : null}
    </ActionCard>
  );
}

function answered(item: CohortItem) {
  return item.correct + item.wrong + item.partial;
}

/** The commonest wrong option, only when 2+ students chose it and no other wrong option tied. */
export function commonWrongPick(item: CohortItem): string | null {
  if (!item.top_wrong_option || item.top_wrong_count < 2 || item.top_wrong_tied) return null;
  return `${item.top_wrong_option} (${item.top_wrong_count})`;
}

/** "Q16 Mechanics - 5 of 12 right · 4 blank · common wrong pick A (2)". */
export function itemLine(item: CohortItem): string {
  const parts =
    item.type === "mcq"
      ? [`${item.correct} of ${item.n} right`]
      : [`${Math.round(item.p * 100)}% of the marks`, `${item.correct} of ${item.n} full marks`];
  if (item.blank) parts.push(`${item.blank} blank`);
  const pick = commonWrongPick(item);
  if (pick) parts.push(`common wrong pick ${pick}`);
  return parts.join(" · ");
}

export function keyErrorLine(item: CohortItem): string {
  const top =
    item.top_group_size && item.top_group_chose_wrong
      ? `, including ${item.top_group_chose_wrong} of the top ${item.top_group_size} students`
      : "";
  return `key ${item.key ?? "?"} · ${item.top_wrong_count} of ${answered(item)} who answered chose ${item.top_wrong_option}${top}`;
}

/** 5c: possible key errors first, then the hardest questions and the most skipped one. */
export function QuestionsCard({
  cohort,
  href,
  onOpenKey,
  onPickTest,
  onReveal,
}: {
  cohort: Cohort;
  href: (patch: ParamPatch) => string;
  onOpenKey: () => void;
  onPickTest: () => void;
  onReveal: (tab: CohortTab) => void;
}) {
  const sitting = cohort.scope?.mode === "sitting";
  const items = sitting ? cohort.item_analysis ?? null : null;
  if (!items || items.length === 0) {
    const n = cohort.scope?.students ?? 0;
    return (
      <ActionCard id="card-questions" title="Questions to check">
        {sitting ? (
          <p className="text-sm text-slate-600">
            Only {plural(n, "graded sheet")} on this test - question analysis needs 5 or more.
          </p>
        ) : (
          <p className="text-sm text-slate-600">
            Question analysis is per test -{" "}
            <button type="button" onClick={onPickTest} className={cn("rounded-sm font-medium underline-offset-2 hover:underline", LINK_TEXT, FOCUS_RING)}>
              pick a test
            </button>
            .
          </p>
        )}
      </ActionCard>
    );
  }
  const mcq = items.some((i) => i.type === "mcq");
  const flagged = items.filter((i) => i.flags.includes("possible_key_error"));
  const hardest = items
    .filter((i) => !i.flags.includes("possible_key_error"))
    .sort((a, b) => a.p - b.p || b.blank - a.blank || a.question - b.question)
    .slice(0, Math.max(0, 3 - flagged.length));
  const skipped = [...items].sort((a, b) => b.blank - a.blank || a.question - b.question)[0];

  return (
    <ActionCard
      id="card-questions"
      title="Questions to check"
      count={
        mcq ? (
          flagged.length ? (
            <span className="font-medium text-red-700">{plural(flagged.length, "possible key error")}</span>
          ) : (
            "No question looks mis-keyed."
          )
        ) : (
          "Hardest first, by share of the marks"
        )
      }
      footer={
        <FootLink href={href({ tab: "questions", flag: null })} tab="questions" onReveal={onReveal}>
          All {items.length} questions
        </FootLink>
      }
    >
      <ul className="-my-2 divide-y divide-slate-100">
        {flagged.slice(0, 3).map((item) => (
          <li key={`k${item.question}`} className="border-l-2 border-red-600 py-2 pl-2.5">
            <p className="text-sm text-slate-800">
              <span className="font-semibold text-red-700">Q{item.question}</span> · {keyErrorLine(item)}
            </p>
            <button
              type="button"
              onClick={onOpenKey}
              className={cn("mt-1 rounded-sm text-xs font-medium hover:underline", LINK_TEXT, FOCUS_RING)}
            >
              Check the key
            </button>
          </li>
        ))}
        {hardest.map((item, i) => (
          <li key={`h${item.question}`} className={rowClass(i + flagged.length)}>
            <p className="text-sm text-slate-800">
              <span className="font-semibold text-brand-navy">Q{item.question}</span>{" "}
              <span className="text-slate-700">{item.topic}</span>
            </p>
            <p className="mt-0.5 text-xs tabular-nums text-slate-600">{itemLine(item)}</p>
          </li>
        ))}
      </ul>
      {skipped && skipped.blank > 0 ? (
        <p className="mt-3 text-[13px] text-slate-700">
          Most skipped: <span className="font-medium text-slate-900">Q{skipped.question}</span> -{" "}
          {nOf(skipped.blank, skipped.n)} left it blank
        </p>
      ) : null}
    </ActionCard>
  );
}
