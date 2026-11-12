import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asNumber, runningProcesses, signalRunningProcess } from "@paperclipai/adapter-utils/server-utils";

// When OpenCode Go hits its usage limit, `opencode run --format json` swallows
// the provider error and hangs: nothing on stdout/stderr and no exit. OpenCode
// only records the failure in its own log. This watchdog reads that log after a
// long silence and, only on a positive match for the run's own session, lets
// the adapter stop the run as a provider-quota failure so model fallback can
// take over. Without a match it never stops anything.

export const USAGE_LIMIT_WATCHDOG_DEFAULT_SEC = 300;
export const USAGE_LIMIT_WATCHDOG_CHECK_INTERVAL_MS = 30_000;
/** Covers clock and write skew between the last output and OpenCode's log line. */
export const USAGE_LIMIT_WATCHDOG_SINCE_SLACK_MS = 60_000;
export const OPENCODE_LOG_TAIL_MAX_BYTES = 2 * 1024 * 1024;
export const OPENCODE_USAGE_LIMIT_ERROR_MESSAGE =
  "OpenCode Go usage limit exceeded (detected from the OpenCode log after 5 minutes without output)";

const USAGE_LIMIT_MARKER = "Go usage limit exceeded";

export interface UsageLimitMatch {
  at: Date;
  line: string;
}

/**
 * Splits a logfmt line into its leading `key=value` tokens. Quoted values may
 * contain spaces; they are returned without their quotes. Only top-level tokens
 * count, so a value that merely mentions `level=ERROR` does not.
 */
function logfmtFields(line: string): Map<string, string> {
  const fields = new Map<string, string>();
  const re = /([^\s=]+)=("(?:[^"\\]|\\.)*"|\S*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    const key = match[1]!;
    let value = match[2] ?? "";
    if (value.startsWith("\"") && value.endsWith("\"") && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    if (!fields.has(key)) fields.set(key, value);
  }
  return fields;
}

/**
 * Finds the latest OpenCode log line, at or after `since`, that records a Go
 * usage-limit error for exactly `sessionId`.
 */
export function findUsageLimitError(
  logTail: string | Buffer,
  sessionId: string,
  since: Date,
): UsageLimitMatch | null {
  const wanted = sessionId.trim();
  if (!wanted) return null;
  const text = typeof logTail === "string" ? logTail : logTail.toString("utf8");
  const sinceMs = since.getTime();
  let latest: UsageLimitMatch | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.includes(USAGE_LIMIT_MARKER) || !rawLine.includes(wanted)) continue;
    const line = rawLine.trim();
    const fields = logfmtFields(line);
    if (fields.get("level") !== "ERROR") continue;
    if (fields.get("session.id") !== wanted) continue;
    const timestamp = fields.get("timestamp");
    if (!timestamp) continue;
    const atMs = Date.parse(timestamp);
    if (!Number.isFinite(atMs) || atMs < sinceMs) continue;
    if (!latest || atMs >= latest.at.getTime()) latest = { at: new Date(atMs), line };
  }
  return latest;
}

export function resolveOpenCodeLogPath(env: Record<string, string | undefined>): string {
  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  const dataHome = xdgDataHome || path.join(env.HOME?.trim() || os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode", "log", "opencode.log");
}

/**
 * Reads at most the last `maxBytes` of the log. Returns null when the file does
 * not exist. The log can contain non-UTF-8 bytes, so it is read as a buffer and
 * decoded leniently; the ASCII logfmt lines survive intact.
 */
export async function readOpenCodeLogTail(
  logPath: string,
  maxBytes = OPENCODE_LOG_TAIL_MAX_BYTES,
): Promise<string | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(logPath, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, Math.max(0, maxBytes));
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** The watchdog threshold in seconds; 0 means disabled. Remote runs are never watched. */
export function resolveUsageLimitWatchdogSec(
  config: Record<string, unknown>,
  executionTargetIsRemote: boolean,
): number {
  // The log lives on the machine that runs OpenCode. For sandbox or SSH runs
  // this host's log is not the run's log, so the watchdog stays local-only.
  if (executionTargetIsRemote) return 0;
  const configured = asNumber(config.usageLimitWatchdogSec, USAGE_LIMIT_WATCHDOG_DEFAULT_SEC);
  return Number.isFinite(configured) && configured > 0 ? configured : 0;
}

/**
 * Stops a local OpenCode child the same way `runChildProcess` stops it on a
 * timeout: SIGTERM to the registered process (group), then SIGKILL after the
 * grace period. Returns a function that cancels the pending SIGKILL once the
 * process has closed.
 */
export function terminateLocalOpenCodeRun(runId: string, graceSec: number): () => void {
  const running = runningProcesses.get(runId);
  if (!running) return () => {};
  signalRunningProcess(running, "SIGTERM");
  const killTimer = setTimeout(() => {
    signalRunningProcess(running, "SIGKILL");
  }, Math.max(1, graceSec) * 1000);
  killTimer.unref?.();
  return () => clearTimeout(killTimer);
}

export interface UsageLimitWatchdogOptions {
  /** Silence threshold in seconds; 0 or less disables the watchdog. */
  thresholdSec: number;
  now?: () => number;
  readLogTail: () => Promise<string | Buffer | null>;
  /** Stops the run. Called at most once, and only after a log match. */
  kill: () => void;
  onDetected?: (match: UsageLimitMatch, sessionId: string) => void;
  /** Called at most once, when the log is missing or unreadable. */
  onWarn?: (message: string) => void;
}

export interface UsageLimitWatchdog {
  noteOutput: (stream: "stdout" | "stderr", chunk: string) => void;
  detected: () => UsageLimitMatch | null;
  sessionId: () => string | null;
  stop: () => void;
}

const SESSION_ID_RE = /"sessionID"\s*:\s*"([^"\\]+)"/;
const SESSION_SCAN_CARRY_CHARS = 256;

export function startUsageLimitWatchdog(options: UsageLimitWatchdogOptions): UsageLimitWatchdog {
  const now = options.now ?? Date.now;
  const thresholdMs = options.thresholdSec > 0 ? options.thresholdSec * 1000 : 0;
  let lastOutputAt = now();
  let sessionId: string | null = null;
  let sessionScanCarry = "";
  let detected: UsageLimitMatch | null = null;
  let checking = false;
  let warned = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  const warnOnce = (message: string) => {
    if (warned) return;
    warned = true;
    try {
      options.onWarn?.(message);
    } catch {
      // Never throw from the timer.
    }
  };

  const check = async () => {
    if (!timer || checking || detected || !sessionId) return;
    if (now() - lastOutputAt < thresholdMs) return;
    checking = true;
    try {
      const tail = await options.readLogTail();
      if (tail === null) {
        warnOnce("OpenCode log file not found; usage-limit watchdog cannot check this run.");
        return;
      }
      if (!timer || detected) return;
      const match = findUsageLimitError(tail, sessionId, new Date(lastOutputAt - USAGE_LIMIT_WATCHDOG_SINCE_SLACK_MS));
      if (!match) return;
      detected = match;
      stop();
      options.kill();
      options.onDetected?.(match, sessionId);
    } catch (err) {
      warnOnce(`OpenCode log could not be read for the usage-limit watchdog: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      checking = false;
    }
  };

  if (thresholdMs > 0) {
    // Short thresholds (tests, aggressive configs) are checked at least as often.
    timer = setInterval(() => {
      void check().catch(() => undefined);
    }, Math.min(USAGE_LIMIT_WATCHDOG_CHECK_INTERVAL_MS, thresholdMs));
    timer.unref?.();
  }

  return {
    noteOutput(stream, chunk) {
      lastOutputAt = now();
      if (sessionId || stream !== "stdout") return;
      const scan = sessionScanCarry + chunk;
      const match = SESSION_ID_RE.exec(scan);
      if (match?.[1]) {
        sessionId = match[1];
        sessionScanCarry = "";
        return;
      }
      sessionScanCarry = scan.slice(-SESSION_SCAN_CARRY_CHARS);
    },
    detected: () => detected,
    sessionId: () => sessionId,
    stop,
  };
}
