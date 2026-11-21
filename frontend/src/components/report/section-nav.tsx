"use client";

import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { currentHash, focusQuestion, replaceHash, scrollToId } from "./report-events";

export const REPORT_SECTIONS = [
  { id: "overview", n: "01", label: "Executive overview", short: "Overview" },
  { id: "diagnostics", n: "02", label: "Subject & topic diagnostics", short: "Diagnostics" },
  { id: "action-plan", n: "03", label: "Teacher action plan", short: "Action plan" },
  { id: "behaviour", n: "04", label: "Exam behaviour", short: "Behaviour" },
  { id: "evidence", n: "05", label: "Question evidence & controls", short: "Evidence" },
  { id: "pages", n: "06", label: "Original pages", short: "Pages" },
] as const;

export type ReportSectionId = (typeof REPORT_SECTIONS)[number]["id"];

const SECTION_IDS: string[] = REPORT_SECTIONS.map((s) => s.id);

/** Section that contains the element the URL hash points at (#q-3 lives in "evidence"). */
function sectionForHash(hash: string): ReportSectionId {
  if (SECTION_IDS.includes(hash)) return hash as ReportSectionId;
  if (typeof document !== "undefined" && hash) {
    const el = document.getElementById(hash);
    const section = el?.closest<HTMLElement>("[data-report-section]");
    if (section && SECTION_IDS.includes(section.id)) return section.id as ReportSectionId;
  }
  if (/^page-\d+$/.test(hash)) return "pages";
  if (/^q-\d+$/.test(hash)) return "evidence";
  return "overview";
}

/**
 * Sticky in-page navigation for the report sections. The page stays one long scroll (so
 * print includes everything); the section in view is highlighted and kept in the URL hash.
 * A deep link inside a section (#q-3, #page-2) is left alone while that section is in view.
 */
export function SectionNav() {
  const [active, setActive] = useState<ReportSectionId>(() => sectionForHash(currentHash()));

  // Deep links (/report/12#q-3, #page-2, #roi-lab) arrive before the client-rendered report
  // exists, so the browser cannot scroll to them: do it once the sections have mounted.
  useEffect(() => {
    const hash = currentHash();
    if (!hash) return;
    const timer = window.setTimeout(() => {
      const q = /^q-(\d+)$/.exec(hash);
      if (q) focusQuestion(Number(q[1]));
      else if (/^page-\d+$/.test(hash)) scrollToId("source-pages");
      else if (document.getElementById(hash)) scrollToId(hash);
    }, 150);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const sections = SECTION_IDS.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => !!el);
    if (sections.length === 0) return;

    const activate = (id: ReportSectionId) => {
      setActive(id);
      const hash = currentHash();
      if (hash === id) return;
      const target = hash ? document.getElementById(hash) : null;
      const section = document.getElementById(id);
      // Keep #q-3 / #page-2 while their own section is the one in view.
      if (target && section && section !== target && section.contains(target)) return;
      if (!hash && id === "overview" && window.scrollY < 200) return;
      replaceHash(id);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        const hit = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (hit) activate(hit.target.id as ReportSectionId);
      },
      { rootMargin: "-30% 0px -65% 0px" },
    );
    sections.forEach((el) => observer.observe(el));

    // A short last section never reaches the band: activate it at the bottom of the page.
    const onScroll = () => {
      const bottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 8;
      if (bottom) activate(sections[sections.length - 1].id as ReportSectionId);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  return (
    <nav
      aria-label="Report sections"
      className="sticky top-[7.4rem] z-30 -mx-1 rounded-2xl border border-slate-200 bg-white/90 p-1.5 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-white/80 md:top-[4.4rem] print:hidden"
    >
      <ol className="flex gap-1 relative overflow-x-auto print:overflow-visible [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {REPORT_SECTIONS.map((s) => {
          const isActive = active === s.id;
          return (
            <li key={s.id} className="shrink-0">
              <a
                href={`#${s.id}`}
                aria-current={isActive ? "location" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  setActive(s.id);
                  scrollToId(s.id);
                  replaceHash(s.id);
                }}
                className={cn(
                  "flex items-center gap-2 whitespace-nowrap rounded-xl px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan",
                  isActive ? "bg-brand-navy text-white shadow-sm" : "text-slate-600 hover:bg-slate-100 hover:text-brand-navy",
                )}
              >
                <span
                  className={cn(
                    "font-mono text-xs tabular-nums",
                    isActive ? "text-brand-cyan" : "text-slate-400",
                  )}
                >
                  {s.n}
                </span>
                <span className="hidden lg:inline">{s.label}</span>
                <span className="lg:hidden">{s.short}</span>
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Numbered section wrapper ("01 | Executive overview"), the anchor target for the nav. */
export function ReportSection({
  id,
  description,
  children,
}: {
  id: ReportSectionId;
  description?: string;
  children: ReactNode;
}) {
  const meta = REPORT_SECTIONS.find((s) => s.id === id)!;
  return (
    <section
      id={id}
      data-report-section
      aria-labelledby={`${id}-heading`}
      className="scroll-mt-[11.5rem] space-y-6 md:scroll-mt-[8.5rem] print:space-y-4"
    >
      <header className="flex flex-wrap items-end justify-between gap-2 border-b-2 border-brand-cyan/70 pb-2 print:break-after-avoid">
        <h2 id={`${id}-heading`} className="text-xl font-semibold tracking-tight text-brand-cyan-600 sm:text-2xl">
          <span className="tabular-nums">{meta.n}</span>
          <span className="mx-2 text-brand-cyan/50" aria-hidden>
            |
          </span>
          <span className="text-brand-navy">{meta.label}</span>
        </h2>
        {description ? <p className="text-xs text-slate-500">{description}</p> : null}
      </header>
      {children}
    </section>
  );
}
