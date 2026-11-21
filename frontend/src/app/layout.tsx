import type { Metadata } from "next";
import { Fira_Code, Fira_Sans } from "next/font/google";
import { AppShell } from "@/components/app-shell";
import "./globals.css";

const firaSans = Fira_Sans({
  variable: "--font-fira-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const firaCode = Fira_Code({
  variable: "--font-fira-code",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "3iLens Academic Intelligence",
    template: "%s · 3iLens Academic Intelligence",
  },
  description:
    "Handwritten answer sheet OCR, rubric grading, student reports and cohort analytics for NEET coaching institutes.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // suppressHydrationWarning: browser extensions (password managers, Grammarly, Edge's built-in
    // assistants) add attributes to <html>/<body> before React hydrates. Only these two elements'
    // own attributes are exempt; mismatches anywhere below are still reported.
    <html
      lang="en"
      className={`${firaSans.variable} ${firaCode.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col font-sans" suppressHydrationWarning>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
