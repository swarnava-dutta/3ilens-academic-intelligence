"use client";

import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { currentHash, focusQuestion, replaceHash, scrollToId } from "./report-events";

/** label = the section heading; nav = the desktop tab text (eight tabs fit one row); short = phones. */
export const REPORT_SECTIONS = [
  { id: "overview", n: "01", label: "Executive overview", nav: "Executive overview", short: "Overview" },
  { id: "analytics", n: "02", label: "Performance analytics", nav: "Analytics", short: "Analytics" },
  { id: "diagnostics", n: "03", label: "Subject & topic diagnostics", nav: "Topic diagnostics", short: "Diagnostics" },
  { id: "action-plan", n: "04", label: "Teacher action plan", nav: "Action plan", short: "Action plan" },
  { id: "behaviour", n: "05", label: "Exam behaviour", nav: "Exam behaviour", short: "Behaviour" },
  { id: "interventions", n: "06", label: "Interventions", nav: "Interventions", short: "Interventions" },
  { id: "evidence", n: "07", label: "Question evidence & controls", nav: "Evidence & controls", short: "Evidence" },
  { id: "pages", n: "08", label: "Original pages", nav: "Original pages", short: "Pages" },
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
      className="sticky top-[7.4rem] z-30 border-b border-slate-200 bg-[#f6f7f9] md:top-[4.4rem] print:hidden"
    >
      <ol className="relative flex overflow-x-auto print:overflow-visible [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
                  "-mb-px flex min-h-10 items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-cyan",
                  isActive
                    ? "border-brand-cyan-600 text-brand-navy"
                    : "border-transparent text-slate-600 hover:border-slate-300 hover:text-brand-navy",
                )}
              >
                <span
                  className={cn(
                    "text-xs tabular-nums",
                    isActive ? "text-brand-cyan-600" : "text-slate-500",
                  )}
                >
                  {s.n}
                </span>
                <span className="hidden lg:inline" title={s.label}>
                  {s.nav}
                </span>
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
      className="scroll-mt-[11.5rem] space-y-4 md:scroll-mt-[8.5rem] print:space-y-4"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-slate-300 pb-2 print:break-after-avoid">
        <h2 id={`${id}-heading`} className="text-lg font-semibold text-brand-navy">
          <span className="mr-2 tabular-nums text-slate-400">{meta.n}</span>
          {meta.label}
        </h2>
        {description ? <p className="text-[13px] text-slate-500">{description}</p> : null}
      </header>
      {children}
    </section>
  );
}
