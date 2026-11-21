"use client";

import Link from "next/link";
import { CheckCircle2, Download, FileText, MessageCircle, Target } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { UrgencyBadge } from "@/components/shared/urgency-badge";
import { reportPdfUrl } from "@/lib/api";
import type { StudentCard, SubmissionStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { NUDGE_LOOK, TONE, clampPct, fmtNumber, fraction, toneFor } from "@/components/report/format";

const STATUS_NOTE: Record<SubmissionStatus, string> = {
  PENDING: "Queued for processing.",
  PROCESSING: "In the AI pipeline now.",
  COMPLETED: "",
  FAILED: "Processing failed: open the report to retry.",
  HUMAN_REVIEW_REQUIRED: "Low OCR confidence: waiting for faculty transcript review.",
};

const actionClass =
  "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ring-1 ring-inset transition focus-visible:outline-2 focus-visible:outline-brand-cyan";

function MiniBars({ card }: { card: StudentCard }) {
  const topics = [...card.topic_mastery].sort((a, b) => a.mastery - b.mastery).slice(0, 5);
  if (topics.length === 0) return null;
  return (
    <ul className="space-y-1" aria-label="Topic scores, weakest first">
      {topics.map((t) => {
        const tone = TONE[toneFor(t.mastery)];
        return (
          <li key={t.topic} className="grid grid-cols-[minmax(0,1fr)_5rem_2.5rem] items-center gap-2 text-[11px]">
            <span className="truncate text-slate-600" title={`${t.topic} (${t.subject})`}>
              {t.topic}
            </span>
            <span className={cn("h-1.5 rounded-full [print-color-adjust:exact]", tone.track)}>
              <span className={cn("block h-full rounded-full", tone.fill)} style={{ width: `${clampPct(t.mastery)}%` }} />
            </span>
            <span className="text-right tabular-nums text-slate-500">{fmtNumber(t.mastery, 0)}%</span>
          </li>
        );
      })}
    </ul>
  );
}

function Card({ card, onWhatsApp }: { card: StudentCard; onWhatsApp: (card: StudentCard) => void }) {
  const done = card.status === "COMPLETED";
  return (
    <article className="flex min-w-0 flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-brand-navy">{card.student_name}</h3>
          <p className="truncate text-xs text-slate-500">
            {card.batch.name}
            {card.batch.exam_type ? ` · ${card.batch.exam_type}` : ""} · {card.test.name} {card.test.version}
          </p>
        </div>
        {done ? <UrgencyBadge urgency={card.urgency} size="sm" /> : <StatusBadge status={card.status} />}
      </header>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
        {card.is_demo ? (
          <span className="rounded-full bg-brand-lime-50 px-2 py-0.5 font-medium text-lime-800 ring-1 ring-inset ring-brand-lime/50">
            Synthetic demo
          </span>
        ) : (
          <span className="rounded-full bg-brand-cyan-50 px-2 py-0.5 font-medium text-cyan-800 ring-1 ring-inset ring-brand-cyan/30">
            Live upload
          </span>
        )}
        {done && card.release_status ? (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 font-medium ring-1 ring-inset",
              card.release_status === "RELEASED" ? "bg-brand-lime-50 text-lime-800 ring-brand-lime/50" : "bg-amber-50 text-amber-800 ring-amber-200",
            )}
          >
            {card.release_status === "RELEASED" ? "Released" : "Provisional"}
          </span>
        ) : null}
        {card.student_ref ? <span className="font-mono text-slate-400">{card.student_ref}</span> : null}
      </div>

      {done ? (
        <>
          <p className="mt-3 flex items-baseline gap-2">
            <span className="text-2xl font-semibold tabular-nums text-brand-navy">{fraction(card.score, card.total_marks)}</span>
            <span className="text-sm tabular-nums text-slate-500">
              {card.percentage === null ? "" : `${fmtNumber(card.percentage)}%`}
            </span>
          </p>
          <div className="mt-2">
            <MiniBars card={card} />
          </div>
          <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
            <div className="min-w-0">
              <p className="mb-1 font-semibold text-lime-800">Strengths</p>
              <ul className="space-y-0.5 text-slate-600">
                {card.strengths.slice(0, 2).map((s, i) => (
                  <li key={i} className="flex gap-1">
                    <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-lime-600" aria-hidden />
                    <span className="line-clamp-2">{s}</span>
                  </li>
                ))}
                {card.strengths.length === 0 ? <li className="text-slate-400">None recorded</li> : null}
              </ul>
            </div>
            <div className="min-w-0">
              <p className="mb-1 font-semibold text-amber-800">Gaps</p>
              <ul className="space-y-0.5 text-slate-600">
                {card.gaps.slice(0, 2).map((g, i) => (
                  <li key={i} className="flex gap-1">
                    <Target className="mt-px h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />
                    <span className="line-clamp-2">{g}</span>
                  </li>
                ))}
                {card.gaps.length === 0 ? <li className="text-slate-400">None recorded</li> : null}
              </ul>
            </div>
          </div>
          {card.nudges.length ? (
            <ul className="mt-3 space-y-1.5">
              {card.nudges.slice(0, 2).map((n, i) => (
                <li key={i} className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs">
                  <span className={cn("mr-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset", NUDGE_LOOK[n.priority].pill)}>
                    {n.priority}
                  </span>
                  <span className="font-medium text-slate-800">{n.label}</span>
                  {n.text ? <span className="mt-0.5 line-clamp-2 block text-slate-600">{n.text}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{STATUS_NOTE[card.status] || card.status}</p>
      )}

      <div className="mt-auto flex flex-wrap gap-1.5 pt-4">
        <Link href={`/report/${card.submission_id}`} className={cn(actionClass, "bg-brand-navy text-white ring-brand-navy hover:bg-brand-navy-700")}>
          <FileText className="h-3.5 w-3.5" aria-hidden />
          View report
        </Link>
        {done ? (
          <>
            <a href={reportPdfUrl(card.submission_id)} className={cn(actionClass, "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50")}>
              <Download className="h-3.5 w-3.5" aria-hidden />
              PDF
            </a>
            <button
              type="button"
              onClick={() => onWhatsApp(card)}
              className={cn(actionClass, "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50")}
              title="Simulated channel - nothing is sent"
            >
              <MessageCircle className="h-3.5 w-3.5" aria-hidden />
              WhatsApp
              <span className="rounded-full bg-amber-100 px-1 text-[9px] font-semibold uppercase text-amber-900">sim</span>
            </button>
          </>
        ) : null}
      </div>
    </article>
  );
}

export function StudentCardsGrid({ cards, onWhatsApp }: { cards: StudentCard[]; onWhatsApp: (card: StudentCard) => void }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {cards.map((c) => (
        <Card key={c.submission_id} card={c} onWhatsApp={onWhatsApp} />
      ))}
    </div>
  );
}
