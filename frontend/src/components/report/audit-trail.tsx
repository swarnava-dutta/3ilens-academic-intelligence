import type { ProcessingLogEntry } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";
import { fmtDuration, fmtTime, humanizeStep } from "./format";
import { Pill, SectionCard } from "./primitives";

/** Flag for steps that failed or were routed to a human; everything else is plain. */
function flagFor(entry: ProcessingLogEntry): { label: string; className: string } | null {
  const s = `${entry.step} ${entry.message}`.toLowerCase();
  if (/fail|error|dead.?letter|dlq|exception/.test(s)) return { label: "Error", className: "bg-rose-50 text-rose-700" };
  if (/human|manual review|low.confidence|below.{0,24}threshold/.test(s))
    return { label: "Review", className: "bg-amber-100 text-amber-900" };
  return null;
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
      className={className}
      action={
        duration ? <span className="text-xs tabular-nums text-slate-500">Pipeline time {duration}</span> : null
      }
    >
      {log.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">{emptyText}</p>
      ) : (
        <ol className="divide-y divide-slate-100">
          {log.map((entry, i) => {
            const flag = flagFor(entry);
            return (
              <li
                key={`${entry.step}-${entry.timestamp}-${i}`}
                className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 py-2 first:pt-0 last:pb-0 print:break-inside-avoid"
              >
                <time
                  dateTime={entry.timestamp}
                  title={formatDateTime(entry.timestamp)}
                  className="pt-0.5 font-mono text-xs tabular-nums text-slate-500"
                >
                  {fmtTime(entry.timestamp)}
                </time>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800">
                    {humanizeStep(entry.step)}
                    {flag ? <Pill className={`ml-2 ${flag.className}`}>{flag.label}</Pill> : null}
                  </p>
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
