// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHART_HEIGHT, WorkTimeChart } from "./WorkTimeChart";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let observedWidth = 0;
class FakeResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() {
    this.callback([{ contentRect: { width: observedWidth } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  disconnect() {}
  unobserve() {}
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const buckets = Array.from({ length: 24 }, (_, h) => new Date(2026, 10, 10, h));

describe("WorkTimeChart", () => {
  it("draws at its container's pixel width so text and lines keep their size", () => {
    observedWidth = 512;
    act(() => root.render(<WorkTimeChart buckets={buckets} unit="hour" series={[]} legend={[]} onToggle={() => {}} />));
    const svg = container.querySelector("svg[role='img']");
    expect(svg?.getAttribute("viewBox")).toBe(`0 0 512 ${CHART_HEIGHT}`);
    expect(svg?.getAttribute("height")).toBe(String(CHART_HEIGHT));
    expect(CHART_HEIGHT).toBe(260);
  });
});
