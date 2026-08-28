import { expect, test } from "bun:test";
import { applyReplacements } from "../bin/rewrite-dense-book.mjs";

test("replaces only the named Markdown block", () => {
  const document = "# Title\n\nDense original paragraph. More. More. More.\n\nKeep this paragraph.\n";
  const rewritten = applyReplacements(document, [{ index: 1, paragraphs: ["First focused paragraph.", "Second focused paragraph."] }]);
  expect(rewritten).toContain("# Title\n\nFirst focused paragraph.\n\nSecond focused paragraph.\n\nKeep this paragraph.");
  expect(rewritten).not.toContain("Dense original paragraph");
});
