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
            padding: "1rem",
            borderRadius: "1rem",
            border: "1px solid rgba(199, 202, 213, 0.9)",
            background: "#f8f9fd",
            boxShadow: "0 0 0 1px rgba(224, 226, 232, 0.95)",
            fontSize: "0.9rem",
            lineHeight: 1.6,
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
        <pre className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
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
