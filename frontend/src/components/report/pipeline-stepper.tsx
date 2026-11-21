import { AlertTriangle, Brain, Check, Database, FileText, Loader2, ScanLine, ScanText, TrendingUp, XCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ProcessingLogEntry, Submission } from "@/lib/types";
import { cn } from "@/lib/utils";

export const PIPELINE_STAGES: { label: string; Icon: LucideIcon }[] = [
  { label: "Ingestion & queue", Icon: FileText },
  { label: "Pre-processing", Icon: ScanLine },
  { label: "OCR & structuring", Icon: ScanText },
  { label: "Rubric evaluation", Icon: Brain },
  { label: "Insights & ROI", Icon: TrendingUp },
  { label: "Results stored", Icon: Database },
];

/** processing_log step names written by backend/pipeline.py, main.py (upload) and seed.py. */
const STEP_STAGE: Record<string, number> = {
  ingestion: 0,
  queue: 0,
  queued: 0,
  "pre-processing": 1,
  "ocr & parse": 2,
  "ocr & answer structuring": 2,
  "rubric evaluation": 3,
  "insights & roi": 4,
  persistence: 5,
};

/** Fallback for other wording. Most specific first; generic ingestion words last. */
const MATCHERS: [number, RegExp][] = [
  [1, /pre.?process|deskew|dpi|contrast|prepar|render/i],
  [2, /ocr|vision|extract|transcri|structur|handwrit/i],
  [3, /evaluat|grad|rubric|scor/i],
  [4, /insight|roi|priorit|master/i],
  [5, /persist|sav|stor|complet|finali/i],
  // "queued" (not "queue") so the "Dead-letter queue" log step is not read as ingestion.
  [0, /queued|upload|ingest|receiv|pending|wait/i],
];

/** Stage index for a log step / current_step name; -1 for non-stage steps ("Human review", "Dead-letter queue"). */
function stageOf(step: string | null | undefined): number {
  const name = (step ?? "").trim();
  if (!name) return -1;
  const exact = STEP_STAGE[name.toLowerCase()];
  if (exact !== undefined) return exact;
  for (const [i, re] of MATCHERS) if (re.test(name)) return i;
  return -1;
}

/** The DLQ entry reads "<step> failed - routed to the dead-letter queue ...": the stage that broke. */
function failedStage(text: string | null | undefined): number {
  const m = /^(.+?) failed\b/i.exec((text ?? "").trim());
  return m ? stageOf(m[1]) : -1;
}

export type StageState = "done" | "active" | "review" | "failed" | "not-run" | "waiting";

/**
 * Each stage's state from what actually ran: a stage is done only if it wrote a log entry and the
 * pipeline moved past it. The halting stage is the last one that ran (for failures, the one the DLQ
 * entry names). Returns null when nothing in the record locates the pipeline.
 */
export function stageStates(
  submission: Pick<Submission, "status" | "current_step" | "error_message">,
  log: ProcessingLogEntry[],
): StageState[] | null {
  const { status } = submission;
  const ran = new Set<number>();
  let failedAt = -1;
  for (const entry of log) {
    const i = stageOf(entry.step);
    if (i >= 0) ran.add(i);
    else if (status === "FAILED") failedAt = Math.max(failedAt, failedStage(entry.message));
  }
  if (status === "COMPLETED") return PIPELINE_STAGES.map(() => "done");

  const reached = ran.size > 0 ? Math.max(...ran) : -1;
  let halt: number;
  if (status === "FAILED") {
    halt = failedAt >= 0 ? failedAt : reached >= 0 ? reached : failedStage(submission.error_message);
  } else if (status === "HUMAN_REVIEW_REQUIRED") {
    halt = reached;
  } else {
    halt = Math.max(reached, stageOf(submission.current_step), 0);
  }
  if (halt < 0) return null;

  const haltState: StageState = status === "FAILED" ? "failed" : status === "HUMAN_REVIEW_REQUIRED" ? "review" : "active";
  // No stage entries at all (older records): assume the earlier stages ran.
  const trustLog = ran.size > 0;
  return PIPELINE_STAGES.map((_, i) => {
    if (i === halt) return haltState;
    if (i < halt) return !trustLog || ran.has(i) ? "done" : "not-run";
    return haltState === "active" ? "waiting" : "not-run";
  });
}

const LOOK: Record<StageState, { label: string; look: string; iconLook: string; Icon?: LucideIcon }> = {
  done: { label: "Done", Icon: Check, look: "border-lime-200 bg-white text-slate-700", iconLook: "bg-brand-lime text-brand-navy" },
  active: {
    label: "In progress",
    Icon: Loader2,
    look: "border-brand-cyan/50 bg-brand-cyan-50 text-brand-navy ring-2 ring-brand-cyan/20",
    iconLook: "bg-brand-cyan text-white",
  },
  review: {
    label: "Paused for review",
    Icon: AlertTriangle,
    look: "border-amber-300 bg-amber-100 text-amber-900",
    iconLook: "bg-amber-500 text-white",
  },
  failed: { label: "Failed here", Icon: XCircle, look: "border-rose-300 bg-rose-100 text-rose-900", iconLook: "bg-rose-600 text-white" },
  "not-run": {
    label: "Not run",
    look: "border-dashed border-slate-300 bg-white/60 text-slate-400",
    iconLook: "bg-slate-100 text-slate-400",
  },
  waiting: { label: "Waiting", look: "border-slate-200 bg-white text-slate-400", iconLook: "bg-slate-100 text-slate-400" },
};

export function PipelineStepper({ states }: { states: StageState[] }) {
  return (
    <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" aria-label="Pipeline progress">
      {PIPELINE_STAGES.map((stage, i) => {
        const state = states[i] ?? "waiting";
        const { label, look, iconLook, Icon = stage.Icon } = LOOK[state];
        const current = state === "active" || state === "review" || state === "failed";
        return (
          <li
            key={stage.label}
            className={cn("flex items-center gap-2.5 rounded-xl border px-3 py-2.5 [print-color-adjust:exact]", look)}
            aria-current={current ? "step" : undefined}
          >
            <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-full", iconLook)}>
              <Icon className={cn("h-3.5 w-3.5", state === "active" && "animate-spin")} aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-xs font-semibold">{stage.label}</span>
              <span className="block text-[11px] opacity-80">{label}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
