"use client";

import { ArrowLeftRight, BookOpenCheck, ClipboardList, FileImage, GraduationCap, ListChecks, Target } from "lucide-react";
import { useState } from "react";
import type { Confusion, Intervention, Priority, Result } from "@/lib/types";
import { cn } from "@/lib/utils";
import { SOURCE_LABEL, fmtNumber, fraction, uniqueSorted } from "./format";
import { QRefChip, observedPriorities, topicRow } from "./immediate-reading";
import { Eyebrow, Pill, SectionCard } from "./primitives";
import { openSourcePage } from "./report-events";

/** Stored intervention, or a rule-template one built from the topic (older rows have none). */
export function interventionFor(p: Priority): Intervention {
  if (p.intervention && (p.intervention.teach || p.intervention.practice || p.intervention.check_criterion)) {
    return p.intervention;
  }
  return {
    teach: `Re-teach ${p.topic}: walk through the missed rubric points from the trigger questions.`,
    practice: `5 unseen ${p.topic} questions of the same type, worked with full steps.`,
    check_criterion: `>=4/5 correct on fresh ${p.topic} items; teacher checks the working.`,
    source: "template",
  };
}

/** Trigger questions: stored on the priority, else the topic's questions. */
export function triggerQuestions(result: Result, p: Priority): number[] {
  if (p.trigger_questions.length) return uniqueSorted(p.trigger_questions);
  return uniqueSorted(topicRow(result, p.topic)?.questions ?? []);
}

/** First source page of the trigger questions (null when the scan has no page references). */
function firstSourcePage(result: Result, questions: number[]): number | null {
  const pages = result.question_evaluations
    .filter((q) => questions.includes(q.question))
    .flatMap((q) => q.source_pages)
    .filter((n) => n > 0);
  return pages.length ? Math.min(...pages) : null;
}

function OpenSourcePage({ result, questions }: { result: Result; questions: number[] }) {
  const page = firstSourcePage(result, questions);
  if (result.submission.is_demo) {
    return <span className="text-xs text-slate-400">Synthetic record - no source scan</span>;
  }
  if (page === null) {
    return <span className="text-xs text-slate-400">No page reference recorded</span>;
  }
  return (
    <button
      type="button"
      onClick={() => openSourcePage(page)}
      className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1 text-xs font-medium text-brand-cyan-600 ring-1 ring-inset ring-brand-cyan/40 transition hover:bg-brand-cyan-50 focus-visible:outline-2 focus-visible:outline-brand-cyan"
    >
      <FileImage className="h-3.5 w-3.5" aria-hidden />
      Open source page {page}
    </button>
  );
}

/** Segmented P1..Pn chooser with the Teach / Practice / Check intervention for the chosen topic. */
export function InterventionChooser({ result }: { result: Result }) {
  const priorities = observedPriorities(result);
  const [index, setIndex] = useState(0);
  const current = priorities[Math.min(index, priorities.length - 1)];

  if (!current) {
    return (
      <SectionCard id="intervention-chooser" title="Choose an intervention" icon={Target}>
        <p className="rounded-xl border border-dashed border-lime-300 bg-brand-lime-50 p-4 text-sm text-slate-600">
          No topic needs an intervention on this assessment: every assessed topic is at or near full marks.
        </p>
      </SectionCard>
    );
  }

  const iv = interventionFor(current);
  const qs = triggerQuestions(result, current);
  const row = topicRow(result, current.topic);
  const steps = [
    { key: "Teach", Icon: GraduationCap, text: iv.teach },
    { key: "Practice", Icon: BookOpenCheck, text: iv.practice },
    { key: "Check", Icon: ListChecks, text: iv.check_criterion },
  ];

  return (
    <SectionCard
      id="intervention-chooser"
      title="Choose an intervention"
      description="Qualitative priority order (observed gaps), not numeric ROI. Evidence-linked and educator-reviewable."
      icon={Target}
      className="print:hidden"
    >
      <div role="tablist" aria-label="Priority topics" className="flex flex-wrap gap-1.5">
        {priorities.map((p, i) => {
          const active = p === current;
          return (
            <button
              key={p.topic}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls="intervention-panel"
              onClick={() => setIndex(i)}
              title={p.topic}
              className={cn(
                "rounded-xl px-3 py-2 text-left text-sm ring-1 ring-inset transition focus-visible:outline-2 focus-visible:outline-brand-cyan",
                active ? "bg-brand-navy text-white ring-brand-navy" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50",
              )}
            >
              <span className={cn("font-mono text-xs font-semibold", active ? "text-brand-cyan" : "text-slate-400")}>P{i + 1}</span>
              <span className="ml-1.5 hidden max-w-[10rem] truncate align-bottom sm:inline-block">{p.topic}</span>
            </button>
          );
        })}
      </div>

      <div id="intervention-panel" role="tabpanel" className="mt-4 rounded-xl border border-slate-200 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              P{Math.min(index, priorities.length - 1) + 1} · {current.subject}
            </p>
            <p className="text-lg font-semibold text-brand-navy">{current.topic}</p>
            <p className="text-sm text-slate-600">
              Observed{" "}
              <span className="font-semibold tabular-nums">
                {row ? fraction(row.score, row.max_marks) : `${fmtNumber(current.mastery, 0)}%`}
              </span>
              {row ? ` · ${row.full} full, ${row.partial} partial, ${row.zero} zero, ${row.blank} blank` : ""}
            </p>
          </div>
          <Pill className="bg-slate-50 text-slate-600 ring-slate-200">{SOURCE_LABEL[iv.source]}</Pill>
        </div>

        <ol className="mt-4 grid gap-3 md:grid-cols-3">
          {steps.map(({ key, Icon, text }) => (
            <li key={key} className="rounded-xl bg-slate-50 p-3 [print-color-adjust:exact]">
              <Eyebrow icon={Icon}>{key}</Eyebrow>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-700">{text || "—"}</p>
            </li>
          ))}
        </ol>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-slate-500">Trigger questions</span>
          {qs.length ? qs.map((q) => <QRefChip key={q} q={q} />) : <span className="text-xs text-slate-400">—</span>}
          <span className="ml-auto">
            <OpenSourcePage result={result} questions={qs} />
          </span>
        </div>
        <p className="mt-3 text-xs text-slate-500">Root cause not proven: the evaluator&apos;s reading, pending teacher review.</p>
      </div>
    </SectionCard>
  );
}

/** Printable action-plan table (SAIR page 5 "Evidence-linked teacher interventions"). */
export function ActionPlanTable({ result }: { result: Result }) {
  const priorities = observedPriorities(result);
  return (
    <SectionCard
      id="action-plan-table"
      title="Evidence-linked teacher interventions"
      description="Teacher action and a measurable retest per priority. Provisional until teacher review."
      icon={ClipboardList}
    >
      {priorities.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-sm text-slate-500">
          No priority topics on this assessment.
        </p>
      ) : (
        <div className="relative overflow-x-auto print:overflow-visible">
          <table className="w-full min-w-[40rem] print:min-w-0 border-collapse text-sm">
            <caption className="sr-only">Teacher action plan</caption>
            <thead>
              <tr className="bg-brand-navy text-left text-xs text-white [print-color-adjust:exact]">
                <th scope="col" className="w-[24%] px-3 py-2 font-semibold">Priority / topic</th>
                <th scope="col" className="w-[16%] px-3 py-2 font-semibold">Trigger questions</th>
                <th scope="col" className="px-3 py-2 font-semibold">Teacher action and suggested measurable retest</th>
              </tr>
            </thead>
            <tbody>
              {priorities.map((p, i) => {
                const iv = interventionFor(p);
                const qs = triggerQuestions(result, p);
                return (
                  <tr key={p.topic} className="border-b border-slate-200 align-top even:bg-slate-50 [print-color-adjust:exact] print:break-inside-avoid">
                    <th scope="row" className="px-3 py-2.5 text-left font-medium text-slate-800">
                      P{i + 1} | {p.topic}
                      <span className="block text-xs font-normal text-slate-500">{p.subject}</span>
                    </th>
                    <td className="px-3 py-2.5">
                      <span className="flex flex-wrap gap-1">
                        {qs.length ? qs.map((q) => <QRefChip key={q} q={q} />) : "—"}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-slate-700">
                      <p>
                        <span className="font-semibold">Teach:</span> {iv.teach}
                      </p>
                      <p className="mt-0.5">
                        <span className="font-semibold">Practice:</span> {iv.practice}
                      </p>
                      <p className="mt-0.5">
                        <span className="font-semibold">Criterion:</span> {iv.check_criterion}
                      </p>
                      <p className="mt-0.5 text-[11px] text-slate-400">{SOURCE_LABEL[iv.source]}</p>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

const CONTRAST_ROWS = ["Definition in one line", "Signature example", "How to tell them apart"];

function ConfusionItem({ c }: { c: Confusion }) {
  return (
    <li className="rounded-xl border border-slate-200 p-4 print:break-inside-avoid">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-base font-semibold text-brand-navy">
          {c.concept_a} <span className="px-1 text-brand-cyan-600" aria-label="versus">↔</span> {c.concept_b}
        </p>
        {c.question !== null ? <QRefChip q={c.question} /> : null}
      </div>
      {c.evidence ? <p className="mt-1.5 text-sm leading-relaxed text-slate-700">{c.evidence}</p> : null}

      <div className="mt-3 rounded-lg bg-slate-50 p-3 [print-color-adjust:exact]">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Disambiguation drill (suggested)</p>
        <div className="mt-2 relative overflow-x-auto print:overflow-visible">
          <table className="w-full min-w-[24rem] print:min-w-0 border-collapse text-xs">
            <thead>
              <tr>
                <th scope="col" className="border border-slate-200 bg-white px-2 py-1 text-left font-medium text-slate-500">
                  Contrast table
                </th>
                <th scope="col" className="border border-slate-200 bg-white px-2 py-1 text-left font-semibold text-brand-navy">
                  {c.concept_a}
                </th>
                <th scope="col" className="border border-slate-200 bg-white px-2 py-1 text-left font-semibold text-brand-navy">
                  {c.concept_b}
                </th>
              </tr>
            </thead>
            <tbody>
              {CONTRAST_ROWS.map((r) => (
                <tr key={r}>
                  <th scope="row" className="border border-slate-200 bg-white px-2 py-1.5 text-left font-normal text-slate-600">
                    {r}
                  </th>
                  <td className="border border-slate-200 bg-white px-2 py-1.5 text-slate-300">student completes</td>
                  <td className="border border-slate-200 bg-white px-2 py-1.5 text-slate-300">student completes</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-xs text-slate-700">
          <li>Define {c.concept_a} and {c.concept_b} in one line each.</li>
          <li>Give one example that is {c.concept_a} but not {c.concept_b}.</li>
          <li>Give one example that is {c.concept_b} but not {c.concept_a}.</li>
          <li>
            Re-answer {c.question !== null ? `Q${c.question}` : "the original question"} and name which concept applies, and why.
          </li>
        </ol>
      </div>
    </li>
  );
}

/** Concept confusions (FR-4.9): A ↔ B pairs the evaluator saw, each with a contrast drill. */
export function ConfusionsCard({ result }: { result: Result }) {
  const items = result.confusions;
  return (
    <SectionCard
      id="confusions"
      title="Concept confusions"
      description="Pairs of concepts the evaluator saw mixed up in the answers (the evaluator's reading, not proven)."
      icon={ArrowLeftRight}
      action={items.length ? <Pill className="bg-slate-50 text-slate-600 ring-slate-200">{items.length}</Pill> : null}
    >
      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-sm text-slate-500">
          {result.submission.is_demo
            ? "Synthetic record - no AI call, so no concept confusions were analysed."
            : "No concept confusions were flagged on this answer sheet."}
        </p>
      ) : (
        <ul className="space-y-3">
          {items.map((c, i) => (
            <ConfusionItem key={`${c.concept_a}-${c.concept_b}-${i}`} c={c} />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
