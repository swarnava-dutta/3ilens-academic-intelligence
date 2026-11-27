"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { Sparkline } from "@/components/charts/sparkline";
import { UrgencyBadge } from "@/components/shared/urgency-badge";
import type { RosterPending, RosterRow, SubmissionStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ActionStatus, DeltaChip, NameTags, type DemoTag } from "./bits";
import {
  fmtDay,
  fmtMarks,
  fmtMastery,
  fmtPct,
  looksLikeFileName,
  marksWord,
  masteryFill,
  previousKind,
  rowKey,
  shortLabel,
  shortOf,
  shortReason,
  SMALL_TEST_QUESTIONS,
  URGENCY_HEX,
  WEAK_MASTERY,
} from "./format";

const TH = "px-3 py-2 text-left text-xs font-medium text-slate-500";
const TD = "px-3 py-3 align-top text-sm text-slate-700";
const LINK_TAG =
  "inline-flex items-center rounded-sm px-1.5 text-[11px] font-medium hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan";

const PENDING_NOTE: Record<SubmissionStatus, string> = {
  HUMAN_REVIEW_REQUIRED: "Held for review - open the sheet",
  FAILED: "Processing failed - open the sheet to retry",
  PROCESSING: "Being marked now",
  PENDING: "Queued for marking",
  COMPLETED: "Graded result unavailable - open the sheet",
};

const WAITING_WORD: Record<SubmissionStatus, string> = {
  HUMAN_REVIEW_REQUIRED: "held for review",
  FAILED: "failed",
  PROCESSING: "being marked",
  PENDING: "queued",
  COMPLETED: "not readable",
};

export type RosterDetail = "technique" | "release" | "waiting" | null;

export interface RosterTableProps {
  rows: RosterRow[];
  /** Which group gets the inline tag (the minority of real vs demo records), or none. */
  tag: DemoTag;
  /** Test names with 2+ versions in scope (their version is shown). */
  versioned: Set<string>;
  onOpen: (row: RosterRow, opener: HTMLElement) => void;
  onLog: (row: RosterRow) => void;
  /** Extra line under the latest paper for the active view. */
  detail?: RosterDetail;
}

/** Exam-technique line in the report's words: "Skipping too many · 47 of 178 blank · −26 marks to
 * wrong answers · risky: Electrostatics". */
function techniqueText(row: RosterRow): string | null {
  const nm = row.negative_marking;
  if (!nm) return row.latest ? "No negatively marked MCQs" : null;
  const lead =
    nm.verdict === "guessing" ? "Wrong answers costing marks" : nm.verdict === "skipping" ? "Skipping too many" : "Strategy working";
  const parts = [lead, `${nm.blank} of ${nm.items} blank`, `−${marksWord(nm.marks_lost)} to wrong answers`];
  if (nm.risky_topics.length) {
    const more = nm.risky_topics.length > 2 ? ` +${nm.risky_topics.length - 2}` : "";
    parts.push(`risky: ${nm.risky_topics.slice(0, 2).join(", ")}${more}`);
  }
  return parts.join(" · ");
}

function releaseText(row: RosterRow): string | null {
  if (!row.latest) return null;
  return row.latest.release_status === "RELEASED" ? "Released" : "Provisional - not released";
}

function WaitingLinks({ waiting }: { waiting: RosterPending[] }) {
  if (waiting.length === 0) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {waiting.slice(0, 3).map((w) => (
        <Link key={w.submission_id} href={`/report/${w.submission_id}`} className={cn(LINK_TAG, "bg-amber-50 text-amber-900")}>
          Sheet {WAITING_WORD[w.status]} · uploaded {fmtDay(w.date)}
        </Link>
      ))}
      {waiting.length > 3 ? <span className="text-[11px] text-slate-500">+{waiting.length - 3} more</span> : null}
    </span>
  );
}

function DetailLine({ row, detail }: { row: RosterRow; detail: RosterDetail }) {
  if (detail === "waiting") {
    // The newest pending sheet already has its own tag below the paper.
    const rest = row.waiting.filter((w) => w.submission_id !== row.pending?.submission_id);
    return <WaitingLinks waiting={rest} />;
  }
  const text = detail === "technique" ? techniqueText(row) : detail === "release" ? releaseText(row) : null;
  if (!text) return null;
  const warn =
    detail === "technique"
      ? row.negative_marking?.verdict === "guessing" || row.negative_marking?.verdict === "skipping"
      : row.latest?.release_status !== "RELEASED";
  return <p className={cn("mt-0.5 text-xs", warn ? "text-amber-800" : "text-slate-600")}>{text}</p>;
}

function weakestLine(row: RosterRow) {
  const weakest = row.topics[0];
  if (!weakest) return null;
  const more = row.weak_count - (weakest.mastery < WEAK_MASTERY ? 1 : 0);
  return { weakest, more };
}

/** Tooltip for the change: the paper it is measured against, or why it is not a trend. */
export function trendTitle(row: RosterRow): string | undefined {
  const prev = row.previous;
  if (!prev) return "First paper - the trend appears after the next one";
  const latest = row.latest;
  if (!prev.comparable && latest) {
    return (
      `Not a trend: ${previousKind(prev)} is a different kind of test from ${shortOf(latest)} ` +
      `(${latest.questions} Qs, ${fmtMarks(latest.total_marks)} marks). Earlier score ${fmtPct(prev.pct)}, uploaded ${fmtDay(prev.date)}.`
    );
  }
  return `vs ${shortOf(prev)} (uploaded ${fmtDay(prev.date)}, ${fmtMarks(prev.total_marks)} marks): ${fmtPct(prev.pct)}`;
}

function trendSentence(row: RosterRow): string {
  if (!row.latest || !row.previous || row.delta_pct === null) return "First paper.";
  if (!row.previous.comparable) return "The earlier paper is a different kind of test, so there is no trend.";
  const dir = row.delta_pct > 0 ? "up" : row.delta_pct < 0 ? "down" : "unchanged,";
  return `Score ${fmtPct(row.previous.pct)} to ${fmtPct(row.latest.pct)}, ${dir} ${Math.abs(row.delta_pct).toFixed(1)} points.`;
}

function NewerTags({ row }: { row: RosterRow }) {
  const newer = row.newer;
  const pending = row.pending;
  if (!newer && !pending) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {newer ? (
        <Link
          href={`/report/${newer.submission_id}`}
          className={cn(LINK_TAG, "bg-slate-100 text-slate-700")}
          title={`${newer.test_name} · uploaded ${fmtDay(newer.date)} · outside the current batch / test filter`}
        >
          Newer: {shortOf(newer)} {fmtPct(newer.pct)} (outside filter)
        </Link>
      ) : null}
      {pending ? (
        <Link href={`/report/${pending.submission_id}`} className={cn(LINK_TAG, "bg-amber-50 text-amber-900")}>
          Newer sheet {WAITING_WORD[pending.status]}
        </Link>
      ) : null}
    </span>
  );
}

function PaperCell({ row, versioned, detail }: { row: RosterRow; versioned: Set<string>; detail: RosterDetail }) {
  const latest = row.latest;
  if (!latest) return null;
  return (
    <>
      <p
        className="truncate font-medium text-slate-800"
        title={`${latest.test_name} ${latest.test_version} · uploaded ${fmtDay(latest.date)}`.trim()}
      >
        {shortLabel(latest, versioned)}
      </p>
      <p className="mt-0.5 text-xs tabular-nums text-slate-500">
        {fmtDay(latest.date)} · {latest.questions} Qs
        {latest.questions < SMALL_TEST_QUESTIONS ? <span className="text-amber-800"> · small test</span> : null}
      </p>
      <DetailLine row={row} detail={detail} />
      <NewerTags row={row} />
    </>
  );
}

function WeakestCell({ row }: { row: RosterRow }) {
  const w = weakestLine(row);
  if (!w) return <span className="text-slate-500">—</span>;
  const whole = w.weakest.subject_level ? " · whole-subject score (the paper had no topic tags)" : "";
  return (
    <div className="text-[13px]">
      <p className="flex min-w-0 items-center gap-1.5" title={`${w.weakest.topic} (${w.weakest.subject}) · ${w.weakest.n} questions${whole}`}>
        <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-sm [print-color-adjust:exact]", masteryFill(w.weakest.mastery))} />
        <span className="min-w-0 truncate">{w.weakest.topic}</span>
        <span className="ml-auto shrink-0 pl-1 tabular-nums text-slate-600">{fmtMastery(w.weakest.mastery)}</span>
      </p>
      {w.more > 0 ? (
        <p className="mt-0.5 text-xs tabular-nums text-slate-500">
          +{w.more} more below {WEAK_MASTERY}%
        </p>
      ) : null}
    </div>
  );
}

function NameButton({ row, onOpen }: { row: RosterRow; onOpen: RosterTableProps["onOpen"] }) {
  return (
    <button
      type="button"
      onClick={(e) => onOpen(row, e.currentTarget)}
      className="max-w-full truncate rounded-sm text-left font-medium text-brand-navy hover:text-brand-cyan-600 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
    >
      {row.student_name}
    </button>
  );
}

function PendingNote({ row }: { row: RosterRow }) {
  if (!row.pending) {
    return <span className="text-slate-600">No graded paper yet (oral check only).</span>;
  }
  return (
    <Link
      href={`/report/${row.pending.submission_id}`}
      className="inline-flex items-center gap-1 rounded-sm font-medium text-amber-800 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
    >
      {PENDING_NOTE[row.pending.status]}
      <span className="font-normal text-slate-500">· uploaded {fmtDay(row.pending.date)}</span>
      <ChevronRight className="h-4 w-4" aria-hidden />
    </Link>
  );
}

function SubLine({ row }: { row: RosterRow }) {
  return (
    <p className="max-w-full truncate text-xs text-slate-500">
      {row.batch.name} · <span className="font-mono">{row.student_ref}</span>
    </p>
  );
}

function TableRow({ row, tag, versioned, onOpen, onLog, detail = null }: { row: RosterRow } & Omit<RosterTableProps, "rows">) {
  const latest = row.latest;
  const w = weakestLine(row);
  const reason = shortReason(row);
  return (
    <tr className="hover:bg-slate-50/70 print:break-inside-avoid">
      <th scope="row" className={cn(TD, "text-left font-normal")}>
        <div className="flex min-w-0 flex-col items-start gap-0.5">
          <div className="flex max-w-full min-w-0 items-center">
            <NameButton row={row} onOpen={onOpen} />
            <NameTags row={row} tag={tag} fileName={looksLikeFileName(row.student_name)} />
          </div>
          <SubLine row={row} />
          {w ? (
            <p className="max-w-full truncate text-xs text-slate-500 lg:hidden print:hidden">
              Weakest: {w.weakest.topic} {fmtMastery(w.weakest.mastery)}
              {w.more > 0 ? ` · +${w.more} more` : ""}
            </p>
          ) : null}
        </div>
      </th>
      {latest ? (
        <>
          <td className={TD}>
            <PaperCell row={row} versioned={versioned} detail={detail} />
          </td>
          <td className={cn(TD, "text-right tabular-nums")}>
            <p className="whitespace-nowrap font-semibold text-brand-navy">
              {fmtMarks(latest.score)}/{fmtMarks(latest.total_marks)}
            </p>
            <p className="text-xs text-slate-500">{fmtPct(latest.pct)}</p>
            <DeltaChip delta={row.delta_pct} trend={row.trend} title={trendTitle(row)} className="mt-0.5 lg:hidden print:hidden" />
          </td>
          <td className={cn(TD, "hidden lg:table-cell print:table-cell")} title={trendTitle(row)}>
            <div className="flex items-center gap-2">
              {row.spark.length >= 2 ? (
                <Sparkline values={row.spark.map((p) => p.pct)} lastColor={URGENCY_HEX[latest.urgency]} width={52} />
              ) : null}
              <DeltaChip delta={row.delta_pct} trend={row.trend} />
            </div>
            <span className="sr-only">{trendSentence(row)}</span>
          </td>
          <td className={TD}>
            <UrgencyBadge urgency={latest.urgency} reasons={latest.urgency_reasons} size="sm" />
            {reason ? <p className="mt-1 text-xs font-medium text-amber-800">{reason}</p> : null}
          </td>
          <td className={cn(TD, "hidden lg:table-cell print:table-cell")}>
            <WeakestCell row={row} />
          </td>
          <td className={TD}>
            <ActionStatus row={row} onLog={() => onLog(row)} />
          </td>
        </>
      ) : (
        <>
          <td colSpan={4} className={cn(TD, "lg:hidden print:hidden")}>
            <PendingNote row={row} />
          </td>
          <td colSpan={6} className={cn(TD, "hidden lg:table-cell print:table-cell")}>
            <PendingNote row={row} />
          </td>
        </>
      )}
    </tr>
  );
}

function MobileCard({ row, tag, versioned, onOpen, detail = null }: { row: RosterRow } & Omit<RosterTableProps, "rows" | "onLog">) {
  const latest = row.latest;
  const w = weakestLine(row);
  const reason = shortReason(row);
  return (
    <li>
      <button
        type="button"
        onClick={(e) => onOpen(row, e.currentTarget)}
        className="block w-full px-4 py-3 text-left transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-cyan"
      >
        <span className="flex items-start justify-between gap-2">
          <span className="min-w-0">
            <span className="flex min-w-0 items-center">
              <span className="truncate font-medium text-brand-navy">{row.student_name}</span>
              <NameTags row={row} tag={tag} fileName={looksLikeFileName(row.student_name)} />
            </span>
            <span className="block truncate text-xs text-slate-500">
              {row.batch.name} · <span className="font-mono">{row.student_ref}</span>
            </span>
          </span>
          {latest ? (
            <UrgencyBadge urgency={latest.urgency} reasons={latest.urgency_reasons} size="sm" className="mt-0.5 shrink-0" />
          ) : (
            <span className="mt-0.5 shrink-0 rounded-sm bg-amber-50 px-1 text-[11px] font-medium text-amber-900">
              {row.pending?.status === "HUMAN_REVIEW_REQUIRED" ? "Held" : row.pending ? "Not graded" : "Oral only"}
            </span>
          )}
        </span>
        {latest ? (
          <>
            <span className="mt-1.5 block truncate text-[13px] text-slate-600">
              {shortLabel(latest, versioned)} · {fmtDay(latest.date)} · {latest.questions} Qs
              {latest.questions < SMALL_TEST_QUESTIONS ? " · small test" : ""}
            </span>
            <span className="mt-1 flex flex-wrap items-center gap-x-2 text-sm tabular-nums">
              <span className="font-semibold text-brand-navy">
                {fmtMarks(latest.score)}/{fmtMarks(latest.total_marks)}
              </span>
              <span className="text-slate-600">{fmtPct(latest.pct)}</span>
              <DeltaChip delta={row.delta_pct} trend={row.trend} />
              {reason ? <span className="text-xs font-medium text-amber-800">{reason}</span> : null}
            </span>
            {detail === "technique" || detail === "release" ? <DetailLine row={row} detail={detail} /> : null}
            {w ? (
              <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[13px] text-slate-600">
                <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-sm", masteryFill(w.weakest.mastery))} />
                <span className="min-w-0 truncate">Weakest: {w.weakest.topic}</span>
                <span className="shrink-0 tabular-nums">{fmtMastery(w.weakest.mastery)}</span>
              </span>
            ) : null}
            <span className="mt-1 block">
              <ActionStatus row={row} compact />
            </span>
            {row.newer ? (
              <span className="mt-1 block text-xs text-slate-600">
                Newer: {shortOf(row.newer)} {fmtPct(row.newer.pct)} (outside filter)
              </span>
            ) : null}
            {row.pending ? (
              <span className="mt-1 block text-xs font-medium text-amber-800">Newer sheet not graded yet</span>
            ) : null}
          </>
        ) : (
          <span className="mt-1.5 block text-[13px] text-amber-800">
            {row.pending ? `${PENDING_NOTE[row.pending.status].split(" - ")[0]} · uploaded ${fmtDay(row.pending.date)}` : "No graded paper yet"}
          </span>
        )}
      </button>
    </li>
  );
}

/** One row per student: a table from 640px (fewer columns below 1024px), a card list on phones. */
export function RosterTable({ rows, tag, versioned, onOpen, onLog, detail = null }: RosterTableProps) {
  return (
    <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
      <table className="hidden w-full table-fixed border-collapse sm:table print:table">
        <caption className="sr-only">
          Students, one row each: latest paper, score, change since the previous paper, status, weakest topic and the
          action logged since the latest paper.
        </caption>
        <thead className="border-b border-slate-200 bg-slate-50">
          <tr>
            <th scope="col" className={cn(TH, "w-[28%] lg:w-[18%]")}>
              Student
            </th>
            <th scope="col" className={cn(TH, "w-[22%] lg:w-[15%]")}>
              Latest paper
            </th>
            <th scope="col" className={cn(TH, "w-20 text-right lg:w-[5.5rem]")}>
              Score
            </th>
            <th scope="col" className={cn(TH, "hidden w-32 lg:table-cell xl:w-36 print:table-cell")}>
              Trend
            </th>
            <th scope="col" className={cn(TH, "w-28 lg:w-32")}>
              Status
            </th>
            <th scope="col" className={cn(TH, "hidden w-40 lg:table-cell xl:w-52 print:table-cell")}>
              Weakest topic
            </th>
            <th scope="col" className={TH}>
              Action since latest
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <TableRow key={rowKey(r)} row={r} tag={tag} versioned={versioned} onOpen={onOpen} onLog={onLog} detail={detail} />
          ))}
        </tbody>
      </table>
      <ul className="divide-y divide-slate-100 sm:hidden print:hidden" aria-label="Students">
        {rows.map((r) => (
          <MobileCard key={rowKey(r)} row={r} tag={tag} versioned={versioned} onOpen={onOpen} detail={detail} />
        ))}
      </ul>
    </div>
  );
}
