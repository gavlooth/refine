#!/usr/bin/env bun
// Final phase: use a tool-enabled OMP agent to turn a resolved graph into a rigorous cited Markdown document.
import { mkdir, rename } from "node:fs/promises";

import { dirname, resolve } from "node:path";
import { issueIds } from "./annotate-markdown.mjs";

const config = {
  timeoutSeconds: integerEnv("REFINE_DOCUMENT_TIMEOUT_SECONDS", 600, { min: 60, max: 3_600 }),
  direct: Bun.env.REFINE_DOCUMENT_DIRECT === "1",
  annotatedSource: Bun.env.REFINE_DOCUMENT_SOURCE ?? "",
  model: Bun.env.REFINE_MODEL ?? "",
  thinking: Bun.env.REFINE_THINKING ?? "high",
  serviceTier: Bun.env.REFINE_SERVICE_TIER ?? "",
};

function integerEnv(name, fallback, { min, max }) {
  const value = Number(Bun.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

async function ensureDirectory(path) { await mkdir(path, { recursive: true }); }

function documentPrompt(graphPath, outputPath, direct = false, annotatedSource = "") {
  return `You are the final author of a rigorous technical learning document.

${direct ? `The complete resolved graph JSON is attached to this request. Return only the finished Markdown document, beginning with its title heading; do not use tools or discuss the task.` : `Read the resolved knowledge graph at ${graphPath}. Write the finished Markdown document to ${outputPath} using the write tool. Do not return the document in chat; write the file, then return a concise completion note.`}
${annotatedSource ? `The annotated source Markdown is at ${annotatedSource}. Every refine:issue comment is an active machine-readable instruction. Resolve it only with supported information and replace it with a refine:resolved comment carrying the same id; otherwise preserve the original refine:issue comment exactly.` : ""}
LEVEL AND PEDAGOGY
- Write at the conceptual and mathematical level of Spivak's Calculus: precise definitions, cumulative development, explicit assumptions, derivations or proof sketches where they carry understanding, worked examples, and short exercises with hints or answers when helpful.
- Start from the most fundamental prerequisites required by the graph. Introduce notation before use. Never use an idea merely because it appeared earlier in the source order.
- Build one coherent route from foundations through the graph's complete accumulated knowledge, including definitions, mechanisms, evidence, limitations, and implications.
- Prefer a small number of well-developed sections over a shallow catalogue. Use a clear title, introduction, dependency-aware section order, equations where useful, examples, and a conclusion.

GRAPH AUTHORITY
- The graph is the syllabus and provenance ledger, not an outline to copy. Reorder nodes into the dependency order a learner needs.
- Source/recovery nodes are evidence from the source material. Model-injected and expansion nodes are aids, not source claims; do not attribute them to the source.
- Use resolved gaps to improve flow. Any remaining unresolved gaps must stay visible as explicit uncertainty or open questions, never silently fabricated.
- Do not mention internal graph identifiers, tool names, density scores, or pipeline phases in the learner-facing document.

RESEARCH AND CITATIONS
${direct ? `- Use the target sources already present in the attached graph. Preserve unresolved gaps as explicit uncertainty rather than fabricate research results.` : `- Use web search for every remaining gap, every externally supplied definition that materially supports the exposition, and important factual claims not directly established by the source.
- Prefer primary sources: cited papers, official documentation, textbooks, standards, or original theorem sources.
- Cite web-derived claims inline with stable URLs or numbered footnotes. End with a Sources section that distinguishes source material from supplementary sources.
- If online evidence does not support a claim, say so plainly; do not fabricate a citation, equation, result, or historical attribution.`}

WRITING REQUIREMENTS
- Produce standalone Markdown suitable for a serious reader. Preserve the distinction between theorem/derivation, experiment, interpretation, and limitation.
- Cover every major dependency path and explain what remains unproven, uncertain, or implementation-dependent.
- One prose paragraph must develop one primary conceptual move. Do not recompress several graph nodes into a checklist paragraph.
- Use at most three prose sentences per paragraph unless the paragraph is one continuous derivation or one worked example.
- When a process has several operations, give each operation its own step or paragraph and explain its input, purpose, output, and failure mode before advancing.
- If a paragraph introduces several technical nouns, prerequisites, approximations, or qualifications, split it and teach each prerequisite first.
- Keep all claims calibrated: observations, theoretical results, model-derived explanations, and open questions must not blur together.

Before completion, verify ${outputPath} exists, is Markdown, contains citations, and includes all major graph concepts in a pedagogically coherent sequence.`;
}

function wordCount(text) {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu)?.length ?? 0;
}

function denseParagraphs(markdown) {
  return markdown.split(/\n\s*\n/).map((block, index) => {
    const text = block.replace(/\s+/g, " ").trim();
    const words = wordCount(text);
    const sentences = text.match(/[.!?](?=\s|$)/g)?.length ?? 0;
    return { index, text, words, sentences };
  }).filter(({ text, words, sentences }) =>
    text &&
    !/^(?:#{1,6}\s|[-*+]\s|\d+\.\s|>|```|\$\$|\\\[|\||<!--)/.test(text) &&
    sentences > 0 &&
    ((words >= 35 && sentences >= 4) || words >= 90)
  ).map(({ index, words, sentences, text }) => ({ index, words, sentences, excerpt: text.slice(0, 300) }));
}
async function writeTextAtomic(path, text) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await Bun.write(temporary, text);
  await rename(temporary, path);
}

async function main() {
  const input = Bun.argv[2];
  const output = Bun.argv[3];
  if (!input || !output) throw new Error("Usage: ./generate-document.mjs INPUT_GRAPH.json OUTPUT_DOCUMENT.md [RUN_DIRECTORY]");
  const graphPath = resolve(input);
  const outputPath = resolve(output);
  const annotatedSourcePath = config.annotatedSource ? resolve(config.annotatedSource) : "";
  if (!(await Bun.file(graphPath).exists())) throw new Error(`Graph does not exist: ${graphPath}`);
  if (annotatedSourcePath && !(await Bun.file(annotatedSourcePath).exists())) throw new Error(`Annotated source does not exist: ${annotatedSourcePath}`);
  if (await Bun.file(outputPath).exists() && Bun.env.REFINE_OVERWRITE !== "1") throw new Error(`Document already exists: ${outputPath}. Set REFINE_OVERWRITE=1 to replace it.`);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDirectory = resolve(Bun.argv[4] ?? `${outputPath}.document-${timestamp}`);
  await Promise.all([ensureDirectory(runDirectory), ensureDirectory(dirname(outputPath))]);
  const prompt = documentPrompt(graphPath, outputPath, config.direct, annotatedSourcePath);
  const promptPath = resolve(runDirectory, "document-agent.prompt.txt");
  await Bun.write(promptPath, prompt);
  const system = config.direct
    ? "You are a meticulous graph-to-document author. Return only the requested Markdown document."
    : "You are a meticulous graph-to-document agent. Use available read, write, and web search tools. Obey the graph provenance boundary and write the requested document file.";
  const args = ["omp", "-p", "--mode", "text", "--no-session", "--no-extensions", "--no-skills", "--no-rules", "--auto-approve", "--approval-mode", "yolo", "--max-time", `${config.timeoutSeconds}s`, "--system-prompt", system];
  if (config.direct) args.push("--no-tools");
  if (config.model) args.push("--model", config.model);
  if (config.thinking) args.push("--thinking", config.thinking);
  if (config.serviceTier) args.push("--service-tier", config.serviceTier);
  if (config.direct) args.push(`@${graphPath}`);
  if (annotatedSourcePath) args.push(`@${annotatedSourcePath}`);
  args.push(`@${promptPath}`);
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", cwd: process.cwd() });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, (config.timeoutSeconds + 10) * 1_000);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  await Promise.all([Bun.write(resolve(runDirectory, "agent.stdout.log"), stdout), Bun.write(resolve(runDirectory, "agent.stderr.log"), stderr)]);
  if (timedOut) throw new Error(`Document agent timed out after ${config.timeoutSeconds}s`);
  if (exitCode !== 0) throw new Error(`Document agent exited ${exitCode}: ${stderr.trim()}`);
  let document;
  if (config.direct) {
    document = stdout;
  } else {
    if (!(await Bun.file(outputPath).exists())) throw new Error("Document agent exited without writing the requested document");
    document = await Bun.file(outputPath).text();
  }
  if (!document.trim().startsWith("#") || document.length < 2_000) throw new Error("Document agent wrote an incomplete Markdown document");
  const densityIssues = denseParagraphs(document);
  await Bun.write(resolve(runDirectory, "document-density-issues.json"), `${JSON.stringify(densityIssues, null, 2)}\n`);
  if (densityIssues.length) {
    if (!config.direct) await rename(outputPath, resolve(runDirectory, "rejected-document.md"));
    throw new Error(`Document contains ${densityIssues.length} dense prose paragraph(s); rejected before publication`);
  }
  if (annotatedSourcePath) {
    const expectedIssueIds = issueIds(await Bun.file(annotatedSourcePath).text());
    const retainedOrResolvedIds = new Set(issueIds(document));
    const missingIssueIds = expectedIssueIds.filter((id) => !retainedOrResolvedIds.has(id));
    await Bun.write(resolve(runDirectory, "document-missing-issue-comments.json"), `${JSON.stringify(missingIssueIds, null, 2)}\n`);
    if (missingIssueIds.length) {
      if (!config.direct) await rename(outputPath, resolve(runDirectory, "rejected-document-missing-issues.md"));
      throw new Error(`Document silently dropped ${missingIssueIds.length} refine issue comment(s)`);
    }
  }
  if (config.direct) await writeTextAtomic(outputPath, document);
  console.error(`document: ${outputPath} (${document.length} characters)`);
}

if (import.meta.main) await main();

export { denseParagraphs, documentPrompt };

