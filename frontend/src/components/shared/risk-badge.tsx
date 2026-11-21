import { AlertOctagon, AlertTriangle, CheckCircle2 } from "lucide-react";
import type { RiskLevel } from "@/lib/types";
import { cn } from "@/lib/utils";

export const RISK_LABELS: Record<RiskLevel, string> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
};

/** Same style family as UrgencyBadge: low = lime, medium = amber, high = rose. */
const STYLES: Record<RiskLevel, { className: string; Icon: typeof CheckCircle2 }> = {
  low: { className: "bg-brand-lime-50 text-brand-lime-600 ring-brand-lime/40", Icon: CheckCircle2 },
  medium: { className: "bg-amber-50 text-amber-800 ring-amber-300", Icon: AlertTriangle },
  high: { className: "bg-rose-50 text-rose-700 ring-rose-200", Icon: AlertOctagon },
};

/**
 * Risk pill for the exam-behaviour patterns (negative marking, fatigue). `label` replaces the
 * default text, e.g. "Over-attempting". Thresholds are defaults pending the academic lead.
 */
export function RiskBadge({
  risk,
  label,
  title,
  size = "md",
  className,
}: {
  risk: RiskLevel | null | undefined;
  label?: string;
  title?: string;
  size?: "sm" | "md";
  className?: string;
}) {
  if (!risk || !(risk in STYLES)) return null;
  const { className: tone, Icon } = STYLES[risk];
  const text = label ?? RISK_LABELS[risk];
  const tooltip = title ?? `${RISK_LABELS[risk]} (thresholds are defaults - confirm with the academic lead)`;
  return (
    <span
      title={tooltip}
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full font-medium ring-1 ring-inset",
        size === "sm" ? "gap-1 px-2 py-0.5 text-[11px]" : "gap-1.5 px-2.5 py-1 text-xs",
        tone,
        className,
      )}
    >
      <Icon className={size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5"} aria-hidden />
      {text}
      <span className="sr-only">. {tooltip}</span>
    </span>
  );
}
