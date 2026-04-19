import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCheck = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: mockCheck,
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn(),
}));

function setTauriRuntime(enabled: boolean) {
  if (enabled) {
    (window as Window & { __TAURI_INTERNALS__?: { invoke?: () => void } }).__TAURI_INTERNALS__ =
      { invoke: () => undefined };
    return;
  }

  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

async function loadUpdateChecker() {
  vi.resetModules();
  return import("../updateChecker");
}

function createMockUpdate() {
  return {
    currentVersion: "1.0.0",
    version: "1.1.0",
    date: "2026-04-19",
    body: "Release notes",
    downloadAndInstall: vi.fn(),
  } as const;
}

beforeEach(() => {
  mockCheck.mockReset();
  setTauriRuntime(false);
});

describe("updateChecker", () => {
  it("is a no-op outside Tauri runtime", async () => {
    const { checkForUpdate } = await loadUpdateChecker();

    const info = await checkForUpdate();

    expect(info).toBeNull();
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("respects check interval when app is already up-to-date", async () => {
    setTauriRuntime(true);
    mockCheck.mockResolvedValueOnce(null);

    const { autoCheckForUpdate } = await loadUpdateChecker();

    expect(await autoCheckForUpdate()).toBeNull();
    expect(await autoCheckForUpdate()).toBeNull();
    expect(mockCheck).toHaveBeenCalledTimes(1);
  });

  it("returns cached update without re-checking inside interval", async () => {
    setTauriRuntime(true);
    const update = createMockUpdate();
    mockCheck.mockResolvedValueOnce(update);

    const { autoCheckForUpdate } = await loadUpdateChecker();

    const first = await autoCheckForUpdate();
    const second = await autoCheckForUpdate();

    expect(first).toEqual({
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      date: "2026-04-19",
      body: "Release notes",
    });
    expect(second).toEqual(first);
    expect(mockCheck).toHaveBeenCalledTimes(1);
  });

  it("backs off after a failed check attempt", async () => {
    setTauriRuntime(true);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockCheck.mockRejectedValueOnce(new Error("network"));

    const { autoCheckForUpdate } = await loadUpdateChecker();

    expect(await autoCheckForUpdate()).toBeNull();
    expect(await autoCheckForUpdate()).toBeNull();
    expect(mockCheck).toHaveBeenCalledTimes(1);
  });
});
