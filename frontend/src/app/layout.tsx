import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AppShell } from "@/components/app-shell";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "3iLens Academic Intelligence",
    template: "%s · 3iLens Academic Intelligence",
  },
  description:
    "Handwritten answer sheets to AI OCR, rubric evaluation, Preparation ROI and cohort insights - 3iLens Academic Intelligence proof of concept.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // suppressHydrationWarning: browser extensions (password managers, Grammarly, Edge's built-in
    // assistants) add attributes to <html>/<body> before React hydrates. Only these two elements'
    // own attributes are exempt; mismatches anywhere below are still reported.
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col bg-slate-50 font-sans text-slate-800 antialiased" suppressHydrationWarning>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
