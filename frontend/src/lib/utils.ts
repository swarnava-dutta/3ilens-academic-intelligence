import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 0.1 -> "10%"; 0.125 -> "12.5%" */
export function formatWeight(fraction: number): string {
  const pct = fraction * 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

/** 0.873 -> "87%" (confidence values are 0-1). */
export function formatConfidence(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${Math.round(value * 100)}%`;
}

/** Mastery values are already 0-100. */
export function formatMastery(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${Math.round(value)}%`;
}

export function formatScore(score: number | null | undefined, total: number): string {
  if (score === null || score === undefined) return "—";
  const s = Number.isInteger(score) ? score : Number(score.toFixed(1));
  return `${s} / ${total}`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Tailwind text colour for a mastery percentage. */
export function masteryTone(mastery: number): "good" | "ok" | "weak" {
  if (mastery >= 75) return "good";
  if (mastery >= 50) return "ok";
  return "weak";
}
