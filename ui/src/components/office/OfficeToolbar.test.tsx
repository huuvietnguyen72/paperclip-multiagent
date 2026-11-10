// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfficeToolbar, type OfficeToolbarProps } from "./OfficeToolbar";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let props: OfficeToolbarProps;

function render(overrides: Partial<OfficeToolbarProps> = {}) {
  props = {
    onHome: vi.fn(),
    onArea: vi.fn(),
    zoomPercent: 100,
    onZoom: vi.fn(),
    onFullscreen: vi.fn(),
    canFollow: false,
    following: false,
    onFollowToggle: vi.fn(),
    onAssign: vi.fn(),
    ...overrides,
  };
  act(() => root.render(<OfficeToolbar {...props} />));
}

const button = (name: string) => container.querySelector(`[data-toolbar='${name}']`) as HTMLButtonElement | null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("OfficeToolbar", () => {
  it("disables follow when no agent is selected", () => {
    render({ canFollow: false });
    expect(button("follow")?.disabled).toBe(true);
    render({ canFollow: true });
    expect(button("follow")?.disabled).toBe(false);
  });

  it("assigns work from the toolbar", () => {
    render();
    act(() => button("assign")?.click());
    expect(props.onAssign).toHaveBeenCalledTimes(1);
  });

  it("zooms in and out and shows the zoom percentage", () => {
    render({ zoomPercent: 125 });
    expect(container.textContent).toContain("125%");
    act(() => button("zoom-in")?.click());
    act(() => button("zoom-out")?.click());
    expect(props.onZoom).toHaveBeenNthCalledWith(1, 1.25);
    expect(props.onZoom).toHaveBeenNthCalledWith(2, 0.8);
  });

  it("offers every room and returns home", () => {
    render();
    expect(container.querySelector("[data-toolbar-room]")).toBeNull();
    act(() => button("rooms")?.click());
    const rooms = Array.from(container.querySelectorAll("[data-toolbar-room]")).map((node) => node.getAttribute("data-toolbar-room"));
    expect(rooms).toEqual(["executive", "analysis", "engineering", "quality", "meeting", "server", "pantry"]);
    act(() => (container.querySelector("[data-toolbar-room='server']") as HTMLButtonElement).click());
    expect(props.onArea).toHaveBeenCalledWith("server");
    act(() => button("home")?.click());
    expect(props.onHome).toHaveBeenCalled();
  });
});
