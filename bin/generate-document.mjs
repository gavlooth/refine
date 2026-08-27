#!/usr/bin/env bun
// Final phase: use a tool-enabled OMP agent to turn a resolved graph into a rigorous cited Markdown document.
import { mkdir, rename } from "node:fs/promises";

import { dirname, resolve } from "node:path";

const config = {
  timeoutSeconds: integerEnv("REFINE_DOCUMENT_TIMEOUT_SECONDS", 600, { min: 60, max: 3_600 }),
  direct: Bun.env.REFINE_DOCUMENT_DIRECT === "1",
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

function documentPrompt(graphPath, outputPath, direct = false) {
  return `You are the final author of a rigorous technical learning document.

${direct ? `The complete resolved graph JSON is attached to this request. Return only the finished Markdown document, beginning with its title heading; do not use tools or discuss the task.` : `Read the resolved knowledge graph at ${graphPath}. Write the finished Markdown document to ${outputPath} using the write tool. Do not return the document in chat; write the file, then return a concise completion note.`}

LEVEL AND PEDAGOGY
- Write at the conceptual and mathematical level of Spivak's Calculus: precise definitions, cumulative development, explicit assumptions, derivations or proof sketches where they carry understanding, worked examples, and short exercises with hints or answers when helpful.
- Start from the most fundamental prerequisites required by the graph. Introduce notation before use. Never use an idea merely because it appeared earlier in the source order.
- Build one coherent route from foundations through the complete accumulated knowledge, including the go-mHC construction, its mathematical setting, architecture, analysis, evidence, limitations, and implications.
- Prefer a small number of well-developed sections over a shallow catalogue. Use a clear title, introduction, dependency-aware section order, equations in LaTeX, examples, and a conclusion.

GRAPH AUTHORITY
- The graph is the syllabus and provenance ledger, not an outline to copy. Reorder nodes into the dependency order a learner needs.
- Source/recovery nodes are evidence from the original paper. Model-injected and expansion nodes are aids, not paper claims; do not attribute them to the paper.
- Use resolved gaps to improve flow. Four remaining unresolved gaps must remain visible as explicit uncertainty or open questions, never silently fabricated.
- Do not mention internal graph identifiers, tool names, density scores, or pipeline phases in the learner-facing document.

RESEARCH AND CITATIONS
${direct ? `- Use the target paper and sources already present in the attached graph. The prior research pass did not close four gaps; preserve them as explicit uncertainty rather than fabricate research results.` : `- Use web search for every remaining gap, every externally supplied definition that materially supports the exposition, and important factual claims not directly established by the paper.
- Prefer primary sources: the paper, cited papers, official documentation, textbooks, or original theorem sources.
- Cite web-derived claims inline with stable URLs or numbered footnotes. End with a Sources section that distinguishes the target paper from supplementary sources.
- If online evidence does not support a claim, say so plainly; do not fabricate a citation, equation, result, or historical attribution.`}

WRITING REQUIREMENTS
- Produce standalone Markdown suitable for a serious reader. Preserve the distinction between theorem/derivation, experiment, interpretation, and limitation.
- Explain the Birkhoff polytope, doubly stochastic and generalized orthostochastic matrices, Hyper-Connections, mHC baselines, Cayley construction, parameter tradeoffs, spectral reach, training evidence, and what remains unproven or implementation-dependent.
- Include at least one worked conceptual example of stream mixing and one explicit feasibility/limitation discussion.
- Keep all claims calibrated: observations, theoretical results, model-derived explanations, and open questions must not blur together.

Before completion, verify ${outputPath} exists, is Markdown, contains citations, and includes all major graph concepts in a pedagogically coherent sequence.`;
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
  if (!(await Bun.file(graphPath).exists())) throw new Error(`Graph does not exist: ${graphPath}`);
  if (await Bun.file(outputPath).exists() && Bun.env.REFINE_OVERWRITE !== "1") throw new Error(`Document already exists: ${outputPath}. Set REFINE_OVERWRITE=1 to replace it.`);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDirectory = resolve(Bun.argv[4] ?? `${outputPath}.document-${timestamp}`);
  await Promise.all([ensureDirectory(runDirectory), ensureDirectory(dirname(outputPath))]);
  const prompt = documentPrompt(graphPath, outputPath, config.direct);
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
  args.push(`@${promptPath}`);
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", cwd: process.cwd() });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, (config.timeoutSeconds + 10) * 1_000);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  await Promise.all([Bun.write(resolve(runDirectory, "agent.stdout.log"), stdout), Bun.write(resolve(runDirectory, "agent.stderr.log"), stderr)]);
  if (timedOut) throw new Error(`Document agent timed out after ${config.timeoutSeconds}s`);
  if (exitCode !== 0) throw new Error(`Document agent exited ${exitCode}: ${stderr.trim()}`);
  if (config.direct) await writeTextAtomic(outputPath, stdout);
  const document = await Bun.file(outputPath).text();
  if (!document.trim().startsWith("#") || document.length < 2_000) throw new Error("Document agent wrote an incomplete Markdown document");
  console.error(`document: ${outputPath} (${document.length} characters)`);
}

if (import.meta.main) await main();

export { documentPrompt };

