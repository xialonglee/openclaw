import { describe, expect, it } from "vitest";
import { chunkFeishuMarkdown, normalizeFeishuPostMarkdownNewlines } from "./markdown.js";

describe("normalizeFeishuPostMarkdownNewlines", () => {
  it.each([
    { name: "LF", input: "line one\nline two", expected: "line one\n\nline two" },
    { name: "CRLF", input: "line one\r\nline two", expected: "line one\r\n\r\nline two" },
    { name: "CR", input: "line one\rline two", expected: "line one\r\rline two" },
  ])("materializes CommonMark soft breaks with $name endings", ({ input, expected }) => {
    expect(normalizeFeishuPostMarkdownNewlines(input)).toBe(expected);
  });

  it("preserves existing paragraph breaks and is idempotent", () => {
    const once = normalizeFeishuPostMarkdownNewlines("a\nb\n\nc\nd");
    expect(once).toBe("a\n\nb\n\nc\n\nd");
    expect(normalizeFeishuPostMarkdownNewlines(once)).toBe(once);
  });

  it("preserves fenced and indented code source", () => {
    const input = [
      "```ts",
      "const first = 1",
      "const second = 2",
      "```",
      "",
      "    indented first",
      "    indented second",
    ].join("\n");
    expect(normalizeFeishuPostMarkdownNewlines(input)).toBe(input);
  });

  it("preserves multiline inline code while materializing the following soft break", () => {
    const input = "run `const first = 1\nconst second = 2` now\nnext";
    expect(normalizeFeishuPostMarkdownNewlines(input)).toBe(
      "run `const first = 1\nconst second = 2` now\n\nnext",
    );
  });

  it("preserves explicit hard breaks and setext headings", () => {
    expect(normalizeFeishuPostMarkdownNewlines("hard  \nbreak")).toBe("hard  \nbreak");
    expect(normalizeFeishuPostMarkdownNewlines("Title\n=====\nnext")).toBe("Title\n=====\nnext");
  });

  it("preserves structural list boundaries and HTML blocks", () => {
    expect(normalizeFeishuPostMarkdownNewlines("- first\n- second")).toBe("- first\n- second");
    expect(normalizeFeishuPostMarkdownNewlines("<div>\nfirst\nsecond\n</div>")).toBe(
      "<div>\nfirst\nsecond\n</div>",
    );
  });

  it("treats an unclosed fence as code through the end of the document", () => {
    const input = "```ts\nconst first = 1\nconst second = 2";
    expect(normalizeFeishuPostMarkdownNewlines(input)).toBe(input);
  });
});

describe("chunkFeishuMarkdown", () => {
  it("keeps split fenced-code chunks independently parseable", () => {
    const chunks = chunkFeishuMarkdown(`\`\`\`ts\n${"const value = 1;\n".repeat(20)}\`\`\``, 80);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.startsWith("```ts") && chunk.endsWith("```"))).toBe(true);
  });
});
