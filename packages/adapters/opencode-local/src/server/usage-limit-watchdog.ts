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
/** Production checks never run more often than this, whatever the threshold. */
export const USAGE_LIMIT_WATCHDOG_MIN_CHECK_INTERVAL_MS = 5_000;
/** Covers clock and write skew between the last output and OpenCode's log line. */
export const USAGE_LIMIT_WATCHDOG_SINCE_SLACK_MS = 60_000;
/**
 * Lines older than the attempt's start, minus this slack, never count: neither
 * a limit error (it belongs to an earlier attempt) nor a created session.
 */
export const USAGE_LIMIT_WATCHDOG_SPAWN_SLACK_MS = 5_000;
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

/**
 * Returns the ids of the sessions OpenCode created, at or after `since`, for
 * exactly `directory` (its `message=created id=<ses> ... directory=<dir>` log
 * lines), oldest first. A new session that hits the limit on its first
 * provider call prints nothing on stdout, so this is how the watchdog learns
 * its id. A sibling, parent or child directory does not match.
 */
export function findCreatedSessions(
  logTail: string | Buffer,
  directory: string,
  since: Date,
): string[] {
  if (!directory) return [];
  const text = typeof logTail === "string" ? logTail : logTail.toString("utf8");
  const sinceMs = since.getTime();
  const ids: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.includes("message=created") || !rawLine.includes("directory=")) continue;
    const fields = logfmtFields(rawLine.trim());
    if (fields.get("message") !== "created") continue;
    if (fields.get("directory") !== directory) continue;
    const id = fields.get("id");
    const timestamp = fields.get("timestamp");
    if (!id || !timestamp) continue;
    const atMs = Date.parse(timestamp);
    if (!Number.isFinite(atMs) || atMs < sinceMs) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * The directory OpenCode runs in: the `--dir` option of `opencode run` (before
 * any `--`), resolved against the process cwd. OpenCode logs it as the
 * `directory` of the sessions it creates.
 */
export function resolveOpenCodeRunDirectory(args: readonly string[], cwd: string): string | null {
  let dir: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") break;
    if (arg === "--dir" && index + 1 < args.length) {
      dir = args[index + 1]!;
      index += 1;
    } else if (arg.startsWith("--dir=")) {
      dir = arg.slice("--dir=".length);
    }
  }
  return dir ? path.resolve(cwd, dir) : null;
}

/** Production interval: every 30 s, or the threshold if shorter, but never under 5 s. */
export function resolveUsageLimitCheckIntervalMs(thresholdSec: number): number {
  return Math.max(
    USAGE_LIMIT_WATCHDOG_MIN_CHECK_INTERVAL_MS,
    Math.min(USAGE_LIMIT_WATCHDOG_CHECK_INTERVAL_MS, Math.max(0, thresholdSec) * 1000),
  );
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
  onDetected?: (detection: UsageLimitDetection) => void;
  /** Called once when the log is missing or unreadable, and once if the kill fails. */
  onWarn?: (message: string) => void;
  /** The `--session` id this attempt resumes, known before spawn. */
  resumeSessionId?: string | null;
  /** The OpenCode `--dir` of this attempt, used to find a session it created. */
  directory?: string | null;
  /** Overrides the production check interval (tests only). */
  checkIntervalMs?: number;
}

export type UsageLimitSessionSource = "stdout" | "resume" | "log_created";

export interface UsageLimitDetection extends UsageLimitMatch {
  sessionId: string;
  sessionSource: UsageLimitSessionSource;
  /** The configured silence threshold. */
  thresholdSec: number;
  /** The measured silence (now - last output) when the limit was detected. */
  silenceSec: number;
}

export interface UsageLimitWatchdog {
  noteOutput: (stream: "stdout" | "stderr", chunk: string) => void;
  detected: () => UsageLimitDetection | null;
  /** The session known without the log: stdout first, else the resume id. */
  sessionId: () => string | null;
  stop: () => void;
}

const SESSION_ID_RE = /"sessionID"\s*:\s*"([^"\\]+)"/;
const SESSION_SCAN_CARRY_CHARS = 256;

export function startUsageLimitWatchdog(options: UsageLimitWatchdogOptions): UsageLimitWatchdog {
  const now = options.now ?? Date.now;
  const thresholdMs = options.thresholdSec > 0 ? options.thresholdSec * 1000 : 0;
  const startedAt = now();
  const resumeSessionId = options.resumeSessionId?.trim() || null;
  const directory = options.directory?.trim() || null;
  let lastOutputAt = startedAt;
  let stdoutSessionId: string | null = null;
  let sessionScanCarry = "";
  let detected: UsageLimitDetection | null = null;
  let checking = false;
  const warned = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  const warnOnce = (key: "log" | "kill", message: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    try {
      options.onWarn?.(message);
    } catch {
      // Never throw from the timer.
    }
  };

  // Session sources, in order: the stdout `sessionID`, else the resumed
  // `--session` id, else sessions the log shows were created for this
  // attempt's directory after it started.
  const knownSession = (): { id: string; source: UsageLimitSessionSource } | null =>
    stdoutSessionId
      ? { id: stdoutSessionId, source: "stdout" }
      : resumeSessionId
        ? { id: resumeSessionId, source: "resume" }
        : null;

  const findDetection = (tail: string | Buffer, checkedAt: number): UsageLimitDetection | null => {
    const floor = startedAt - USAGE_LIMIT_WATCHDOG_SPAWN_SLACK_MS;
    const since = new Date(Math.max(floor, lastOutputAt - USAGE_LIMIT_WATCHDOG_SINCE_SLACK_MS));
    const known = knownSession();
    const candidates = known
      ? [known]
      : directory
        ? findCreatedSessions(tail, directory, new Date(floor)).map((id) => ({ id, source: "log_created" as const }))
        : [];
    let best: UsageLimitDetection | null = null;
    for (const candidate of candidates) {
      const match = findUsageLimitError(tail, candidate.id, since);
      if (!match || (best && match.at.getTime() < best.at.getTime())) continue;
      best = {
        ...match,
        sessionId: candidate.id,
        sessionSource: candidate.source,
        thresholdSec: options.thresholdSec,
        silenceSec: Math.round(checkedAt - lastOutputAt) / 1000,
      };
    }
    return best;
  };

  const check = async () => {
    if (!timer || checking || detected) return;
    if (!knownSession() && !directory) return;
    if (now() - lastOutputAt < thresholdMs) return;
    checking = true;
    let detection: UsageLimitDetection | null = null;
    try {
      const tail = await options.readLogTail();
      if (tail === null) {
        warnOnce("log", "OpenCode log file not found; usage-limit watchdog cannot check this run.");
        return;
      }
      if (!timer || detected) return;
      detection = findDetection(tail, now());
    } catch (err) {
      warnOnce("log", `OpenCode log could not be read for the usage-limit watchdog: ${err instanceof Error ? err.message : String(err)}`);
      return;
    } finally {
      checking = false;
    }
    if (!detection) return;
    detected = detection;
    stop();
    try {
      options.kill();
    } catch (err) {
      // The run is still reported as provider_quota once the process ends.
      warnOnce("kill", `Usage-limit watchdog could not stop the OpenCode process: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      options.onDetected?.(detection);
    } catch {
      // Never throw from the timer.
    }
  };

  if (thresholdMs > 0) {
    const intervalMs = options.checkIntervalMs && options.checkIntervalMs > 0
      ? options.checkIntervalMs
      : resolveUsageLimitCheckIntervalMs(options.thresholdSec);
    timer = setInterval(() => {
      void check().catch(() => undefined);
    }, intervalMs);
    timer.unref?.();
  }

  return {
    noteOutput(stream, chunk) {
      lastOutputAt = now();
      if (stdoutSessionId || stream !== "stdout") return;
      const scan = sessionScanCarry + chunk;
      const match = SESSION_ID_RE.exec(scan);
      if (match?.[1]) {
        stdoutSessionId = match[1];
        sessionScanCarry = "";
        return;
      }
      sessionScanCarry = scan.slice(-SESSION_SCAN_CARRY_CHARS);
    },
    detected: () => detected,
    sessionId: () => knownSession()?.id ?? null,
    stop,
  };
}
