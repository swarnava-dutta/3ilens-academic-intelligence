import { AlertTriangle, CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";
import type { SubmissionStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const STYLES: Record<
  SubmissionStatus,
  { label: string; className: string; Icon: typeof Clock; spin?: boolean }
> = {
  PENDING: {
    label: "Pending",
    className: "bg-slate-100 text-slate-700",
    Icon: Clock,
  },
  PROCESSING: {
    label: "Processing",
    className: "bg-brand-cyan-50 text-cyan-800",
    Icon: Loader2,
    spin: true,
  },
  COMPLETED: {
    label: "Completed",
    className: "bg-brand-lime-50 text-lime-800",
    Icon: CheckCircle2,
  },
  FAILED: {
    label: "Failed",
    className: "bg-red-50 text-red-700",
    Icon: XCircle,
  },
  HUMAN_REVIEW_REQUIRED: {
    label: "Human review required",
    className: "bg-amber-100 text-amber-900 font-semibold",
    Icon: AlertTriangle,
  },
};

export function StatusBadge({ status, className }: { status: SubmissionStatus; className?: string }) {
  const s = STYLES[status] ?? STYLES.PENDING;
  const { Icon } = s;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-xs font-medium",
        s.className,
        className,
      )}
    >
      <Icon className={cn("h-3 w-3", s.spin && "animate-spin")} aria-hidden />
      {s.label}
    </span>
  );
}
