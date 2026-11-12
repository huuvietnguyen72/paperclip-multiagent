import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => ({
  ...await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>(),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(),
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(),
}));
// Production checks are at least 5 s apart; inject a fast interval for tests.
vi.mock("./usage-limit-watchdog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./usage-limit-watchdog.js")>();
  return {
    ...actual,
    startUsageLimitWatchdog: (options: Parameters<typeof actual.startUsageLimitWatchdog>[0]) =>
      actual.startUsageLimitWatchdog({ ...options, checkIntervalMs: 100 }),
  };
});
import { execute } from "./execute.js";

const SESSION = "ses_fixtureUsageLimit0000001";

function usageLimitLine(session: string, at = new Date()) {
  return `timestamp=${at.toISOString()} level=ERROR run=88363989 message="stream error" providerID=opencode-go modelID=kimi-k3 session.id=${session} small=false agent=build mode=primary error.error="AI_APICallError: Go usage limit exceeded"`;
}

function createdLine(session: string, directory: string, at = new Date()) {
  return `timestamp=${at.toISOString()} level=INFO run=88363989 message=created id=${session} slug=neon-sailor version=1.18.34 projectID=global directory=${directory} path=x title="New session"`;
}

describe("OpenCode usage-limit watchdog in execute", () => {
  let dir: string;
  let command: string;
  let silentCommand: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-usage-limit-"));
    vi.stubEnv("XDG_CONFIG_HOME", path.join(dir, "config"));
    vi.stubEnv("XDG_DATA_HOME", path.join(dir, "data"));
    await fs.mkdir(path.join(dir, "data", "opencode", "log"), { recursive: true });
    // A fake OpenCode that announces its session and then hangs silently, like
    // `opencode run --format json` after a swallowed usage-limit error.
    command = path.join(dir, "fake-opencode");
    await fs.writeFile(
      command,
      `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ type: "step_start", sessionID: ${JSON.stringify(SESSION)}, part: {} }) + "\\n");\nsetInterval(() => {}, 1000);\n`,
      { mode: 0o755 },
    );
    // A fake OpenCode whose first provider call hits the limit: nothing on stdout at all.
    silentCommand = path.join(dir, "fake-opencode-silent");
    await fs.writeFile(silentCommand, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", { mode: 0o755 });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const logPath = () => path.join(dir, "data", "opencode", "log", "opencode.log");
  const writeLog = (text: string) => fs.writeFile(logPath(), `${text}\n`);
  const context = (config: Record<string, unknown>): AdapterExecutionContext => ({
    runId: "run-usage-limit-fixture",
    agent: { id: "agent-fixture", companyId: "company-fixture", name: "Fixture", adapterType: "opencode_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command, model: "opencode-go/kimi-k3", cwd: dir, graceSec: 0.1,
      env: { OPENCODE_ALLOW_ALL_MODELS: "1" }, ...config },
    context: {}, onLog: async () => {},
  });

  it("stops a silent run and reports provider_quota when the log shows the session's usage limit", async () => {
    await writeLog(usageLimitLine(SESSION));
    const logs: string[] = [];
    const ctx = context({ usageLimitWatchdogSec: 0.3, timeoutSec: 20 });
    ctx.onLog = async (_stream, chunk) => { logs.push(chunk); };
    const startedAt = Date.now();
    const result = await execute(ctx);
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(result).toMatchObject({
      timedOut: false,
      errorCode: "provider_quota",
      errorFamily: "provider_quota",
      errorMessage: "OpenCode Go usage limit exceeded (detected from the OpenCode log after 5 minutes without output)",
      sessionId: SESSION,
      resultJson: { errorFamily: "provider_quota",
        usageLimitWatchdog: { sessionId: SESSION, sessionSource: "stdout", thresholdSec: 0.3 } },
    });
    const watchdog = (result.resultJson as { usageLimitWatchdog: { silenceSec: number } }).usageLimitWatchdog;
    expect(watchdog.silenceSec).toBeGreaterThanOrEqual(0.3);
    expect(watchdog.silenceSec).toBeLessThan(10);
    expect(result.retryNotBefore ?? null).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(logs.join("")).toContain("usage limit");
    expect(logs.join("")).toMatch(/configured threshold 0\.3s/);
  }, 15_000);

  it("finds a brand-new session from the log when OpenCode prints nothing", async () => {
    await writeLog("");
    const ctx = context({ command: silentCommand, usageLimitWatchdogSec: 0.3, timeoutSec: 20 });
    // OpenCode logs the session creation for its --dir after it starts.
    ctx.onSpawn = async () => {
      await fs.appendFile(logPath(), `${createdLine("ses_otherDirectory0000000000", `${dir}-other`)}\n`);
      await fs.appendFile(logPath(), `${usageLimitLine("ses_otherDirectory0000000000")}\n`);
      await fs.appendFile(logPath(), `${createdLine(SESSION, dir)}\n${usageLimitLine(SESSION)}\n`);
    };
    const result = await execute(ctx);
    expect(result).toMatchObject({
      timedOut: false,
      errorCode: "provider_quota",
      errorFamily: "provider_quota",
      resultJson: { usageLimitWatchdog: { sessionId: SESSION, sessionSource: "log_created" } },
    });
  }, 15_000);

  it("uses the resumed session id when OpenCode prints nothing", async () => {
    const resumed = "ses_resumedFixture0000000001";
    await writeLog("");
    const ctx = context({ command: silentCommand, usageLimitWatchdogSec: 0.3, timeoutSec: 20 });
    ctx.runtime = { sessionId: resumed, sessionParams: null, sessionDisplayId: null, taskKey: null };
    ctx.onSpawn = async () => { await fs.appendFile(logPath(), `${usageLimitLine(resumed)}\n`); };
    const result = await execute(ctx);
    expect(result).toMatchObject({
      timedOut: false,
      errorCode: "provider_quota",
      resultJson: { usageLimitWatchdog: { sessionId: resumed, sessionSource: "resume" } },
    });
  }, 15_000);

  it("never stops the run without a matching log line", async () => {
    await writeLog(usageLimitLine("ses_someOtherSession00000000"));
    const result = await execute(context({ usageLimitWatchdogSec: 0.2, timeoutSec: 1.5 }));
    expect(result).toMatchObject({ timedOut: true, errorMessage: "OpenCode execution timed out" });
    expect(result.errorCode ?? null).not.toBe("provider_quota");
  });

  it("tells the run log once when the OpenCode log is missing", async () => {
    const logs: string[] = [];
    const ctx = context({ usageLimitWatchdogSec: 0.2, timeoutSec: 1.5 });
    ctx.onLog = async (_stream, chunk) => { logs.push(chunk); };
    const result = await execute(ctx);
    expect(result).toMatchObject({ timedOut: true });
    expect(logs.filter((line) => line.includes("OpenCode log file not found"))).toHaveLength(1);
  });

  it("does nothing when usageLimitWatchdogSec is 0", async () => {
    await writeLog(usageLimitLine(SESSION));
    const result = await execute(context({ usageLimitWatchdogSec: 0, timeoutSec: 1.5 }));
    expect(result).toMatchObject({ timedOut: true, errorMessage: "OpenCode execution timed out" });
    expect(result.errorCode ?? null).not.toBe("provider_quota");
  });
});
