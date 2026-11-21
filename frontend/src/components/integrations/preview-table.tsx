import { CheckCircle2, Clock, Mic } from "lucide-react";
import { UrgencyBadge } from "@/components/shared/urgency-badge";
import { fmt, fmtDate, NET_TOOLTIP, pct } from "@/components/owner/format";
import { DemoTag } from "@/components/owner/states";
import type { LmsResultRow } from "@/lib/types";

/** Compact table of LMS export rows (GET /api/lms/v1/results). */
export function LmsPreviewTable({ rows }: { rows: LmsResultRow[] }) {
  if (!rows.length) {
    return (
      <p className="rounded-xl bg-slate-50 px-4 py-4 text-center text-sm text-slate-600">
        The key works, but there are no results to export yet (released or provisional).
      </p>
    );
  }
  return (
    <div className="relative max-h-96 overflow-auto rounded-xl ring-1 ring-slate-200">
      <table className="w-full min-w-[820px] border-collapse text-sm">
        <caption className="sr-only">First {rows.length} rows of the LMS results export</caption>
        <thead className="sticky top-0 bg-slate-50">
          <tr className="text-left text-xs font-semibold uppercase tracking-wide text-slate-600">
            <th scope="col" className="px-3 py-2">Student</th>
            <th scope="col" className="px-3 py-2">Batch · test</th>
            <th scope="col" className="px-3 py-2 text-right">Score</th>
            <th scope="col" className="px-3 py-2">Urgency</th>
            <th scope="col" className="px-3 py-2">Status</th>
            <th scope="col" className="px-3 py-2">Evaluated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.submission_id} className="align-top">
              <td className="px-3 py-1.5">
                <span className="font-medium text-slate-800">{r.student_name}</span>
                <span className="block text-xs text-slate-600">{r.student_ref}</span>
              </td>
              <td className="px-3 py-1.5 text-slate-700">
                <span className="flex flex-wrap items-center gap-1">
                  {r.batch_name} {r.is_demo ? <DemoTag /> : null}
                </span>
                <span className="block text-xs text-slate-600">
                  {r.test_name} {r.test_version}
                </span>
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums" title={NET_TOOLTIP}>
                <span className="font-semibold text-brand-navy">
                  {fmt(r.score)} / {fmt(r.total_marks)}
                </span>
                <span className="block text-xs text-slate-600">{pct(r.percentage, 1)}</span>
              </td>
              <td className="px-3 py-1.5">
                <UrgencyBadge urgency={r.urgency} size="sm" />
              </td>
              <td className="px-3 py-1.5 text-xs text-slate-700">
                <span className="inline-flex items-center gap-1">
                  {r.release_status === "RELEASED" ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-lime-700" aria-hidden />
                  ) : (
                    <Clock className="h-3.5 w-3.5 text-amber-700" aria-hidden />
                  )}
                  {r.release_status === "RELEASED" ? "Released" : "Provisional"}
                </span>
                {r.input_kind === "voice" ? (
                  <span className="mt-0.5 flex items-center gap-1">
                    <Mic className="h-3.5 w-3.5" aria-hidden /> Voice
                  </span>
                ) : null}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap text-xs text-slate-700">{fmtDate(r.evaluated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
