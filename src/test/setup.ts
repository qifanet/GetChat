/**
 * @file setup.ts
 * @description Global test setup for Vitest.
 *
 * Extends expect with jest-dom matchers.
 * Mocks react-i18next to return key-based stubs in tests.
 */
import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

/**
 * Mock react-i18next for all tests.
 *
 * The mock t() function returns the key as the display text.
 * This allows tests to assert on translation keys (stable across locales)
 * while keeping component logic verifiable.
 */
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (!params) return key;
      // Simple interpolation: replace {{key}} with value
      return Object.entries(params).reduce(
        (str, [k, v]) => str.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v)),
        key,
      );
    },
    i18n: {
      language: "zh-CN",
      changeLanguage: vi.fn(),
    },
  }),
  initReactI18next: {
    type: "3rdParty",
    init: vi.fn(),
  },
  Trans: ({ children }: { children: React.ReactNode }) => children,
}));
