// Visual tokens of the redesigned report (design-system/3ilens/MASTER.md): navy for measures, amber
// only for targets and highlights (amber text uses #B45309 for 4.5:1 on white), red for wrong
// answers (always with a hatch or glyph), slate for blank. Kept as literal class strings so
// Tailwind sees them.

export const COLOR = {
  /** Measures (score bar, "answered" bars, right answers). */
  navy: "#1E40AF",
  /** Second measure series ("right when answered"). */
  blue: "#3B82F6",
  /** Target markers and highlights only. */
  amber: "#D97706",
  /** Amber text on white (4.5:1). */
  amberText: "#B45309",
  /** Wrong answers, always paired with a hatch or glyph. */
  red: "#DC2626",
  /** Headline ink. */
  ink: "#1E3A8A",
  /** Bonus questions (with a star glyph). */
  bonus: "#BFDBFE",
} as const;

/** Visible 2px navy ring with a 2px offset. */
export const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1E40AF]";

/** White card, dense dashboard padding. */
export const card = "rounded-md border border-slate-200 bg-white";

/** Scores and table numbers: Fira Code, tabular. */
export const numeric = "font-mono tabular-nums";

/** Small text link / button in navy. */
export const linkButton =
  "inline-flex cursor-pointer items-center gap-1 rounded-sm text-[13px] font-medium text-[#1E40AF] underline-offset-2 transition-colors duration-150 hover:text-[#1E3A8A] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1E40AF]";

/** Section heading (h2) of the summary sections. */
export const sectionTitle = "text-base font-semibold text-[#1E3A8A]";

/** Red diagonal hatch for wrong answers (colour is never the only cue). */
export const WRONG_HATCH =
  "repeating-linear-gradient(135deg, #DC2626 0 3px, #B91C1C 3px 6px)";
