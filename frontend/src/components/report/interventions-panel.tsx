"use client";

import { CircleSlash, Clock3, Loader2, MoveRight, Plus, Trash2, TrendingDown, TrendingUp } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { IllustrativePill } from "@/components/shared/illustrative-pill";
import { KIND_LABELS } from "@/components/students/format";
import { deleteIntervention, errorCode, errorMessage } from "@/lib/api";
import type { InterventionRecord, OutcomeStatus, Result } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Notice, btnPrimary } from "./dialog";
import { fmtIST, fmtNumber, fmtSigned } from "./format";
import { SectionCard } from "./primitives";
import { RecordInterventionDialog } from "./record-intervention-dialog";

const STATUS_LOOK: Record<OutcomeStatus, { label: string; Icon: LucideIcon; tone: string; title: string }> = {
  pending: {
    label: "Pending",
    Icon: Clock3,
    tone: "bg-slate-100 text-slate-700",
    title: "No later test for this student yet.",
  },
  improved: {
    label: "Improved",
    Icon: TrendingUp,
    tone: "bg-brand-lime-50 text-lime-800",
    title: "Topic mastery rose on the next test that covered the topic.",
  },
  flat: {
    label: "Flat",
    Icon: MoveRight,
    tone: "bg-amber-50 text-amber-900",
    title: "Topic mastery barely changed on the next test that covered the topic.",
  },
  declined: {
    label: "Declined",
    Icon: TrendingDown,
    tone: "bg-rose-50 text-rose-700",
    title: "Topic mastery fell on the next test that covered the topic.",
  },
  not_assessed: {
    label: "Not assessed",
    Icon: CircleSlash,
    tone: "bg-slate-100 text-slate-700",
    title: "Later tests did not cover this topic.",
  },
};

function OutcomeStatusChip({ status }: { status: OutcomeStatus }) {
  const look = STATUS_LOOK[status] ?? STATUS_LOOK.pending;
  return (
    <span
      title={look.title}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-xs font-medium",
        look.tone,
      )}
    >
      <look.Icon className="h-3 w-3" aria-hidden />
      {look.label}
    </span>
  );
}

function pctText(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? `${fmtNumber(n)}%` : "—";
}

function RecordRow({ rec, onDeleted }: { rec: InterventionRecord; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const o = rec.outcome;

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await deleteIntervention(rec.id);
      onDeleted();
    } catch (err) {
      setError(errorCode(err) === "unknown_intervention" ? "Already deleted - reload the page." : errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <li className="py-3 first:pt-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[15px] font-semibold text-brand-navy">{rec.topic}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs tabular-nums text-slate-600">
            <span className="font-medium text-slate-700">{KIND_LABELS[rec.kind] ?? rec.kind}</span>
            <span>
              by {rec.applied_by} · {fmtIST(rec.applied_at)}
            </span>
            <span>· {rec.hours !== null ? `${fmtNumber(rec.hours)} h` : "hours not recorded"}</span>
            <span>
              · compliance {rec.compliance !== null ? `${Math.round(rec.compliance * 100)}%` : "not recorded"}
            </span>
            <span>· source {rec.source}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {rec.is_demo ? <IllustrativePill label="Sample data" title="Synthetic sample intervention record." /> : null}
          <OutcomeStatusChip status={rec.outcome_status} />
          {confirming ? (
            <span className="inline-flex items-center gap-1">
              <button
                type="button"
                onClick={() => void remove()}
                disabled={busy}
                className="inline-flex h-8 items-center gap-1 rounded-md bg-rose-700 px-2.5 text-xs font-medium text-white transition-colors duration-150 hover:bg-rose-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan disabled:opacity-60"
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
                Delete
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="h-8 rounded-md border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-700 transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="grid h-8 w-8 place-items-center rounded-md text-slate-500 transition-colors duration-150 hover:bg-rose-50 hover:text-rose-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
              aria-label={`Delete the ${rec.topic} intervention`}
              title="Delete this record"
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </button>
          )}
        </div>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{rec.action}</p>
      {rec.note ? <p className="mt-1 text-xs text-slate-500">Note: {rec.note}</p> : null}

      {o ? (
        <div className="mt-2 space-y-1 border-l-2 border-slate-300 pl-3 text-sm text-slate-700">
          <p>
            Topic mastery baseline <span className="font-semibold tabular-nums">{pctText(o.baseline_mastery)}</span> →{" "}
            <span className="font-semibold tabular-nums">{pctText(o.follow_up_mastery)}</span> on{" "}
            <Link
              href={`/report/${o.follow_up_submission_id}`}
              className="rounded-sm font-medium text-brand-cyan-600 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
            >
              {o.follow_up_test}
            </Link>{" "}
            (<span className="font-semibold tabular-nums">{fmtSigned(o.mastery_change)} pts</span>)
          </p>
          {o.predicted_gain_pct !== null ? (
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
              <span>
                predicted {fmtSigned(o.predicted_gain_pct)} pts
                {o.roi_accuracy !== null ? `, actual/predicted ${fmtNumber(o.roi_accuracy, 2)}` : ""}
              </span>
              <IllustrativePill />
            </p>
          ) : null}
        </div>
      ) : rec.predicted_gain_pct !== null ? (
        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
          <span>
            Baseline {pctText(rec.baseline_mastery)} · predicted {fmtSigned(rec.predicted_gain_pct)} pts after{" "}
            {rec.hours !== null ? `${fmtNumber(rec.hours)} h` : "the planned hours"}
          </span>
          <IllustrativePill />
        </p>
      ) : null}
      {error ? <Notice className="mt-2">{error}</Notice> : null}
    </li>
  );
}

/**
 * "Interventions" (FR-4.13): teaching actions recorded against this result and what happened to
 * the topic on the student's next test. Observational - not proof the action caused the change.
 */
export function InterventionsPanel({ result }: { result: Result }) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // The API returns each new record with its outcome, so the list updates without a report reload.
  const [list, setList] = useState<InterventionRecord[]>(() => result.interventions ?? []);
  const records = [...list].sort((a, b) => b.applied_at.localeCompare(a.applied_at) || b.id - a.id);

  return (
    <SectionCard
      id="interventions-log"
      title="Intervention log"
      description="What was done for each topic, and the topic's mastery on the next test that covered it."
      action={
        <button type="button" className={btnPrimary} onClick={() => setOpen(true)} disabled={result.topic_mastery.length === 0}>
          <Plus className="h-4 w-4" aria-hidden />
          Record intervention
        </button>
      }
    >
      {notice ? (
        <Notice tone="ok" className="mb-3">
          {notice}
        </Notice>
      ) : null}
      {records.length === 0 ? (
        <p className="text-sm text-slate-600">
          No interventions recorded for this result yet. Record one after acting on a nudge or a priority topic; the next
          test that covers the topic shows whether it moved.
        </p>
      ) : (
        <ul className="divide-y divide-slate-200">
          {records.map((rec) => (
            <RecordRow
              key={rec.id}
              rec={rec}
              onDeleted={() => {
                setNotice(`Deleted the ${rec.topic} intervention.`);
                setList((prev) => prev.filter((r) => r.id !== rec.id));
              }}
            />
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-slate-500">
        Observational: students and topics were not randomised, so a change is not proof the intervention caused it.
        Predicted gains come from the illustrative effort-response model.
      </p>

      <RecordInterventionDialog
        open={open}
        onClose={() => setOpen(false)}
        result={result}
        initialTopic={result.roi_recommendations[0]?.topic ?? null}
        onRecorded={(rec) => {
          setOpen(false);
          setNotice(`Recorded the ${rec.topic} intervention (${STATUS_LOOK[rec.outcome_status]?.label.toLowerCase() ?? "pending"}).`);
          setList((prev) => [rec, ...prev.filter((r) => r.id !== rec.id)]);
        }}
      />
    </SectionCard>
  );
}
