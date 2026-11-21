import type { FacultySummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmt, pct } from "./format";
import { EmptyNote, Panel, theadCls, thCls } from "./states";

/** Faculty activity: names come from batch faculty leads and reviewer / intervention names (no users table). */
export function FacultyTable({ faculty }: { faculty: FacultySummary[] }) {
  const th = thCls;
  const td = "px-3 py-2 align-top text-sm text-slate-700";
  return (
    <Panel
      id="owner-faculty-title"
      title="Faculty"
      subtitle="Batch leads and reviewers. Names are free text in this PoC (no user accounts)."
    >
      {faculty.length === 0 ? (
        <EmptyNote>No faculty recorded yet. Set a faculty lead on a batch above.</EmptyNote>
      ) : (
        <div className="relative -mx-4 -my-4 overflow-x-auto sm:-mx-5">
          <table className="min-w-[860px] w-full border-collapse">
            <caption className="sr-only">Faculty activity</caption>
            <thead className={theadCls}>
              <tr>
                <th scope="col" className={cn(th, "pl-4 sm:pl-5")}>Name</th>
                <th scope="col" className={th}>Batches</th>
                <th scope="col" className={cn(th, "text-right")}>Students</th>
                <th scope="col" className={cn(th, "text-right")}>Avg %</th>
                <th scope="col" className={cn(th, "text-right")}>Reports released</th>
                <th scope="col" className={cn(th, "text-right")}>OCR reviews</th>
                <th scope="col" className={cn(th, "text-right")}>Interventions logged</th>
                <th scope="col" className={cn(th, "pr-4 text-right sm:pr-5")}>Avg release time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {faculty.map((f) => (
                <tr key={f.name}>
                  <th scope="row" className={cn(td, "pl-4 text-left font-medium text-slate-900 sm:pl-5")}>
                    {f.name}
                  </th>
                  <td className={td}>{f.batches.length ? f.batches.join(", ") : "—"}</td>
                  <td className={cn(td, "text-right tabular-nums")}>{f.students}</td>
                  <td className={cn(td, "text-right tabular-nums")}>{pct(f.average_pct)}</td>
                  <td className={cn(td, "text-right tabular-nums")}>{f.reports_released}</td>
                  <td className={cn(td, "text-right tabular-nums")}>{f.ocr_reviews}</td>
                  <td className={cn(td, "text-right tabular-nums")}>{f.interventions_logged}</td>
                  <td
                    className={cn(td, "pr-4 text-right tabular-nums sm:pr-5")}
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
    </Panel>
  );
}
