import type { BloomLevel, BloomSource } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Bloom's taxonomy level names (backend bloom.LABELS). */
export const BLOOM_LABELS: Record<BloomLevel, string> = {
  K1: "Remember",
  K2: "Understand",
  K3: "Apply",
  K4: "Analyse",
  K5: "Evaluate",
};

export const BLOOM_SOURCE_LABELS: Record<BloomSource, string> = {
  faculty: "set by faculty",
  ai: "AI-detected",
  heuristic: "heuristic (verb in the question)",
};

/**
 * Bloom level tag, e.g. "K3 Apply". The tooltip names where the level came from; when the
 * answer showed a different level (demonstrated, from the grader) the chip adds "shown: K2".
 * Renders nothing without a level.
 */
export function BloomBadge({
  level,
  source,
  demonstrated,
  size = "md",
  className,
}: {
  level: BloomLevel | null | undefined;
  source?: BloomSource | null;
  demonstrated?: BloomLevel | null;
  size?: "sm" | "md";
  className?: string;
}) {
  if (!level || !(level in BLOOM_LABELS)) return null;
  const name = `${level} ${BLOOM_LABELS[level]}`;
  const shown = demonstrated && demonstrated !== level && demonstrated in BLOOM_LABELS ? demonstrated : null;
  const details = [
    `Bloom level ${name}${source ? ` - ${BLOOM_SOURCE_LABELS[source]}` : ""}.`,
    shown ? `The answer showed ${shown} ${BLOOM_LABELS[shown]}.` : "",
  ].filter(Boolean);
  return (
    <span
      title={details.join("\n")}
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-sm font-medium bg-slate-100 text-slate-700",
        size === "sm" ? "gap-1 px-1 text-[11px]" : "gap-1 px-1.5 py-0.5 text-xs",
        className,
      )}
    >
      {name}
      {shown ? <span className="font-normal">· shown: {shown}</span> : null}
      <span className="sr-only">. {details.join(" ")}</span>
    </span>
  );
}
