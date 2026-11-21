import { RUN_CHANGES_LIMITS, type RunChangeCommand } from "@paperclipai/shared";

/**
 * Extracts the commands an agent ran from its run log (NDJSON lines of
 * `{ts, stream, chunk}`, where `chunk` carries the adapter's JSON events).
 *
 * - Claude via ACP: `acpx.tool_call` events grouped by `toolCallId`. The first
 *   event names the tool ("Terminal"); a later update carries the command in
 *   `name`.
 * - OpenCode: `tool_use` events with `part.tool` and `part.state.input`.
 */

const READ_ONLY_TOOLS = new Set([
  "read", "glob", "grep", "list", "toolsearch", "skill", "todowrite", "todoread", "webfetch", "websearch", "monitor",
]);

interface PendingCall { ts: string | null; tool: string; text: string | null }

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function openCodeText(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  if (typeof record.command === "string") return record.command;
  if (typeof record.filePath === "string") return record.filePath;
  return JSON.stringify(record);
}

export function extractRunCommands(ndjson: string, redact: (text: string) => string): RunChangeCommand[] {
  const order: string[] = [];
  const calls = new Map<string, PendingCall>();

  const remember = (id: string, call: PendingCall) => {
    if (!calls.has(id)) order.push(id);
    calls.set(id, call);
  };

  for (const rawLine of ndjson.split("\n")) {
    const line = parseJson(rawLine);
    if (!line || typeof line.chunk !== "string") continue;
    const ts = typeof line.ts === "string" ? line.ts : null;
    for (const rawEvent of line.chunk.split("\n")) {
      const event = parseJson(rawEvent);
      if (!event) continue;
      if (event.type === "acpx.tool_call" && typeof event.toolCallId === "string" && typeof event.name === "string") {
        const existing = calls.get(event.toolCallId);
        if (!existing) {
          remember(event.toolCallId, { ts, tool: event.name, text: null });
        } else if (existing.text === null && event.name !== existing.tool) {
          existing.text = event.name;
        }
      } else if (event.type === "tool_use" && event.part && typeof event.part === "object") {
        const part = event.part as Record<string, unknown>;
        if (typeof part.tool !== "string" || typeof part.callID !== "string") continue;
        const state = part.state && typeof part.state === "object" ? part.state as Record<string, unknown> : {};
        const eventTs = typeof event.timestamp === "number" ? new Date(event.timestamp).toISOString() : ts;
        remember(part.callID, { ts: eventTs, tool: part.tool, text: openCodeText(state.input) });
      }
    }
  }

  const commands: RunChangeCommand[] = [];
  for (const id of order) {
    const call = calls.get(id)!;
    if (READ_ONLY_TOOLS.has(call.tool.toLowerCase())) continue;
    if (!call.text) continue;
    commands.push({ ts: call.ts, tool: call.tool, text: redact(call.text).slice(0, RUN_CHANGES_LIMITS.commandChars) });
    if (commands.length >= RUN_CHANGES_LIMITS.commands) break;
  }
  return commands;
}
