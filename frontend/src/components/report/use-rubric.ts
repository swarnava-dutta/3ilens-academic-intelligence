"use client";

import { useEffect, useState } from "react";
import { getRubrics } from "@/lib/api";
import type { Rubric } from "@/lib/types";

/**
 * Looks up a rubric (name, version, question prompts) by id. Optional enrichment only:
 * returns null until loaded and stays null on any error, so callers must render without it.
 */
export function useRubric(rubricId: number | null | undefined): Rubric | null {
  const [rubric, setRubric] = useState<Rubric | null>(null);
  useEffect(() => {
    if (rubricId === null || rubricId === undefined) return;
    let cancelled = false;
    getRubrics()
      .then((rubrics) => {
        if (cancelled || !Array.isArray(rubrics)) return;
        setRubric(rubrics.find((r) => r.id === rubricId) ?? null);
      })
      .catch(() => {
        /* enrichment is optional */
      });
    return () => {
      cancelled = true;
    };
  }, [rubricId]);
  return rubric && rubric.id === rubricId ? rubric : null;
}

/** "Biology - Genetics · v1" (accepts versions with or without a leading "v"). */
export function rubricLabel(rubric: { name: string; version?: string | null }): string {
  const version = String(rubric.version ?? "").trim();
  if (!version) return rubric.name;
  return `${rubric.name} · ${/^v/i.test(version) ? version : `v${version}`}`;
}

/** Question number -> prompt text from the rubric content. */
export function rubricPrompts(rubric: Rubric | null): Record<number, string> {
  const map: Record<number, string> = {};
  for (const q of rubric?.content?.questions ?? []) {
    if (q?.prompt) map[q.question] = q.prompt;
  }
  return map;
}
