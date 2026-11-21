"use client";

import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { ReportLoadError } from "./report-states";

/**
 * Keeps an unexpected render error (e.g. a malformed result payload) from blanking the page
 * during a client demo. Shows the friendly error card instead.
 */
export class ReportErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Student Intelligence Report failed to render", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <ReportLoadError
          message="This report contains data the page could not display. Try reloading, or return to the workspace."
          onRetry={() => this.setState({ error: null })}
        />
      );
    }
    return this.props.children;
  }
}
