/**
 * @file MarkdownRenderer.test.tsx
 * @description Smoke tests for the production markdown renderer.
 *
 * Coverage focus:
 *   - GFM tables render as table elements
 *   - External links open in a safe new tab
 *   - Fenced code blocks render through the syntax highlighter path
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarkdownRenderer } from "../MarkdownRenderer";

describe("MarkdownRenderer", () => {
  it("renders GFM tables", () => {
    render(
      <MarkdownRenderer
        content={`| Name | Value |\n| --- | --- |\n| Alpha | 1 |`}
      />
    );

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });

  it("renders safe external links", () => {
    render(<MarkdownRenderer content="[OpenAI](https://openai.com)" />);

    const link = screen.getByRole("link", { name: "OpenAI" });
    expect(link).toHaveAttribute("href", "https://openai.com");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("renders fenced code blocks", () => {
    render(
      <MarkdownRenderer
        content={"```ts\nconst value = 42;\n```"}
      />
    );

    expect(
      screen.getByText((_, element) => {
        return (
          element?.tagName.toLowerCase() === "code" &&
          element.textContent === "const value = 42;"
        );
      })
    ).toBeInTheDocument();
  });
});
