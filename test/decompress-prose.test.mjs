import { expect, test } from "bun:test";
import { splitDenseProse } from "../bin/decompress-prose.mjs";
import { denseParagraphs } from "../bin/generate-document.mjs";

test("splits the packed electronic-structure example without losing sentences", () => {
  const packed = "A real calculation usually begins from nuclear species and positions and treats the electronic structure with an approximation such as density-functional theory, often in a periodically repeated supercell. Charged defects need careful electrostatic finite-size corrections. Atomic coordinates must relax. Band-gap errors can put defect levels in the wrong place.";
  const result = splitDenseProse(packed);
  expect(result.splitCount).toBeGreaterThan(0);
  expect(denseParagraphs(result.markdown)).toEqual([]);
  for (const sentence of ["Charged defects need careful electrostatic finite-size corrections.", "Atomic coordinates must relax.", "Band-gap errors can put defect levels in the wrong place."]) expect(result.markdown).toContain(sentence);
});

test("does not change headings, lists, equations, or issue comments", () => {
  const markdown = "# Heading\n\n- one\n- two\n\n$$\nx=y\n$$\n\n<!-- refine:issue {\"id\":\"g1\"} -->\n";
  expect(splitDenseProse(markdown).markdown.trim()).toBe(markdown.trim());
});
