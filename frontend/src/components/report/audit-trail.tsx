import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  CircleDot,
  Database,
  FileText,
  History,
  Layers,
  ScanLine,
  ScanText,
  TrendingUp,
  XCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ProcessingLogEntry } from "@/lib/types";
import { cn, formatDateTime } from "@/lib/utils";
import { fmtDuration, fmtTime, humanizeStep } from "./format";
import { Pill, SectionCard } from "./primitives";

type StepLook = { Icon: LucideIcon; dot: string };

function lookFor(entry: ProcessingLogEntry): StepLook {
  const s = `${entry.step} ${entry.message}`.toLowerCase();
  if (/fail|error|dead.?letter|dlq|exception/.test(s)) return { Icon: XCircle, dot: "bg-rose-50 text-rose-600 ring-rose-200" };
  if (/human|manual review|low.confidence|below.{0,24}threshold/.test(s))
    return { Icon: AlertTriangle, dot: "bg-amber-50 text-amber-700 ring-amber-300" };
  const step = entry.step.toLowerCase();
  if (/complet|done|finish/.test(step)) return { Icon: CheckCircle2, dot: "bg-brand-lime-50 text-lime-700 ring-brand-lime/50" };
  if (/persist|sav|store|database/.test(step)) return { Icon: Database, dot: "bg-brand-cyan-50 text-cyan-700 ring-brand-cyan/30" };
  if (/insight|roi|priorit/.test(step)) return { Icon: TrendingUp, dot: "bg-brand-cyan-50 text-cyan-700 ring-brand-cyan/30" };
  if (/evaluat|grad|rubric/.test(step)) return { Icon: Brain, dot: "bg-brand-cyan-50 text-cyan-700 ring-brand-cyan/30" };
  if (/ocr|vision|extract|transcri|structur/.test(step)) return { Icon: ScanText, dot: "bg-brand-cyan-50 text-cyan-700 ring-brand-cyan/30" };
  if (/pre.?process|deskew|dpi|prepar|render/.test(step)) return { Icon: ScanLine, dot: "bg-brand-cyan-50 text-cyan-700 ring-brand-cyan/30" };
  if (/queue|enqueue|pending/.test(step)) return { Icon: Layers, dot: "bg-slate-50 text-slate-600 ring-slate-200" };
  if (/upload|ingest|receiv/.test(step)) return { Icon: FileText, dot: "bg-slate-50 text-slate-600 ring-slate-200" };
  return { Icon: CircleDot, dot: "bg-slate-50 text-slate-600 ring-slate-200" };
}

export function AuditTrailCard({
  log,
  className,
  emptyText = "No processing events have been recorded yet.",
}: {
  log: ProcessingLogEntry[];
  className?: string;
  emptyText?: string;
}) {
  const duration = log.length > 1 ? fmtDuration(log[0]?.timestamp, log[log.length - 1]?.timestamp) : null;

  return (
    <SectionCard
      id="audit-trail"
      title="Audit trail"
      description="Every pipeline step, as recorded by the processing worker."
      icon={History}
      className={className}
      action={
        duration ? <Pill className="bg-slate-50 text-slate-600 ring-slate-200">Pipeline time {duration}</Pill> : null
      }
    >
      {log.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-500">{emptyText}</p>
      ) : (
        <ol className="relative">
          {log.map((entry, i) => {
            const { Icon, dot } = lookFor(entry);
            const last = i === log.length - 1;
            return (
              <li key={`${entry.step}-${entry.timestamp}-${i}`} className="relative flex gap-4 pb-5 last:pb-0 print:break-inside-avoid">
                {!last ? (
                  <span aria-hidden className="absolute left-4 top-9 -bottom-0 w-px -translate-x-1/2 bg-slate-200" />
                ) : null}
                <span
                  className={cn(
                    "relative z-10 grid h-8 w-8 shrink-0 place-items-center rounded-full ring-1 ring-inset [print-color-adjust:exact]",
                    dot,
                  )}
                >
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1 pt-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <p className="text-sm font-semibold text-slate-800">{humanizeStep(entry.step)}</p>
                    <time
                      dateTime={entry.timestamp}
                      title={formatDateTime(entry.timestamp)}
                      className="font-mono text-xs tabular-nums text-slate-400"
                    >
                      {fmtTime(entry.timestamp)}
                    </time>
                  </div>
                  {entry.message ? (
                    <p className="mt-0.5 break-words text-sm leading-relaxed text-slate-600">{entry.message}</p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </SectionCard>
  );
}
