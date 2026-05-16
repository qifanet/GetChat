/**
 * @file MarkdownRenderer.tsx
 * @description Production markdown renderer for finalized assistant content.
 *
 * Supports:
 *   - GitHub-Flavored Markdown via remark-gfm
 *   - LaTeX math via remark-math + rehype-katex
 *   - Mermaid diagrams (dynamic import, rendered as SVG) — can be disabled
 *   - Syntax-highlighted fenced code blocks with language label and copy button
 *   - Safe external link handling
 *   - Tables, lists, blockquotes, and inline code
 *
 * Raw HTML remains disabled so assistant output cannot inject arbitrary DOM.
 */
import { memo, useState, useCallback, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import c from "react-syntax-highlighter/dist/esm/languages/prism/c";
import cpp from "react-syntax-highlighter/dist/esm/languages/prism/cpp";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import csharp from "react-syntax-highlighter/dist/esm/languages/prism/csharp";
import dart from "react-syntax-highlighter/dist/esm/languages/prism/dart";
import diff from "react-syntax-highlighter/dist/esm/languages/prism/diff";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go";
import java from "react-syntax-highlighter/dist/esm/languages/prism/java";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import kotlin from "react-syntax-highlighter/dist/esm/languages/prism/kotlin";
import lua from "react-syntax-highlighter/dist/esm/languages/prism/lua";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import php from "react-syntax-highlighter/dist/esm/languages/prism/php";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import r from "react-syntax-highlighter/dist/esm/languages/prism/r";
import ruby from "react-syntax-highlighter/dist/esm/languages/prism/ruby";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import scala from "react-syntax-highlighter/dist/esm/languages/prism/scala";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import swift from "react-syntax-highlighter/dist/esm/languages/prism/swift";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useTranslation } from "react-i18next";
import { copyTextToClipboard } from "../../utils/clipboard";
import { MermaidBlock } from "./MermaidBlock";

import "katex/dist/katex.min.css";

interface MarkdownRendererProps {
  content: string;
  /** When true, mermaid code blocks are displayed as plain code instead of rendered diagrams. */
  disableMermaid?: boolean;
}

const registeredLanguages = {
  bash,
  sh: bash,
  shell: bash,
  c,
  "c++": cpp,
  cpp,
  cs: csharp,
  csharp,
  css,
  dart,
  diff,
  go,
  java,
  javascript,
  js: javascript,
  json,
  jsx,
  kotlin,
  lua,
  markdown,
  md: markdown,
  php,
  python,
  py: python,
  r,
  ruby,
  rb: ruby,
  rust,
  rs: rust,
  scala,
  sql,
  swift,
  ts: typescript,
  tsx,
  typescript,
  yaml,
  yml: yaml,
} as const;

for (const [name, grammar] of Object.entries(registeredLanguages)) {
  SyntaxHighlighter.registerLanguage(name, grammar);
}

const supportedLanguages = new Set(Object.keys(registeredLanguages));

function resolveCodeLanguage(className?: string): string | null {
  const m = /language-([\w+-]+)/.exec(className ?? "");
  if (!m) return null;
  const norm = m[1].toLowerCase();
  if (norm === "mermaid") return "mermaid";
  return supportedLanguages.has(norm) ? norm : null;
}

function extractLanguageFromChildren(children: ReactNode): string | null {
  if (!children) return null;
  if (typeof children === "object" && "props" in children) {
    const childProps = (children as { props?: { className?: string } }).props;
    if (childProps?.className) {
      return resolveCodeLanguage(childProps.className);
    }
  }
  if (Array.isArray(children)) {
    for (const child of children) {
      const lang = extractLanguageFromChildren(child);
      if (lang) return lang;
    }
  }
  return null;
}

function extractTextFromChildren(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(extractTextFromChildren).join("");
  if (children && typeof children === "object" && "props" in children) {
    return extractTextFromChildren((children as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

function CodeBlockHeader({
  language,
  rawCode,
  copyLabel,
  copiedLabel,
}: {
  language: string | null;
  rawCode: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    void copyTextToClipboard(rawCode).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }, [rawCode]);
  return (
    <div className="flex items-center justify-between border-b border-miro-border/15 px-4 py-2">
      <span className="font-mono text-[11px] font-medium uppercase tracking-wider text-miro-text-secondary">
        {language ?? "text"}
      </span>
      <button
        type="button"
        onClick={handleCopy}
        className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium text-miro-text-secondary transition-colors hover:bg-miro-surface-high hover:text-miro-text"
      >
        {copied ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
        )}
        {copied ? copiedLabel : copyLabel}
      </button>
    </div>
  );
}

function buildMarkdownComponents(
  copyLabel: string,
  copiedLabel: string,
  disableMermaid: boolean,
): Components {
  return {
  pre({ node: _node, children }) {
    const language = extractLanguageFromChildren(children);
    const rawCode = extractTextFromChildren(children).replace(/\n$/, "");

    if (language === "mermaid" && !disableMermaid) {
      return <MermaidBlock code={rawCode} />;
    }

    return (
      <div className="my-4 overflow-hidden rounded-2xl border border-miro-border/20 bg-[#f6f7fb]">
        <CodeBlockHeader
          language={language}
          rawCode={rawCode}
          copyLabel={copyLabel}
          copiedLabel={copiedLabel}
        />
        <div className="overflow-x-auto">{children}</div>
      </div>
    );
  },
  a({ node: _node, href, children, ...props }) {
    return (
      <a href={typeof href === "string" ? href : undefined} target="_blank" rel="noreferrer noopener" {...props}>
        {children}
      </a>
    );
  },
  code({ node: _node, className, children, ...props }) {
    const language = resolveCodeLanguage(className);
    const codeText = String(children).replace(/\n$/, "");

    if (language === "mermaid" && !disableMermaid) {
      return <MermaidBlock code={codeText} />;
    }

    if (language) {
      return (
        <SyntaxHighlighter
          language={language}
          style={oneLight}
          PreTag="div"
          customStyle={{
            margin: 0,
            padding: "1rem 1.25rem",
            borderRadius: 0,
            border: "none",
            background: "transparent",
            fontSize: "0.875rem",
            lineHeight: 1.7,
          }}
          codeTagProps={{
            style: { fontFamily: '"JetBrains Mono", "Fira Code", monospace' },
          }}
        >
          {codeText}
        </SyntaxHighlighter>
      );
    }
    if (className?.includes("language-")) {
      return (
        <pre className="p-4 text-sm">
          <code className={className} {...props}>{children}</code>
        </pre>
      );
    }
    return <code className={className} {...props}>{children}</code>;
  },
  };
}

/**
 * Normalize LaTeX math delimiters to formats recognized by remark-math.
 *
 * Many AI models output math using LaTeX-style delimiters:
 *   \[...\] for block math, \(...\) for inline math.
 * remark-math only recognizes $...$ and $$...$$, so we convert.
 * Fenced code blocks are excluded to avoid false positives.
 */
function normalizeMathDelimiters(text: string): string {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      let result = part;
      // Block math: \[...\] -> $$...$$
      result = result.replace(
        /\\\[([\s\S]*?)\\\]/g,
        (_m, inner: string) => "$$" + inner + "$$"
      );
      // Inline math: \(...\) -> $...$
      result = result.replace(
        /\\\(([\s\S]*?)\\\)/g,
        (_m, inner: string) => "$" + inner + "$"
      );
      return result;
    })
    .join("");
}

export const MarkdownRenderer = memo(function MarkdownRenderer({ content, disableMermaid = false }: MarkdownRendererProps) {
  const { t } = useTranslation();
  const markdownComponents = useMemo(
    () =>
      buildMarkdownComponents(
        t("common.copyCode"),
        t("common.codeCopied"),
        disableMermaid,
      ),
    [t, disableMermaid]
  );
  const normalizedContent = useMemo(() => normalizeMathDelimiters(content), [content]);
  return (
    <div className="markdown-content max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={markdownComponents}
      >
        {normalizedContent}
      </ReactMarkdown>
    </div>
  );
});
