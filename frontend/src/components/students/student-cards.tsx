"use client";

import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";
import { UrgencyBadge } from "@/components/shared/urgency-badge";
import { reportPdfUrl } from "@/lib/api";
import type { StudentCard, SubmissionStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { TONE, fmtNumber, fraction, toneFor } from "@/components/report/format";

const STATUS_NOTE: Record<SubmissionStatus, string> = {
  PENDING: "Queued for processing.",
  PROCESSING: "In the pipeline now.",
  COMPLETED: "",
  FAILED: "Processing failed: open the report to retry.",
  HUMAN_REVIEW_REQUIRED: "Low OCR confidence: waiting for faculty transcript review.",
};

const TH = "whitespace-nowrap px-3 py-2 text-left text-xs font-medium text-slate-500";
const TD = "px-3 py-2.5 align-top text-sm text-slate-700";
const TAG = "inline-flex items-center whitespace-nowrap rounded-sm border px-1.5 text-xs";
const ACTION =
  "inline-flex h-8 items-center rounded-md px-2 text-[13px] font-medium text-brand-cyan-600 transition-colors hover:bg-slate-50 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan";

/** Weakest three topics as "Genetics 32%", with a tone square. */
function WeakTopics({ card }: { card: StudentCard }) {
  const topics = [...card.topic_mastery].sort((a, b) => a.mastery - b.mastery).slice(0, 3);
  if (topics.length === 0) return <span className="text-slate-400">—</span>;
  return (
    <ul className="space-y-0.5 text-[13px]" aria-label="Weakest topics">
      {topics.map((t) => (
        <li key={t.topic} className="flex items-center gap-1.5" title={`${t.topic} (${t.subject})`}>
          <span className={cn("h-2 w-2 shrink-0 rounded-sm [print-color-adjust:exact]", TONE[toneFor(t.mastery)].fill)} aria-hidden />
          <span className="max-w-40 truncate">{t.topic}</span>
          <span className="ml-auto pl-2 tabular-nums text-slate-500">{fmtNumber(t.mastery, 0)}%</span>
        </li>
      ))}
    </ul>
  );
}

function FirstItems({ items }: { items: string[] }) {
  if (items.length === 0) return <span className="text-slate-400">None recorded</span>;
  return (
    <ul className="space-y-0.5 text-[13px]" title={items.join("\n")}>
      {items.slice(0, 2).map((s, i) => (
        <li key={i} className="line-clamp-2">
          {s}
        </li>
      ))}
    </ul>
  );
}

function Row({ card, onWhatsApp }: { card: StudentCard; onWhatsApp: (card: StudentCard) => void }) {
  const done = card.status === "COMPLETED";
  const topNudge = card.nudges[0];
  return (
    <tr className="hover:bg-slate-50/70">
      <th scope="row" className={cn(TD, "text-left font-normal")}>
        <Link
          href={`/report/${card.submission_id}`}
          className="rounded-sm font-medium text-brand-navy hover:text-brand-cyan-600 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
        >
          {card.student_name}
        </Link>
        <p className="text-xs text-slate-500">
          {card.batch.name}
          {card.batch.exam_type ? ` · ${card.batch.exam_type}` : ""} · {card.test.name} {card.test.version}
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-1.5">
          {card.is_demo ? (
            <span className={cn(TAG, "border-amber-300 text-amber-800")}>Synthetic demo</span>
          ) : (
            <span className={cn(TAG, "border-slate-300 text-slate-600")}>Live upload</span>
          )}
          {card.student_ref ? <span className="font-mono text-xs text-slate-500">{card.student_ref}</span> : null}
        </p>
        <div className="-ml-2 mt-1 flex flex-wrap items-center">
          <Link href={`/report/${card.submission_id}`} className={ACTION}>
            Report
          </Link>
          {done ? (
            <>
              <a href={reportPdfUrl(card.submission_id)} className={ACTION}>
                PDF
              </a>
              <button
                type="button"
                onClick={() => onWhatsApp(card)}
                className={ACTION}
                title="Simulated channel - nothing is sent"
                aria-label={`WhatsApp ${card.student_name} (simulated)`}
              >
                WhatsApp<span className="ml-1 text-xs font-normal text-slate-500">sim</span>
              </button>
            </>
          ) : null}
        </div>
      </th>
      <td className={TD}>
        {done ? <UrgencyBadge urgency={card.urgency} size="sm" /> : <StatusBadge status={card.status} className="whitespace-normal" />}
        {done && card.release_status ? (
          <p className="mt-1 text-xs text-slate-500">{card.release_status === "RELEASED" ? "Released" : "Provisional"}</p>
        ) : null}
      </td>
      {done ? (
        <>
          <td className={cn(TD, "text-right whitespace-nowrap tabular-nums")}>
            <span className="font-semibold text-brand-navy">{fraction(card.score, card.total_marks)}</span>
            <p className="text-xs text-slate-500">{card.percentage === null ? "" : `${fmtNumber(card.percentage)}%`}</p>
          </td>
          <td className={TD}>
            <WeakTopics card={card} />
          </td>
          <td className={TD}>
            <FirstItems items={card.strengths} />
          </td>
          <td className={TD}>
            <FirstItems items={card.gaps} />
          </td>
          <td className={cn(TD, "text-[13px]")}>
            {topNudge ? (
              <>
                <span className="font-medium text-slate-800">{topNudge.label}</span>
                <span className="ml-1 text-xs text-slate-500">({topNudge.priority})</span>
                {topNudge.text ? (
                  <span className="mt-0.5 line-clamp-2 text-slate-600" title={topNudge.text}>
                    {topNudge.text}
                  </span>
                ) : null}
                {card.nudges.length > 1 ? (
                  <span className="block text-xs tabular-nums text-slate-500">+{card.nudges.length - 1} more</span>
                ) : null}
              </>
            ) : (
              <span className="text-slate-400">—</span>
            )}
          </td>
        </>
      ) : (
        <td colSpan={5} className={cn(TD, "text-slate-600")}>
          {STATUS_NOTE[card.status] || card.status}
        </td>
      )}
    </tr>
  );
}

/** Dense results table: one row per submission, most useful fields only. */
export function StudentCardsGrid({ cards, onWhatsApp }: { cards: StudentCard[]; onWhatsApp: (card: StudentCard) => void }) {
  return (
    <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
      <table className="w-full min-w-[1160px] table-fixed border-collapse">
        <colgroup>
          <col className="w-56" />
          <col className="w-28" />
          <col className="w-20" />
          <col className="w-60" />
          <col />
          <col />
          <col className="w-60" />
        </colgroup>
        <caption className="sr-only">Students and their latest results</caption>
        <thead className="border-b border-slate-200 bg-slate-50">
          <tr>
            <th scope="col" className={TH}>
              Student
            </th>
            <th scope="col" className={TH}>
              Status
            </th>
            <th scope="col" className={cn(TH, "text-right")}>
              Score
            </th>
            <th scope="col" className={TH}>
              Weakest topics
            </th>
            <th scope="col" className={TH}>
              Strengths
            </th>
            <th scope="col" className={TH}>
              Gaps
            </th>
            <th scope="col" className={TH}>
              Top nudge
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {cards.map((c) => (
            <Row key={c.submission_id} card={c} onWhatsApp={onWhatsApp} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
