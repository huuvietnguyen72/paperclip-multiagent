// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelBadge } from "@/components/office/ModelBadge";
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
    expect(markup).not.toContain("agent-harness-unknown");
  });

  it("shows a neutral hint instead of silently claiming the configured model when the in-use connection is unknown", () => {
    const markup = renderToStaticMarkup(
      <AgentHarnessLine adapterType="claude_local" displayAdapterType="claude_local" isFallback={false} activeUnknown />,
    );
    expect(markup).toContain("data-testid=\"agent-harness-unknown\"");
    expect(markup).toContain("Không rõ kết nối đang dùng");
    expect(markup).not.toContain("Dự phòng");
  });
});

describe("ModelBadge", () => {
  const badge = { label: "Sonnet 5.5", markType: "claude_local" };
  it("office badge shows a neutral hint when the in-use connection is unknown", () => {
    const markup = renderToStaticMarkup(<ModelBadge badge={badge} unknown />);
    expect(markup).toContain("data-testid=\"model-badge-unknown\"");
    expect(markup).toContain("Không rõ kết nối đang dùng");
    expect(renderToStaticMarkup(<ModelBadge badge={badge} />)).not.toContain("model-badge-unknown");
  });
});
