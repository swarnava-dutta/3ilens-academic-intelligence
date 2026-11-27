"use client";

import { GraduationCap, UserRound } from "lucide-react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { FOLD, OPEN_FOLD_EVENT, currentHash, openFoldAndScroll } from "./report-events";
import { focusRing } from "./summary/tokens";

type ReportViewMode = "student" | "teacher";

const STORE_KEY = "sair:report-view";
const FACULTY_FOLDS: string[] = [FOLD.review, FOLD.teaching, FOLD.reading, FOLD.audit, FOLD.lab];

type Ctx = { mode: ReportViewMode; teacher: boolean; setMode: (mode: ReportViewMode) => void };

const ReportViewContext = createContext<Ctx>({ mode: "student", teacher: false, setMode: () => {} });

/** The viewer's mode: "teacher" shows the faculty material (review, re-grade, reading quality, the
 * study-plan lab), "student" hides it. */
export function useReportView(): Ctx {
  return useContext(ReportViewContext);
}

function readStored(): ReportViewMode | null {
  try {
    const v = window.localStorage.getItem(STORE_KEY);
    return v === "teacher" || v === "student" ? v : null;
  } catch {
    return null;
  }
}

function writeStored(mode: ReportViewMode): void {
  try {
    window.localStorage.setItem(STORE_KEY, mode);
  } catch {
    /* private mode or blocked storage: the switch still works for this visit */
  }
}

/**
 * Student / teacher view of the report. A shared link opens in the student view; `?view=teacher` (or
 * `?view=student`), a deep link to a faculty fold, or the viewer's last choice (kept in this browser)
 * picks the teacher view. The mode is mirrored on <html data-report-view> so the app shell can hide the
 * staff navigation and the proof-of-concept footer in the student view.
 */
export function ReportViewProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ReportViewMode>("student");

  useEffect(() => {
    const param = new URLSearchParams(window.location.search).get("view");
    const fromUrl = param === "teacher" || param === "student" ? param : null;
    const deepFaculty = FACULTY_FOLDS.includes(currentHash());
    const initial: ReportViewMode = fromUrl ?? (deepFaculty ? "teacher" : (readStored() ?? "student"));
    // Reading the URL and storage needs the browser, so the first client render follows it here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setModeState(initial);
    // A faculty fold opened from anywhere (a "Re-grade" link, #faculty-review) needs the teacher view.
    const onOpen = (e: Event) => {
      if (FACULTY_FOLDS.includes((e as CustomEvent<string>).detail)) setModeState("teacher");
    };
    window.addEventListener(OPEN_FOLD_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_FOLD_EVENT, onOpen);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.reportView = mode;
    return () => {
      delete document.documentElement.dataset.reportView;
    };
  }, [mode]);

  const setMode = (next: ReportViewMode) => {
    setModeState(next);
    writeStored(next);
  };

  return <ReportViewContext value={{ mode, teacher: mode === "teacher", setMode }}>{children}</ReportViewContext>;
}

/** Content only the teacher view shows. */
export function TeacherOnly({ children }: { children: ReactNode }) {
  return useReportView().teacher ? <>{children}</> : null;
}

/** Segmented "Student | Teacher" switch for the report header. */
export function ViewSwitch({ className }: { className?: string }) {
  const { mode, setMode } = useReportView();
  const options: { key: ReportViewMode; label: string; Icon: typeof UserRound }[] = [
    { key: "student", label: "Student view", Icon: UserRound },
    { key: "teacher", label: "Teacher view", Icon: GraduationCap },
  ];
  return (
    <div role="group" aria-label="Report view" className={cn("inline-flex rounded-md border border-slate-300 bg-white p-0.5", className)}>
      {options.map(({ key, label, Icon }) => {
        const active = mode === key;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={active}
            onClick={() => {
              setMode(key);
              // The faculty sections mount folded at the bottom of the page: open the first one and
              // scroll to it, so switching to the teacher view visibly does something.
              if (key === "teacher" && mode !== "teacher") window.setTimeout(() => openFoldAndScroll(FOLD.teaching), 60);
            }}
            className={cn(
              "inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-[5px] px-2.5 text-[13px] font-medium transition-colors duration-150 sm:min-h-8",
              focusRing,
              active ? "bg-[#1E40AF] text-white" : "text-slate-700 hover:bg-slate-100",
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            <span className="sr-only sm:not-sr-only">{label}</span>
            <span className="sm:hidden" aria-hidden>
              {key === "student" ? "Student" : "Teacher"}
            </span>
          </button>
        );
      })}
    </div>
  );
}
