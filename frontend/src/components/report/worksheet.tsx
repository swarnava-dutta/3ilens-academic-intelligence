import Link from "next/link";
import { CalendarRange } from "lucide-react";
import { UrgencyBadge } from "@/components/shared/urgency-badge";
import type { HistoryEntry, Result } from "@/lib/types";
import { cn } from "@/lib/utils";
import { clampPct, fmtISTDate, fmtNumber, fraction, isoDateIST } from "./format";
import { Pill, SectionCard } from "./primitives";

/** History rows oldest first; when the API has none, this assessment alone. */
export function worksheetRows(result: Result): HistoryEntry[] {
  const rows = result.history.length
    ? [...result.history]
    : [
        {
          submission_id: result.submission.id,
          date: result.submission.created_at,
          batch_name: result.report_meta.batch.name,
          rubric_name: result.rubric.name,
          rubric_version: result.rubric.version,
          subjects: result.subject_rollup.map((s) => s.subject),
          score: result.total_score,
          total_marks: result.total_marks,
          pct: result.percentage,
          urgency: result.urgency,
          outcome_counts: result.outcome_counts,
          current: true,
        },
      ];
  return rows.sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.submission_id - b.submission_id);
}

const W = 320;
const H = 96;
const PAD_X = 14;
const PAD_Y = 16;

function Sparkline({ rows }: { rows: HistoryEntry[] }) {
  const times = rows.map((r) => Date.parse(r.date)).map((t, i) => (Number.isNaN(t) ? i : t));
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const span = t1 - t0 || 1;
  const pts = rows.map((r, i) => ({
    x: rows.length === 1 ? W / 2 : PAD_X + ((times[i] - t0) / span) * (W - 2 * PAD_X),
    y: PAD_Y + (1 - clampPct(r.pct) / 100) * (H - 2 * PAD_Y),
    r,
  }));
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full max-w-md [print-color-adjust:exact]"
      role="img"
      aria-label={`Score percentage by date: ${rows.map((r) => `${isoDateIST(r.date)} ${fmtNumber(r.pct)}%`).join(", ")}`}
    >
      {[0, 50, 100].map((g) => {
        const y = PAD_Y + (1 - g / 100) * (H - 2 * PAD_Y);
        return (
          <g key={g}>
            <line x1={PAD_X} x2={W - PAD_X} y1={y} y2={y} className="stroke-slate-200" strokeDasharray={g === 50 ? "3 3" : undefined} />
            <text x={2} y={y + 3} className="fill-slate-400 text-[8px]">
              {g}
            </text>
          </g>
        );
      })}
      <polyline
        points={pts.map((p) => `${p.x},${p.y}`).join(" ")}
        fill="none"
        className="stroke-brand-cyan"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      {pts.map((p) => (
        <g key={p.r.submission_id}>
          <circle cx={p.x} cy={p.y} r={p.r.current ? 4.5 : 3.5} className={p.r.current ? "fill-brand-navy" : "fill-brand-cyan"} />
          <text x={p.x} y={p.y - 7} textAnchor="middle" className="fill-slate-600 text-[8px] font-semibold">
            {fmtNumber(p.r.pct, 0)}%
          </text>
        </g>
      ))}
    </svg>
  );
}

/** Dated assessment worksheet (FR-5.8): one row per assessment of this student, oldest first. */
export function WorksheetCard({ result }: { result: Result }) {
  const rows = worksheetRows(result);
  const first = rows[0];
  const last = rows[rows.length - 1];
  const range =
    first && last && isoDateIST(first.date) !== isoDateIST(last.date)
      ? `${fmtISTDate(first.date)} - ${fmtISTDate(last.date)}`
      : first
        ? fmtISTDate(first.date)
        : "";

  return (
    <SectionCard
      id="worksheet"
      title="Dated assessment worksheet"
      description="Every assessment on record for this student (matched by student ref)."
      icon={CalendarRange}
      action={
        <Pill className="bg-slate-50 text-slate-600 ring-slate-200">
          {rows.length} {rows.length === 1 ? "assessment" : "assessments"}
          {range ? ` · ${range}` : ""}
        </Pill>
      }
    >
      <div className="relative overflow-x-auto print:overflow-visible">
        <table className="w-full min-w-[40rem] print:min-w-0 border-collapse text-sm">
          <caption className="sr-only">Assessments for this student</caption>
          <thead>
            <tr className="bg-brand-navy text-left text-xs text-white [print-color-adjust:exact]">
              <th scope="col" className="px-2.5 py-2 font-semibold">Date (IST)</th>
              <th scope="col" className="px-2.5 py-2 font-semibold">Assessment</th>
              <th scope="col" className="px-2.5 py-2 font-semibold">Subjects</th>
              <th scope="col" className="px-2.5 py-2 text-right font-semibold">Score</th>
              <th scope="col" className="px-2.5 py-2 text-right font-semibold">%</th>
              <th scope="col" className="px-2.5 py-2 font-semibold">F / P / Z / B</th>
              <th scope="col" className="px-2.5 py-2 font-semibold">Urgency</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((h) => (
              <tr
                key={`${h.submission_id}-${h.date}`}
                className={cn(
                  "border-b border-slate-100 [print-color-adjust:exact]",
                  h.current ? "bg-brand-cyan-50/70" : "even:bg-slate-50",
                )}
              >
                <td className="whitespace-nowrap px-2.5 py-2 tabular-nums text-slate-700">{isoDateIST(h.date)}</td>
                <th scope="row" className="px-2.5 py-2 text-left font-normal">
                  {h.current ? (
                    <span className="font-medium text-brand-navy">
                      {h.batch_name} · {h.rubric_name} {h.rubric_version}
                      <span className="ml-1.5 rounded bg-brand-navy px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white">
                        This report
                      </span>
                    </span>
                  ) : (
                    <Link
                      href={`/report/${h.submission_id}`}
                      className="font-medium text-brand-cyan-600 underline-offset-2 hover:text-brand-navy hover:underline"
                    >
                      {h.batch_name} · {h.rubric_name} {h.rubric_version}
                    </Link>
                  )}
                </th>
                <td className="px-2.5 py-2 text-slate-600">{h.subjects.join(", ") || "—"}</td>
                <td className="px-2.5 py-2 text-right font-semibold tabular-nums text-brand-navy">
                  {fraction(h.score, h.total_marks)}
                </td>
                <td className="px-2.5 py-2 text-right tabular-nums">{fmtNumber(h.pct)}%</td>
                <td className="whitespace-nowrap px-2.5 py-2 font-mono text-xs text-slate-600">
                  {h.outcome_counts
                    ? `${h.outcome_counts.full} / ${h.outcome_counts.partial} / ${h.outcome_counts.zero} / ${h.outcome_counts.blank}`
                    : "—"}
                </td>
                <td className="px-2.5 py-2">
                  <UrgencyBadge urgency={h.urgency} size="sm" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 [print-color-adjust:exact]">
        {rows.length >= 2 ? (
          <Sparkline rows={rows} />
        ) : (
          <p className="text-sm text-slate-500">Longitudinal view needs at least 2 assessments.</p>
        )}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-slate-500">
        Different papers/rubrics are not equated for difficulty; dates cannot establish an improvement trend.
      </p>
    </SectionCard>
  );
}
