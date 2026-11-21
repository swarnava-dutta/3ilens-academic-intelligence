import { UserCheck } from "lucide-react";
import { Card, CardHeader } from "@/components/cohort/card";
import type { FacultySummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmt, pct } from "./format";

/** Faculty activity: names come from batch faculty leads and reviewer / intervention names (no users table). */
export function FacultyTable({ faculty }: { faculty: FacultySummary[] }) {
  const th = "px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-600 whitespace-nowrap";
  const td = "px-3 py-2.5 align-top text-sm text-slate-700";
  return (
    <Card aria-labelledby="owner-faculty-title">
      <CardHeader
        id="owner-faculty-title"
        icon={UserCheck}
        title="Faculty"
        subtitle="Batch leads and reviewers. Names are free text in this PoC (no user accounts)."
      />
      {faculty.length === 0 ? (
        <p className="mt-4 rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-600">
          No faculty recorded yet. Set a faculty lead on a batch above.
        </p>
      ) : (
        <div className="relative mt-4 -mx-5 overflow-x-auto sm:-mx-6">
          <table className="min-w-[860px] w-full border-collapse">
            <caption className="sr-only">Faculty activity</caption>
            <thead className="border-y border-slate-200 bg-slate-50">
              <tr>
                <th scope="col" className={cn(th, "pl-5 sm:pl-6")}>Name</th>
                <th scope="col" className={th}>Batches</th>
                <th scope="col" className={cn(th, "text-right")}>Students</th>
                <th scope="col" className={cn(th, "text-right")}>Avg %</th>
                <th scope="col" className={cn(th, "text-right")}>Reports released</th>
                <th scope="col" className={cn(th, "text-right")}>OCR reviews</th>
                <th scope="col" className={cn(th, "text-right")}>Interventions logged</th>
                <th scope="col" className={cn(th, "pr-5 text-right sm:pr-6")}>Avg release time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {faculty.map((f) => (
                <tr key={f.name}>
                  <th scope="row" className={cn(td, "pl-5 text-left font-semibold text-brand-navy sm:pl-6")}>
                    {f.name}
                  </th>
                  <td className={td}>{f.batches.length ? f.batches.join(", ") : "—"}</td>
                  <td className={cn(td, "text-right tabular-nums")}>{f.students}</td>
                  <td className={cn(td, "text-right tabular-nums")}>{pct(f.average_pct)}</td>
                  <td className={cn(td, "text-right tabular-nums")}>{f.reports_released}</td>
                  <td className={cn(td, "text-right tabular-nums")}>{f.ocr_reviews}</td>
                  <td className={cn(td, "text-right tabular-nums")}>{f.interventions_logged}</td>
                  <td
                    className={cn(td, "pr-5 text-right tabular-nums sm:pr-6")}
                    title="Average hours from evaluation to release for the reports this person released"
                  >
                    {f.avg_release_hours === null ? "—" : `${fmt(f.avg_release_hours)} h`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
