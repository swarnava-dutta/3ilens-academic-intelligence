"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { errorMessage, getCohort } from "@/lib/api";
import type { Delivery, ReleaseInfo, Result } from "@/lib/types";
import { CohortComparison, ScorePosition, type CohortState } from "./analytics/cohort-charts";
import { PlanLoad, ProjectedGain } from "./analytics/topic-charts";
import { Notice } from "./dialog";
import { EvidenceTraceCard } from "./evidence-trace";
import { Fold, FoldGroup } from "./fold";
import { fmtMarks, plannedMinutesText } from "./format";
import { ExamTechnique, techniqueTeaser } from "./more/exam-technique";
import { ProcessingAudit } from "./more/processing-audit";
import { ReadingQuality, readingTeaser } from "./more/reading-quality";
import { ReviewRelease, reviewTeaser } from "./more/review-release";
import { TeachingActions, teachingTeaser } from "./more/teaching-actions";
import { TopicTable, topicTeaser } from "./more/topic-table";
import { normalizeResult } from "./normalize";
import { PrintFooter, ProvisionalNotice, releaseText } from "./provisional-banner";
import { QuestionEvaluationsCard } from "./question-evaluations";
import { FOLD } from "./report-events";
import { ReportViewProvider, useReportView } from "./report-view-mode";
import { RoiLab, WeeklyCalendar } from "./roi-lab";
import { ReportSection, SectionNav } from "./section-nav";
import { SourcePagesViewer } from "./source-pages";
import { SourcesPanel } from "./sources-panel";
import { CompactHeader } from "./summary/compact-header";
import { FocusList, routeLine } from "./summary/focus-list";
import { InShort } from "./summary/in-short";
import { KeyInsights, shownInsights } from "./summary/key-insights";
import { QuestionGrid } from "./summary/question-grid";
import { ScoreHero } from "./summary/score-hero";
import { SubjectCards } from "./summary/subject-cards";
import { card } from "./summary/tokens";
import { rubricPrompts, useRubric } from "./use-rubric";
import { VoiceAnswerCard } from "./voice-answer";
import { WhatsAppDialog } from "./whatsapp-dialog";

/** The batch charts. Mounted when their fold first opens, so /api/cohort is fetched only then. */
function BatchComparison({ result }: { result: Result }) {
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
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div className={`${card} p-3 sm:p-4`}>
        <CohortComparison result={result} cohort={cohort} />
      </div>
      <div className={`${card} p-3 sm:p-4`}>
        <ScorePosition result={result} cohort={cohort} />
      </div>
    </div>
  );
}

/** "Physics 90 min, Chemistry 90 min, Biology 30 min" in focus order, the checkpoint last. */
function weekSplit(result: Result): string {
  const plan = result.study_plan;
  const minutes = new Map<string, number>();
  for (const d of plan.weekly_calendar) for (const b of d.blocks) minutes.set(b.topic, (minutes.get(b.topic) ?? 0) + b.minutes);
  const rank = new Map(plan.focus.map((t, i) => [t.topic, i]));
  return [...minutes]
    .sort((a, b) => Number(!rank.has(a[0])) - Number(!rank.has(b[0])) || b[1] - a[1] || (rank.get(a[0]) ?? 0) - (rank.get(b[0]) ?? 0))
    .map(([topic, m]) => `${topic} ${m} min`)
    .join(", ");
}

/**
 * Completed student report, in three levels, with a Student / Teacher view (student by default).
 * L0 (above the fold): compact header, a one-line release notice, the score card with its bullet
 * chart, "In short" (the server's plain summary) and the key insight it does not already say.
 * L1 (open, compact): subjects, where to focus, the question grid. L2: "More details" folds, closed
 * by default; the teacher view adds the "Teacher tools" group (review, the study-plan lab, teaching
 * actions, reading quality, processing). Release and delivery changes made on the page update the
 * notice and the print footer without a reload.
 */
export function ReadyReport(props: {
  result: Result;
  /** Set when an archived version is open. */
  version?: number;
  onReload?: () => void;
}) {
  return (
    <ReportViewProvider>
      <ReportBody {...props} />
    </ReportViewProvider>
  );
}

function ReportBody({
  result: raw,
  version,
  onReload,
}: {
  result: Result;
  version?: number;
  onReload?: () => void;
}) {
  const base = useMemo(() => normalizeResult(raw), [raw]);
  const prompts = rubricPrompts(useRubric(base.rubric.id));
  const { teacher } = useReportView();
  const [release, setRelease] = useState<ReleaseInfo>(base.release);
  const [sent, setSent] = useState<Delivery[]>([]);
  const [whatsAppOpen, setWhatsAppOpen] = useState(false);

  const sentIds = new Set(sent.map((d) => d.id));
  const deliveries = [...sent, ...base.deliveries.filter((d) => !sentIds.has(d.id))];
  const result: Result = { ...base, release, deliveries };
  const isDemo = result.submission.is_demo;
  const archived = version !== undefined || raw.superseded === true;
  // The server's median of the other graded students on this test (null below 5 of them).
  const median = result.score_band?.batch_median_marks ?? null;
  const summary = result.student_summary ?? [];
  const insights = shownInsights(result.key_insights ?? [], summary);
  const pages = result.submission.page_count;
  const plan = result.study_plan;
  const days = plan.days_to_exam ?? result.report_meta.batch.days_to_exam;
  const focus = result.focus_topics;
  const focusRows = focus?.rows.length ?? 0;
  const target = focus?.target_pct ?? 85;
  const hardToRead = isDemo
    ? 0
    : result.question_evaluations.filter(
        (q) =>
          (q.student_answer ?? "").trim() &&
          q.result_kind !== "blank" &&
          q.result_kind !== "bonus" &&
          q.confidence > 0 &&
          q.confidence < result.extraction.threshold,
      ).length;
  const hasWeek = plan.weekly_calendar.some((d) => d.blocks.length);
  const chapters = focus?.level === "chapter";

  return (
    <div className="space-y-4 pb-20 sm:space-y-5 md:pb-0 print:space-y-3 print:pb-0">
      <CompactHeader
        result={result}
        version={version}
        onWhatsApp={() => setWhatsAppOpen(true)}
        onRenamed={() => onReload?.()}
      />
      {archived ? (
        <Notice tone="info">
          <span className="font-medium text-slate-800">
            Superseded{raw.superseded_by ? ` by version ${raw.superseded_by}` : ""}.
          </span>{" "}
          This is archived version {version}; review and release apply to the current version only.{" "}
          <Link
            href={`/report/${result.submission.id}`}
            className="rounded-sm font-medium text-[#1E40AF] underline underline-offset-2 hover:text-[#1E3A8A] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1E40AF]"
          >
            Open the current version
          </Link>
        </Notice>
      ) : null}
      <ProvisionalNotice release={release} rubric={result.rubric} isDemo={isDemo} hardToRead={hardToRead} />
      <SectionNav />

      {/* L0: the score and what it means */}
      <ReportSection id="summary" title="Summary" hideTitle>
        {/* Phones: "In short" first, then the score card and the key insight; wide screens: the score
            card on the left, "In short" and the insight on the right. */}
        <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-12 print:grid-cols-12">
          <ScoreHero
            result={result}
            className={
              summary.length || insights.length
                ? "lg:col-span-5 lg:row-span-2 print:col-span-5 print:row-span-2"
                : "lg:col-span-12 print:col-span-12"
            }
          />
          {summary.length ? <InShort lines={summary} className="-order-1 lg:order-none lg:col-span-7 print:order-none print:col-span-7" /> : null}
          {insights.length ? (
            <KeyInsights insights={insights} counts={result.outcome_counts} className="lg:col-span-7 print:col-span-7" />
          ) : null}
        </div>
      </ReportSection>

      {/* L1: open by default, compact */}
      <ReportSection id="subjects" title="Subjects" description="Where the marks came from and where they went.">
        <SubjectCards result={result} />
      </ReportSection>

      <ReportSection
        id="focus"
        title="Where to focus"
        description={
          routeLine(result) ??
          (focusRows > 1
            ? `The ${focusRows} below ${target}%, by the marks reaching it adds.`
            : focusRows === 1
              ? `Marks added by reaching ${target}%.`
              : undefined)
        }
      >
        <FocusList result={result} />
      </ReportSection>

      <ReportSection id="questions" title="Questions" description="Tap a question for the marked option, the key and the page.">
        <QuestionGrid result={result} />
      </ReportSection>

      {/* L2: folded details */}
      <ReportSection id="more" title="More details" description="Closed until you open them.">
        <FoldGroup>
          {hasWeek ? (
            <Fold
              id={FOLD.plan}
              title="Your study plan this week"
              teaser={[
                `About ${plannedMinutesText(plan.planned_minutes_total ?? 0)}: ${weekSplit(result)}`,
                typeof days === "number" ? `${days} days to ${plan.exam || "NEET"}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            >
              <p className="text-[13px] text-slate-700">
                One or two short blocks a day, starting from the questions each block names, then a mini-test at the end of
                the week.
              </p>
              <WeeklyCalendar plan={plan} notes />
            </Fold>
          ) : null}
          <Fold id={FOLD.technique} title="Exam technique: attempts and negative marking" teaser={techniqueTeaser(result)}>
            <ExamTechnique result={result} />
          </Fold>
          {chapters ? (
            <Fold id={FOLD.topics} title="All chapters and topics" teaser={topicTeaser(result)}>
              <TopicTable result={result} />
            </Fold>
          ) : null}
          <Fold
            id={FOLD.questions}
            title="Question-by-question details"
            teaser={`All ${result.question_evaluations.length} questions with the marked option, the key, the marks and the page`}
          >
            {teacher ? <EvidenceTraceCard result={result} prompts={prompts} /> : null}
            <QuestionEvaluationsCard
              questions={result.question_evaluations}
              prompts={prompts}
              threshold={result.extraction.threshold}
              isDemo={isDemo}
            />
          </Fold>
          {isDemo && !result.voice ? null : (
            <Fold
              id={FOLD.pages}
              title={result.voice ? "Recording and transcript" : "Answer sheet pages"}
              teaser={
                result.voice
                  ? "The recording, its transcript and the files the key was drafted from"
                  : `${pages ? `${pages} ${pages === 1 ? "page" : "pages"}` : "The pages"} as uploaded${teacher ? ", next to the files the key was drafted from" : ""}`
              }
            >
              {isDemo || !teacher ? null : <SourcesPanel submission={result.submission} rubricId={result.rubric.id} />}
              {result.voice ? (
                <VoiceAnswerCard
                  submissionId={result.submission.id}
                  voice={result.voice}
                  mappedQuestions={result.question_evaluations
                    .filter((q) => (q.student_answer ?? "").trim())
                    .map((q) => q.question)
                    .sort((a, b) => a - b)}
                  isDemo={isDemo}
                />
              ) : (
                <SourcePagesViewer result={result} />
              )}
            </Fold>
          )}
          {median !== null ? (
            <Fold
              id={FOLD.cohort}
              title="Compared with your batch"
              teaser={`Other graded students on this test · batch median ${fmtMarks(median)}`}
            >
              <BatchComparison result={result} />
            </Fold>
          ) : null}
        </FoldGroup>

        {teacher ? (
          <FoldGroup title="Teacher tools" faculty>
            <Fold id={FOLD.review} title="Review and release" teaser={reviewTeaser(release)} faculty>
              <ReviewRelease
                result={result}
                release={release}
                archived={archived}
                version={version}
                onRelease={setRelease}
                onRegraded={() => onReload?.()}
              />
            </Fold>
            <Fold
              id={FOLD.lab}
              title="Study plan lab (illustrative)"
              teaser={`What-if days and hours, the next five topics, quadrants, the projection to 85% and the roadmap`}
              faculty
            >
              <RoiLab result={result} />
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 print:grid-cols-1">
                <div className={`${card} p-3 sm:p-4`}>
                  <ProjectedGain result={result} />
                </div>
                <div className={`${card} p-3 sm:p-4`}>
                  <PlanLoad result={result} />
                </div>
              </div>
            </Fold>
            <Fold id={FOLD.teaching} title="Teaching actions" teaser={teachingTeaser(result)} faculty>
              <TeachingActions result={result} />
            </Fold>
            <Fold id={FOLD.reading} title="Reading quality" teaser={readingTeaser(result)} faculty>
              <ReadingQuality result={result} />
            </Fold>
            <Fold id={FOLD.audit} title="Processing and audit" teaser="Run details, model calls, timings and the audit trail" faculty>
              <ProcessingAudit result={result} deliveries={deliveries} />
            </Fold>
          </FoldGroup>
        ) : null}
      </ReportSection>

      <p className="border-t border-slate-200 pt-3 text-xs leading-relaxed text-slate-500">
        AI-assisted marking, checked against the answer key&apos;s limits and totals. Not official NEET scoring.
      </p>

      <PrintFooter text={releaseText(release, result.rubric)} />

      <WhatsAppDialog
        open={whatsAppOpen}
        onClose={() => setWhatsAppOpen(false)}
        submissionIds={[result.submission.id]}
        studentName={result.submission.student_name}
        testName={`${result.rubric.name} ${result.rubric.version}`.trim()}
        onDelivered={(rows) => setSent((prev) => [...rows, ...prev])}
      />
    </div>
  );
}
