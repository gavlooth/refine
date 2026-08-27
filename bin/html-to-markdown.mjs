#!/usr/bin/env bun
// Convert static article HTML to extraction-ready Markdown without dependencies.
// Usage: ./html-to-markdown.mjs INPUT.html OUTPUT.md

import { mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, value) => String.fromCodePoint(value.startsWith("x") ? Number.parseInt(value.slice(1), 16) : Number.parseInt(value, 10)));
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return decodeEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

function stripTags(text) {
  return decodeEntities(text.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim());
}

function convertHtml(html) {
  let markdown = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "");

  markdown = markdown.replace(/<math\b[^>]*\balttext=(?:"([^"]*)"|'([^']*)')[^>]*>[\s\S]*?<\/math>/gi, (_, a, b) => `\n\n$${decodeEntities(a ?? b)}$\n\n`);
  markdown = markdown.replace(/<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_, code) => `\n\n\`\`\`\n${decodeEntities(code.replace(/<[^>]*>/g, ""))}\n\`\`\`\n\n`);
  markdown = markdown.replace(/<img\b[^>]*>/gi, (tag) => `![${attribute(tag, "alt")}](${attribute(tag, "src")})`);
  markdown = markdown.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, attrs, label) => {
    const href = attribute(attrs, "href");
    const text = stripTags(label);
    return href && text ? `[${text}](${href})` : text;
  });
  markdown = markdown.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, text) => `\n\n${"#".repeat(Number(level))} ${stripTags(text)}\n\n`);
  markdown = markdown.replace(/<(p|section|article|main|figure|figcaption|blockquote|div)\b[^>]*>/gi, "\n\n");
  markdown = markdown.replace(/<\/(p|section|article|main|figure|figcaption|blockquote|div)>/gi, "\n\n");
  markdown = markdown.replace(/<br\s*\/?\s*>/gi, "\n");
  markdown = markdown.replace(/<li\b[^>]*>/gi, "\n- ");
  markdown = markdown.replace(/<\/?(ul|ol)\b[^>]*>/gi, "\n");
  markdown = markdown.replace(/<table\b[^>]*>/gi, "\n\n").replace(/<\/table>/gi, "\n\n");
  markdown = markdown.replace(/<tr\b[^>]*>/gi, "\n").replace(/<\/(tr|td|th)>/gi, " | ");
  markdown = markdown.replace(/<[^>]*>/g, "");
  markdown = decodeEntities(markdown)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return `${markdown}\n`;
}

async function writeTextAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await Bun.write(temporary, text);
  await rename(temporary, path);
}

async function main() {
  const input = Bun.argv[2];
  const output = Bun.argv[3];
  if (!input || !output) throw new Error("Usage: ./html-to-markdown.mjs INPUT.html OUTPUT.md");
  const html = await Bun.file(resolve(input)).text();
  const markdown = convertHtml(html);
  if (!markdown.trim()) throw new Error("HTML conversion produced empty Markdown");
  await writeTextAtomic(resolve(output), markdown);
  console.error(`markdown: ${resolve(output)} (${markdown.length} characters)`);
}

if (import.meta.main) await main();

export { convertHtml };
