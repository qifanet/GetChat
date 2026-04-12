/** @type {import('tailwindcss').Config} */
import forms from '@tailwindcss/forms';

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        "miro-page": "#faf8ff",
        "miro-bg": "#f2f3ff",
        "miro-card": "#ffffff",
        "miro-sidebar": "#f2f3ff",
        "miro-surface-low": "#f2f3ff",
        "miro-surface": "#eaedff",
        "miro-surface-high": "#e2e7ff",
        "miro-surface-highest": "#d9e2ff",
        "miro-border": "#98b1f2",
        "miro-ring": "#cad2ff",
        "miro-text": "#113069",
        "miro-text-secondary": "#526074",
        "miro-placeholder": "#7486af",
        "miro-blue": "#3755c3",
        "miro-blue-pressed": "#2848b7",
        "miro-blue-light": "#dde1ff",
        "miro-violet": "#6079b7",
        "miro-violet-light": "#d5e3fc",
        "miro-green": "#006b62",
        "miro-green-light": "#e2fff9",
        "miro-teal": "#006d64",
        "miro-teal-light": "#d8faf5",
        "miro-coral": "#9f403d",
        "miro-coral-light": "#fff1f0",
        "miro-amber": "#80630f",
        "miro-amber-light": "#fff6d6",
        "miro-orange-light": "#fff4dd",
        "miro-pink-light": "#f6ebff",
        "miro-red": "#9f403d",
        "miro-red-light": "#fff1f0",
      },
      fontFamily: {
        sans: [
          "Inter",
          "Noto Sans SC",
          "Segoe UI",
          "sans-serif",
        ],
        display: [
          "Inter",
          "Noto Sans SC",
          "Segoe UI",
          "sans-serif",
        ],
        body: [
          "Inter",
          "Noto Sans SC",
          "Segoe UI",
          "sans-serif",
        ],
        mono: ["JetBrains Mono", "Fira Code", "Consolas", "monospace"],
      },
      boxShadow: {
        ring: "0 0 0 1px rgba(152, 177, 242, 0.18)",
        panel:
          "0 22px 56px -28px rgba(17, 48, 105, 0.24), 0 0 0 1px rgba(152, 177, 242, 0.1)",
        float:
          "0 32px 64px -30px rgba(17, 48, 105, 0.18), 0 0 0 1px rgba(152, 177, 242, 0.08)",
        focus: "0 0 0 4px rgba(55, 85, 195, 0.1)",
      },
      borderRadius: {
        DEFAULT: "14px",
        panel: "20px",
        shell: "28px",
      },
      backdropBlur: {
        chrome: "24px",
      },
    },
  },
  plugins: [forms],
};
