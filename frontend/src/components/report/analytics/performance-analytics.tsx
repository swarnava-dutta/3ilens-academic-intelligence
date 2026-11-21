"use client";

import { useEffect, useState, type ReactNode } from "react";
import { errorMessage, getCohort } from "@/lib/api";
import type { Result } from "@/lib/types";
import { CohortComparison, ScorePosition, ScoreTrend, type CohortState } from "./cohort-charts";
import { BloomAccuracy, QuestionMarks, Stamina } from "./paper-charts";
import { FocusQuadrant, PlanLoad, ProjectedGain, TopicTargets } from "./topic-charts";

const Panel = ({ children }: { children: ReactNode }) => (
  <div className="min-w-0 rounded-md border border-slate-200 bg-white p-4 sm:p-5 print:break-inside-avoid">
    {children}
  </div>
);

/** Charts of this paper, the student's batch (same batch and rubric) and the study plan. */
export function PerformanceAnalytics({ result }: { result: Result }) {
  const { batch_id, rubric_id } = result.submission;
  const [cohort, setCohort] = useState<CohortState>({ status: "loading" });

  useEffect(() => {
    let live = true;
    getCohort({ batch_id, rubric_id })
      .then((data) => live && setCohort({ status: "ready", data }))
      .catch((err) => live && setCohort({ status: "error", message: errorMessage(err) }));
    return () => {
      live = false;
    };
  }, [batch_id, rubric_id]);

  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2 print:grid-cols-1 [print-color-adjust:exact]">
      <Panel>
        <QuestionMarks result={result} />
      </Panel>
      <Panel>
        <TopicTargets result={result} />
      </Panel>
      <Panel>
        <CohortComparison result={result} cohort={cohort} />
      </Panel>
      <Panel>
        <ScorePosition result={result} cohort={cohort} />
      </Panel>
      <Panel>
        <FocusQuadrant result={result} />
      </Panel>
      <Panel>
        <ProjectedGain result={result} />
      </Panel>
      <Panel>
        <ScoreTrend result={result} />
      </Panel>
      <Panel>
        <PlanLoad result={result} />
      </Panel>
      <Panel>
        <BloomAccuracy result={result} />
      </Panel>
      <Panel>
        <Stamina result={result} />
      </Panel>
    </div>
  );
}
