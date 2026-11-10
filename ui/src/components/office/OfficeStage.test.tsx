// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OfficeStage from "./OfficeStage";

let throwOnCreate = false;

vi.mock("@/lib/office/scene/office-scene", () => ({
  OfficeScene: class {
    constructor() {
      if (throwOnCreate) throw new Error("WebGL unavailable");
    }
    onPick() {}
    onFrame() {
      return () => {};
    }
    setAgents() {}
    setSelected() {}
    focusAgent() {}
    focusArea() {}
    setFollow() {}
    zoomBy() {}
    zoomPercent() {
      return 100;
    }
    labelPositions() {
      return new Map();
    }
    roomLabelPositions() {
      return new Map();
    }
    dispose() {}
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const onAssign = vi.fn();

function render() {
  act(() => {
    root.render(<OfficeStage agents={[]} now={0} selectedId={null} onSelect={vi.fn()} onAssign={onAssign} />);
  });
}

beforeEach(() => {
  throwOnCreate = false;
  onAssign.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("OfficeStage", () => {
  it("keeps label stacking inside the stage so dialogs stay on top", () => {
    render();
    const stageRoot = container.firstElementChild as HTMLElement;
    expect(stageRoot.className).toContain("isolate");
  });

  it("shows the no-WebGL message when the scene cannot start", () => {
    throwOnCreate = true;
    render();
    expect(container.textContent).toContain("Không hiển thị được 3D trên trình duyệt này.");
  });

  it("leaves fullscreen before opening the assign dialog", () => {
    render();
    const exitFullscreen = vi.fn(() => Promise.resolve());
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => container });
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exitFullscreen });
    act(() => (container.querySelector("[data-toolbar='assign']") as HTMLButtonElement).click());
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    expect(onAssign).toHaveBeenCalledWith(null);
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => null });
  });
});
