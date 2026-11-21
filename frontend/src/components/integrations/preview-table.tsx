import { UrgencyBadge } from "@/components/shared/urgency-badge";
import { fmt, fmtDate, NET_TOOLTIP, pct } from "@/components/owner/format";
import { DemoTag, EmptyNote, theadCls, thCls } from "@/components/owner/states";
import { cn } from "@/lib/utils";
import type { LmsResultRow } from "@/lib/types";

/** Compact table of LMS export rows (GET /api/lms/v1/results). */
export function LmsPreviewTable({ rows }: { rows: LmsResultRow[] }) {
  if (!rows.length) {
    return (
      <EmptyNote>The key works, but there are no results to export yet (released or provisional).</EmptyNote>
    );
  }
  return (
    <div className="relative max-h-96 overflow-auto rounded-md border border-slate-200">
      <table className="w-full min-w-[820px] border-collapse text-sm">
        <caption className="sr-only">First {rows.length} rows of the LMS results export</caption>
        <thead className={cn(theadCls, "sticky top-0")}>
          <tr>
            <th scope="col" className={thCls}>Student</th>
            <th scope="col" className={thCls}>Batch · test</th>
            <th scope="col" className={cn(thCls, "text-right")}>Score</th>
            <th scope="col" className={thCls}>Urgency</th>
            <th scope="col" className={thCls}>Status</th>
            <th scope="col" className={thCls}>Evaluated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {rows.map((r) => (
            <tr key={r.submission_id} className="align-top">
              <td className="px-3 py-1.5">
                <span className="text-slate-800">{r.student_name}</span>
                <span className="block font-mono text-xs text-slate-500">{r.student_ref}</span>
              </td>
              <td className="px-3 py-1.5 text-slate-700">
                <span className="flex flex-wrap items-center gap-1">
                  {r.batch_name} {r.is_demo ? <DemoTag /> : null}
                </span>
                <span className="block text-xs text-slate-500">
                  {r.test_name} {r.test_version}
                </span>
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums" title={NET_TOOLTIP}>
                <span className="font-medium text-slate-900">
                  {fmt(r.score)} / {fmt(r.total_marks)}
                </span>
                <span className="block text-xs text-slate-500">{pct(r.percentage, 1)}</span>
              </td>
              <td className="px-3 py-1.5">
                <UrgencyBadge urgency={r.urgency} size="sm" />
              </td>
              <td className="px-3 py-1.5 text-xs text-slate-700">
                <span className={r.release_status === "RELEASED" ? "text-lime-800" : "text-amber-800"}>
                  {r.release_status === "RELEASED" ? "Released" : "Provisional"}
                </span>
                {r.input_kind === "voice" ? <span className="mt-0.5 block text-slate-500">Voice</span> : null}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap text-xs text-slate-700">{fmtDate(r.evaluated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
