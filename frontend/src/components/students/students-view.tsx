"use client";

import { Database, Grid3x3, LayoutGrid, Lightbulb, Loader2, RefreshCw, Users } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { FilterBar, useDashboardFilters } from "@/components/shared/filter-bar";
import { URGENCY_LABELS } from "@/components/shared/urgency-badge";
import { errorMessage, errorStatus, getCohort, getStudents, seedDemoCohort } from "@/lib/api";
import type { ClassIntervention, StudentCard, Urgency } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Notice, btnPrimary, btnSecondary } from "@/components/report/dialog";
import { WhatsAppDialog } from "@/components/report/whatsapp-dialog";
import { FocusMatrix } from "./focus-matrix";
import { normalizeStudents } from "./normalize";
import { NudgesView } from "./nudges-view";
import { StudentCardsGrid } from "./student-cards";

export type StudentsTab = "cards" | "nudges" | "focus";

const TABS: { key: StudentsTab; label: string; Icon: typeof LayoutGrid }[] = [
  { key: "cards", label: "Cards", Icon: LayoutGrid },
  { key: "nudges", label: "Nudges", Icon: Lightbulb },
  { key: "focus", label: "Preparation focus", Icon: Grid3x3 },
];

function parseTab(value: string | null): StudentsTab {
  return value === "nudges" || value === "focus" ? value : "cards";
}

type StudentsState =
  | { key: string; kind: "ready"; cards: StudentCard[] }
  | { key: string; kind: "error"; message: string; status: number | null };

type CohortState = { key: string; interventions: ClassIntervention[] | null; note: string | null };

const URGENCY_DOT: Record<Urgency, string> = {
  at_risk: "bg-rose-500",
  needs_attention: "bg-amber-400",
  on_track: "bg-brand-lime",
};

/** Students page body. Reads URL search params, so the page renders it inside <Suspense>. */
export function StudentsView() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = useDashboardFilters();
  const tab = parseTab(searchParams.get("tab"));
  const filterKey = JSON.stringify(filters);
  const [nonce, setNonce] = useState(0);
  const key = `${filterKey}#${nonce}`;
  const [students, setStudents] = useState<StudentsState | null>(null);
  const [cohort, setCohort] = useState<CohortState | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [seedError, setSeedError] = useState<string | null>(null);
  const [whatsApp, setWhatsApp] = useState<StudentCard | null>(null);

  useEffect(() => {
    let cancelled = false;
    getStudents(filters)
      .then((rows) => {
        if (!cancelled) setStudents({ key, kind: "ready", cards: normalizeStudents(rows) });
      })
      .catch((err) => {
        if (!cancelled) setStudents({ key, kind: "error", message: errorMessage(err), status: errorStatus(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [key, filters]);

  // Class interventions for the Nudges tab (cohort analytics with the same filters).
  useEffect(() => {
    if (tab !== "nudges") return;
    let cancelled = false;
    getCohort(filters)
      .then((c) => {
        if (!cancelled) setCohort({ key, interventions: Array.isArray(c?.interventions) ? c.interventions : [], note: null });
      })
      .catch((err) => {
        if (!cancelled) setCohort({ key, interventions: null, note: `Class interventions unavailable: ${errorMessage(err)}` });
      });
    return () => {
      cancelled = true;
    };
  }, [tab, key, filters]);

  const setParam = (name: string, value: string | null) => {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(name, value);
    else next.delete(name);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  async function seed() {
    setSeeding(true);
    setSeedError(null);
    try {
      await seedDemoCohort("all");
      setNonce((n) => n + 1);
    } catch (err) {
      setSeedError(errorMessage(err));
    } finally {
      setSeeding(false);
    }
  }

  const current = students?.key === key ? students : null;
  const cards = current?.kind === "ready" ? current.cards : [];
  const filtered = Object.values(filters).some((v) => v !== null && v !== undefined && v !== "");
  const counts = cards.reduce<Record<Urgency, number>>(
    (acc, c) => {
      if (c.status === "COMPLETED" && c.urgency) acc[c.urgency] += 1;
      return acc;
    },
    { at_risk: 0, needs_attention: 0, on_track: 0 },
  );
  const demoCount = cards.filter((c) => c.is_demo).length;
  const cohortHere = cohort?.key === key ? cohort : null;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-brand-cyan-600">
            <Users className="h-4 w-4" aria-hidden />
            Student intelligence
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-brand-navy">Students</h1>
          <p className="mt-1 text-sm text-slate-500">Synthetic demo records are labelled; live uploads use real AI.</p>
        </div>
        <button type="button" className={btnSecondary} onClick={() => setNonce((n) => n + 1)} disabled={!current}>
          <RefreshCw className={cn("h-4 w-4", !current && "animate-spin")} aria-hidden />
          Refresh
        </button>
      </header>

      <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm lg:flex-row lg:items-center lg:justify-between">
        <FilterBar show={["batch", "test", "urgency", "topic"]} />
        {current?.kind === "ready" && cards.length ? (
          <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600" aria-label="Students by urgency">
            {(["at_risk", "needs_attention", "on_track"] as Urgency[]).map((u) => (
              <li key={u} className="inline-flex items-center gap-1.5">
                <span aria-hidden className={cn("h-2 w-2 rounded-full", URGENCY_DOT[u])} />
                {URGENCY_LABELS[u]} <span className="font-semibold tabular-nums text-slate-800">{counts[u]}</span>
              </li>
            ))}
            <li className="text-slate-400">
              {cards.length} shown{demoCount ? ` · ${demoCount} synthetic` : ""}
            </li>
          </ul>
        ) : null}
      </div>

      <div role="tablist" aria-label="Student views" className="flex gap-1 relative overflow-x-auto print:overflow-visible rounded-xl bg-slate-100 p-1 sm:w-fit">
        {TABS.map(({ key: k, label, Icon }) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setParam("tab", k === "cards" ? null : k)}
            className={cn(
              "flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-brand-cyan",
              tab === k ? "bg-white text-brand-navy shadow-sm" : "text-slate-600 hover:text-brand-navy",
            )}
          >
            <Icon className={cn("h-4 w-4", tab === k ? "text-brand-cyan" : "text-slate-400")} aria-hidden />
            {label}
          </button>
        ))}
      </div>

      {!current ? (
        <p className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading students…
        </p>
      ) : current.kind === "error" ? (
        <Notice tone={current.status === 404 ? "info" : "error"}>
          {current.status === 404
            ? "The students endpoint (GET /api/students) is not available on this backend yet."
            : current.message}
        </Notice>
      ) : cards.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-brand-cyan-50 text-brand-cyan-600">
            <Database className="h-6 w-6" aria-hidden />
          </span>
          <p className="font-semibold text-brand-navy">{filtered ? "No students match these filters" : "No students yet"}</p>
          <p className="max-w-md text-sm text-slate-500">
            {filtered
              ? "Clear a filter, or load the synthetic demo cohort (labelled, no AI calls)."
              : "Upload answer sheets in the Faculty Workspace, or load the synthetic demo cohort (labelled, no AI calls)."}
          </p>
          <button type="button" className={btnPrimary} onClick={seed} disabled={seeding}>
            {seeding ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Database className="h-4 w-4" aria-hidden />}
            {seeding ? "Loading demo data…" : "Load demo data"}
          </button>
          {seedError ? <Notice tone="error">{seedError}</Notice> : null}
        </div>
      ) : tab === "cards" ? (
        <StudentCardsGrid cards={cards} onWhatsApp={setWhatsApp} />
      ) : tab === "nudges" ? (
        <NudgesView
          cards={cards}
          interventions={cohortHere ? cohortHere.interventions : null}
          interventionsNote={cohortHere?.note ?? null}
        />
      ) : (
        <FocusMatrix cards={cards} activeTopic={filters.topic ?? null} onTopic={(t) => setParam("topic", t)} />
      )}

      <WhatsAppDialog
        open={whatsApp !== null}
        onClose={() => setWhatsApp(null)}
        submissionIds={whatsApp ? [whatsApp.submission_id] : []}
        studentName={whatsApp?.student_name}
        testName={whatsApp ? `${whatsApp.test.name} ${whatsApp.test.version}`.trim() : undefined}
      />
    </div>
  );
}
