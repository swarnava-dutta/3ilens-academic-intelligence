// What the Upload buttons may do while the intake's answer key is taken on the fly.

/**
 * blocked: no answer-key source yet - the button is disabled with this reason.
 * waiting: the key is not ready (drafting, or a question to fix) - a click queues the sheets in the
 * browser and they are sent the moment the key is ready.
 */
export interface IntakeGate {
  blocked: string | null;
  waiting: string | null;
  /** Sheets are queued in the browser, waiting for the key. */
  queued: boolean;
  /**
   * Queued sheets wait for a click: a hand edit made the key valid after they were queued (they do
   * not go on the keystroke that did it).
   */
  held: boolean;
  /** Upload now, or queue until the key is ready. */
  send: () => void;
  /** Take the sheets out of the queue (they stay staged). */
  cancel: () => void;
}

/** "Sent the moment the answer key is ready" note under a queued upload. */
export function queuedNote(what: string, waiting: string | null): string {
  return `${what} queued - sent automatically the moment the answer key is ready. Keep this page open.${
    waiting ? ` ${waiting}` : ""
  }`;
}

/** Upload button text while a click waits for another upload to save the answer key on the server. */
export const KEY_SAVE_WAIT = "Waiting for the answer key to be saved…";

/** Note under it: what waits ("this sheet goes", "3 sheets go") and why. */
export function keySaveNote(what: string): string {
  return `The upload in progress is saving the answer key on the server; ${what} right after it.`;
}
