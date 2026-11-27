"use client";

import { ArrowRight, CircleMinus, Info, Lightbulb, Target, TrendingDown } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import type { KeyInsight, KeyInsightFigure, OutcomeCounts } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmtMarks, fmtPctValue } from "../format";
import { openEvidence, type GridFilter } from "../report-events";
import { card, linkButton, numeric } from "./tokens";

const ICONS: Record<string, typeof Target> = { attempts: CircleMinus, subjects: TrendingDown, gain: Target };

/** A figure's number as it reads in the detail line: 188, 80.2%. */
function figureNumber(f: KeyInsightFigure): string {
  if (typeof f.value === "string") return f.value;
  return f.unit === "%" ? fmtPctValue(f.value) : fmtMarks(f.value);
}

/** A figure with its unit, for the "How is this calculated?" list: "188 marks", "80.2%". */
function figureText(f: KeyInsightFigure): string {
  const n = figureNumber(f);
  return typeof f.value === "number" && f.unit && f.unit !== "%" ? `${n} ${f.unit}` : n;
}

const NUMBER = /([+−-]?\d[\d,]*(?:\.\d+)?%?(?:\/\d[\d,]*(?:\.\d+)?)?)/g;

/** The detail line with every number in tabular Fira Code; the lead figure in amber-700. */
export function Detail({ text, lead }: { text: string; lead: string | null }) {
  const parts = text.split(NUMBER);
  const bare = (s: string) => s.replace(/^[+−-]/, "");
  const leadIndex = lead ? parts.findIndex((p, i) => i % 2 === 1 && bare(p) === bare(lead)) : -1;
  const pick = lead === null ? -1 : leadIndex >= 0 ? leadIndex : parts.findIndex((_, i) => i % 2 === 1);
  return (
    <>
      {parts.map((p, i) => {
        if (i % 2 === 0) return <Fragment key={i}>{p}</Fragment>;
        const hot = i === pick;
        return (
          <span key={i} className={cn(numeric, "text-[12.5px]", hot ? "font-semibold text-[#B45309]" : "text-slate-900")}>
            {p}
          </span>
        );
      })}
    </>
  );
}

function EvidenceLink({ children, onClick, href }: { children: ReactNode; onClick: () => void; href: string }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        onClick();
      }}
      className={linkButton}
    >
      {children}
    </a>
  );
}

function InsightCard({ insight, counts }: { insight: KeyInsight; counts: OutcomeCounts }) {
  const [open, setOpen] = useState(false);
  const Icon = ICONS[insight.id] ?? Lightbulb;
  const ev = insight.evidence;
  const formulas = insight.figures.filter((f) => f.formula);
  // The server picks the number to highlight ("+35", "518/720"); else the first figure.
  const lead = insight.highlight ?? (insight.figures[0] ? figureNumber(insight.figures[0]) : null);
  const panelId = `insight-${insight.id}-how`;
  const fallback = ev?.kind === "questions" ? "questions" : ev?.kind === "subject" ? "subjects" : "focus";
  const blanks = counts.blank;
  const wrong = counts.wrong ?? 0;
  // Plain links that say what opens: the question grid filtered to the blanks / the wrong answers.
  const links: { key: string; label: string; open: () => void; href: string }[] = [];
  if (ev?.kind === "questions") {
    const show = (filter: GridFilter) => () => openEvidence({ anchor: ev.anchor, filter, fallback });
    const blankLink = blanks > 0 ? { key: "blank", label: `Show my ${blanks} ${blanks === 1 ? "blank" : "blanks"}`, open: show("blank"), href: `#${ev.anchor}` } : null;
    const wrongLink = wrong > 0 ? { key: "wrong", label: `Show my ${wrong} wrong ${wrong === 1 ? "answer" : "answers"}`, open: show("wrong"), href: `#${ev.anchor}` } : null;
    for (const l of ev.filter === "wrong" ? [wrongLink, blankLink] : [blankLink, wrongLink]) if (l) links.push(l);
  } else if (ev) {
    const where = ev.anchor.startsWith("focus-") ? "the focus list" : (ev.topic ?? ev.subject ?? "the details");
    links.push({ key: "see", label: `See ${where}`, open: () => openEvidence({ anchor: ev.anchor, filter: null, fallback }), href: `#${ev.anchor}` });
  }

  return (
    <li className={cn(card, "p-3 sm:p-3.5 print:break-inside-avoid")}>
      <div className="flex gap-3">
        <span
          className={cn(
            "grid h-8 w-8 shrink-0 place-items-center rounded-md",
            insight.tone === "warn" ? "bg-amber-50 text-[#B45309]" : insight.tone === "good" ? "bg-emerald-50 text-emerald-700" : "bg-blue-50 text-[#1E40AF]",
          )}
          aria-hidden
        >
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold leading-snug text-[#1E3A8A]">{insight.headline}</h3>
          {insight.detail ? (
            <p className="mt-1 text-[13px] leading-relaxed text-slate-700">
              <Detail text={insight.detail} lead={lead} />
            </p>
          ) : null}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 print:hidden">
            {links.map((l) => (
              <EvidenceLink key={l.key} href={l.href} onClick={l.open}>
                {l.label}
                <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </EvidenceLink>
            ))}
            {formulas.length ? (
              <button
                type="button"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => setOpen((v) => !v)}
                className={cn(linkButton, "text-slate-600")}
              >
                <Info className="h-3.5 w-3.5" aria-hidden />
                How is this calculated?
              </button>
            ) : null}
          </div>
          {formulas.length ? (
            <dl id={panelId} hidden={!open} className="mt-2 space-y-1 border-l-2 border-slate-200 pl-2.5 text-xs text-slate-700">
              {formulas.map((f) => (
                <div key={f.key || f.label}>
                  <dt className="inline font-medium text-slate-800">{f.label}: </dt>
                  <dd className="inline">
                    <span className={numeric}>{figureText(f)}</span>
                    <span className="text-slate-600"> = {f.formula}</span>
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/**
 * The server-built key insights (attempts, subjects, gain) that "In short" does not already say: with
 * the three summary lines (score and band, strongest / weakest with the reason, the next step) only the
 * attempts insight is left, so the same point is never made twice. Nothing when the API sent none.
 */
export function shownInsights(insights: KeyInsight[], summary: string[]): KeyInsight[] {
  const covered = summary.length >= 3 ? new Set(["subjects", "gain"]) : new Set<string>();
  return insights.filter((i) => !covered.has(i.id));
}

export function KeyInsights({
  insights,
  counts,
  className,
}: {
  insights: KeyInsight[];
  counts: OutcomeCounts;
  className?: string;
}) {
  if (!insights.length) return null;
  return (
    <section aria-labelledby="insights-heading" className={cn("min-w-0", className)}>
      <h2 id="insights-heading" className="mb-2 text-xs font-semibold text-slate-600">
        {insights.length === 1 ? "Key insight" : "Key insights"}
      </h2>
      <ol className="space-y-2">
        {insights.map((i) => (
          <InsightCard key={i.id} insight={i} counts={counts} />
        ))}
      </ol>
    </section>
  );
}
