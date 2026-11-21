"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { errorMessage, getHealth } from "@/lib/api";
import type { Health } from "@/lib/types";
import { cn } from "@/lib/utils";
import { batchLabel, FALLBACK_BATCH, FALLBACK_INSTITUTION } from "@/components/workspace/format";

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
  refresh: () => Promise<void>;
}

const HealthContext = createContext<HealthState>({
  health: null,
  error: null,
  loading: true,
  refresh: async () => {},
});

/** Read the shared API health (AI readiness, institution, batch) from any client component. */
export function useHealth(): HealthState {
  return useContext(HealthContext);
}

/** Used until GET /api/health answers (or when it is unreachable); the backend default (BRD FR-2.4). */
export const DEFAULT_OCR_THRESHOLD = 0.7;

/** Auto-grade OCR confidence threshold (0-1): below it a sheet goes to human review. */
export function useOcrThreshold(): number {
  const value = useHealth().health?.ocr_confidence_threshold;
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1 ? value : DEFAULT_OCR_THRESHOLD;
}

const HEALTH_POLL_MS = 10_000;

function useHealthPolling(): HealthState {
  const [state, setState] = useState<Omit<HealthState, "refresh">>({
    health: null,
    error: null,
    loading: true,
  });
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
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
    void refresh();
    const id = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, HEALTH_POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  return { ...state, refresh };
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

export function AppShell({ children }: { children: ReactNode }) {
  const healthState = useHealthPolling();
  const { health, error, loading } = healthState;
  const institution = health?.institution?.name || FALLBACK_INSTITUTION;
  const batch = batchLabel(health?.batch) ?? FALLBACK_BATCH;
  const exam = health?.batch?.exam || health?.batch?.exam_type || null;
  const days = health?.batch?.days_to_exam;
  const assumed = health?.batch?.exam_date_assumed ?? false;
  const examTitle =
    exam && health?.batch?.exam_date
      ? `${exam} on ${health.batch.exam_date}${assumed ? " (assumed date - set it on the Cohort page)" : ""}`
      : undefined;

  return (
    <HealthContext value={healthState}>
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
            <p
              className="flex min-w-0 items-center gap-1.5 whitespace-nowrap"
              title={examTitle ? `Institution · active batch · ${examTitle}` : "Institution · active batch"}
            >
              <span className="hidden truncate lg:inline">{institution}</span>
              <span className="hidden text-slate-300 lg:inline" aria-hidden>
                /
              </span>
              <span className="hidden truncate font-medium text-brand-navy md:inline">{batch}</span>
              {exam && typeof days === "number" ? (
                <>
                  <span className="hidden text-slate-300 md:inline" aria-hidden>
                    /
                  </span>
                  <span title={examTitle}>
                    {exam} in {days} d{assumed ? <span className="text-slate-400">*</span> : null}
                  </span>
                </>
              ) : null}
            </p>
            <span className="h-4 w-px bg-slate-200" aria-hidden />
            <AiStatus health={health} error={error} loading={loading} />
          </div>
        </div>

        <nav aria-label="Primary" className="mx-auto w-full max-w-7xl px-1 sm:px-3 lg:px-5">
          <Suspense fallback={<NavList pathname={null} />}>
            <ActiveNavList />
          </Suspense>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>

      <footer className="border-t border-slate-200 print:hidden">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-1 px-4 py-3 text-xs text-slate-500 sm:flex-row sm:justify-between sm:px-6 lg:px-8">
          <p>Proof of concept · local pipeline (SQLite, local storage) · WhatsApp delivery simulated</p>
          <p>3iLens Academic Intelligence</p>
        </div>
      </footer>
    </HealthContext>
  );
}
