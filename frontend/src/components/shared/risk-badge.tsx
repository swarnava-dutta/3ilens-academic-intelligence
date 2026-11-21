import type { RiskLevel } from "@/lib/types";
import { cn } from "@/lib/utils";

export const RISK_LABELS: Record<RiskLevel, string> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
};

/** Same style family as UrgencyBadge: low = lime, medium = amber, high = red. */
const STYLES: Record<RiskLevel, string> = {
  low: "bg-brand-lime-50 text-lime-800",
  medium: "bg-amber-50 text-amber-800",
  high: "bg-red-50 text-red-700",
};

/**
 * Risk badge for the exam-behaviour patterns (negative marking, fatigue). `label` replaces the
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
  const tone = STYLES[risk];
  const text = label ?? RISK_LABELS[risk];
  const tooltip = title ?? `${RISK_LABELS[risk]} (thresholds are defaults - confirm with the academic lead)`;
  return (
    <span
      title={tooltip}
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-sm font-medium",
        size === "sm" ? "gap-1 px-1 text-[11px]" : "gap-1 px-1.5 py-0.5 text-xs",
        tone,
        className,
      )}
    >
      {text}
      <span className="sr-only">. {tooltip}</span>
    </span>
  );
}
