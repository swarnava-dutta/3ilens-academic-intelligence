"use client";

import Link from "next/link";
import { useState } from "react";
import { ChartFrame, Dumbbell } from "@/components/charts";
import { pct1 } from "@/lib/format";
import type { OwnerDashboard, OwnerProgressStudent } from "@/lib/types";
import { ChangeText, Disclosure, linkCls, signed1 } from "./owner-ui";
import { EmptyNote } from "./states";
import { TrendChart } from "./trend-chart";

function MoverList({ title, rows, empty }: { title: string; rows: OwnerProgressStudent[]; empty: string }) {
  return (
    <div className="min-w-0">
      <h3 className="text-[13px] font-semibold text-slate-700">{title}</h3>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">{empty}</p>
      ) : (
        <ol className="mt-1 divide-y divide-slate-100">
          {rows.map((m) => (
            <li
              key={m.submission_id}
              title={`${m.before_test} → ${m.after_test} (different papers)`}
              className="flex flex-col gap-y-0.5 py-1.5 text-sm sm:flex-row sm:items-baseline sm:justify-between sm:gap-x-3"
            >
              <span className="min-w-0">
                <Link href={`/report/${m.submission_id}`} className={linkCls}>
                  {m.student_name}
                </Link>{" "}
                <span className="text-xs text-slate-500">· {m.batch_name}</span>
              </span>
              <span className="shrink-0 tabular-nums text-slate-700">
                {pct1(m.before_pct)} &rarr; {pct1(m.after_pct)} <ChangeText value={m.change} suffix="" className="ml-1 font-medium" />
                <span className="sr-only">
                  {" "}
                  ({m.before_test} to {m.after_test})
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * Progress tab: same students, previous vs latest whole-class test (a dumbbell per batch), the
 * biggest gains and drops, and every sitting behind "All sittings".
 */
export function ProgressPanel({ data }: { data: OwnerDashboard }) {
  const [sittingsOpen, setSittingsOpen] = useState(false);
  const progress = data.progress ?? null;
  const batches = data.batches ?? [];
  const withPairs = batches.flatMap((b) => (b.progress && b.progress.students > 0 ? [{ b, p: b.progress }] : []));
  const without = batches.filter((b) => (b.students_graded ?? 0) > 0 && (b.progress?.students ?? 0) === 0);
  const movers = data.progress_students ?? [];
  const gains = movers.filter((m) => m.change > 0).slice(0, 5);
  const drops = movers.filter((m) => m.change <= -5).sort((a, b) => a.change - b.change).slice(0, 5);

  if (!progress) {
    return (
      <div className="space-y-4">
        <EmptyNote>Same-student progress is not available yet; every sitting is below.</EmptyNote>
        <TrendChart trend={data.trend ?? []} />
      </div>
    );
  }

  const rows = withPairs.map(({ b, p }) => ({
    label: `${b.batch.name} · ${p.students} of ${b.students_graded ?? b.students}`,
    a: p.mean_after ?? 0,
    b: p.mean_before ?? 0,
  }));
  // A dot plot needs no zero baseline: fit the axis to the values (10-point steps) so a 6-point change is visible.
  const values = rows.flatMap((r) => [r.a, r.b]);
  const lo = values.length ? Math.max(0, Math.floor((Math.min(...values) - 5) / 10) * 10) : 0;
  const hi = values.length ? Math.min(100, Math.ceil((Math.max(...values) + 5) / 10) * 10) : 100;
  const domain: [number, number] = hi - lo >= 20 ? [lo, hi] : [Math.max(0, lo - 10), Math.min(100, hi + 10)];
  const other = progress.not_comparable ?? 0;
  const notComparable = other ? ` ${other} more re-tested on a paper that is not comparable with their previous one, so not counted.` : "";
  const takeaway =
    progress.students > 0
      ? `Re-tested students: ${signed1(progress.mean_change)} pts (${progress.students} students; ${progress.improved} up 5+ · ${progress.declined} down 5+ · ${progress.steady} steady), each against the test they sat before on a comparable paper.${notComparable}`
      : other
        ? `${other} students re-tested, but on papers that are not comparable with their previous ones (a different test, not full papers over the same subjects), so there is no change to show.`
        : "No student has sat two whole-class tests yet, so there is no like-for-like change to show.";

  return (
    <div className="space-y-6">
      {rows.length ? (
        <ChartFrame
          title="Same students, previous → latest test"
          takeaway={takeaway}
          table={{
            columns: ["Batch", "Students", "Previous", "Latest", "Change", "Up 5+", "Down 5+", "Steady"],
            rows: withPairs.map(({ b, p }) => [
              b.batch.name,
              p.students,
              pct1(p.mean_before),
              pct1(p.mean_after),
              signed1(p.mean_change),
              p.improved,
              p.declined,
              p.steady,
            ]),
          }}
        >
          <Dumbbell rows={rows} aLabel="Latest test" bLabel="Previous test" domain={domain} unit="%" />
        </ChartFrame>
      ) : (
        <p className="text-sm text-slate-600">{takeaway}</p>
      )}
      {without.length ? (
        <p className="text-xs text-slate-500">
          {without
            .map((b) =>
              b.progress?.not_comparable
                ? `${b.batch.name}: ${b.progress.not_comparable} re-tested, not comparable`
                : `${b.batch.name}: no repeat whole-class test yet`,
            )
            .join(" · ")}
        </p>
      ) : null}

      {movers.length ? (
        <div className="grid grid-cols-1 gap-6 border-t border-slate-200 pt-4 md:grid-cols-2">
          <MoverList title="Biggest gains" rows={gains} empty="No student gained on their latest test." />
          <MoverList title="Biggest drops" rows={drops} empty="No student dropped 5+ points." />
        </div>
      ) : null}

      <div className="border-t border-slate-200 pt-3">
        <Disclosure open={sittingsOpen} onToggle={() => setSittingsOpen((v) => !v)} controls="owner-all-sittings">
          {sittingsOpen ? "Hide all sittings" : `All sittings (${(data.trend ?? []).length})`}
        </Disclosure>
        <div id="owner-all-sittings" hidden={!sittingsOpen} className="mt-3">
          {sittingsOpen ? <TrendChart trend={data.trend ?? []} /> : null}
        </div>
      </div>
    </div>
  );
}
