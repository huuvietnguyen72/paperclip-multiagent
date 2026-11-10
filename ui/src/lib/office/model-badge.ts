import { getAdapterDisplay } from "@/adapters/adapter-display-registry";

export interface ModelBadge {
  label: string;
  /** A key understood by `AdapterMark` (an adapter type whose brand mark matches the model family). */
  markType: string;
}

const UPPERCASE_PREFIXES = new Set(["gpt", "glm"]);

function familyMark(modelId: string): string | null {
  if (modelId.startsWith("claude-")) return "claude_local";
  if (modelId.startsWith("gpt-") || /^o\d/.test(modelId) || modelId.startsWith("codex")) return "codex_local";
  if (modelId.startsWith("gemini")) return "gemini_local";
  if (modelId.startsWith("kimi")) return "kimi_local";
  if (modelId.startsWith("grok")) return "grok_local";
  return null;
}

function capitalise(token: string): string {
  return token.length === 0 ? token : token[0].toUpperCase() + token.slice(1);
}

function prettifyModelId(modelId: string): string {
  const claude = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(modelId);
  if (claude) return `${capitalise(claude[1])} ${claude[2]}.${claude[3]}`;

  const tokens = modelId.split("-").filter(Boolean);
  const words: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (UPPERCASE_PREFIXES.has(token)) {
      const next = tokens[i + 1];
      if (next && /^\d/.test(next)) {
        words.push(`${token.toUpperCase()}-${next}`);
        i++;
      } else {
        words.push(token.toUpperCase());
      }
      continue;
    }
    words.push(capitalise(token));
  }
  return words.join(" ");
}

export function modelBadgeFor(
  adapterType: string,
  model: string | null | undefined,
  adapterLabels?: ReadonlyMap<string, string>,
): ModelBadge {
  const raw = (model ?? "").trim();
  if (!raw) return { label: getAdapterDisplay(adapterType).label, markType: adapterType };

  const bareId = raw.slice(raw.lastIndexOf("/") + 1);
  const markType = familyMark(bareId) ?? adapterType;
  // An adapter label that merely repeats the id adds nothing; prettify it instead.
  const adapterLabel = adapterLabels?.get(raw);
  const useful = adapterLabel && adapterLabel !== raw && adapterLabel !== bareId ? adapterLabel : null;
  const label = useful ?? (prettifyModelId(bareId) || raw);
  return { label, markType };
}
