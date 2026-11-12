// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentHarnessLine } from "./AgentHarnessLine";

describe("AgentHarnessLine", () => {
  it("agent header shows fallback harness with Dự phòng tag", () => {
    const markup = renderToStaticMarkup(
      <AgentHarnessLine adapterType="codex_local" displayAdapterType="codex_local" model="gpt-5.5" isFallback />,
    );
    expect(markup).toContain("Codex");
    expect(markup).toContain("gpt-5.5");
    expect(markup).toContain("Dự phòng");
  });

  it("shows no tag when the agent runs on its configured connection", () => {
    const markup = renderToStaticMarkup(
      <AgentHarnessLine adapterType="claude_local" displayAdapterType="claude_local" isFallback={false} />,
    );
    expect(markup).toContain("Claude");
    expect(markup).not.toContain("Dự phòng");
  });
});
