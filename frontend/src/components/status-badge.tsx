import { AlertTriangle, CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";
import type { SubmissionStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const STYLES: Record<
  SubmissionStatus,
  { label: string; className: string; Icon: typeof Clock; spin?: boolean }
> = {
  PENDING: {
    label: "Pending",
    className: "bg-slate-100 text-slate-600 ring-slate-200",
    Icon: Clock,
  },
  PROCESSING: {
    label: "Processing",
    className: "bg-brand-cyan-50 text-brand-cyan-600 ring-brand-cyan/30",
    Icon: Loader2,
    spin: true,
  },
  COMPLETED: {
    label: "Completed",
    className: "bg-brand-lime-50 text-brand-lime-600 ring-brand-lime/40",
    Icon: CheckCircle2,
  },
  FAILED: {
    label: "Failed",
    className: "bg-rose-50 text-rose-700 ring-rose-200",
    Icon: XCircle,
  },
  HUMAN_REVIEW_REQUIRED: {
    label: "Human review required",
    className: "bg-amber-100 text-amber-800 ring-amber-300 font-semibold",
    Icon: AlertTriangle,
  },
};

export function StatusBadge({ status, className }: { status: SubmissionStatus; className?: string }) {
  const s = STYLES[status] ?? STYLES.PENDING;
  const { Icon } = s;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset",
        s.className,
        className,
      )}
    >
      <Icon className={cn("h-3.5 w-3.5", s.spin && "animate-spin")} aria-hidden />
      {s.label}
    </span>
  );
}
