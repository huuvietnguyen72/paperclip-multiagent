import { describe, expect, it } from "vitest";
import { RUN_CHANGES_LIMITS } from "@paperclipai/shared";
import { extractRunCommands } from "./commands.js";

const noRedact = (text: string) => text;

/** One run-log NDJSON line: the adapter's stdout chunk carries one or more JSON events. */
function logLine(ts: string, ...events: object[]): string {
  return JSON.stringify({ ts, stream: "stdout", chunk: events.map((event) => JSON.stringify(event)).join("\n") + "\n" });
}

function acpCall(id: string, command: string, tool = "Terminal"): object[] {
  return [
    { type: "acpx.tool_call", name: tool, toolCallId: id, status: "pending", text: `${tool} (pending)`, tag: "tool_call" },
    { type: "acpx.tool_call", name: command, toolCallId: id, text: `${command}: ${command}`, tag: "tool_call_update" },
    { type: "acpx.tool_call", name: tool, toolCallId: id, status: "completed", text: "tool call (completed)", tag: "tool_call_update" },
  ];
}

function openCodeTool(callId: string, tool: string, input: Record<string, unknown>, timestamp = 1795017664278): object {
  return { type: "tool_use", timestamp, sessionID: "ses_1", part: { type: "tool", tool, callID: callId, state: { status: "completed", input, output: "..." } } };
}

describe("extractRunCommands", () => {
  it("extracts ACP terminal commands in order", () => {
    const log = [
      logLine("2026-11-19T07:11:37.000Z", ...acpCall("t1", "git status --short")),
      logLine("2026-11-19T07:11:40.000Z", ...acpCall("t2", "cat > src/a.ts <<'EOF'\nexport const a = 1;\nEOF")),
    ].join("\n");
    expect(extractRunCommands(log, noRedact)).toEqual([
      { ts: "2026-11-19T07:11:37.000Z", tool: "Terminal", text: "git status --short" },
      { ts: "2026-11-19T07:11:40.000Z", tool: "Terminal", text: "cat > src/a.ts <<'EOF'\nexport const a = 1;\nEOF" },
    ]);
  });

  it("extracts OpenCode bash and edit tools with file paths", () => {
    const log = logLine(
      "2026-11-19T07:20:00.000Z",
      openCodeTool("c1", "bash", { command: "npm test" }, Date.parse("2026-11-19T07:20:01.000Z")),
      openCodeTool("c2", "edit", { filePath: "/w/src/app.ts", oldString: "a", newString: "b" }, Date.parse("2026-11-19T07:20:02.000Z")),
    );
    expect(extractRunCommands(log, noRedact)).toEqual([
      { ts: "2026-11-19T07:20:01.000Z", tool: "bash", text: "npm test" },
      { ts: "2026-11-19T07:20:02.000Z", tool: "edit", text: "/w/src/app.ts" },
    ]);
  });

  it("drops read-only tools", () => {
    const log = [
      logLine("2026-11-19T07:00:00.000Z", ...acpCall("t1", "select:Read", "ToolSearch")),
      logLine("2026-11-19T07:00:01.000Z", openCodeTool("c1", "read", { filePath: "/w/a.ts" }), openCodeTool("c2", "skill", { name: "paperclip" })),
      logLine("2026-11-19T07:00:02.000Z", ...acpCall("t2", "ls")),
    ].join("\n");
    expect(extractRunCommands(log, noRedact).map((command) => command.text)).toEqual(["ls"]);
  });

  it("truncates long commands to 500 chars", () => {
    const long = "echo " + "x".repeat(800);
    const [command] = extractRunCommands(logLine("2026-11-19T07:00:00.000Z", ...acpCall("t1", long)), noRedact);
    expect(command!.text.length).toBe(RUN_CHANGES_LIMITS.commandChars);
  });

  it("caps at 200 commands", () => {
    const log = Array.from({ length: 230 }, (_, index) => logLine("2026-11-19T07:00:00.000Z", ...acpCall(`t${index}`, `echo ${index}`))).join("\n");
    expect(extractRunCommands(log, noRedact)).toHaveLength(RUN_CHANGES_LIMITS.commands);
  });

  it("redacts secrets", () => {
    const log = logLine("2026-11-19T07:00:00.000Z", ...acpCall("t1", "export GH_TOKEN=ghp_abc123"));
    const [command] = extractRunCommands(log, (text) => text.replace(/ghp_\w+/g, "***REDACTED***"));
    expect(command!.text).toBe("export GH_TOKEN=***REDACTED***");
  });

  it("tolerates malformed lines and non-tool events", () => {
    const log = [
      "not json",
      JSON.stringify({ ts: "2026-11-19T07:00:00.000Z", stream: "stderr", chunk: "[paperclip] starting\n" }),
      JSON.stringify({ ts: "2026-11-19T07:00:00.000Z", stream: "stdout", chunk: "{broken\n{\"type\":\"acpx.text_delta\",\"text\":\"hi\"}\n" }),
      logLine("2026-11-19T07:00:01.000Z", ...acpCall("t1", "pwd")),
    ].join("\n");
    expect(extractRunCommands(log, noRedact).map((command) => command.text)).toEqual(["pwd"]);
  });
});
