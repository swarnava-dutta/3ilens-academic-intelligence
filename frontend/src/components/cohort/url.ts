"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { URGENCIES } from "@/components/shared/urgency-badge";
import type { CohortItemFlag, Urgency } from "@/lib/types";

const TABS = ["students", "chapters", "questions", "behaviour", "progress"] as const;
export type CohortTab = (typeof TABS)[number];

const FLAGS: CohortItemFlag[] = ["possible_key_error", "hard", "often_skipped", "weak_discrimination"];

export interface CohortParams {
  batchId: number | null;
  /** Any key-version id of the test (the API resolves the family). */
  rubricId: number | null;
  /** "all": each student's latest test. */
  view: "all" | null;
  tab: CohortTab;
  /** Students tab chips (back-compat ?urgency / ?topic). */
  urgency: Urgency | null;
  chapter: string | null;
  notReleased: boolean;
  /** ?key=open opens About this data > Answer key. */
  keyOpen: boolean;
  /** Questions tab filter chip. */
  flag: CohortItemFlag | "negatives" | null;
}

function positiveId(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function readCohortParams(params: { get(name: string): string | null }): CohortParams {
  const tab = params.get("tab");
  const urgency = params.get("urgency");
  const topic = params.get("topic")?.trim();
  const flag = params.get("flag");
  return {
    batchId: positiveId(params.get("batch_id")),
    rubricId: positiveId(params.get("rubric_id")),
    view: params.get("view") === "all" ? "all" : null,
    // Students is the default tab, so back-compat ?urgency / ?topic links land on it.
    tab: (TABS as readonly string[]).includes(tab ?? "") ? (tab as CohortTab) : "students",
    urgency: urgency && (URGENCIES as string[]).includes(urgency) ? (urgency as Urgency) : null,
    chapter: topic ? topic : null,
    notReleased: params.get("release") === "provisional",
    keyOpen: params.get("key") === "open",
    flag: flag === "negatives" ? "negatives" : flag && (FLAGS as string[]).includes(flag) ? (flag as CohortItemFlag) : null,
  };
}

export type ParamPatch = Record<string, string | number | null | undefined>;

/** The current search params with `patch` applied (null / undefined / "" removes a key). */
function patchQuery(current: string, patch: ParamPatch): string {
  const next = new URLSearchParams(current);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === "") next.delete(key);
    else next.set(key, String(value));
  }
  return next.toString();
}

/** Cohort URL state: read it, build links from it and replace it (no scroll, no history entry). */
export function useCohortParams() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = searchParams.toString();
  const params = useMemo(() => readCohortParams(new URLSearchParams(current)), [current]);

  const href = useCallback(
    (patch: ParamPatch) => {
      const qs = patchQuery(current, patch);
      return qs ? `${pathname}?${qs}` : pathname;
    },
    [current, pathname],
  );

  const update = useCallback(
    (patch: ParamPatch) => {
      router.replace(href(patch), { scroll: false });
    },
    [router, href],
  );

  return { params, current, pathname, href, update };
}
