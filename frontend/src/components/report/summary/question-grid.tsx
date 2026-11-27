"use client";

import { Lock, Star, X } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import { ChartFrame } from "@/components/charts";
import type { QuestionEvaluation, Result, ResultKind } from "@/lib/types";
import { cn, formatConfidence } from "@/lib/utils";
import { FacultyBadge } from "../faculty-badge";
import { fmtMarks, orJoin } from "../format";
import { subjectMap } from "../normalize-summary";
import { GRID_FILTER_EVENT, focusQuestion, openSourcePage, type GridFilter } from "../report-events";
import { useReportView } from "../report-view-mode";
import { SEGMENT_STYLE, Swatch } from "./subject-cards";
import { COLOR, WRONG_HATCH, card, focusRing, linkButton, numeric } from "./tokens";

const CELL_STYLE: Record<ResultKind, CSSProperties> = {
  right: { background: COLOR.navy, color: "#fff" },
  wrong: { backgroundImage: WRONG_HATCH, color: "#fff" },
  zero: { backgroundImage: WRONG_HATCH, color: "#fff" },
  blank: { background: "#fff", color: "#475569", boxShadow: "inset 0 0 0 1.5px #94A3B8" },
  bonus: { background: COLOR.bonus, color: "#1E3A8A" },
  partial: { ...SEGMENT_STYLE.partial, color: "#78350F" },
};

const FILTER_LABEL: Record<Exclude<GridFilter, "all">, string> = {
  right: "Right",
  wrong: "Wrong",
  blank: "Blank",
  bonus: "Bonus",
  partial: "Partial",
  zero: "Zero",
  unclear: "Hard to read",
};

/** Something was read off the sheet for this question (a marked option or written text). */
const answered = (q: QuestionEvaluation) => Boolean(q.selected_option) || q.student_answer.trim() !== "";

function marked(q: QuestionEvaluation): string {
  const sel = (q.selected_option ?? "").trim().toUpperCase();
  if (!sel) return "not answered";
  if (sel === "MULTI") return "more than one option marked";
  if (sel === "UNKNOWN") return "mark unclear";
  return `marked ${sel}`;
}

const signed = (n: number) => (n > 0 ? `+${fmtMarks(n)}` : fmtMarks(n));

/** "Accepted B or C", "Bonus question", "Key not recorded". */
function accepted(q: QuestionEvaluation): string {
  if (q.result_kind === "bonus") return "bonus question, full marks to everyone";
  const opts = q.accepted_options ?? [];
  return opts.length ? `accepted ${orJoin(opts)}` : "key not recorded";
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function cellLabel(q: QuestionEvaluation, subject: string, unclear: boolean): string {
  const head = `Q${q.question}${subject ? ` ${subject}` : ""}`;
  const body =
    q.question_type === "mcq"
      ? `${marked(q)}, ${accepted(q)}, ${signed(q.estimated_marks)}`
      : `${fmtMarks(q.estimated_marks)} of ${fmtMarks(q.max_marks)} marks, ${q.result_kind === "right" ? "full credit" : (q.result_kind ?? "")}`;
  return `${head}, ${body}${unclear ? ", hard to read" : ""}`;
}

type Popover = { n: number; top: number; left: number; sheet: boolean };

/**
 * The paper at a glance: one band of numbered cells per subject. Right = navy, wrong = red hatch,
 * blank = hollow outline, bonus = star, hard to read = dashed outline, so colour is never the only
 * cue. Filter chips (with counts) dim the other cells; a cell opens a small popover (a bottom sheet
 * on phones) with the marked option, the key, the marks and the page.
 */
export function QuestionGrid({ result }: { result: Result }) {
  const qs = [...result.question_evaluations].sort((a, b) => a.question - b.question);
  const subjectOf = subjectMap(result.topic_mastery);
  const isDemo = result.submission.is_demo;
  const threshold = result.extraction.threshold;
  const unclear = (q: QuestionEvaluation) => !isDemo && answered(q) && q.confidence > 0 && q.confidence < threshold;
  const { teacher } = useReportView();

  const [filter, setFilter] = useState<GridFilter>("all");
  const [active, setActive] = useState<number>(qs[0]?.question ?? 0);
  const [pop, setPop] = useState<Popover | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const cells = useRef(new Map<number, HTMLButtonElement>());

  useEffect(() => {
    const onFilter = (e: Event) => {
      const f = (e as CustomEvent<GridFilter>).detail;
      setFilter(f);
      setPop(null);
    };
    window.addEventListener(GRID_FILTER_EVENT, onFilter);
    return () => window.removeEventListener(GRID_FILTER_EVENT, onFilter);
  }, []);

  useEffect(() => {
    if (!pop) return;
    const close = (refocus: boolean) => {
      setPop(null);
      if (refocus) cells.current.get(pop.n)?.focus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(true);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (popRef.current?.contains(t) || t.closest("[data-qcell]")) return;
      close(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    const timer = window.setTimeout(() => popRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus(), 0);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      window.clearTimeout(timer);
    };
  }, [pop]);

  if (!qs.length) return <p className="text-sm text-slate-600">No question-level marks were recorded for this result.</p>;

  // Subjects in paper order (first appearance); questions no topic lists go under "Other".
  const bySubject = new Map<string, QuestionEvaluation[]>();
  for (const q of qs) {
    const s = subjectOf.get(q.question) ?? (subjectOf.size ? "Other" : "");
    bySubject.set(s, [...(bySubject.get(s) ?? []), q]);
  }
  const groups = [...bySubject].map(([subject, items]) => ({ subject, items }));
  const count = (f: GridFilter) => (f === "unclear" ? qs.filter(unclear).length : qs.filter((q) => q.result_kind === f).length);
  const matches = (q: QuestionEvaluation) =>
    filter === "all" || (filter === "unclear" ? unclear(q) : q.result_kind === filter);
  const hard = qs.filter(unclear);
  // MCQ papers: right / wrong / blank / bonus; written answers: full / partial / zero / blank.
  const mcqPaper = qs.some((q) => q.question_type === "mcq");
  const always: GridFilter[] = mcqPaper ? ["right", "wrong", "blank"] : ["right", "partial", "zero", "blank"];
  const chips = (["right", "wrong", "blank", "bonus", "partial", "zero"] as const).filter(
    (k) => count(k) > 0 || always.includes(k),
  );
  const chipLabel = (k: Exclude<GridFilter, "all">) => (k === "right" && !mcqPaper ? "Full" : FILTER_LABEL[k]);
  const order = qs.map((q) => q.question);

  const focusCell = (n: number) => {
    setActive(n);
    cells.current.get(n)?.focus();
  };

  const onCellKey = (e: ReactKeyboardEvent<HTMLButtonElement>, n: number) => {
    const i = order.indexOf(n);
    let next: number | undefined;
    if (e.key === "ArrowRight") next = order[Math.min(order.length - 1, i + 1)];
    else if (e.key === "ArrowLeft") next = order[Math.max(0, i - 1)];
    else if (e.key === "Home") next = order[0];
    else if (e.key === "End") next = order[order.length - 1];
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      // The cell straight below / above (rows wrap with the container width).
      const cur = e.currentTarget.getBoundingClientRect();
      const down = e.key === "ArrowDown";
      let best: { n: number; dy: number; dx: number } | null = null;
      for (const [k, el] of cells.current) {
        const r = el.getBoundingClientRect();
        const dy = down ? r.top - cur.top : cur.top - r.top;
        if (dy < 4) continue;
        const dx = Math.abs(r.left - cur.left);
        if (!best || dy < best.dy - 2 || (Math.abs(dy - best.dy) <= 2 && dx < best.dx)) best = { n: k, dy, dx };
      }
      next = best?.n;
    } else return;
    e.preventDefault();
    if (next !== undefined) focusCell(next);
  };

  const openPop = (e: ReactMouseEvent<HTMLButtonElement>, n: number) => {
    setActive(n);
    if (pop?.n === n) {
      setPop(null);
      return;
    }
    const box = wrap.current?.getBoundingClientRect();
    const r = e.currentTarget.getBoundingClientRect();
    if (!box) return;
    const sheet = window.matchMedia("(max-width: 639px)").matches;
    const half = 144;
    setPop({
      n,
      top: r.bottom - box.top + 6,
      left: Math.min(Math.max(r.left - box.left + r.width / 2, half), box.width - half),
      sheet,
    });
  };

  const selected = pop ? qs.find((q) => q.question === pop.n) : undefined;

  return (
    <div className={cn(card, "p-3 sm:p-4")}>
      <ChartFrame
        title={`All ${qs.length} questions${groups.length > 1 ? " by subject" : ""}`}
        titleClassName="sr-only"
        className="space-y-2"
        table={{
          columns: ["Q", "Subject", "Marked", "Accepted", "Marks"],
          rows: qs.map((q) => [
            `Q${q.question}`,
            subjectOf.get(q.question) ?? "—",
            q.question_type === "mcq" ? (q.selected_option ?? "—") : answered(q) ? "written" : "—",
            q.result_kind === "bonus" ? "Bonus" : q.accepted_options?.length ? orJoin(q.accepted_options) : "—",
            signed(q.estimated_marks),
          ]),
        }}
      >
        <div
          role="group"
          aria-label="Show questions"
          className="-mx-1 flex flex-wrap gap-1.5 px-1 pb-1 print:hidden sm:flex-nowrap sm:overflow-x-auto sm:[scrollbar-width:none] sm:[&::-webkit-scrollbar]:hidden"
        >
          <FilterChip active={filter === "all"} onClick={() => setFilter("all")} label="All" n={qs.length} />
          {chips.map((k) => (
            <FilterChip
              key={k}
              active={filter === k}
              onClick={() => setFilter(filter === k ? "all" : k)}
              label={chipLabel(k)}
              n={count(k)}
              swatch={<Swatch kind={k === "zero" ? "wrong" : k} />}
            />
          ))}
          {hard.length && teacher ? (
            <FilterChip
              active={filter === "unclear"}
              onClick={() => setFilter(filter === "unclear" ? "all" : "unclear")}
              label={FILTER_LABEL.unclear}
              n={hard.length}
              title="For faculty: answers read below the confidence line"
              swatch={<span aria-hidden className="h-2.5 w-2.5 rounded-[2px] border-[1.5px] border-dashed border-[#B45309]" />}
              suffix={<Lock className="h-3 w-3 text-slate-500" aria-label="for faculty" />}
            />
          ) : null}
        </div>
        <div ref={wrap} className="relative space-y-2.5">
          {groups.map((g) => (
            <div key={g.subject || "all"} className="space-y-1">
              {g.subject ? (
                <p className="text-xs text-slate-600">
                  <span className="font-semibold text-slate-800">{g.subject}</span>{" "}
                  <span className={numeric}>
                    Q{g.items[0].question}–Q{g.items[g.items.length - 1].question}
                  </span>
                </p>
              ) : null}
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(2.375rem,1fr))] gap-1 sm:grid-cols-[repeat(auto-fill,minmax(2.125rem,1fr))]">
                {g.items.map((q) => {
                  const dim = !matches(q);
                  const low = unclear(q);
                  return (
                    <li key={q.question} className="min-w-0">
                      <button
                        type="button"
                        data-qcell
                        ref={(el) => {
                          if (el) cells.current.set(q.question, el);
                          else cells.current.delete(q.question);
                        }}
                        tabIndex={q.question === active ? 0 : -1}
                        aria-label={cellLabel(q, g.subject, low)}
                        aria-haspopup="dialog"
                        aria-expanded={pop?.n === q.question}
                        onClick={(e) => openPop(e, q.question)}
                        onKeyDown={(e) => onCellKey(e, q.question)}
                        onFocus={() => setActive(q.question)}
                        className={cn(
                          "relative grid h-10 w-full cursor-pointer place-items-center rounded-[3px] text-[11px] font-semibold transition-opacity duration-150 sm:h-8 [print-color-adjust:exact]",
                          numeric,
                          focusRing,
                          low && "outline-2 outline-offset-1 outline-dashed outline-[#B45309]",
                          dim && "opacity-25",
                        )}
                        style={CELL_STYLE[q.result_kind ?? "partial"]}
                      >
                        {q.question}
                        {q.result_kind === "bonus" ? (
                          <Star className="absolute right-0.5 top-0.5 h-2 w-2 fill-[#1E40AF] text-[#1E40AF]" aria-hidden />
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {pop && selected ? (
            <QuestionPopover
              ref={popRef}
              q={selected}
              subject={subjectOf.get(selected.question) ?? ""}
              pop={pop}
              unclear={unclear(selected)}
              isDemo={isDemo}
              teacher={teacher}
              threshold={threshold}
              onClose={() => {
                setPop(null);
                cells.current.get(selected.question)?.focus();
              }}
            />
          ) : null}
        </div>
      </ChartFrame>
      {hard.length ? (
        <p className="mt-3 text-[13px] text-slate-700">
          {hard.length} {hard.length === 1 ? "answer was" : "answers were"} hard to read and may change after teacher review (
          {hard.map((q, i) => (
            <span key={q.question}>
              {i ? ", " : ""}
              <button type="button" onClick={() => focusQuestion(q.question)} className={cn(linkButton, numeric, "text-[13px]")}>
                Q{q.question}
              </button>
            </span>
          ))}
          ).
        </p>
      ) : null}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  n,
  swatch,
  suffix,
  title,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  n: number;
  swatch?: ReactNode;
  suffix?: ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      title={title}
      className={cn(
        "inline-flex min-h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors duration-150",
        focusRing,
        active ? "border-[#1E40AF] bg-[#1E40AF] text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
      )}
    >
      {swatch ? <span className={cn("inline-flex", active && "rounded-[3px] bg-white p-px")}>{swatch}</span> : null}
      {label}
      <span className={numeric}>{n}</span>
      {suffix}
    </button>
  );
}

function QuestionPopover({
  ref,
  q,
  subject,
  pop,
  unclear,
  isDemo,
  teacher,
  threshold,
  onClose,
}: {
  ref: Ref<HTMLDivElement>;
  q: QuestionEvaluation;
  subject: string;
  pop: Popover;
  unclear: boolean;
  isDemo: boolean;
  /** Teacher view: the reading confidence (faculty-only) is shown. */
  teacher: boolean;
  threshold: number;
  onClose: () => void;
}) {
  const mcq = q.question_type === "mcq";
  const page = q.source_pages[0];
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`Question ${q.question} details`}
      className={cn(
        "z-40 border border-slate-200 bg-white text-[13px] text-slate-800 shadow-lg",
        pop.sheet
          ? "fixed inset-x-0 bottom-0 rounded-t-lg p-4 pb-6"
          : "absolute w-72 -translate-x-1/2 rounded-md p-3",
      )}
      style={pop.sheet ? undefined : { top: pop.top, left: pop.left }}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-semibold text-[#1E3A8A]">
          <span className={numeric}>Q{q.question}</span>
          {subject ? ` · ${subject}` : ""}
        </p>
        <button
          type="button"
          data-autofocus
          onClick={onClose}
          aria-label="Close"
          className={cn("-m-1 grid h-8 w-8 cursor-pointer place-items-center rounded-md text-slate-500 hover:bg-slate-100", focusRing)}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <p className="mt-1">
        {mcq ? (
          <>
            {cap(marked(q))} · {cap(accepted(q))} ·{" "}
            <span className={cn(numeric, "font-semibold", q.estimated_marks < 0 && "text-red-700")}>{signed(q.estimated_marks)}</span>
          </>
        ) : (
          <>
            <span className={numeric}>
              {fmtMarks(q.estimated_marks)} / {fmtMarks(q.max_marks)}
            </span>{" "}
            marks
          </>
        )}
      </p>
      {!isDemo && page ? (
        <p className="mt-1 flex items-center gap-2">
          <span>
            Page <span className={numeric}>{page}</span>
          </span>
          <button type="button" onClick={() => openSourcePage(page)} className={linkButton}>
            View page
          </button>
        </p>
      ) : null}
      {unclear ? <p className="mt-1 text-slate-600">Hard to read: may change after teacher review.</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-slate-100 pt-2 text-xs text-slate-600">
        {teacher ? <FacultyBadge /> : null}
        {teacher && !isDemo && answered(q) ? (
          <span>
            Reading confidence <span className={numeric}>{formatConfidence(q.confidence)}</span> (review line{" "}
            <span className={numeric}>{formatConfidence(threshold)}</span>)
          </span>
        ) : null}
        <button type="button" onClick={() => focusQuestion(q.question)} className={cn(linkButton, "text-xs")}>
          Open the question card
        </button>
      </div>
    </div>
  );
}
