import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { providerEnv } from "../config";
import { MARK, NONE_CHOICE, QK } from "../core/types";
import type { Judge, LLM, Usage } from "../core/types";
import { JevJudge } from "../providers/jev";
import { OpenAICompatLLM } from "../providers/openai-llm";
import { extractFinalAnswer } from "../tasks/check";

export interface SmokeLine {
  name: string;
  model: string;
  latencyMs: number;
  usage: Usage;
  detail: string;
}

/** One System-1 decision (noul + choice) and one System-2 solve, the two call shapes a run depends on. */
export async function smoke(judge: Judge, llm: LLM): Promise<SmokeLine[]> {
  const runId = "smoke";
  const j = await judge.ask({
    state: [
      "Cell c01",
      `${MARK.profile} arithmetic 3/3, rates 0/2, logic 1/1, gsm8k 0/0`,
      "Choose the task this cell is most likely to solve correctly.",
    ].join("\n"),
    questions: {
      strong: {
        type: "noul",
        instructions: "This cell has a strong record on arithmetic problems.",
      },
      [QK.claim]: {
        type: "choice",
        instructions: "Which candidate task should this cell claim next?",
        criteria: {
          t001: "arithmetic; attempts=0; open; A shop sells pens at 3 dollars each...",
          t002: "rates; attempts=1; needs independent verification; A train travels 120 km in 2 hours...",
          [NONE_CHOICE]: "no suitable task",
        },
      },
    },
    meta: { runId, purpose: "claim", cellId: "c01" },
  });
  const noul = j.answers.strong;
  const choice = j.answers[QK.claim];
  if (noul?.type !== "noul" || choice?.type !== "choice") throw new Error("judge did not answer both questions");

  const l = await llm.complete({
    messages: [
      { role: "system", content: "You solve exactly one problem. Be concise and exact." },
      {
        role: "user",
        content: `${MARK.domain} arithmetic\n\nA baker makes 7 trays of 12 rolls and sells all but 9. How many rolls are sold?\n\nReply with one line starting with ${MARK.method} (max 30 words) and a final line ${MARK.answer} <number>.`,
      },
    ],
    maxTokens: 200,
    meta: { runId, purpose: "solve", taskId: "smoke" },
  });
  const answer = extractFinalAnswer(l.text);
  return [
    {
      name: "system1",
      model: j.model,
      latencyMs: j.latencyMs,
      usage: j.usage,
      detail: `noul=${noul.noul.toFixed(3)} choice=${choice.choice} (${choice.confidence.toFixed(3)})`,
    },
    { name: "system2", model: l.model, latencyMs: l.latencyMs, usage: l.usage, detail: `answer=${answer || "?"} (expected 75)` },
  ];
}

export function formatSmoke(lines: SmokeLine[]): string {
  return lines
    .map(
      (s) =>
        `${s.name.padEnd(8)} model=${s.model} latency=${Math.round(s.latencyMs)}ms tokens=${s.usage.inputTokens}+${s.usage.outputTokens} cost=$${s.usage.costUsd.toFixed(6)} ${s.detail}`,
    )
    .join("\n");
}

async function main(): Promise<void> {
  const env = providerEnv();
  if (!env.jev.apiKey) throw new Error("JEV_API_KEY or OPENROUTER_API_KEY is not set");
  if (!env.llm.apiKey) throw new Error("LLM_API_KEY or OPENROUTER_API_KEY is not set");
  const judge = new JevJudge({ baseUrl: env.jev.baseUrl, apiKey: env.jev.apiKey, model: env.jev.model });
  const llm = new OpenAICompatLLM({ baseUrl: env.llm.baseUrl, apiKey: env.llm.apiKey, model: env.llm.model });
  console.log(formatSmoke(await smoke(judge, llm)));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    () => process.exit(0),
    (err: unknown) => {
      // Provider errors carry the URL and status, never request headers.
      console.error(`smoke failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
