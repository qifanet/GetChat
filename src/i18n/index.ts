/**
 * @file i18n/index.ts
 * @description Internationalization configuration for the application.
 *
 * Uses i18next + react-i18next with browser language detection.
 * Default locale: zh-CN (Simplified Chinese).
 * Supported locales: zh-CN, en.
 *
 * Usage in components:
 *   import { useTranslation } from "react-i18next";
 *   const { t } = useTranslation();
 *   <span>{t("common.mainline")}</span>
 */

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import zhCN from "./locales/zh-CN.json";
import en from "./locales/en.json";

/** Supported locale identifiers */
export type SupportedLocale = "zh-CN" | "en";

/** Default locale when detection fails */
export const DEFAULT_LOCALE: SupportedLocale = "zh-CN";

/** All supported locales with their display names */
export const SUPPORTED_LOCALES: Record<SupportedLocale, string> = {
  "zh-CN": "简体中文",
  en: "English",
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      "zh-CN": { translation: zhCN },
      en: { translation: en },
    },
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: Object.keys(SUPPORTED_LOCALES),
    interpolation: {
      escapeValue: false, // React already escapes
    },
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "getchat-locale",
      caches: ["localStorage"],
    },
  });

export default i18n;
