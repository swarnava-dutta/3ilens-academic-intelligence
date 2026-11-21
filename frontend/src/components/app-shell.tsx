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
import { Building2, CalendarClock, LayoutDashboard, Route, Upload, Users } from "lucide-react";
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

/** Faculty console navigation (V5 wireframe parity): Students · Intake · Cohort · How it works. */
const NAV_ITEMS = [
  { href: "/students", label: "Students", Icon: Users },
  { href: "/", label: "Intake", Icon: Upload },
  { href: "/cohort", label: "Cohort", Icon: LayoutDashboard },
  { href: "/journey", label: "How it works", Icon: Route },
] as const;

function isActive(href: string, pathname: string | null): boolean {
  if (!pathname) return false;
  if (href === "/") return pathname === "/" || pathname.startsWith("/report");
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavList({ pathname }: { pathname: string | null }) {
  return (
    <ul className="flex w-full items-center gap-0.5 rounded-xl bg-slate-100/80 p-1 sm:gap-1 md:w-auto md:bg-transparent md:p-0">
      {NAV_ITEMS.map(({ href, label, Icon }) => {
        const active = isActive(href, pathname);
        return (
          <li key={href} className="flex-1 md:flex-none">
            <Link
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center justify-center gap-2 whitespace-nowrap rounded-lg px-1 py-2 text-xs font-medium transition-colors sm:px-3 sm:text-sm",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-2",
                active
                  ? "bg-white text-brand-navy shadow-sm ring-1 ring-slate-200 md:bg-brand-cyan-50 md:text-brand-navy md:shadow-none md:ring-brand-cyan/30"
                  : "text-slate-600 hover:bg-white/70 hover:text-brand-navy md:hover:bg-slate-100",
              )}
            >
              <Icon
                className={cn("hidden h-4 w-4 sm:block", active ? "text-brand-cyan" : "text-slate-400")}
                aria-hidden
              />
              {label}
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

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={className} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="three-i-lens-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#13315c" />
          <stop offset="1" stopColor="#0b2545" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="11" fill="url(#three-i-lens-bg)" />
      {/* Lens ring with an open aperture at the top right */}
      <path
        d="M26.71 10.05 A12 12 0 1 0 31.88 18.33"
        fill="none"
        stroke="#05a7c5"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      {/* Insight glint */}
      <circle cx="30.18" cy="13.64" r="2.4" fill="#a0d84e" />
      <text
        x="19.6"
        y="24.4"
        textAnchor="middle"
        fontSize="12.5"
        fontWeight="700"
        fill="#ffffff"
        style={{ fontFamily: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif", letterSpacing: "-0.04em" }}
      >
        3i
      </text>
    </svg>
  );
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
        "inline-flex items-center gap-2 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset",
        tone === "ok" && "bg-brand-lime-50 text-brand-lime-600 ring-brand-lime/40",
        tone === "warn" && "bg-amber-50 text-amber-800 ring-amber-300",
        tone === "down" && "bg-rose-50 text-rose-700 ring-rose-200",
        tone === "idle" && "bg-slate-100 text-slate-500 ring-slate-200",
      )}
    >
      <span className="relative flex h-2 w-2" aria-hidden>
        {(tone === "ok" || tone === "idle") && (
          <span
            className={cn(
              "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
              tone === "ok" ? "bg-brand-lime" : "bg-slate-400",
            )}
          />
        )}
        <span
          className={cn(
            "relative inline-flex h-2 w-2 rounded-full",
            tone === "ok" && "bg-brand-lime-600",
            tone === "warn" && "bg-amber-500",
            tone === "down" && "bg-rose-500",
            tone === "idle" && "bg-slate-400",
          )}
        />
      </span>
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
      <header className="sticky top-0 z-40 print:hidden border-b border-slate-200/80 bg-white/85 backdrop-blur supports-[backdrop-filter]:bg-white/75">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6 lg:px-8">
          <Link
            href="/"
            className="group flex items-center gap-3 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-2"
            aria-label="3iLens Academic Intelligence - Intake"
          >
            <LogoMark className="h-9 w-9 shrink-0 drop-shadow-sm transition-transform group-hover:scale-105" />
            <span className="flex flex-col leading-tight">
              <span className="text-base font-bold tracking-tight text-brand-navy">
                3i<span className="text-brand-cyan">Lens</span>
              </span>
              <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">
                Academic Intelligence
              </span>
            </span>
          </Link>

          <nav aria-label="Primary" className="order-last w-full md:order-none md:w-auto">
            <Suspense fallback={<NavList pathname={null} />}>
              <ActiveNavList />
            </Suspense>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <span
              className="hidden items-center gap-1.5 whitespace-nowrap rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-200 sm:inline-flex"
              title={examTitle ? `Institution · active batch · ${examTitle}` : "Institution · active batch"}
            >
              <Building2 className="h-3.5 w-3.5 text-brand-navy/70" aria-hidden />
              {institution}
              <span className="text-slate-300" aria-hidden>
                ·
              </span>
              <span className="text-brand-navy">{batch}</span>
              {exam && typeof days === "number" ? (
                <>
                  <span className="text-slate-300" aria-hidden>
                    ·
                  </span>
                  <span className="inline-flex items-center gap-1 text-slate-600" title={examTitle}>
                    <CalendarClock className="h-3.5 w-3.5 text-brand-cyan" aria-hidden />
                    {exam} in {days}d{assumed ? <span className="text-slate-400">*</span> : null}
                  </span>
                </>
              ) : null}
            </span>
            <AiStatus health={health} error={error} loading={loading} />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8">{children}</main>

      <footer className="border-t border-slate-200 bg-white/60 print:hidden">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-1 px-4 py-4 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <p>
            <span className="font-semibold text-brand-navy">PoC</span> · local pipeline (BackgroundTasks · SQLite ·
            local storage) · WhatsApp delivery simulated
          </p>
          <p className="text-slate-400">3iLens Academic Intelligence</p>
        </div>
      </footer>
    </HealthContext>
  );
}
