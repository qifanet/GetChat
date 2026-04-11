/**
 * @file CompareWorkspace.test.tsx
 * @description Tests for the compare workspace component.
 *
 * Product rules tested:
 *   - COMPARE mode renders compare view (not chat view)
 *   - Compare mode shows "只读" indicator
 *   - Compare mode does NOT render any composer or send elements
 *   - Graceful degradation when compareState has missing branches
 *   - "返回聊天" button exits compare mode
 *
 * Mock strategy:
 *   Use real Zustand store (reset between tests) instead of unstable function mocks.
 *   This avoids the "getSnapshot should be cached" infinite loop issue.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { create } from "zustand";

// ============================================================================
// Mock compare data — returns stable reference
// ============================================================================

const mockCompareResult = {
  leftBranch: { id: "b1", name: "路径 A", isMainline: true },
  rightBranch: { id: "b2", name: "路径 B", isMainline: false },
  forkPointMessageId: "m3",
  sharedContextMessages: [
    { id: "m1", role: "USER", content: { text: "问题" } },
    { id: "m2", role: "ASSISTANT", content: { text: "回答" } },
  ],
  leftDivergedMessages: [
    { id: "m4a", role: "USER", content: { text: "A 路线问题" } },
    { id: "m5a", role: "ASSISTANT", content: { text: "A 路线回答" } },
  ],
  rightDivergedMessages: [
    { id: "m4b", role: "USER", content: { text: "B 路线问题" } },
    { id: "m5b", role: "ASSISTANT", content: { text: "B 路线回答" } },
  ],
};

const emptyCompareResult = {
  leftBranch: null,
  rightBranch: null,
  forkPointMessageId: null,
  sharedContextMessages: [],
  leftDivergedMessages: [],
  rightDivergedMessages: [],
};

vi.mock("../../../selectors/compareSelectors", () => ({
  selectCompareData: vi.fn(() => mockCompareResult),
}));

// Mock sub-components to isolate tests
vi.mock("../CompareToolbar", () => ({
  CompareToolbar: ({ leftBranch, rightBranch }: any) => (
    <div data-testid="compare-toolbar">
      <span data-testid="toolbar-left">{leftBranch.name}</span>
      <span data-testid="toolbar-right">{rightBranch.name}</span>
      <span>对比模式（只读）</span>
      <button>导出</button>
    </div>
  ),
}));

vi.mock("../SharedContextStrip", () => ({
  SharedContextStrip: ({ messages }: any) => (
    <div data-testid="shared-context">
      共同上下文 ({messages.length} 条消息)
    </div>
  ),
}));

vi.mock("../CompareColumn", () => ({
  CompareColumn: ({ branchName, messages }: any) => (
    <div data-testid="compare-column" data-branch={branchName}>
      {messages.length} diverged messages
    </div>
  ),
}));

// Create a real Zustand mock store with stable references
const mockStoreActions = {
  exitCompare: vi.fn(),
  setCurrentBranch: vi.fn(),
  patchBranchLocal: vi.fn(),
  openExportDialog: vi.fn(),
};

const useMockStore = create(() => ({
  ...mockStoreActions,
}));

vi.mock("../../../stores/useAppStore", () => ({
  useAppStore: Object.assign(
    (selector: any) => selector(useMockStore.getState()),
    { getState: () => useMockStore.getState() }
  ),
}));

// Import after mocks
import { CompareWorkspace } from "../CompareWorkspace";
import { selectCompareData } from "../../../selectors/compareSelectors";

// ============================================================================
// Tests
// ============================================================================

describe("CompareWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMockStore.setState(mockStoreActions, true);
  });

  it("renders compare view with branch names", () => {
    render(<CompareWorkspace />);

    expect(screen.getByTestId("compare-toolbar")).toBeInTheDocument();
    expect(screen.getByTestId("toolbar-left")).toHaveTextContent("路径 A");
    expect(screen.getByTestId("toolbar-right")).toHaveTextContent("路径 B");
  });

  it("shows read-only indicator (compare mode is strictly read-only)", () => {
    render(<CompareWorkspace />);

    expect(screen.getByText(/对比模式.*只读/)).toBeInTheDocument();
  });

  it("does NOT render any composer or send button", () => {
    const { container } = render(<CompareWorkspace />);

    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector('input[type="text"]')).toBeNull();
    expect(container.querySelector("button[type='submit']")).toBeNull();
  });

  it("shows shared context section", () => {
    render(<CompareWorkspace />);

    expect(screen.getByTestId("shared-context")).toBeInTheDocument();
    expect(screen.getByText(/共同上下文/)).toBeInTheDocument();
  });

  it("shows two compare columns for left and right branches", () => {
    render(<CompareWorkspace />);

    const columns = screen.getAllByTestId("compare-column");
    expect(columns).toHaveLength(2);
  });

  it("shows '返回聊天' button in degraded state when no branches", () => {
    vi.mocked(selectCompareData).mockReturnValueOnce(emptyCompareResult as any);

    render(<CompareWorkspace />);

    expect(screen.getByText("compare.returnToChat")).toBeInTheDocument();
  });

  it("calls exitCompare when '返回聊天' is clicked in degraded state", async () => {
    vi.mocked(selectCompareData).mockReturnValueOnce(emptyCompareResult as any);

    render(<CompareWorkspace />);
    await userEvent.click(screen.getByText("compare.returnToChat"));

    expect(mockStoreActions.exitCompare).toHaveBeenCalled();
  });

  it("shows export button", () => {
    render(<CompareWorkspace />);

    expect(screen.getByText("导出")).toBeInTheDocument();
  });
});
