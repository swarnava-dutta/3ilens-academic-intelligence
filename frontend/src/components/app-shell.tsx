"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { errorMessage, getFilters, getHealth } from "@/lib/api";
import type { Batch, Health } from "@/lib/types";
import { cn } from "@/lib/utils";
import { batchLabel, FALLBACK_INSTITUTION } from "@/components/workspace/format";

/* ------------------------------------------------------------------ */
/* Health context: one GET /api/health poller shared by the whole app  */
/* ------------------------------------------------------------------ */

export interface HealthState {
  /** Last good /api/health payload (kept while the API is briefly unreachable). */
  health: Health | null;
  /** errorMessage() text of the most recent failed health check, null when healthy. */
  error: string | null;
  /** True until the first health check settles. */
  loading: boolean;
  /** Every batch (GET /api/filters): null while loading, [] when unavailable. */
  batches: Batch[] | null;
  /** Re-read health and the batch list now (e.g. after saving a batch's exam date). */
  refresh: () => Promise<void>;
}

const HealthContext = createContext<HealthState>({
  health: null,
  error: null,
  loading: true,
  batches: null,
  refresh: async () => {},
});

/** Read the shared API health (AI readiness, institution, batches) from any client component. */
export function useHealth(): HealthState {
  return useContext(HealthContext);
}

/** Used until GET /api/health answers (or when it is unreachable); the backend default (BRD FR-2.4). */
const DEFAULT_OCR_THRESHOLD = 0.7;

/** Auto-grade OCR confidence threshold (0-1): below it a sheet goes to human review. */
export function useOcrThreshold(): number {
  const value = useHealth().health?.ocr_confidence_threshold;
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1 ? value : DEFAULT_OCR_THRESHOLD;
}

const HEALTH_POLL_MS = 10_000;

function useHealthPolling(): HealthState {
  const [state, setState] = useState<Omit<HealthState, "batches" | "refresh">>({
    health: null,
    error: null,
    loading: true,
  });
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const inFlight = useRef(false);

  // Loaded once and on refresh(), not on every poll (GET /api/filters also scans the results).
  const loadBatches = useCallback(async () => {
    try {
      setBatches((await getFilters()).batches ?? []);
    } catch {
      setBatches((prev) => prev ?? []);
    }
  }, []);

  const refreshHealth = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const health = await getHealth();
      setState({ health, error: null, loading: false });
    } catch (err) {
      setState((prev) => ({ ...prev, error: errorMessage(err), loading: false }));
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refreshHealth();
    void loadBatches();
    const id = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refreshHealth();
    }, HEALTH_POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshHealth, loadBatches]);

  const refresh = useCallback(async () => {
    await Promise.all([refreshHealth(), loadBatches()]);
  }, [refreshHealth, loadBatches]);

  return { ...state, batches, refresh };
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

/**
 * Console navigation: Students, Intake, Cohort, Owner, Integrations, How it works. `short` is the
 * label below the sm breakpoint (the row also scrolls sideways).
 */
const NAV_ITEMS = [
  { href: "/students", label: "Students", short: "Students" },
  { href: "/", label: "Intake", short: "Intake" },
  { href: "/cohort", label: "Cohort", short: "Cohort" },
  { href: "/owner", label: "Owner", short: "Owner" },
  { href: "/integrations", label: "Integrations", short: "LMS/AI" },
  { href: "/journey", label: "How it works", short: "Journey" },
] as const;

function isActive(href: string, pathname: string | null): boolean {
  if (!pathname) return false;
  if (href === "/") return pathname === "/" || pathname.startsWith("/report");
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavList({ pathname }: { pathname: string | null }) {
  return (
    <ul className="-mb-px flex overflow-x-auto [scrollbar-width:none]">
      {NAV_ITEMS.map(({ href, label, short }) => {
        const active = isActive(href, pathname);
        return (
          <li key={href} className="shrink-0">
            <Link
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-10 items-center whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors duration-150 focus-visible:-outline-offset-2",
                active
                  ? "border-brand-cyan text-brand-navy"
                  : "border-transparent text-slate-600 hover:border-slate-300 hover:text-brand-navy",
              )}
            >
              <span className="sm:hidden">{short}</span>
              <span className="hidden sm:inline">{label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** usePathname can suspend on dynamic routes under cacheComponents, so it lives in its own leaf. */
function ActiveNavList() {
  const pathname = usePathname();
  return <NavList pathname={pathname} />;
}

function AiStatus({ health, error, loading }: Pick<HealthState, "health" | "error" | "loading">) {
  let tone: "ok" | "warn" | "down" | "idle";
  let label: string;
  let title: string;
  if (error) {
    tone = "down";
    label = "API offline";
    title = error;
  } else if (loading || !health) {
    tone = "idle";
    label = "Connecting…";
    title = "Checking the 3iLens API";
  } else if (health.ai_ready) {
    tone = "ok";
    label = "AI ready";
    title = `AI providers configured (vision: ${health.vision_provider})`;
  } else {
    tone = "warn";
    label = "AI keys missing";
    title = `Missing: ${health.missing_configuration.join(", ") || "AI configuration"}`;
  }

  return (
    <span
      role="status"
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap text-xs",
        tone === "ok" && "text-slate-600",
        tone === "warn" && "font-medium text-amber-800",
        tone === "down" && "font-medium text-red-700",
        tone === "idle" && "text-slate-500",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "h-2 w-2 rounded-full",
          tone === "ok" && "bg-brand-lime-600",
          tone === "warn" && "bg-amber-500",
          tone === "down" && "bg-red-600",
          tone === "idle" && "bg-slate-400",
        )}
      />
      {label}
    </span>
  );
}

/** Pages filtered by ?batch_id (none = every batch), and pages that always span every batch. */
const BATCH_FILTERED = ["/cohort", "/students"];
const EVERY_BATCH = ["/owner"];

/** The batch a page shows: its id, "all", or null on pages that are not about batches. */
function pageBatch(pathname: string | null, batchId: string | null): number | "all" | null {
  if (pathname && EVERY_BATCH.includes(pathname)) return "all";
  if (!pathname || !BATCH_FILTERED.includes(pathname)) return null;
  const id = Number(batchId);
  return Number.isInteger(id) && id > 0 ? id : "all";
}

function Sep({ at }: { at: "md" | "lg" }) {
  return (
    <span className={cn("hidden text-slate-300", at === "md" ? "md:inline" : "lg:inline")} aria-hidden>
      /
    </span>
  );
}

/**
 * "Institution / batch in view / NEET in N days". The batch is the one the page is filtered to
 * ("All batches" without a filter, and on /owner); other pages name no batch. The countdown is that
 * batch's, or with no single batch in view the one every batch shares (none when their dates differ).
 */
const noSubscribe = () => () => {};

function Crumb({ scope }: { scope: number | "all" | null }) {
  // The server HTML has no API data, and this Suspense leaf can hydrate after health/batches load,
  // so it hydrates empty (matching the server) and fills in right after.
  const hydrated = useSyncExternalStore(noSubscribe, () => true, () => false);
  const live = useHealth();
  const { health, batches } = hydrated ? live : { health: null, batches: null };
  // The placeholder institution ("Instit-42") is never shown as if it were a real name.
  const institution = health?.institution?.name && health.institution.name !== FALLBACK_INSTITUTION ? health.institution.name : null;
  const pool = batches?.length ? batches : health?.batch ? [health.batch] : [];
  const inView = typeof scope === "number" ? pool.find((b) => b.id === scope) ?? null : null;
  const label = scope === "all" ? "All batches" : batchLabel(inView);
  const shared = pool.every((b) => b.exam === pool[0].exam && b.exam_date === pool[0].exam_date) ? pool[0] ?? null : null;
  const examBatch = typeof scope === "number" ? inView : shared;
  const exam = examBatch?.exam || null;
  const days = examBatch?.days_to_exam;
  const assumed = examBatch?.exam_date_assumed ?? false;
  const examTitle =
    exam && examBatch?.exam_date
      ? `${exam} on ${examBatch.exam_date}${assumed ? " (assumed date - set it on the Cohort page)" : ""}`
      : undefined;

  return (
    <p
      className="flex min-w-0 items-center gap-1.5 whitespace-nowrap"
      title={[institution ? "Institution" : null, label ? "batch in view" : null, examTitle].filter(Boolean).join(" · ")}
    >
      {institution ? <span className="hidden truncate lg:inline">{institution}</span> : null}
      {label ? (
        <>
          {institution ? <Sep at="lg" /> : null}
          <span className="hidden truncate font-medium text-brand-navy md:inline">{label}</span>
        </>
      ) : null}
      {exam && typeof days === "number" ? (
        <>
          {label ? <Sep at="md" /> : institution ? <Sep at="lg" /> : null}
          <span title={examTitle} className="text-slate-600">
            {exam} in {assumed ? "~" : ""}
            {days} {days === 1 ? "day" : "days"}
            {assumed ? <span className="hidden sm:inline"> (date assumed)</span> : null}
          </span>
        </>
      ) : null}
    </p>
  );
}

/** usePathname / useSearchParams suspend under cacheComponents, so the page scope is read in a leaf. */
function PageCrumb() {
  return <Crumb scope={pageBatch(usePathname(), useSearchParams().get("batch_id"))} />;
}

export function AppShell({ children }: { children: ReactNode }) {
  const healthState = useHealthPolling();
  const { health, error, loading } = healthState;

  return (
    <HealthContext value={healthState}>
      <a
        href="#main-content"
        className="sr-only z-50 rounded-md bg-white px-3 py-2 text-sm font-medium text-[#1E40AF] focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:outline-2 focus:outline-[#1E40AF]"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white print:hidden">
        <div className="mx-auto flex h-12 w-full max-w-7xl items-center gap-4 px-4 sm:px-6 lg:px-8">
          <Link
            href="/"
            className="flex items-baseline gap-2 whitespace-nowrap"
            aria-label="3iLens Academic Intelligence - Intake"
          >
            <span className="text-[17px] font-semibold tracking-tight text-brand-navy">3iLens</span>
            <span className="hidden text-[13px] text-slate-500 sm:inline">Academic Intelligence</span>
          </Link>

          <div className="ml-auto flex min-w-0 items-center gap-3 text-xs text-slate-600">
            <Suspense fallback={<Crumb scope={null} />}>
              <PageCrumb />
            </Suspense>
            <span className="h-4 w-px bg-slate-200" aria-hidden />
            <AiStatus health={health} error={error} loading={loading} />
          </div>
        </div>

        <nav aria-label="Primary" className="sair-staff-only mx-auto w-full max-w-7xl px-1 sm:px-3 lg:px-5">
          <Suspense fallback={<NavList pathname={null} />}>
            <ActiveNavList />
          </Suspense>
        </nav>
      </header>

      <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 outline-none sm:px-6 lg:px-8">
        {children}
      </main>

      <footer className="sair-staff-only border-t border-slate-200 print:hidden">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-1 px-4 py-3 text-xs text-slate-500 sm:flex-row sm:justify-between sm:px-6 lg:px-8">
          <p>Proof of concept · local pipeline (SQLite, local storage) · WhatsApp delivery simulated</p>
          <p>3iLens Academic Intelligence</p>
        </div>
      </footer>
    </HealthContext>
  );
}
