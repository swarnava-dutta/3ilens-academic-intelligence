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

/** Slate (K1, recall) to violet (K5, evaluation). Every pair keeps text contrast >= 4.5:1. */
const TONES: Record<BloomLevel, string> = {
  K1: "bg-slate-100 text-slate-700 ring-slate-300",
  K2: "bg-sky-50 text-sky-800 ring-sky-200",
  K3: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  K4: "bg-purple-50 text-purple-800 ring-purple-200",
  K5: "bg-violet-100 text-violet-800 ring-violet-300",
};

/**
 * Bloom level chip, e.g. "K3 Apply". The tooltip names where the level came from; when the
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
  if (!level || !(level in TONES)) return null;
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
        "inline-flex items-center whitespace-nowrap rounded-full font-medium ring-1 ring-inset",
        size === "sm" ? "gap-1 px-2 py-0.5 text-[11px]" : "gap-1.5 px-2.5 py-1 text-xs",
        TONES[level],
        className,
      )}
    >
      {name}
      {shown ? <span className="font-normal opacity-90">· shown: {shown}</span> : null}
      <span className="sr-only">. {details.join(" ")}</span>
    </span>
  );
}
