import type { SubjectRollup } from "@/lib/types";
import { clampPct, fmtNumber, fraction } from "./format";
import { SectionCard } from "./primitives";

const CHART_H = 230;
const TOP = 28;
const BOTTOM = 34;
const LEFT = 34;
const BAND = 110;

function RollupChart({ rows }: { rows: SubjectRollup[] }) {
  // At least three bands wide so a one- or two-subject chart keeps sensible bar and text sizes;
  // the bars are centred in the plot.
  const bands = Math.max(rows.length, 3);
  const width = LEFT + bands * BAND + 10;
  const offset = ((bands - rows.length) * BAND) / 2;
  const plotH = CHART_H - TOP - BOTTOM;
  const best = rows.reduce((m, r) => Math.max(m, r.pct), -1);
  const y = (pct: number) => TOP + plotH * (1 - clampPct(pct) / 100);
  return (
    <svg
      viewBox={`0 0 ${width} ${CHART_H}`}
      className="mx-auto h-auto w-full [print-color-adjust:exact]"
      style={{ maxWidth: Math.round(width * 1.25) }}
      role="img"
      aria-label={`Subject performance: ${rows.map((r) => `${r.subject} ${fmtNumber(r.pct)}% of ${r.questions} questions`).join("; ")}`}
    >
      {[0, 25, 50, 75, 100].map((g) => (
        <g key={g}>
          <line x1={LEFT} x2={width - 6} y1={y(g)} y2={y(g)} className="stroke-slate-200" strokeWidth={g === 0 ? 1.2 : 0.8} />
          <text x={LEFT - 6} y={y(g) + 3.5} textAnchor="end" className="fill-slate-500 text-[10px] tabular-nums">
            {g}
          </text>
        </g>
      ))}
      {rows.map((r, i) => {
        const x = LEFT + offset + i * BAND + 18;
        const w = BAND - 36;
        const top = y(r.pct);
        return (
          <g key={r.subject}>
            <rect
              x={x}
              y={top}
              width={w}
              height={Math.max(0, CHART_H - BOTTOM - top)}
              rx={1}
              className={r.pct === best && rows.length > 1 ? "fill-brand-navy" : "fill-slate-400"}
            />
            <text x={x + w / 2} y={top - 7} textAnchor="middle" className="fill-slate-700 text-[11px] font-medium tabular-nums">
              {fmtNumber(r.pct)}% (n={r.questions})
            </text>
            <text x={x + w / 2} y={CHART_H - BOTTOM + 16} textAnchor="middle" className="fill-slate-600 text-[11px]">
              {r.subject.length > 16 ? `${r.subject.slice(0, 15)}…` : r.subject}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Subject roll-up: SVG vertical bars (percent, n=) plus the per-subject outcome table. */
export function SubjectRollupCard({ rows }: { rows: SubjectRollup[] }) {
  const single = rows.length === 1;
  return (
    <SectionCard
      id="subject-rollup"
      title="Subject roll-up"
      description="Marks earned divided by each subject's maximum. Screening results, not certified competencies."
    >
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">
          No subject data was recorded for this assessment.
        </p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2 lg:items-center print:grid-cols-2 print:items-center">
          <div>
            <RollupChart rows={rows} />
            {single ? (
              <p className="mt-2 text-center text-xs text-slate-500">
                Single-subject assessment: no cross-subject comparison is possible.
              </p>
            ) : null}
          </div>
          <div className="relative overflow-x-auto print:overflow-visible">
            <table className="w-full min-w-[30rem] print:min-w-0 border-collapse text-sm">
              <caption className="sr-only">Subject roll-up</caption>
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th scope="col" className="px-2.5 py-2 font-medium">Subject</th>
                  <th scope="col" className="px-2.5 py-2 text-right font-medium">Qs</th>
                  <th scope="col" className="px-2.5 py-2 text-right font-medium">Full</th>
                  <th scope="col" className="px-2.5 py-2 text-right font-medium">Partial</th>
                  <th scope="col" className="px-2.5 py-2 text-right font-medium">Zero</th>
                  <th scope="col" className="px-2.5 py-2 text-right font-medium">Blank</th>
                  <th scope="col" className="px-2.5 py-2 text-right font-medium">Score / max</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.subject} className="border-b border-slate-100">
                    <th scope="row" className="px-2.5 py-2 text-left font-medium text-slate-800">{r.subject}</th>
                    <td className="px-2.5 py-2 text-right tabular-nums">{r.questions}</td>
                    <td className="px-2.5 py-2 text-right tabular-nums">{r.full}</td>
                    <td className="px-2.5 py-2 text-right tabular-nums">{r.partial}</td>
                    <td className="px-2.5 py-2 text-right tabular-nums">{r.zero}</td>
                    <td className="px-2.5 py-2 text-right tabular-nums">{r.blank}</td>
                    <td className="px-2.5 py-2 text-right font-semibold tabular-nums text-brand-navy">
                      {fraction(r.score, r.max_marks)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-slate-500">
              Each subject uses a different number of questions; percentages are not comparable across differently sized
              sections.
            </p>
          </div>
        </div>
      )}
    </SectionCard>
  );
}
