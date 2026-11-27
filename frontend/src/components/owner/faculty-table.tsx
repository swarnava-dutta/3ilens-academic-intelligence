import type { FacultySummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmt } from "./format";
import { ageText, ChangeText } from "./owner-ui";
import { EmptyNote, theadCls, thCls } from "./states";

function hours(f: FacultySummary): string {
  const v = f.median_release_hours ?? f.avg_release_hours;
  return v === null || v === undefined ? "—" : `${fmt(v)} h`;
}

/** "6 released · 19.5 h" (reports this person released, median hours from grading to release). */
function Releases({ f }: { f: FacultySummary }) {
  const n = f.reports_released ?? 0;
  if (n === 0) return <span className="text-slate-500">none released</span>;
  return (
    <span className="whitespace-nowrap tabular-nums" title={`${n} report${n === 1 ? "" : "s"} released by this person · median hours from grading to release`}>
      {n} released · {hours(f)}
    </span>
  );
}

function Change({ f }: { f: FacultySummary }) {
  if (!f.progress_students) return <span className="text-slate-500">—</span>;
  return (
    <span title="Same students, previous vs latest whole-class test (different papers, indicative)">
      <ChangeText value={f.progress_change} suffix="" /> <span className="text-xs text-slate-500">({f.progress_students})</span>
    </span>
  );
}

function Awaiting({ f }: { f: FacultySummary }) {
  const n = f.awaiting_release ?? 0;
  if (!f.batches.length) return <span className="text-slate-500">—</span>;
  return (
    <span className="whitespace-nowrap tabular-nums">
      {n}
      {n > 0 && f.oldest_awaiting_days !== null && f.oldest_awaiting_days !== undefined ? (
        <span className={cn("ml-1 text-xs", f.oldest_awaiting_days >= 2 ? "text-amber-800" : "text-slate-500")}>
          ({ageText(f.oldest_awaiting_days, true)})
        </span>
      ) : null}
    </span>
  );
}

function RiskOpen({ f }: { f: FacultySummary }) {
  if (!f.batches.length) return <span className="text-slate-500">—</span>;
  const open = f.at_risk_unactioned ?? 0;
  return (
    <span className="tabular-nums" title={`${f.at_risk ?? 0} at risk, ${open} with no action since their latest test`}>
      <span className="whitespace-nowrap">{f.at_risk ?? 0} at risk</span> ·{" "}
      <span className={cn("whitespace-nowrap", open > 0 ? "font-medium text-rose-700" : "text-slate-700")}>{open} no action</span>
    </span>
  );
}

function Actions({ f }: { f: FacultySummary }) {
  if (!f.interventions_logged) return <span className="text-slate-500">none logged</span>;
  return (
    <span className="tabular-nums" title="Actions logged · measured at a later test · improved 5+ mastery points">
      {f.interventions_logged} logged · {f.actions_measured ?? 0} measured · {f.actions_improved ?? 0} improved
    </span>
  );
}

/**
 * Faculty follow-through: what each lead's batches need (at-risk students with no action,
 * reports waiting) and what they have done (actions, releases). Names are free text (no accounts).
 */
export function FacultyTable({ faculty }: { faculty: FacultySummary[] }) {
  const rows = faculty
    .slice()
    .sort(
      (a, b) =>
        (b.at_risk_unactioned ?? 0) - (a.at_risk_unactioned ?? 0) ||
        (b.awaiting_release ?? 0) - (a.awaiting_release ?? 0) ||
        a.name.localeCompare(b.name),
    );
  const showChecked = rows.some((f) => f.ocr_reviews > 0);
  const td = "px-3 py-2 align-top text-sm text-slate-700";

  if (rows.length === 0) {
    return <EmptyNote>No faculty recorded yet. Set a faculty lead on a batch above.</EmptyNote>;
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Batches sit different papers, so compare progress and follow-through, not raw averages. Names are free text (no
        accounts in this PoC).
      </p>
      <div className="hidden overflow-x-auto rounded-md border border-slate-200 md:block">
        <table className="w-full border-collapse">
          <caption className="sr-only">Faculty follow-through</caption>
          <thead className={theadCls}>
            <tr>
              <th scope="col" className={thCls}>Name</th>
              <th scope="col" className={thCls}>Batches</th>
              <th scope="col" className={cn(thCls, "text-right")}>Students graded</th>
              <th scope="col" className={thCls} title="Same students, previous vs latest whole-class test (n)">Change (n)</th>
              <th scope="col" className={thCls}>At-risk students</th>
              <th scope="col" className={thCls}>Awaiting release (oldest)</th>
              <th scope="col" className={thCls}>Actions</th>
              <th scope="col" className={cn(thCls, "text-right")} title="Reports this person released · median hours from grading to release">
                Releases (median time)
              </th>
              {showChecked ? (
                <th scope="col" className={cn(thCls, "text-right")} title="Held sheets this person checked">
                  Sheets checked
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((f) => (
              <tr key={f.name}>
                <th scope="row" className={cn(td, "text-left font-medium text-slate-900")}>{f.name}</th>
                <td className={td}>{f.batches.length ? f.batches.join(", ") : <span className="text-slate-500">reviewer only</span>}</td>
                <td className={cn(td, "text-right tabular-nums")}>{f.batches.length ? (f.students_graded ?? f.students) : "—"}</td>
                <td className={td}><Change f={f} /></td>
                <td className={td}><RiskOpen f={f} /></td>
                <td className={td}><Awaiting f={f} /></td>
                <td className={td}><Actions f={f} /></td>
                <td className={cn(td, "text-right")}><Releases f={f} /></td>
                {showChecked ? <td className={cn(td, "text-right tabular-nums")}>{f.ocr_reviews}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 md:hidden">
        {rows.map((f) => (
          <li key={f.name} className="rounded-md border border-slate-200 px-3 py-2 text-sm">
            <p className="font-medium text-slate-900">{f.name}</p>
            <p className="text-xs text-slate-500">{f.batches.length ? f.batches.join(", ") : "reviewer only"}</p>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
              <div>
                <dt className="text-slate-500">Students graded</dt>
                <dd className="tabular-nums text-slate-900">{f.batches.length ? (f.students_graded ?? f.students) : "—"}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Change (n)</dt>
                <dd><Change f={f} /></dd>
              </div>
              <div>
                <dt className="text-slate-500">At-risk students</dt>
                <dd><RiskOpen f={f} /></dd>
              </div>
              <div>
                <dt className="text-slate-500">Awaiting release</dt>
                <dd><Awaiting f={f} /></dd>
              </div>
              <div>
                <dt className="text-slate-500">Actions</dt>
                <dd><Actions f={f} /></dd>
              </div>
              <div>
                <dt className="text-slate-500">Releases (median time)</dt>
                <dd className="text-slate-900"><Releases f={f} /></dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}
