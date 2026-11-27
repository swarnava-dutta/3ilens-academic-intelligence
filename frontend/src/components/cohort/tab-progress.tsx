"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BarList, ChartFrame, Dumbbell, LineChart } from "@/components/charts";
import { errorMessage, getInterventionEffectiveness } from "@/lib/api";
import type { Cohort, InterventionEffectiveness } from "@/lib/types";
import { cn } from "@/lib/utils";
import { dayMonth, FOCUS_RING, fullDate, LINK_TEXT, pct1, plural, pts } from "./format";

function BatchTrend({ cohort }: { cohort: Cohort }) {
  const scope = cohort.scope;
  if (!scope || scope.batch_id === null) {
    return (
      <p className="text-sm text-slate-600">Pick a batch to see its class average test by test.</p>
    );
  }
  const points = (cohort.sittings ?? [])
    .filter((s) => s.batch_id === scope.batch_id && s.is_class && s.average_pct !== null)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (points.length < 2) {
    return (
      <p className="text-sm text-slate-600">
        {scope.batch_name ?? "This batch"} has {points.length === 1 ? "one class test" : "no class test"} so far - the
        trend appears after the second.
      </p>
    );
  }
  const label = (s: (typeof points)[number]) => `${s.short_name} ${dayMonth(s.date)}`;
  const last = points[points.length - 1];
  const firstPoint = points[0];
  // A change line only between comparable papers (backend sittings.comparable); otherwise the sittings are listed.
  const notComparable = points.slice(1).filter((s) => s.comparable_previous === false).length;
  return (
    <ChartFrame
      title={`${scope.batch_name} over time`}
      takeaway={
        notComparable
          ? `${plural(points.length, "class test")}, ${plural(notComparable, "of them", "of them")} not comparable with the test before (a different paper), so the class averages are listed, not charted as a change.`
          : `Class average ${pct1(firstPoint.average_pct)} on ${firstPoint.short_name} to ${pct1(last.average_pct)} on ${last.short_name}, over ${plural(points.length, "class test")}.`
      }
    >
      {notComparable ? null : (
        <LineChart
          unit="%"
          yDomain={[0, 100]}
          series={[
            { name: "Class average", series: 1, points: points.map((s) => ({ x: label(s), y: s.average_pct ?? 0 })) },
            { name: "Median", series: "context", points: points.map((s) => ({ x: label(s), y: s.median_pct ?? 0 })) },
          ]}
        />
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[30rem] border-collapse text-[13px] tabular-nums">
          <caption className="sr-only">Class tests of this batch</caption>
          <thead className="border-b border-slate-200 text-xs text-slate-500">
            <tr>
              <th scope="col" className="py-1.5 pr-3 text-left font-medium">Date</th>
              <th scope="col" className="py-1.5 pr-3 text-left font-medium">Test</th>
              <th scope="col" className="py-1.5 pr-3 text-right font-medium">Students</th>
              <th scope="col" className="py-1.5 pr-3 text-right font-medium">Average</th>
              <th scope="col" className="py-1.5 text-right font-medium">At risk</th>
            </tr>
          </thead>
          <tbody>
            {[...points].reverse().map((s) => {
              const current = s.test_id === scope.test_id;
              return (
                <tr key={s.test_id} className={cn("border-b border-slate-100", current && "bg-brand-cyan-50 font-medium")}>
                  <td className="py-1.5 pr-3 text-slate-600">{dayMonth(s.date)}</td>
                  <th scope="row" className="py-1.5 pr-3 text-left font-normal text-slate-800">
                    {s.test_name}
                    {current ? <span className="sr-only"> (this test)</span> : null}
                    {s.comparable_previous === false ? (
                      <span className="block text-xs font-normal text-slate-500">not comparable with the test before</span>
                    ) : null}
                  </th>
                  <td className="py-1.5 pr-3 text-right">{s.students}</td>
                  <td className="py-1.5 pr-3 text-right">{pct1(s.average_pct)}</td>
                  <td className="py-1.5 text-right">{s.urgency_counts.at_risk}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">Different papers - difficulty varies, so compare with care.</p>
    </ChartFrame>
  );
}

/** Each student against the test they sat just before (backend sittings.pairs), in every view. */
function Paired({ cohort }: { cohort: Cohort }) {
  const paired = cohort.paired_change;
  const scope = cohort.scope;
  if (!paired || !scope) return null;
  const same = paired.rows.filter((r) => r.comparable !== false);
  const other = paired.rows.filter((r) => r.comparable === false);
  const now = scope.short_name ?? "Latest test";
  // One earlier test for everyone (e.g. Mock 09) names the column; otherwise each row says its own.
  const names = [...new Set(same.map((r) => r.prev_test ?? ""))];
  const prevName = names.length === 1 && names[0] ? names[0] : "Previous test";
  const notComparable = other.length ? (
    <p className="text-xs text-slate-500">
      Not comparable ({plural(other.length, "student")}, previous test a different paper):{" "}
      {other.map((r) => `${r.name} (${r.prev_test || "previous test"} ${pct1(r.prev)} → ${pct1(r.now)})`).join(", ")}.
    </p>
  ) : null;
  if (paired.paired < 3) {
    return notComparable || same.length ? (
      <section className="space-y-1">
        <h3 className="text-sm font-semibold text-slate-900">Same students, previous test → {now}</h3>
        {same.length ? (
          <p className="text-sm text-slate-600">
            {plural(same.length, "student")} with a comparable earlier test: mean {pts(paired.mean_change)} (too few to chart).
          </p>
        ) : null}
        {notComparable}
      </section>
    ) : null;
  }
  return (
    <ChartFrame
      title={`Same students, ${prevName === "Previous test" ? "previous test" : prevName} → ${now}`}
      takeaway={`${paired.improved} up 5+ · ${paired.declined} down 5+ · ${paired.steady} steady · mean ${pts(paired.mean_change)}${other.length ? ` · ${other.length} not comparable` : ""}`}
      table={{
        columns: ["Student", prevName, now, "Change"],
        rows: same.map((r) => [r.name, `${pct1(r.prev)}${prevName === "Previous test" && r.prev_test ? ` (${r.prev_test})` : ""}`, pct1(r.now), pts(r.change)]),
      }}
    >
      <Dumbbell
        unit="%"
        domain={[0, 100]}
        aLabel={now}
        bLabel={prevName}
        rows={same.map((r) => ({ label: r.name, a: r.now, b: r.prev }))}
      />
      {notComparable}
    </ChartFrame>
  );
}

function Batches({ cohort }: { cohort: Cohort }) {
  const rows = cohort.batch_comparison ?? [];
  if (rows.length < 2) return null;
  const thin = rows.filter((r) => r.thin);
  return (
    <ChartFrame
      title={`Batches on ${cohort.scope?.short_name ?? "this test"}`}
      takeaway={rows.map((r) => `${r.batch_name} ${pct1(r.average_pct)} (${r.students})`).join(" vs ")}
    >
      <BarList
        unit="%"
        items={rows.map((r) => ({
          label: `${r.batch_name}${r.is_current ? " (this batch)" : ""} · ${plural(r.students, "student")}`,
          value: r.average_pct ?? 0,
          max: 100,
          tone: r.thin ? "context" : "default",
          valueLabel: pct1(r.average_pct),
        }))}
      />
      {thin.length ? (
        <p className="text-xs text-slate-500">
          {thin.map((r) => r.batch_name).join(", ")}: fewer than 3 students, so not a fair comparison yet.
        </p>
      ) : null}
    </ChartFrame>
  );
}

function Effect({ cohort, canLog }: { cohort: Cohort; canLog: boolean }) {
  const batchId = cohort.scope?.batch_id ?? null;
  const [data, setData] = useState<InterventionEffectiveness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logged = cohort.interventions_logged ?? 0;

  useEffect(() => {
    let cancelled = false;
    getInterventionEffectiveness({ batch_id: batchId })
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [batchId, logged]);

  const where = batchId !== null ? cohort.scope?.batch_name ?? "this batch" : "all batches";
  const sign = (v: number | null | undefined) => (v === null || v === undefined ? "—" : pts(v));
  return (
    <section aria-labelledby="effect-title" className="space-y-2">
      <h3 id="effect-title" className="text-sm font-semibold text-slate-900">
        Intervention effect · {where}
      </h3>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {data ? (
        data.records === 0 ? (
          <p className="text-sm text-slate-600">
            No interventions logged for {where} yet.{" "}
            {canLog
              ? "Use \u201cLog class intervention\u201d on a chapter in the Re-teach card above; the change shows at the students\u2019 next test."
              : batchId === null
                ? "Pick a batch: class interventions are logged per batch, on a re-teach chapter."
                : "When a chapter qualifies for a re-teach, log what you did from the Re-teach card; the change shows at the students\u2019 next test."}
          </p>
        ) : (
          <>
            <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 text-center">
              {[
                ["Treated chapters", sign(data.mean_change_treated)],
                ["Untreated", sign(data.mean_change_control)],
                ["Uplift", sign(data.uplift)],
              ].map(([label, value]) => (
                <div key={label} className="bg-white px-2 py-2">
                  <dt className="text-xs text-slate-500">{label}</dt>
                  <dd className="text-base font-semibold tabular-nums text-brand-navy">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-slate-500">
              {plural(logged, "intervention")} logged for {where} · {data.measured} measured at a later test ·{" "}
              {data.pending} waiting for one. Mean mastery change at the next test; observational, not causal.{" "}
              <Link href="/owner" className={cn("rounded-sm font-medium hover:underline", LINK_TEXT, FOCUS_RING)}>
                Full breakdown on the Owner page
              </Link>
            </p>
          </>
        )
      ) : !error ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : null}
    </section>
  );
}

/** Progress tab: the batch over time, each student against their previous test, batches on this test, effect. */
export function ProgressTab({ cohort }: { cohort: Cohort }) {
  const scope = cohort.scope;
  const notClass = scope?.mode === "sitting" && !scope.is_class;
  return (
    <div className="space-y-8">
      {notClass ? (
        <p className="rounded-md bg-slate-50 px-3 py-2 text-[13px] text-slate-600">
          Not a class sitting ({plural(scope?.students ?? 0, "student")}), so it is not compared with the batch&apos;s other
          tests{scope?.date ? ` (sat ${fullDate(scope.date)})` : ""}.
        </p>
      ) : null}
      <BatchTrend cohort={cohort} />
      {!notClass ? <Paired cohort={cohort} /> : null}
      <Batches cohort={cohort} />
      <Effect
        cohort={cohort}
        canLog={scope?.batch_id != null && (cohort.chapters ?? []).some((c) => c.reteach_rank !== null)}
      />
    </div>
  );
}
