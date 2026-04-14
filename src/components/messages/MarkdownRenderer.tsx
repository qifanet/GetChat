/**
 * @file MarkdownRenderer.tsx
 * @description Production markdown renderer for finalized assistant content.
 *
 * This component is ONLY used after streaming completes. It supports:
 *   - GitHub-Flavored Markdown via remark-gfm
 *   - Syntax-highlighted fenced code blocks
 *   - Safe external link handling
 *   - Tables, lists, blockquotes, and inline code
 *
 * Raw HTML remains disabled so assistant output cannot inject arbitrary DOM.
 */

import { memo } from "react";
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

interface MarkdownRendererProps {
  /** The markdown text to render */
  content: string;
}

/**
 * Register a focused set of languages that cover the app's expected
 * code-review and prompt-engineering use cases without bundling every grammar.
 */
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

for (const [languageName, languageGrammar] of Object.entries(registeredLanguages)) {
  SyntaxHighlighter.registerLanguage(languageName, languageGrammar);
}

const supportedLanguages = new Set(Object.keys(registeredLanguages));

/**
 * Resolve markdown fence metadata to a registered Prism language name.
 */
function resolveCodeLanguage(className?: string): string | null {
  const languageMatch = /language-([\w-]+)/.exec(className ?? "");
  if (!languageMatch) {
    return null;
  }

  const normalizedLanguage = languageMatch[1].toLowerCase();
  return supportedLanguages.has(normalizedLanguage) ? normalizedLanguage : null;
}

/**
 * Shared renderer overrides so completed messages follow the app design system.
 */
const markdownComponents: Components = {
  pre({ node: _node, children }) {
    return (
      <div className="my-4 overflow-hidden rounded-2xl">
        {children}
      </div>
    );
  },
  a({ node: _node, href, children, ...props }) {
    const safeHref = typeof href === "string" ? href : undefined;
    return (
      <a
        href={safeHref}
        target="_blank"
        rel="noreferrer noopener"
        {...props}
      >
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
            borderRadius: "1rem",
            border: "1px solid rgba(199, 202, 213, 0.6)",
            background: "#f6f7fb",
            boxShadow: "inset 0 1px 2px rgba(17, 48, 105, 0.04)",
            fontSize: "0.875rem",
            lineHeight: 1.7,
          }}
          codeTagProps={{
            style: {
              fontFamily: '"JetBrains Mono", "Fira Code", monospace',
            },
          }}
        >
          {codeText}
        </SyntaxHighlighter>
      );
    }

    if (className?.includes("language-")) {
      return (
        <pre className="rounded-2xl border border-miro-border/30 bg-miro-surface-low p-4 text-sm">
          <code className={className} {...props}>
            {children}
          </code>
        </pre>
      );
    }

    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};

/**
 * Render finalized markdown content with GFM support.
 */
export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
}: MarkdownRendererProps) {
  return (
    <div className="markdown-content max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
