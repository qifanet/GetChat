/**
 * @file MarkdownRenderer.tsx
 * @description Production markdown renderer for finalized assistant content.
 *
 * This component is ONLY used after streaming completes. It supports:
 *   - GitHub-Flavored Markdown via remark-gfm
 *   - Syntax-highlighted fenced code blocks with language label and copy button
 *   - Safe external link handling
 *   - Tables, lists, blockquotes, and inline code
 *
 * Raw HTML remains disabled so assistant output cannot inject arbitrary DOM.
 */
import { memo, useState, useCallback, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import diff from "react-syntax-highlighter/dist/esm/languages/prism/diff";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go";
import java from "react-syntax-highlighter/dist/esm/languages/prism/java";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import { useTranslation } from "react-i18next";
import { copyTextToClipboard } from "../../utils/clipboard";
interface MarkdownRendererProps {
  content: string;
}
const registeredLanguages = {
  bash,
  sh: bash,
  shell: bash,
  css,
  diff,
  go,
  java,
  javascript,
  js: javascript,
  json,
  jsx,
  markdown,
  md: markdown,
  python,
  py: python,
  rust,
  rs: rust,
  sql,
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
  const m = /language-([\w-]+)/.exec(className ?? "");
  if (!m) return null;
  const norm = m[1].toLowerCase();
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
  copiedLabel: string
): Components {
  return {
  pre({ node: _node, children }) {
    const language = extractLanguageFromChildren(children);
    const rawCode = extractTextFromChildren(children).replace(/\n$/, "");
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
export const MarkdownRenderer = memo(function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const { t } = useTranslation();
  const markdownComponents = useMemo(
    () =>
      buildMarkdownComponents(
        t("common.copyCode"),
        t("common.codeCopied")
      ),
    [t]
  );
  return (
    <div className="markdown-content max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
