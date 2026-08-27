import { expect, test } from "bun:test";
import { convertHtml } from "../bin/html-to-markdown.mjs";

test("converts article structure, links, code, and MathML alttext", () => {
  const markdown = convertHtml(`<!doctype html><html><head><style>ignored</style></head><body><h1>Title</h1><p>Read <a href="https://example.test">source</a>.</p><math alttext="x^2">ignored</math><pre><code>const x = 1;</code></pre><ul><li>item</li></ul></body></html>`);
  expect(markdown).toContain("# Title");
  expect(markdown).toContain("[source](https://example.test)");
  expect(markdown).toContain("$x^2$");
  expect(markdown).toContain("```\nconst x = 1;\n```");
  expect(markdown).toContain("- item");
  expect(markdown).not.toContain("ignored");
});
