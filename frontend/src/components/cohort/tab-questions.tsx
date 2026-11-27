"use client";

import { useEffect, useMemo, useState } from "react";
import type { Cohort, CohortItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { commonWrongPick, keyErrorLine } from "./action-cards";
import { TD, TH } from "./card";
import { FOCUS_RING, LINK_TEXT, lost, plural } from "./format";
import type { CohortParams, ParamPatch } from "./url";

const SHOW = 15;
/** Phones show fewer rows before "Show all" (each row is three lines there). */
const SHOW_PHONE = 8;
/** "Many wrong": a question 3+ students answered wrongly (an NEET MCQ costs a mark each). */
const MANY_WRONG = 3;
const CHIP = cn(
  "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-[13px] transition-colors",
  FOCUS_RING,
);
const LINK_BTN = cn("rounded-sm text-xs font-medium hover:underline", LINK_TEXT, FOCUS_RING);

type Filter = "all" | "possible_key_error" | "hard" | "often_skipped" | "negatives";

const FLAG_LOOK: Record<string, { label: string; className: string }> = {
  possible_key_error: { label: "Check key", className: "bg-red-50 text-red-700" },
  hard: { label: "Hard", className: "bg-amber-50 text-amber-900" },
  often_skipped: { label: "Often skipped", className: "bg-slate-100 text-slate-700" },
};

/** Right / partly right / wrong / blank as one small stacked bar, with the counts in text. Written
 * answers lead with the share of the marks (what "hard" is measured on). */
export function AnswerBar({ item }: { item: CohortItem }) {
  const parts = [
    { n: item.correct, fill: "bg-brand-lime-600", word: item.type === "mcq" ? "right" : "full" },
    { n: item.partial, fill: "bg-amber-400", word: "partly" },
    { n: item.wrong, fill: "bg-red-600", word: "wrong" },
    { n: item.blank, fill: "bg-slate-400", word: "blank" },
  ];
  const counts = parts.filter((p) => p.n > 0 || p === parts[0]).map((p) => `${p.n} ${p.word}`);
  const text = (item.type === "mcq" ? counts : [`${Math.round(item.p * 100)}% of marks`, ...counts]).join(" · ");
  return (
    <span className="block min-w-0">
      <span
        role="img"
        aria-label={`${text} (of ${item.n})`}
        className="flex h-2 w-full max-w-40 gap-px overflow-hidden rounded-sm bg-slate-100"
      >
        {parts.map((p) =>
          p.n > 0 ? <span key={p.word} className={p.fill} style={{ width: `${(p.n / item.n) * 100}%` }} /> : null,
        )}
      </span>
      <span className="mt-0.5 block text-xs tabular-nums text-slate-600" aria-hidden>
        {text}
      </span>
    </span>
  );
}

function separates(item: CohortItem): { label: string; className: string } | null {
  const d = item.discrimination;
  if (d === null) return null;
  if (d < 0) return { label: "Reversed", className: "text-red-700" };
  if (d < 0.1) return { label: "Weak", className: "text-amber-800" };
  return { label: "Good", className: "text-slate-700" };
}

function SeparatesCell({ item }: { item: CohortItem }) {
  const s = separates(item);
  if (!s) return <span className="text-slate-500" title="Shown from 8 answers">—</span>;
  return (
    <span
      className={cn("text-xs font-medium", s.className)}
      title={`Top 27% of the class minus bottom 27%: ${item.discrimination?.toFixed(2)} (share right)`}
    >
      {s.label}
    </span>
  );
}

function Flags({ item }: { item: CohortItem }) {
  const flags = item.flags.filter((f) => f in FLAG_LOOK);
  if (!flags.length) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {flags.map((f) => (
        <span key={f} className={cn("rounded-sm px-1 text-[11px] font-medium", FLAG_LOOK[f].className)}>
          {FLAG_LOOK[f].label}
        </span>
      ))}
    </span>
  );
}

/** Written-answer gaps grouped by question; the names are one click away. */
function WrittenErrors({ cohort }: { cohort: Cohort }) {
  const [open, setOpen] = useState(false);
  const errors = cohort.common_errors;
  const list = useMemo(() => errors ?? [], [errors]);
  const byQuestion = useMemo(() => {
    const groups = new Map<number, { question: number; topic: string; denominator: number; gaps: typeof list }>();
    for (const e of list) {
      const g = groups.get(e.question) ?? { question: e.question, topic: e.topic, denominator: e.denominator, gaps: [] };
      g.gaps.push(e);
      groups.set(e.question, g);
    }
    return [...groups.values()];
  }, [list]);
  if (!list.length) return null;
  return (
    <section aria-labelledby="written-gaps" className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="written-gaps" className="text-sm font-semibold text-slate-900">
          Repeated gaps in written answers
        </h3>
        <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={cn(LINK_BTN, "text-[13px]")}>
          {open ? "Hide names" : "Show names"}
        </button>
      </div>
      <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
        {byQuestion.map((g) => (
          <li key={g.question} className="px-3 py-2">
            <p className="text-sm">
              <span className="font-semibold text-brand-navy">Q{g.question}</span>{" "}
              <span className="text-xs text-slate-600">{g.topic}</span>
            </p>
            <ul className="mt-1 space-y-1">
              {g.gaps.map((e, i) => (
                <li key={i} className="text-sm text-slate-800">
                  <p className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0">{e.error}</span>
                    <span className="shrink-0 text-xs tabular-nums text-slate-700">
                      {e.count} of {e.denominator}
                    </span>
                  </p>
                  {open ? <p className="text-xs text-slate-600">{e.students.join(", ")}</p> : null}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Questions tab (one test): flags, a table sorted hardest first, written-answer gaps. */
export function QuestionsTab({
  cohort,
  params,
  update,
  onOpenKey,
  onPickTest,
}: {
  cohort: Cohort;
  params: CohortParams;
  update: (patch: ParamPatch) => void;
  onOpenKey: () => void;
  onPickTest: () => void;
}) {
  const items = useMemo(
    () => (cohort.scope?.mode === "sitting" ? cohort.item_analysis ?? [] : []),
    [cohort.scope?.mode, cohort.item_analysis],
  );
  const [showAll, setShowAll] = useState(false);
  const [jump, setJump] = useState("");
  const [target, setTarget] = useState<number | null>(null);
  const filter: Filter = (params.flag === "weak_discrimination" ? "all" : params.flag) ?? "all";
  const many = (i: CohortItem) => i.wrong >= MANY_WRONG && i.negative_marks > 0;

  const counts = {
    possible_key_error: items.filter((i) => i.flags.includes("possible_key_error")).length,
    hard: items.filter((i) => i.flags.includes("hard")).length,
    often_skipped: items.filter((i) => i.flags.includes("often_skipped")).length,
    negatives: items.filter(many).length,
  };

  const rows = useMemo(() => {
    if (filter === "negatives") {
      return items.filter(many).sort((a, b) => b.negative_marks - a.negative_marks || a.question - b.question);
    }
    const list = filter === "all" ? items : items.filter((i) => i.flags.includes(filter));
    return [...list].sort((a, b) => a.p - b.p || b.blank - a.blank || a.question - b.question);
  }, [items, filter]);

  useEffect(() => {
    if (target === null) return;
    document.getElementById(`q-${target}`)?.scrollIntoView({ block: "center" });
  }, [target]);

  if (!items.length) {
    const sitting = cohort.scope?.mode === "sitting";
    return (
      <p className="text-sm text-slate-600">
        {sitting ? (
          `Question analysis needs 5 or more graded sheets of one test (this one has ${plural(cohort.scope?.students ?? 0, "student")}).`
        ) : (
          <>
            Question analysis is per test.{" "}
            <button type="button" onClick={onPickTest} className={cn(LINK_BTN, "text-sm")}>
              Pick one test
            </button>{" "}
            to see which questions most students got wrong, skipped, or may have a wrong key.
          </>
        )}
      </p>
    );
  }

  const mcq = items.some((i) => i.type === "mcq");
  const all = showAll || target !== null;
  const shown = all ? rows : rows.slice(0, SHOW);
  const chips: { id: Filter; label: string; n: number }[] = [
    { id: "all", label: "All", n: items.length },
    ...(mcq ? [{ id: "possible_key_error" as Filter, label: "Possible key error", n: counts.possible_key_error }] : []),
    { id: "hard", label: mcq ? "Hard (<40% right)" : "Hard (<40% of marks)", n: counts.hard },
    { id: "often_skipped", label: "Often skipped (30%+ blank)", n: counts.often_skipped },
    ...(mcq ? [{ id: "negatives" as Filter, label: `${MANY_WRONG}+ wrong`, n: counts.negatives }] : []),
  ];
  const bonus = cohort.attempt?.bonus_answers ?? 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        {/* One row that scrolls sideways on a phone; wraps on wider screens. */}
        <div
          role="group"
          aria-label="Filter questions"
          hidden={chips.filter((c) => c.n > 0 && c.id !== "all").length === 0 && filter === "all"}
          className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0"
        >
          {chips
            .filter((c) => c.n > 0 || c.id === "all" || filter === c.id)
            .map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={filter === c.id}
                onClick={() => update({ flag: c.id === "all" || filter === c.id ? null : c.id })}
                className={cn(
                  CHIP,
                  filter === c.id ? "border-brand-navy bg-brand-navy text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
                )}
              >
                {c.label} <span className="tabular-nums">{c.n}</span>
              </button>
            ))}
        </div>
        {items.length > 30 ? (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(jump);
              if (Number.isInteger(n) && items.some((i) => i.question === n)) {
                update({ flag: null });
                setTarget(n);
              }
            }}
          >
            <label htmlFor="jump-q" className="text-[13px] text-slate-700">
              Go to Q
            </label>
            <input
              id="jump-q"
              inputMode="numeric"
              value={jump}
              onChange={(e) => setJump(e.target.value.replace(/\D/g, ""))}
              className="h-8 w-16 rounded-md border border-slate-300 px-2 text-[13px] tabular-nums"
            />
          </form>
        ) : null}
      </div>
      {mcq && counts.possible_key_error === 0 && filter === "all" ? (
        <p className="text-[13px] text-slate-600">
          No question looks mis-keyed. One is flagged when it has 8+ answers, 3+ students chose the same wrong option and
          more than chose the key, and the top 27% of the class did no better on it than the bottom 27%.
        </p>
      ) : null}
      {bonus > 0 ? (
        <p className="text-[13px] text-slate-600">
          Bonus questions (full marks to everyone) are left out of this list and of the attempt figures.
        </p>
      ) : null}

      {/* Desktop */}
      <table className="hidden w-full border-collapse sm:table">
        <caption className="sr-only">Questions, hardest first</caption>
        <thead className="border-b border-slate-200">
          <tr>
            <th scope="col" className={cn(TH, "w-12")}>
              Q
            </th>
            <th scope="col" className={TH}>
              Chapter
            </th>
            {mcq ? (
              <th scope="col" className={TH}>
                Key
              </th>
            ) : null}
            <th scope="col" className={cn(TH, "w-64")}>
              Answers
            </th>
            {mcq ? (
              <th scope="col" className={TH} title="The wrong option 2 or more students chose (— when none, or a tie)">
                Common wrong pick
              </th>
            ) : null}
            {mcq ? (
              <th scope="col" className={cn(TH, "text-right")}>
                Lost
              </th>
            ) : null}
            <th scope="col" className={TH} title="Did the stronger students get it right more often than the weaker ones?">
              Separates strong / weak
            </th>
            <th scope="col" className={TH}>
              Flag
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {shown.map((item) => {
            const keyError = item.flags.includes("possible_key_error");
            return (
              <tr
                key={item.question}
                id={target === item.question ? `q-${item.question}` : undefined}
                className={cn(keyError && "bg-red-50/40", target === item.question && "bg-brand-cyan-50")}
              >
                <th scope="row" className={cn(TD, "text-left font-semibold", keyError ? "text-red-700" : "text-brand-navy")}>
                  Q{item.question}
                </th>
                <td className={cn(TD, "max-w-48 truncate text-slate-700")} title={item.topic}>
                  {item.topic}
                </td>
                {mcq ? <td className={cn(TD, "font-mono text-xs")}>{item.key ?? "—"}</td> : null}
                <td className={TD}>
                  <AnswerBar item={item} />
                </td>
                {mcq ? <td className={TD}>{commonWrongPick(item) ?? <span className="text-slate-500">—</span>}</td> : null}
                {mcq ? (
                  <td className={cn(TD, "text-right", item.negative_marks > 0 && "text-red-700")}>{lost(item.negative_marks)}</td>
                ) : null}
                <td className={TD}>
                  <SeparatesCell item={item} />
                </td>
                <td className={TD}>
                  <Flags item={item} />
                  {keyError ? (
                    <button type="button" onClick={onOpenKey} className={cn(LINK_BTN, "mt-1 block")} title={keyErrorLine(item)}>
                      Check the key
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Phone */}
      <ul className="divide-y divide-slate-100 border-y border-slate-100 sm:hidden">
        {shown.map((item, index) => {
          const keyError = item.flags.includes("possible_key_error");
          const pick = commonWrongPick(item);
          return (
            <li
              key={item.question}
              id={target === item.question ? `q-${item.question}` : undefined}
              className={cn("py-2", keyError && "border-l-2 border-red-600 pl-2", !all && index >= SHOW_PHONE && "hidden")}
            >
              <div className="flex items-baseline gap-2">
                <span className={cn("text-sm font-semibold", keyError ? "text-red-700" : "text-brand-navy")}>Q{item.question}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-slate-700">{item.topic}</span>
                {item.key ? <span className="font-mono text-xs text-slate-600">key {item.key}</span> : null}
              </div>
              <div className="mt-1">
                <AnswerBar item={item} />
              </div>
              {pick || item.flags.some((f) => f in FLAG_LOOK) ? (
                <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
                  {pick ? <span>wrong pick {pick}</span> : null}
                  <Flags item={item} />
                  {keyError ? (
                    <button type="button" onClick={onOpenKey} className={LINK_BTN}>
                      Check the key
                    </button>
                  ) : null}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>

      {target === null && (rows.length > SHOW || rows.length > SHOW_PHONE) ? (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className={cn(LINK_BTN, "text-[13px]", rows.length <= SHOW && "sm:hidden")}
        >
          {showAll ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      ) : null}

      {items.some((i) => i.type !== "mcq") ? <WrittenErrors cohort={cohort} /> : null}
    </div>
  );
}
