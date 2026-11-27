/** Fraction 0-1 -> "63%" (null -> "—"). */
export function pct(fraction: number | null | undefined, digits = 0): string {
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) return "—";
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** "+4 / -1" with real minus signs. */
export function realMinus(text: string): string {
  return text.replace(/-(?=\d)/g, "−");
}

/** Muted explanation shown in place of a profile the backend could not compute. */
export function NullProfile({ text }: { text: string }) {
  return (
    <p className="text-sm text-slate-500">{text}</p>
  );
}
