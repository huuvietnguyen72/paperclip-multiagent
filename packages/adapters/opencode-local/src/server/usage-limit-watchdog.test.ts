import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  USAGE_LIMIT_WATCHDOG_DEFAULT_SEC,
  findCreatedSessions,
  findUsageLimitError,
  readOpenCodeLogTail,
  resolveOpenCodeLogPath,
  resolveOpenCodeRunDirectory,
  resolveUsageLimitCheckIntervalMs,
  resolveUsageLimitWatchdogSec,
  startUsageLimitWatchdog,
} from "./usage-limit-watchdog.js";

const SESSION = "ses_e578f569effeDkCt4ubS3dqYuo";
const SAMPLE_LINE =
  'timestamp=2026-11-04T21:24:58.706Z level=ERROR run=88363989 message="stream error" providerID=opencode-go modelID=kimi-k3 session.id=ses_e578f569effeDkCt4ubS3dqYuo small=false agent=build mode=primary error.error="AI_APICallError: Go usage limit exceeded"';
const BEFORE_SAMPLE = new Date("2026-11-04T21:20:00.000Z");

function lineFor(input: { at: string; level?: string; session?: string; error?: string }) {
  return `timestamp=${input.at} level=${input.level ?? "ERROR"} run=deadbeef message="stream error" providerID=opencode-go modelID=kimi-k3 session.id=${input.session ?? SESSION} small=false agent=build mode=primary error.error="${input.error ?? "AI_APICallError: Go usage limit exceeded"}"`;
}

describe("findUsageLimitError", () => {
  it("matches the exact OpenCode sample line", () => {
    const tail = `timestamp=2026-11-04T21:24:58.700Z level=INFO run=88363989 message=init\n${SAMPLE_LINE}\n`;
    expect(findUsageLimitError(tail, SESSION, BEFORE_SAMPLE)).toEqual({
      at: new Date("2026-11-04T21:24:58.706Z"),
      line: SAMPLE_LINE,
    });
  });

  it("ignores another session id and a prefix of the session id", () => {
    const tail = [
      lineFor({ at: "2026-11-04T21:25:00.000Z", session: "ses_other0000000000000000000" }),
      lineFor({ at: "2026-11-04T21:25:01.000Z", session: "ses_e578f569effeDkCt4ubS3dqYuoX" }),
    ].join("\n");
    expect(findUsageLimitError(tail, SESSION, BEFORE_SAMPLE)).toBeNull();
    // A prefix of the logged id must not match either.
    expect(findUsageLimitError(SAMPLE_LINE, "ses_e578f569effeDkCt4ubS3dqYu", BEFORE_SAMPLE)).toBeNull();
  });

  it("ignores lines before since", () => {
    expect(findUsageLimitError(SAMPLE_LINE, SESSION, new Date("2026-11-04T21:24:58.707Z"))).toBeNull();
    expect(findUsageLimitError(SAMPLE_LINE, SESSION, new Date("2026-11-04T21:24:58.706Z"))).not.toBeNull();
  });

  it("ignores non-ERROR lines and lines without the usage-limit message", () => {
    const tail = [
      lineFor({ at: "2026-11-04T21:25:00.000Z", level: "WARN" }),
      lineFor({ at: "2026-11-04T21:25:01.000Z", level: "INFO" }),
      lineFor({ at: "2026-11-04T21:25:02.000Z", error: "AI_APICallError: rate limited" }),
      // The marker hidden in another field still needs a real ERROR level.
      `timestamp=2026-11-04T21:25:03.000Z level=INFO message="level=ERROR" session.id=${SESSION} note="Go usage limit exceeded"`,
    ].join("\n");
    expect(findUsageLimitError(tail, SESSION, BEFORE_SAMPLE)).toBeNull();
  });

  it("returns the latest of several matching lines", () => {
    const tail = [
      lineFor({ at: "2026-11-04T21:25:03.000Z" }),
      lineFor({ at: "2026-11-04T21:25:09.000Z" }),
      lineFor({ at: "2026-11-04T21:25:05.000Z" }),
    ].join("\r\n");
    expect(findUsageLimitError(tail, SESSION, BEFORE_SAMPLE)?.at).toEqual(new Date("2026-11-04T21:25:09.000Z"));
  });

  it("works on a log buffer that contains non-UTF-8 bytes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-log-"));
    try {
      const file = path.join(dir, "opencode.log");
      await fs.writeFile(file, Buffer.concat([
        Buffer.from("timestamp=2026-11-04T21:24:00.000Z level=INFO message=\""),
        Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0x80]),
        Buffer.from("\"\n"),
        Buffer.from(`${SAMPLE_LINE}\n`),
        Buffer.from([0xe2, 0x82]),
      ]));
      const tail = await readOpenCodeLogTail(file);
      expect(tail).not.toBeNull();
      expect(findUsageLimitError(tail!, SESSION, BEFORE_SAMPLE)?.line).toBe(SAMPLE_LINE);
      // Buffers are accepted directly as well.
      expect(findUsageLimitError(await fs.readFile(file), SESSION, BEFORE_SAMPLE)?.line).toBe(SAMPLE_LINE);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("reads only the tail of a large log", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-log-"));
    try {
      const file = path.join(dir, "opencode.log");
      await fs.writeFile(file, `${"x".repeat(4096)}\n${SAMPLE_LINE}\n`);
      const tail = await readOpenCodeLogTail(file, 1024);
      expect(tail!.length).toBeLessThanOrEqual(1024);
      expect(findUsageLimitError(tail!, SESSION, BEFORE_SAMPLE)?.line).toBe(SAMPLE_LINE);
      expect(await readOpenCodeLogTail(path.join(dir, "missing.log"))).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("findCreatedSessions", () => {
  const WORKDIR = "/home/u/.paperclip/instances/default/isolated-workspaces/agent-1";
  function createdLine(input: { at: string; id: string; directory: string }) {
    return `timestamp=${input.at} level=INFO run=88363989 message=created id=${input.id} slug=neon-sailor version=1.18.34 projectID=global directory=${input.directory} path=agent-1 workspaceID=undefined parentID=undefined title="New session - ${input.at}" agent=undefined`;
  }
  const FLOOR = new Date("2026-11-04T21:21:50.000Z");

  it("returns sessions created in exactly the run directory", () => {
    const tail = [
      // The real sample line, trimmed of its tail.
      `timestamp=2026-11-04T21:21:58.113Z level=INFO run=88363989 message=created id=ses_e578f569effeDkCt4ubS3dqYuo slug=neon-sailor version=1.18.34 projectID=global directory=${WORKDIR}`,
      createdLine({ at: "2026-11-04T21:22:00.000Z", id: "ses_sibling", directory: `${WORKDIR}-2` }),
      createdLine({ at: "2026-11-04T21:22:00.000Z", id: "ses_parent", directory: path.posix.dirname(WORKDIR) }),
      createdLine({ at: "2026-11-04T21:22:00.000Z", id: "ses_child", directory: `${WORKDIR}/sub` }),
      createdLine({ at: "2026-11-04T21:22:01.000Z", id: "ses_second", directory: WORKDIR }),
      `timestamp=2026-11-04T21:22:02.000Z level=INFO run=1 message=loop session.id=ses_loop directory=${WORKDIR}`,
    ].join("\n");
    expect(findCreatedSessions(tail, WORKDIR, FLOOR)).toEqual(["ses_e578f569effeDkCt4ubS3dqYuo", "ses_second"]);
  });

  it("ignores sessions created before the time floor", () => {
    const tail = [
      createdLine({ at: "2026-11-04T21:21:49.999Z", id: "ses_old", directory: WORKDIR }),
      createdLine({ at: "2026-11-04T21:21:50.000Z", id: "ses_new", directory: WORKDIR }),
    ].join("\n");
    expect(findCreatedSessions(tail, WORKDIR, FLOOR)).toEqual(["ses_new"]);
  });

  it("matches a quoted directory that contains spaces", () => {
    const spaced = "/home/u/My Projects/repo";
    const tail = [
      createdLine({ at: "2026-11-04T21:22:00.000Z", id: "ses_spaced", directory: JSON.stringify(spaced) }),
      createdLine({ at: "2026-11-04T21:22:00.000Z", id: "ses_unquoted_prefix", directory: "/home/u/My" }),
    ].join("\n");
    expect(findCreatedSessions(tail, spaced, FLOOR)).toEqual(["ses_spaced"]);
    expect(findCreatedSessions(tail, "/home/u/My", FLOOR)).toEqual(["ses_unquoted_prefix"]);
  });
});

describe("resolveOpenCodeRunDirectory", () => {
  it("returns the --dir OpenCode runs in, resolved against the process cwd", () => {
    expect(resolveOpenCodeRunDirectory(["run", "--format", "json", "--dir", "/work/a"], "/cwd")).toBe("/work/a");
    expect(resolveOpenCodeRunDirectory(["run", "--dir=rel/b"], "/cwd")).toBe(path.resolve("/cwd", "rel/b"));
    expect(resolveOpenCodeRunDirectory(["run", "--", "--dir", "/ignored"], "/cwd")).toBeNull();
    expect(resolveOpenCodeRunDirectory(["run"], "/cwd")).toBeNull();
  });
});

describe("OpenCode log location and watchdog config", () => {
  it("clamps the production check interval between 5 s and 30 s", () => {
    expect(resolveUsageLimitCheckIntervalMs(0.3)).toBe(5_000);
    expect(resolveUsageLimitCheckIntervalMs(10)).toBe(10_000);
    expect(resolveUsageLimitCheckIntervalMs(300)).toBe(30_000);
  });

  it("resolves the log under XDG_DATA_HOME, else HOME/.local/share", () => {
    expect(resolveOpenCodeLogPath({ XDG_DATA_HOME: "/data", HOME: "/home/a" }))
      .toBe(path.join("/data", "opencode", "log", "opencode.log"));
    expect(resolveOpenCodeLogPath({ HOME: "/home/a" }))
      .toBe(path.join("/home/a", ".local", "share", "opencode", "log", "opencode.log"));
  });

  it("defaults to 300 s, honours 0 and disables remote runs", () => {
    expect(USAGE_LIMIT_WATCHDOG_DEFAULT_SEC).toBe(300);
    expect(resolveUsageLimitWatchdogSec({}, false)).toBe(300);
    expect(resolveUsageLimitWatchdogSec({ usageLimitWatchdogSec: 120 }, false)).toBe(120);
    expect(resolveUsageLimitWatchdogSec({ usageLimitWatchdogSec: 0 }, false)).toBe(0);
    expect(resolveUsageLimitWatchdogSec({ usageLimitWatchdogSec: -5 }, false)).toBe(0);
    expect(resolveUsageLimitWatchdogSec({}, true)).toBe(0);
    expect(resolveUsageLimitWatchdogSec({ usageLimitWatchdogSec: 120 }, true)).toBe(0);
  });
});

describe("startUsageLimitWatchdog", () => {
  const START = new Date("2026-11-13T10:00:00.000Z").getTime();
  const sessionEvent = `${JSON.stringify({ type: "step_start", sessionID: SESSION, part: {} })}\n`;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function harness(input: {
    thresholdSec?: number;
    log?: () => string | null;
    resumeSessionId?: string | null;
    directory?: string | null;
    checkIntervalMs?: number;
    kill?: () => void;
  } = {}) {
    const readLogTail = vi.fn(async () => input.log ? input.log() : null);
    const kill = vi.fn(input.kill ?? (() => {}));
    const onDetected = vi.fn();
    const onWarn = vi.fn();
    const watchdog = startUsageLimitWatchdog({
      thresholdSec: input.thresholdSec ?? 300,
      now: () => Date.now(),
      readLogTail,
      kill,
      onDetected,
      onWarn,
      ...(input.resumeSessionId !== undefined ? { resumeSessionId: input.resumeSessionId } : {}),
      ...(input.directory !== undefined ? { directory: input.directory } : {}),
      ...(input.checkIntervalMs !== undefined ? { checkIntervalMs: input.checkIntervalMs } : {}),
    });
    return { watchdog, readLogTail, kill, onDetected, onWarn };
  }

  const WORKDIR = "/work/agent-1";
  const createdAt = (offsetMs: number, id = SESSION, directory = WORKDIR) =>
    `timestamp=${new Date(START + offsetMs).toISOString()} level=INFO run=1 message=created id=${id} slug=x version=1.18.34 projectID=global directory=${directory} title="New session"`;

  it("discovers a brand-new session from the log when stdout stays empty", async () => {
    const h = harness({
      directory: WORKDIR,
      log: () => [
        createdAt(-60_000, "ses_beforeThisRun000000000000"),
        lineFor({ at: new Date(START + 9_000).toISOString(), session: "ses_beforeThisRun000000000000" }),
        createdAt(8_000, "ses_otherDirectory0000000000", "/work/agent-2"),
        lineFor({ at: new Date(START + 9_000).toISOString(), session: "ses_otherDirectory0000000000" }),
        createdAt(8_000),
        lineFor({ at: new Date(START + 9_000).toISOString() }),
      ].join("\n"),
    });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.kill).toHaveBeenCalledTimes(1);
    expect(h.watchdog.detected()).toMatchObject({ sessionId: SESSION, sessionSource: "log_created" });
  });

  it("does not kill from the log when no session was created in the run directory", async () => {
    const h = harness({
      directory: WORKDIR,
      log: () => [createdAt(8_000, SESSION, "/work/agent-2"), lineFor({ at: new Date(START + 9_000).toISOString() })].join("\n"),
    });
    await vi.advanceTimersByTimeAsync(400_000);
    expect(h.readLogTail).toHaveBeenCalled();
    expect(h.kill).not.toHaveBeenCalled();
    h.watchdog.stop();
  });

  it("uses the seeded resume session when stdout stays empty", async () => {
    const h = harness({ resumeSessionId: SESSION, log: () => lineFor({ at: new Date(START + 9_000).toISOString() }) });
    expect(h.watchdog.sessionId()).toBe(SESSION);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.kill).toHaveBeenCalledTimes(1);
    expect(h.watchdog.detected()).toMatchObject({ sessionId: SESSION, sessionSource: "resume" });
  });

  it("prefers the stdout session over the seeded resume session", async () => {
    const h = harness({ resumeSessionId: "ses_resumedButReplaced000000", log: () =>
      lineFor({ at: new Date(START + 9_000).toISOString(), session: "ses_resumedButReplaced000000" }) });
    h.watchdog.noteOutput("stdout", sessionEvent);
    expect(h.watchdog.sessionId()).toBe(SESSION);
    await vi.advanceTimersByTimeAsync(400_000);
    expect(h.kill).not.toHaveBeenCalled();
    h.watchdog.stop();
  });

  it("never matches a limit line from before this attempt started", async () => {
    // lastOutputAt - 60 s would reach back to START - 60 s; the spawn floor does not.
    const h = harness({ resumeSessionId: SESSION, log: () => lineFor({ at: new Date(START - 30_000).toISOString() }) });
    await vi.advanceTimersByTimeAsync(400_000);
    expect(h.readLogTail).toHaveBeenCalled();
    expect(h.kill).not.toHaveBeenCalled();
    h.watchdog.stop();
  });

  it("records the configured threshold and the measured silence", async () => {
    const h = harness({ log: () => lineFor({ at: new Date(START + 25_000).toISOString() }) });
    await vi.advanceTimersByTimeAsync(20_000);
    h.watchdog.noteOutput("stdout", sessionEvent);
    // Ticks at 300 s (280 s silent) do nothing; the 330 s tick finds 310 s of silence.
    await vi.advanceTimersByTimeAsync(310_000);
    expect(h.kill).toHaveBeenCalledTimes(1);
    expect(h.watchdog.detected()).toMatchObject({ thresholdSec: 300, silenceSec: 310, sessionSource: "stdout" });
  });

  it("checks at least 5 s apart in production but accepts an injected interval", async () => {
    const slow = harness({ thresholdSec: 1, resumeSessionId: SESSION, log: () => null });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(slow.readLogTail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(slow.readLogTail).toHaveBeenCalledTimes(1);
    slow.watchdog.stop();

    const fast = harness({ thresholdSec: 1, checkIntervalMs: 100, resumeSessionId: SESSION, log: () => null });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fast.readLogTail).toHaveBeenCalledTimes(1);
    fast.watchdog.stop();
  });

  it("reports a failed kill with its own warning and still records the detection", async () => {
    const h = harness({
      resumeSessionId: SESSION,
      log: () => lineFor({ at: new Date(START + 9_000).toISOString() }),
      kill: () => { throw new Error("EPERM"); },
    });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.kill).toHaveBeenCalledTimes(1);
    expect(h.watchdog.detected()).toMatchObject({ sessionId: SESSION });
    expect(h.onDetected).toHaveBeenCalledTimes(1);
    expect(h.onWarn).toHaveBeenCalledTimes(1);
    expect(h.onWarn.mock.calls[0]![0]).toMatch(/could not stop/i);
    expect(h.onWarn.mock.calls[0]![0]).not.toMatch(/could not be read/i);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("(a) kills after 5 silent minutes when the log has a matching usage-limit error", async () => {
    const h = harness({ log: () => lineFor({ at: new Date(START + 290_000).toISOString() }) });
    // The session id arrives split across chunks.
    h.watchdog.noteOutput("stdout", sessionEvent.slice(0, 30));
    h.watchdog.noteOutput("stdout", sessionEvent.slice(30));
    await vi.advanceTimersByTimeAsync(270_000);
    expect(h.readLogTail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.readLogTail).toHaveBeenCalledTimes(1);
    expect(h.kill).toHaveBeenCalledTimes(1);
    expect(h.onDetected).toHaveBeenCalledTimes(1);
    expect(h.watchdog.detected()).toMatchObject({ at: new Date(START + 290_000) });
    expect(h.watchdog.sessionId()).toBe(SESSION);
    // Detection is final: no further checks or kills.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.readLogTail).toHaveBeenCalledTimes(1);
    expect(h.kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("(b) never kills when 5 silent minutes pass without a matching log line", async () => {
    const h = harness({ log: () => [
      lineFor({ at: new Date(START + 10_000).toISOString(), session: "ses_someoneElse000000000000" }),
      // Older than lastOutputAt - 60 s slack.
      lineFor({ at: new Date(START - 61_000).toISOString() }),
    ].join("\n") });
    h.watchdog.noteOutput("stdout", sessionEvent);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.readLogTail).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.readLogTail).toHaveBeenCalledTimes(3);
    expect(h.kill).not.toHaveBeenCalled();
    expect(h.onDetected).not.toHaveBeenCalled();
    expect(h.watchdog.detected()).toBeNull();
    h.watchdog.stop();
  });

  it("(c) does not check the log while output keeps arriving", async () => {
    const h = harness({ log: () => lineFor({ at: new Date(START).toISOString() }) });
    h.watchdog.noteOutput("stdout", sessionEvent);
    for (let i = 0; i < 40; i += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      h.watchdog.noteOutput(i % 2 === 0 ? "stdout" : "stderr", "still working\n");
    }
    expect(h.readLogTail).not.toHaveBeenCalled();
    expect(h.kill).not.toHaveBeenCalled();
    h.watchdog.stop();
  });

  it("does not check without a known session id", async () => {
    const h = harness({ log: () => lineFor({ at: new Date(START).toISOString() }) });
    h.watchdog.noteOutput("stdout", "plain text without a session\n");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.readLogTail).not.toHaveBeenCalled();
    h.watchdog.stop();
  });

  it("(d) clears its timer when the run ends", async () => {
    const h = harness({ log: () => lineFor({ at: new Date(START).toISOString() }) });
    h.watchdog.noteOutput("stdout", sessionEvent);
    expect(vi.getTimerCount()).toBe(1);
    h.watchdog.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.readLogTail).not.toHaveBeenCalled();
    expect(h.kill).not.toHaveBeenCalled();
  });

  it("(e) usageLimitWatchdogSec 0 disables it", async () => {
    const h = harness({ thresholdSec: 0, log: () => lineFor({ at: new Date(START).toISOString() }) });
    expect(vi.getTimerCount()).toBe(0);
    h.watchdog.noteOutput("stdout", sessionEvent);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.readLogTail).not.toHaveBeenCalled();
    expect(h.kill).not.toHaveBeenCalled();
    h.watchdog.stop();
  });

  it("warns once and keeps running when the log is missing or unreadable", async () => {
    let calls = 0;
    const readLogTail = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return null;
      throw new Error("EACCES");
    });
    const kill = vi.fn();
    const onWarn = vi.fn();
    const watchdog = startUsageLimitWatchdog({ thresholdSec: 300, now: () => Date.now(), readLogTail, kill, onWarn });
    watchdog.noteOutput("stdout", sessionEvent);
    await vi.advanceTimersByTimeAsync(400_000);
    expect(readLogTail.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(kill).not.toHaveBeenCalled();
    watchdog.stop();
  });
});
