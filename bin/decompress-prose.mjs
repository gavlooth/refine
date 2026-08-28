#!/usr/bin/env bun
// Losslessly split dense prose paragraphs at sentence boundaries.
// Usage: ./decompress-prose.mjs INPUT.md OUTPUT.md
import { mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { denseParagraphs } from "./generate-document.mjs";

function words(text) { return text.match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu)?.length ?? 0; }
function protectedBlock(text) { return /^(?:#{1,6}\s|[-*+]\s|\d+\.\s|>|```|\$\$|\||<!--)/.test(text.trim()); }
function sentences(text) { return text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+(?=[A-Z0-9*_`(\[\\“])/u).filter(Boolean); }

function splitDenseProse(markdown) {
  let splitCount = 0;
  const blocks = markdown.split(/\n\s*\n/).map((block) => {
    const text = block.trim();
    if (!text || protectedBlock(text) || !denseParagraphs(text).length) return block;
    const parts = sentences(text);
    if (parts.length < 2) return block;
    const groups = []; let current = [];
    for (const sentence of parts) {
      if (current.length && (current.length >= 2 || words([...current, sentence].join(" ")) > 55)) { groups.push(current.join(" ")); current = []; }
      current.push(sentence);
    }
    if (current.length) groups.push(current.join(" "));
    if (groups.length < 2) return block;
    splitCount += groups.length - 1;
    return groups.join("\n\n");
  });
  return { markdown: `${blocks.join("\n\n").trim()}\n`, splitCount };
}

async function writeAtomic(path, text) { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.tmp-${process.pid}-${Date.now()}`; await Bun.write(temporary, text); await rename(temporary, path); }

async function main() {
  const input = Bun.argv[2]; const output = Bun.argv[3];
  if (!input || !output) throw new Error("Usage: ./decompress-prose.mjs INPUT.md OUTPUT.md");
  const result = splitDenseProse(await Bun.file(resolve(input)).text()); await writeAtomic(resolve(output), result.markdown);
  console.error(`split ${result.splitCount} dense paragraph boundaries; ${denseParagraphs(result.markdown).length} dense paragraphs remain`);
}
if (import.meta.main) await main();

export { sentences, splitDenseProse };
