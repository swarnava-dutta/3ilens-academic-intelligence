"use client";

import { useEffect, useState, type ReactNode } from "react";
import { getOpsCosts } from "@/lib/api";
import type { Cohort, OpsCosts } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Card, CardHeader } from "./card";
import { clampPct, num, plural, shareOf } from "./format";

/** BRD §14 OCR quality KPI (mean confidence), distinct from the 0.70 per-page review gate. */
export const OCR_QUALITY_KPI = 0.85;

const PURPOSE_LABEL: Record<string, string> = {
  ocr: "OCR (vision)",
  evaluation: "Rubric grading",
  consistency: "Consistency re-grade",
  rubric_parse: "Rubric drafting",
  transcription: "Voice transcription",
  voice_mapping: "Voice mapping",
  bloom_detect: "Bloom detection",
  llm_drill: "Fallback drill",
};

function inr(value: number | null | undefined, digits = 2): string {
  const v = num(value);
  return v === null ? "—" : `Rs ${v.toFixed(digits)}`;
}

function duration(seconds: number | null | undefined): string {
  const v = num(seconds);
  if (v === null) return "—";
  if (v < 60) return `${Math.round(v)} s`;
  const m = Math.floor(v / 60);
  const s = Math.round(v % 60);
  return s ? `${m} min ${s} s` : `${m} min`;
}

type Verdict = "ok" | "bad" | "none";

function Tile({
  label,
  value,
  hint,
  verdict = "none",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  verdict?: Verdict;
}) {
  return (
    <div className="min-w-0 bg-white px-3 py-2.5">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-base font-semibold tabular-nums text-brand-navy">{value}</dd>
      {hint ? (
        <dd className={cn("text-xs", verdict === "ok" ? "text-lime-800" : verdict === "bad" ? "text-red-700" : "text-slate-500")}>
          {verdict === "ok" ? "Met: " : verdict === "bad" ? "Missed: " : null}
          {hint}
        </dd>
      ) : null}
    </div>
  );
}

/**
 * Acceptance §14 operations: LLM calls and cost per student (vs Rs 5), OCR cache hits, latency
 * (vs 5 min), dead-letter count and mean OCR confidence (vs the 0.85 KPI). Cohort numbers follow
 * the filters; the cost-by-purpose split (GET /api/ops/costs) covers every batch.
 */
export function OperationsCard({ cohort }: { cohort: Cohort }) {
  const [costs, setCosts] = useState<OpsCosts | null>(null);
  const [costsUnavailable, setCostsUnavailable] = useState(false);
  const ops = cohort.operations;
  const updatedKey = `${cohort.completed}-${cohort.processing}-${ops?.calls ?? 0}`;

  useEffect(() => {
    let cancelled = false;
    getOpsCosts("purpose")
      .then((data) => {
        if (!cancelled) {
          setCosts(data);
          setCostsUnavailable(false);
        }
      })
      .catch(() => {
        if (!cancelled) setCostsUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [updatedKey]);

  const target = num(ops?.target_inr) ?? num(costs?.target_inr) ?? 5;
  const latencyTarget = num(ops?.target_latency_seconds) ?? 300;
  const perStudent = num(ops?.avg_cost_per_student_inr);
  const p95 = num(ops?.p95_latency_seconds);
  const avgLatency = num(ops?.avg_latency_seconds);
  const meanConf = num(ops?.mean_ocr_confidence);
  const demo = cohort.demo_count ?? 0;
  const groups = (costs?.groups ?? []).filter((g) => g && typeof g.key === "string");
  const maxGroup = groups.reduce((m, g) => Math.max(m, num(g.cost_inr) ?? 0), 0);

  return (
    <Card aria-labelledby="cohort-ops-title">
      <CardHeader
        id="cohort-ops-title"
        title="Operations"
        subtitle="Cost, latency and reliability of live processing against the pilot acceptance targets"
      />

      {!ops ? (
        <p className="mt-4 text-sm text-slate-500">Operations data is not available on this API build yet.</p>
      ) : (
        <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 sm:grid-cols-4">
          <Tile label="LLM calls" value={ops.calls ?? 0} hint={`${plural(cohort.real_count ?? 0, "live sheet")}`} />
          <Tile label="LLM cost" value={inr(ops.total_cost_inr)} hint="tokens priced per model" />
          <Tile
            label="Per student"
            value={inr(perStudent)}
            verdict={perStudent === null ? "none" : perStudent <= target ? "ok" : "bad"}
            hint={`target < ${inr(target, 0)}`}
          />
          <Tile label="OCR cache hits" value={ops.ocr_cache_hits ?? 0} hint="no vision call (Rs 0.00)" />
          <Tile
            label="Latency avg / p95"
            value={
              <span>
                {duration(avgLatency)} <span className="text-sm font-semibold text-slate-400">/ {duration(p95)}</span>
              </span>
            }
            verdict={p95 === null ? "none" : p95 <= latencyTarget ? "ok" : "bad"}
            hint={`target < ${duration(latencyTarget)} per sheet`}
          />
          <Tile
            label="Over latency target"
            value={ops.over_latency_target ?? 0}
            verdict={(ops.over_latency_target ?? 0) > 0 ? "bad" : "none"}
            hint="sheets slower than target"
          />
          <Tile
            label="Dead-letter (DLQ)"
            value={ops.dlq_count ?? 0}
            verdict={(ops.dlq_count ?? 0) > 0 ? "bad" : "none"}
            hint={(ops.dlq_count ?? 0) > 0 ? "retry them in the workspace" : "no failed jobs"}
          />
          <Tile
            label="Mean OCR confidence"
            value={meanConf === null ? "—" : `${Math.round(meanConf * 100)}%`}
            verdict={meanConf === null ? "none" : meanConf >= OCR_QUALITY_KPI ? "ok" : "bad"}
            hint={`KPI > ${Math.round(OCR_QUALITY_KPI * 100)}% (review gate is per page)`}
          />
        </dl>
      )}

      <div className="mt-4 border-t border-slate-200 pt-3">
        <h3 className="text-sm font-semibold text-brand-navy">
          LLM cost by purpose <span className="font-normal text-slate-500">· all batches</span>
        </h3>
        {costsUnavailable ? (
          <p className="mt-2 text-sm text-slate-500">Cost breakdown is not available on this API build yet.</p>
        ) : !costs ? (
          <div className="mt-2 h-4 w-48 animate-pulse rounded-sm bg-slate-100 motion-reduce:animate-none" aria-hidden />
        ) : groups.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">No live AI calls recorded yet.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {groups.map((g) => (
              <li key={g.key} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-3 text-sm">
                <span className="truncate text-slate-700">{PURPOSE_LABEL[g.key] ?? g.key}</span>
                <span className="h-2 bg-slate-100" aria-hidden>
                  <span
                    className="block h-full bg-slate-500"
                    style={{ width: `${maxGroup > 0 ? Math.max(clampPct(((num(g.cost_inr) ?? 0) / maxGroup) * 100), 2) : 0}%` }}
                  />
                </span>
                <span className="whitespace-nowrap text-xs tabular-nums text-slate-600">
                  {inr(g.cost_inr)} · {plural(g.calls, "call")}
                </span>
              </li>
            ))}
            <li className="pt-1 text-xs text-slate-500">
              Total {inr(costs.total_cost_inr)} over {plural(costs.students, "student")}
              {num(costs.avg_cost_per_student_inr) !== null ? ` (${inr(costs.avg_cost_per_student_inr)} each)` : ""} ·
              USD→INR {num(costs.usd_inr) ?? "—"}
            </li>
          </ul>
        )}
      </div>

      {demo > 0 ? (
        <p className="mt-3 text-xs text-slate-500">
          <span className="mr-1.5 rounded-sm border border-amber-300 px-1.5 text-amber-800">Sample data</span>
          {plural(demo, "demo row")} made no model call, so they add no cost or latency here.
        </p>
      ) : null}
    </Card>
  );
}

/**
 * Release gate (provisional vs faculty-released) and the denominator disclosure: who is left out of
 * the class numbers because they are in review, failed or still processing.
 */
export function ReleaseCard({ cohort }: { cohort: Cohort }) {
  const release = cohort.release_counts ?? { provisional: 0, released: 0 };
  const total = release.provisional + release.released;
  const excluded = cohort.excluded ?? { review: [], failed: [], processing: [] };
  const groups: { label: string; names: string[]; tone: string }[] = [
    { label: "In faculty review", names: excluded.review ?? [], tone: "text-amber-800" },
    { label: "Failed (DLQ)", names: excluded.failed ?? [], tone: "text-red-700" },
    { label: "Still processing", names: excluded.processing ?? [], tone: "text-brand-cyan-600" },
  ];
  const excludedCount = groups.reduce((n, g) => n + g.names.length, 0);

  return (
    <Card aria-labelledby="cohort-release-title">
      <CardHeader
        id="cohort-release-title"
        title="Release & denominator"
        subtitle="Reports stay provisional until a teacher signs them off"
      />
      <div className="mt-4">
        <div className="flex h-2 w-full gap-px overflow-hidden rounded-sm bg-slate-100" aria-hidden>
          {release.released > 0 ? (
            <span className="h-full bg-brand-lime-600" style={{ width: `${shareOf(release.released, total) ?? 0}%` }} />
          ) : null}
          {release.provisional > 0 ? (
            <span className="h-full bg-slate-400" style={{ width: `${shareOf(release.provisional, total) ?? 0}%` }} />
          ) : null}
        </div>
        <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
          <div>
            <dt className="flex items-center gap-1.5 text-xs text-slate-500"><span className="h-2 w-2 rounded-sm bg-brand-lime-600" aria-hidden />Released</dt>
            <dd className="font-semibold tabular-nums text-slate-800">{release.released}</dd>
          </div>
          <div>
            <dt className="flex items-center gap-1.5 text-xs text-slate-500"><span className="h-2 w-2 rounded-sm bg-slate-400" aria-hidden />Provisional</dt>
            <dd className="font-semibold tabular-nums text-slate-700">{release.provisional}</dd>
          </div>
        </dl>
      </div>

      <div className="mt-4 border-t border-slate-200 pt-3">
        <h3 className="text-sm font-semibold text-brand-navy">
          Not in the class numbers <span className="font-normal tabular-nums text-slate-500">({excludedCount})</span>
        </h3>
        {excludedCount === 0 ? (
          <p className="mt-1 text-sm text-slate-500">
            Every submission in this view is completed and counted ({cohort.completed ?? 0}).
          </p>
        ) : (
          <ul className="mt-1.5 space-y-1 text-sm">
            {groups
              .filter((g) => g.names.length > 0)
              .map((g) => (
                <li key={g.label}>
                  <span className={cn("font-medium", g.tone)}>
                    {g.label} ({g.names.length}):
                  </span>{" "}
                  <span className="text-slate-600">{g.names.join(", ")}</span>
                </li>
              ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
