"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useHealth } from "@/components/app-shell";
import { getCohortSittings } from "@/lib/api";
import type { Cohort, CohortChapter } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AboutData } from "./about-data";
import { QuestionsCard, ReteachCard, StudentsCard } from "./action-cards";
import { ActionStrip } from "./action-strip";
import { CohortHeader, StaleBanner } from "./cohort-header";
import { CohortTabs, type RevealRequest, type TabDef } from "./cohort-tabs";
import { btnSecondary, Toast, type ToastMessage } from "./dialog";
import { plural } from "./format";
import { HeadlineTiles } from "./headline";
import { LogInterventionDialog, todayIso, type LogTarget } from "./log-intervention-dialog";
import { ScopeBar } from "./scope-bar";
import { ScoreDistribution } from "./score-distribution";
import { CohortEmpty, CohortErrorCard, CohortSkeleton, ScopeGone } from "./states";
import { AtRiskCard, RankingCard } from "./student-lists";
import { BehaviourTab } from "./tab-behaviour";
import { ChaptersTab } from "./tab-chapters";
import { ProgressTab } from "./tab-progress";
import { QuestionsTab } from "./tab-questions";
import { StudentsTab } from "./tab-students";
import { TopicMastery } from "./topic-mastery";
import { useCohortParams, type CohortTab } from "./url";
import { useCohort } from "./use-cohort";
import { WhatsAppDialog } from "./whatsapp-dialog";

/** An API without the cohort page fields: the v1 sections, so the page never breaks. */
function LegacyCohort({ cohort }: { cohort: Cohort }) {
  return (
    <>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <RankingCard ranking={cohort.ranking ?? []} mixed={cohort.mixed_rubrics ?? false} />
        <AtRiskCard rows={cohort.at_risk ?? []} />
      </div>
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-5">
        <TopicMastery topics={cohort.topic_mastery} className="lg:col-span-3" />
        <ScoreDistribution buckets={cohort.score_distribution} className="lg:col-span-2" />
      </div>
    </>
  );
}

/**
 * Cohort page: one test sitting of one batch (each student once, their latest sheet), or each
 * student's latest test. Header and headline sentence, scope bar, what needs doing, 4 tiles, 3
 * action cards, then the detail one tab at a time, and "About this data" at the bottom. Links in
 * the tiles, cards and the action strip open a tab and scroll it into view.
 * Reads the URL (useSearchParams): render inside <Suspense>.
 */
export function CohortDashboard() {
  const { params, href, update } = useCohortParams();
  const { health } = useHealth();
  const testRef = useRef<HTMLSelectElement>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [whatsApp, setWhatsApp] = useState<{ ids: number[]; names: Map<number, string> } | null>(null);
  const [logTarget, setLogTarget] = useState<LogTarget | null>(null);
  const [aboutOpen, setAboutOpen] = useState(params.keyOpen);
  const [focusKey, setFocusKey] = useState(params.keyOpen ? 1 : 0);
  const [reveal, setReveal] = useState<RevealRequest | null>(null);
  const closeToast = useCallback(() => setToast(null), []);
  const onReveal = useCallback((tab: CohortTab) => setReveal((r) => ({ tab, n: (r?.n ?? 0) + 1 })), []);

  // First visit (no test and not "all tests"): open the latest class sitting (3+ students) of the
  // batch, or of any batch. Without one: the batch's only test when every student sat that one,
  // else each student's latest test. On an older API, each student's latest test.
  const needsDefault = params.rubricId === null && params.view !== "all";
  const batchKey = String(params.batchId ?? "");
  const [noDefaultFor, setNoDefaultFor] = useState<string | null>(null);
  const resolving = needsDefault && noDefaultFor !== batchKey;
  useEffect(() => {
    if (!resolving) return;
    let cancelled = false;
    getCohortSittings(params.batchId)
      .then((list) => {
        if (cancelled) return;
        const mine = list.filter((s) => params.batchId === null || s.batch_id === params.batchId);
        const pick = mine.find((s) => s.is_class);
        if (pick) update({ batch_id: pick.batch_id, rubric_id: pick.test_id, view: null });
        else if (params.batchId !== null && mine.length === 1) update({ rubric_id: mine[0].test_id, view: null });
        else if (mine.length > 0) update({ rubric_id: null, view: "all" });
        else setNoDefaultFor(batchKey);
      })
      .catch(() => {
        if (!cancelled) setNoDefaultFor(batchKey);
      });
    return () => {
      cancelled = true;
    };
  }, [resolving, params.batchId, batchKey, update]);

  const { cohort, error, scopeGone, updatedLabel, switching, refreshing, refresh, announcement, pollSeconds } = useCohort(
    resolving ? null : { batch_id: params.batchId, test_id: needsDefault || params.view === "all" ? null : params.rubricId },
  );

  const openKey = useCallback(() => {
    setAboutOpen(true);
    setFocusKey((k) => k + 1);
  }, []);
  const pickTest = useCallback(() => {
    testRef.current?.focus();
    testRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);
  // The batch's faculty lead, only when one batch is in scope.
  const lead = cohort?.scope?.batch_id != null ? cohort.batch?.faculty_lead ?? "" : "";
  const onLog = useCallback((chapter: CohortChapter) => {
    setLogTarget({ chapter, taughtBy: lead, today: todayIso() });
  }, [lead]);
  const toLatest = useCallback(() => update({ rubric_id: null, view: null }), [update]);
  const toAllBatches = useCallback(() => update({ batch_id: null, rubric_id: null, view: "all" }), [update]);

  if (!cohort) {
    if (scopeGone) return <ScopeGone kind={scopeGone} onLatest={toLatest} onAllBatches={toAllBatches} />;
    if (error && !resolving) return <CohortErrorCard message={error} onRetry={() => void refresh()} retrying={refreshing} />;
    return <CohortSkeleton />;
  }

  const scope = cohort.scope ?? null;
  const n = scope?.students ?? 0;
  // Old data stays on screen (dimmed) while a new scope loads or a new batch's latest test is found.
  const busy = (switching && !scopeGone) || resolving;
  const noSheets = scope !== null && n === 0 && (cohort.sittings ?? []).length === 0;
  const chapterCount = (cohort.chapters ?? []).filter((c) => !c.subject_level).length;
  const items = scope?.mode === "sitting" ? cohort.item_analysis ?? null : null;
  const tabs: TabDef[] = [
    { id: "students", label: "Students", count: n },
    { id: "chapters", label: "Chapters", count: chapterCount },
    { id: "questions", label: "Questions", count: items?.length ?? null },
    { id: "behaviour", label: "Exam behaviour" },
    { id: "progress", label: "Progress" },
  ];

  let panel = null;
  if (params.tab === "students") {
    panel = (
      <StudentsTab
        cohort={cohort}
        params={params}
        update={update}
        onWhatsApp={(ids, names) => setWhatsApp({ ids, names })}
        onReleased={(count) => {
          void refresh();
          setToast(
            count > 0
              ? { kind: "success", message: `Released ${plural(count, "report")}.` }
              : { kind: "error", message: `Released ${plural(-count, "report")}; some could not be released - see the list.` },
          );
        }}
      />
    );
  } else if (params.tab === "chapters") {
    panel = <ChaptersTab cohort={cohort} />;
  } else if (params.tab === "questions") {
    panel = <QuestionsTab cohort={cohort} params={params} update={update} onOpenKey={openKey} onPickTest={pickTest} />;
  } else if (params.tab === "behaviour") {
    panel = <BehaviourTab cohort={cohort} />;
  } else {
    panel = <ProgressTab cohort={cohort} />;
  }

  return (
    <div className="space-y-5" aria-busy={busy || refreshing}>
      <CohortHeader
        cohort={cohort}
        updatedLabel={updatedLabel}
        pollSeconds={pollSeconds}
        refreshing={refreshing}
        onRefresh={() => void refresh()}
        announcement={announcement}
        onOpenAbout={() => setAboutOpen(true)}
        paused={Boolean(error) && !scopeGone}
      />
      {error && !scopeGone ? <StaleBanner message={error} updatedLabel={updatedLabel} /> : null}
      <ScopeBar
        cohort={cohort}
        params={params}
        update={update}
        switching={busy}
        testRef={testRef}
        onExamSaved={refresh}
        onWhatsApp={() =>
          setWhatsApp({
            ids: (cohort.students_view ?? []).map((r) => r.submission_id),
            names: new Map((cohort.students_view ?? []).map((r) => [r.submission_id, r.student_name])),
          })
        }
        onOpenKey={openKey}
      />

      {scopeGone ? (
        <ScopeGone kind={scopeGone} onLatest={toLatest} onAllBatches={toAllBatches} />
      ) : (
        <div className={cn("space-y-5 transition-opacity", busy && "pointer-events-none opacity-60")}>
          <ActionStrip
            cohort={cohort}
            notReleasedHref={href({ tab: "students", release: "provisional", urgency: null })}
            onReveal={onReveal}
          />

          {!scope ? (
            <LegacyCohort cohort={cohort} />
          ) : noSheets ? (
            <CohortEmpty reading={cohort.processing ?? 0} />
          ) : n === 0 ? (
            <section className="rounded-md border border-slate-200 bg-white p-5">
              <p className="text-base font-semibold text-brand-navy">
                No graded sheets for {scope.test_name ?? "this test"}
                {scope.batch_name ? ` in ${scope.batch_name}` : ""}
              </p>
              <p className="mt-1 text-sm text-slate-600">
                Sheets held for your check, still being read or not readable are not counted. Pick another test, or open the
                latest one.
              </p>
              <button type="button" onClick={toLatest} className={cn(btnSecondary, "mt-4")}>
                Open the latest test
              </button>
            </section>
          ) : (
            <>
              <HeadlineTiles cohort={cohort} href={href} onReveal={onReveal} />
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <StudentsCard cohort={cohort} href={href} onReveal={onReveal} />
                <ReteachCard cohort={cohort} href={href} onLog={onLog} onReveal={onReveal} />
                <QuestionsCard cohort={cohort} href={href} onOpenKey={openKey} onPickTest={pickTest} onReveal={onReveal} />
              </div>
              <CohortTabs tabs={tabs} selected={params.tab} onSelect={(tab: CohortTab) => update({ tab })} reveal={reveal}>
                {panel}
              </CohortTabs>
            </>
          )}

          <AboutData
            cohort={cohort}
            open={aboutOpen}
            onToggle={setAboutOpen}
            focusKey={focusKey}
            onRerunQueued={refresh}
            onToast={setToast}
          />
        </div>
      )}

      <WhatsAppDialog
        open={whatsApp !== null}
        onClose={() => setWhatsApp(null)}
        submissionIds={whatsApp?.ids ?? []}
        names={whatsApp?.names ?? new Map()}
        whatsappMode={health?.whatsapp_mode ?? null}
      />
      <LogInterventionDialog
        target={logTarget}
        onClose={() => setLogTarget(null)}
        onLogged={(count) => {
          void refresh();
          if (count > 0) {
            setLogTarget(null);
            setToast({
              kind: "success",
              message: `Logged for ${plural(count, "student")} - the effect is measured at their next test.`,
              action: { label: "See progress", href: href({ tab: "progress" }), onClick: () => onReveal("progress") },
            });
          }
        }}
      />
      <Toast toast={toast} onClose={closeToast} />
    </div>
  );
}
