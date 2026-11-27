// Defensive readers for API payloads (the report, summary and roster normalisers): an older or
// partial response must never crash a page, so missing lists become [], missing numbers a
// fallback or null, and unknown enum values a default.

/** Every field of T, each still unchecked. */
export type Loose<T = Record<string, unknown>> = { [K in keyof T]?: unknown } | null | undefined;

/** A plain object (not an array), else null. */
export function obj<T = Record<string, unknown>>(value: unknown): Loose<T> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Loose<T>) : null;
}

/** An array without null / undefined items, else []. */
export function arr<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value.filter((v) => v !== null && v !== undefined) as T[]) : [];
}

/** The non-blank strings of an array. */
export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "") : [];
}

/** The finite numbers of an array. */
export function nums(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === "number" && Number.isFinite(v)) : [];
}

export function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** A finite number, else null (guards against NaN / undefined from an evolving backend). */
export function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** `value` when it is one of `allowed`, else `fallback`. */
export function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}
