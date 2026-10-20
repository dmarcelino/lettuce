/**
 * Pushed remote-pi progress: the browser-side store behind `__bff_pi_progress`
 * frames (the BFF's runner flushes facts every ~2 s per running run and once
 * at settle; `bff/src/session/registry.ts` fans them out to opted-in sessions
 * only). This replaced four independent pollers — the transcript card's 3-s
 * `/status` loop, the Runs list's 6-s reload, the chip's 15-s/60-s-forever
 * loop and the run sheet's blind refetch — so a page with nothing running now
 * issues zero pi requests.
 *
 * The store is a last-seen cache, never the source of truth: consumers always
 * fetch on mount and keep a slow watchdog re-sync (stalenessWatchdogMs), so a
 * frame lost to a reconnect or a BFF restart mid-run self-heals in ~15 s.
 */

import { useSyncExternalStore } from "react";
import type { PiRunFacts } from "./pi.ts";

/** One received frame. The terminal ones are kept — that final frame is what
 * flips a card and drops the chip's count without a refetch. */
const MAX_KEEP = 32;

const frames = new Map<string, PiRunFacts>();
let snapshot: Record<string, PiRunFacts> = {};
const listeners = new Set<() => void>();

/** Module clock of the last frame arrival — the shared stall signal. */
let lastFrameAtMs = 0;

/** Called by the session client for every `__bff_pi_progress` frame. */
export function applyPiProgressFrame(frame: PiRunFacts): void {
  if (!frame || typeof frame.runId !== "string") return;
  frames.set(frame.runId, frame);
  lastFrameAtMs = Date.now();
  prune();
  snapshot = Object.fromEntries(frames);
  for (const listener of listeners) listener();
}

/** Prune on arrival: a long-lived tab must not grow one entry per run forever.
 * Running entries are kept (their next frame is expected and losing one would
 * blank a live row); when there is nothing running to drop, the oldest go, and
 * a pruned running entry simply returns with its next frame. */
function prune(): void {
  if (frames.size <= MAX_KEEP) return;
  for (const [runId, fact] of frames) {
    if (frames.size <= MAX_KEEP) return;
    if (fact.state !== "running") frames.delete(runId);
  }
  while (frames.size > MAX_KEEP) frames.delete(frames.keys().next().value as string);
}

/** Minutes since the last frame arrived — Infinity before the first one. */
export function msSinceLastPiFrame(nowMs = Date.now()): number {
  return lastFrameAtMs === 0 ? Infinity : nowMs - lastFrameAtMs;
}

/** How long a running view waits for a frame before re-syncing by fetch. */
export const stalenessWatchdogMs = 15_000;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The store read, without React: the snapshot only changes identity per frame. */
export function peekPiLiveRuns(): Record<string, PiRunFacts> {
  return snapshot;
}

/** All last-seen frames, keyed by run id — stable across unrelated renders. */
export function usePiLiveRuns(): Record<string, PiRunFacts> {
  return useSyncExternalStore(subscribe, peekPiLiveRuns);
}
