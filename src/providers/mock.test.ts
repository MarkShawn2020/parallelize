import { describe, expect, it } from "vitest";
import type { CallMeta, Domain, JudgeRequest, LLMRequest, Purpose, Question, Task, Tier } from "../core/types";
import { MARK, NONE_CHOICE, QK } from "../core/types";
import { MockJudge, MockLLM, MockOracle, singleContextAccuracy } from "./mock";

function makeTasks(n: number, domain: Domain = "arithmetic"): Task[] {
  return Array.from({ length: n }, (_, i) => ({ id: `t${i}`, domain, prompt: `What is ${i} + 7?`, answer: String(i + 7) }));
}

const meta = (purpose: Purpose, taskId?: string): CallMeta => ({ runId: "r", purpose, ...(taskId ? { taskId } : {}) });

const llmReq = (purpose: Purpose, user: string, extra: Partial<LLMRequest> = {}): LLMRequest => ({
  messages: [
    { role: "system", content: "You are a careful solver." },
    { role: "user", content: user },
  ],
  meta: meta(purpose, extra.meta?.taskId),
  ...extra,
});

const answerOf = (text: string) => text.slice(text.lastIndexOf(MARK.answer) + MARK.answer.length).trim();

describe("MockOracle", () => {
  it("looks up answers and domains", () => {
    const oracle = new MockOracle(makeTasks(2, "logic"));
    expect(oracle.answer("t1")).toBe("8");
    expect(oracle.domain("t1")).toBe("logic");
    expect(oracle.answer("nope")).toBeUndefined();
  });
});

describe("MockLLM", () => {
  const tasks = makeTasks(400);
  const oracle = new MockOracle(tasks);
  const mk = (seed = 7) => new MockLLM({ oracle, seed, latencyMs: [0, 0] });
  const solve = (llm: MockLLM, t: Task, prompt = t.prompt) => llm.complete(llmReq("solve", prompt, { meta: meta("solve", t.id) }));

  it("is reproducible per seed while retries differ", async () => {
    const a = mk();
    const b = mk();
    const c = mk(8);
    const first: string[] = [];
    const retry: string[] = [];
    const other: string[] = [];
    for (const t of tasks.slice(0, 100)) {
      const ra = (await solve(a, t)).text;
      expect((await solve(b, t)).text).toBe(ra);
      first.push(ra);
      retry.push((await solve(a, t)).text);
      other.push((await solve(c, t)).text);
    }
    expect(retry).not.toEqual(first);
    expect(other).not.toEqual(first);
  });

  it("solves with the configured accuracy and plausible wrong answers", async () => {
    const llm = mk();
    let correct = 0;
    for (const t of tasks) {
      const { text } = await solve(llm, t);
      expect(text).toMatch(/^METHOD: .+\nANSWER: \S+$/);
      const got = answerOf(text);
      if (got === t.answer) correct++;
      else {
        const offset = Number(got) - Number(t.answer);
        expect(offset).not.toBe(0);
        expect(Math.abs(offset)).toBeLessThanOrEqual(9);
      }
    }
    expect(correct / tasks.length).toBeGreaterThan(0.88);
    expect(correct / tasks.length).toBeLessThan(0.97);
  });

  it("answers unknown for non-numeric answers it gets wrong", async () => {
    const words = Array.from({ length: 50 }, (_, i): Task => ({ id: `w${i}`, domain: "logic", prompt: "Who?", answer: "alice" }));
    const llm = new MockLLM({ oracle: new MockOracle(words), seed: 1, latencyMs: [0, 0], accuracy: { logic: 0.5 } });
    const answers = new Set<string>();
    for (const t of words) answers.add(answerOf((await solve(llm, t)).text));
    expect([...answers].sort()).toEqual(["alice", "unknown"]);
  });

  it("gains accuracy from an adopted strategy", async () => {
    const plain = mk();
    const boosted = mk();
    let plainCorrect = 0;
    let boostedCorrect = 0;
    for (const t of tasks) {
      const p = answerOf((await solve(plain, t)).text) === t.answer;
      const b = answerOf((await solve(boosted, t, `${MARK.strategy}\n- check units\n${t.prompt}`)).text) === t.answer;
      if (p) expect(b).toBe(true);
      plainCorrect += Number(p);
      boostedCorrect += Number(b);
    }
    expect(boostedCorrect).toBeGreaterThan(plainCorrect);
  });

  it("copies a teammate's answer about 80% of the time", async () => {
    const llm = mk();
    let copied = 0;
    const sample = tasks.slice(0, 300);
    for (const t of sample) {
      const { text } = await solve(llm, t, `${t.prompt}\n${MARK.teammate} 99999 (their method: guessed)`);
      if (answerOf(text) === "99999") copied++;
    }
    expect(copied / sample.length).toBeGreaterThan(0.72);
    expect(copied / sample.length).toBeLessThan(0.88);
  });

  it("collapses on large single-context batches", async () => {
    const big = makeTasks(160);
    const bigOracle = new MockOracle(big);
    const accuracyAt = async (n: number) => {
      const llm = new MockLLM({ oracle: bigOracle, seed: 3, latencyMs: [0, 0] });
      const lines = big.slice(0, n).map((t) => `${MARK.taskId} ${t.id}: ${t.prompt}`);
      const user = [`Answer every task as: ${MARK.taskId} t0: ${MARK.answer} <value>`, ...lines].join("\n");
      const { text } = await llm.complete(llmReq("single", user));
      const out = text.split("\n");
      expect(out).toHaveLength(n);
      let correct = 0;
      for (const [i, line] of out.entries()) {
        const t = big[i];
        expect(line.startsWith(`${MARK.taskId} ${t?.id}: ${MARK.answer} `)).toBe(true);
        if (answerOf(line) === t?.answer) correct++;
      }
      return correct / n;
    };
    const small = await accuracyAt(32);
    const large = await accuracyAt(128);
    expect(small).toBeGreaterThan(0.8);
    expect(large).toBeLessThan(0.6);
    expect(small - large).toBeGreaterThan(0.25);
    expect(singleContextAccuracy(128)).toBeCloseTo(0.45, 2);
    expect(singleContextAccuracy(160)).toBeCloseTo(0.21, 2);
    expect(singleContextAccuracy(1000)).toBe(0.15);
  });

  it("writes one-line reports and merges them lossily", async () => {
    const llm = mk();
    const sample = tasks.slice(0, 400);
    const reports: string[] = [];
    for (const t of sample) {
      const { text } = await llm.complete(llmReq("report", t.prompt, { meta: meta("report", t.id) }));
      expect(text).toMatch(new RegExp(`^${MARK.taskId} ${t.id} report: .+ ${MARK.answer} \\S+$`));
      reports.push(text);
    }
    const reported = new Map(reports.map((r, i) => [sample[i]?.id, answerOf(r)]));
    const { text } = await llm.complete(llmReq("merge", `Merge these reports:\n${reports.join("\n")}`));
    const lines = text.split("\n");
    expect(lines).toHaveLength(sample.length);
    let kept = 0;
    for (const line of lines) {
      const m = line.match(new RegExp(`^${MARK.taskId} (\\S+): ${MARK.answer} (\\S+)$`));
      expect(m).not.toBeNull();
      if (m && reported.get(m[1]) === m[2]) kept++;
    }
    expect(kept / lines.length).toBeGreaterThan(0.48);
    expect(kept / lines.length).toBeLessThan(0.63);
  });

  it("writes domain strategy genes", async () => {
    const llm = mk();
    expect((await llm.complete(llmReq("gene", `${MARK.domain} rates\nwins: 3`))).text).toMatch(/^Strategy for rates: \S.+/);
    expect((await llm.complete(llmReq("gene", "no domain here"))).text).toMatch(/^Strategy for arithmetic: /);
  });

  it("echoes an answer for coordination purposes and returns {} in JSON mode", async () => {
    const llm = mk();
    expect((await llm.complete(llmReq("verify", `proposal\n${MARK.answer} 42\n${MARK.answer} 7`))).text).toBe(`${MARK.answer} 42`);
    expect((await llm.complete(llmReq("adjudicate", "nothing"))).text).toBe(`${MARK.answer} unknown`);
    expect((await llm.complete(llmReq("claim", `${MARK.answer} 42`, { json: true }))).text).toBe("{}");
  });

  it("meters usage like a Haiku-class model and simulates latency", async () => {
    const llm = mk();
    const r = await llm.complete(llmReq("adopt", "x".repeat(15)));
    const promptChars = "You are a careful solver.".length + 15;
    expect(r.usage.inputTokens).toBe(Math.ceil(promptChars / 4));
    expect(r.usage.outputTokens).toBe(Math.ceil(r.text.length / 4));
    expect(r.usage.costUsd).toBeCloseTo(r.usage.inputTokens * 1e-6 + r.usage.outputTokens * 5e-6, 12);
    expect(r.latencyMs).toBe(0);
    expect(r.model).toBe("mock-llm");
    expect(llm.simulated).toBe(true);

    const slow = await new MockLLM({ oracle, seed: 1 }).complete(llmReq("solve", "q", { meta: meta("solve", "t1") }));
    expect(slow.latencyMs).toBeGreaterThanOrEqual(60);
    expect(slow.latencyMs).toBeLessThanOrEqual(180);
  });
});

describe("MockJudge", () => {
  const tasks = makeTasks(300);
  const oracle = new MockOracle(tasks);
  const mk = (tier: Tier, seed = 11, withOracle = true) =>
    new MockJudge({ tier, seed, latencyMs: [0, 0], ...(withOracle ? { oracle } : {}) });
  const verifyQ: Record<string, Question> = { [QK.verify]: { type: "noul", instructions: "Does this need a re-solve?" } };
  const precedentLines = (k: number) =>
    k === 0 ? "" : `\n${MARK.precedents}\n${Array.from({ length: k }, (_, i) => `- case ${i}: ${MARK.answer} 1 -> 0.9`).join("\n")}`;
  const verifyReq = (t: Task, answer: string, precedents = 0): JudgeRequest => ({
    state: `${MARK.domain} ${t.domain}\n${t.prompt}\n${MARK.answer} ${answer}${precedentLines(precedents)}`,
    questions: verifyQ,
    meta: { runId: "r", purpose: "verify", taskId: t.id, cellId: "c1" },
  });
  const noul = (a: unknown) => (a as { noul: number }).noul;
  const wrongOf = (t: Task) => String(Number(t.answer) + 3);

  it("gives verify probabilities that separate wrong from right answers", async () => {
    for (const tier of ["system1", "system2"] as const) {
      const judge = mk(tier);
      let wrongSum = 0;
      let rightSum = 0;
      for (const t of tasks) {
        wrongSum += noul((await judge.ask(verifyReq(t, wrongOf(t)))).answers[QK.verify]);
        rightSum += noul((await judge.ask(verifyReq(t, t.answer))).answers[QK.verify]);
      }
      expect(wrongSum / tasks.length - rightSum / tasks.length).toBeGreaterThan(0.4);
    }
  });

  it("escalates fewer verify decisions as precedents accumulate", async () => {
    const escalationRate = async (tier: Tier, precedents: number) => {
      const judge = mk(tier);
      let escalated = 0;
      for (const [i, t] of tasks.entries()) {
        const p = noul((await judge.ask(verifyReq(t, i % 2 ? t.answer : wrongOf(t), precedents))).answers[QK.verify]);
        if (Math.abs(2 * p - 1) < 0.5) escalated++;
      }
      return escalated / tasks.length;
    };
    const early = await escalationRate("system1", 0);
    const mid = await escalationRate("system1", 2);
    const late = await escalationRate("system1", 4);
    expect(early).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(early);
    expect(late).toBeLessThan(0.05);
  });

  it("lets System 2 separate wrong from right at the 0.5 verify threshold", async () => {
    const judge = mk("system2");
    for (const t of tasks) {
      expect(noul((await judge.ask(verifyReq(t, wrongOf(t)))).answers[QK.verify])).toBeGreaterThanOrEqual(0.5);
      expect(noul((await judge.ask(verifyReq(t, t.answer))).answers[QK.verify])).toBeLessThan(0.5);
    }
  });

  it("returns an uninformative verify without an oracle or answer", async () => {
    const t = tasks[0] as Task;
    expect((await mk("system1", 1, false).ask(verifyReq(t, "8"))).answers[QK.verify]).toEqual({ type: "noul", noul: 0.35 });
    const noAnswer: JudgeRequest = { ...verifyReq(t, "8"), state: "no proposal yet" };
    expect((await mk("system1").ask(noAnswer)).answers[QK.verify]).toEqual({ type: "noul", noul: 0.35 });
  });

  describe("claim", () => {
    const criteria = {
      t1: `${MARK.domain} arithmetic | What is 3 + 4?`,
      t2: "A rates problem: a train covers 60 km in 1.5 h",
      t3: `${MARK.domain} logic | Who owns the zebra?`,
      [NONE_CHOICE]: "claim nothing this round",
    };
    const claimReq = (state: string, c: Record<string, string> = criteria): JudgeRequest => ({
      state,
      questions: { [QK.claim]: { type: "choice", instructions: "Which task should this cell claim?", criteria: c } },
      meta: { runId: "r", purpose: "claim", cellId: "c1" },
    });
    type Choice = { choice: string; confidence: number; probabilities: Record<string, number> };

    it("picks the domain with the best smoothed success rate", async () => {
      const a = (await mk("system1").ask(claimReq(`${MARK.profile} arithmetic 3/4, rates 0/1, logic 2/2`))).answers[QK.claim] as Choice;
      expect(a.choice).toBe("t3");
      const sum = Object.values(a.probabilities).reduce((x, y) => x + y, 0);
      expect(sum).toBeCloseTo(1, 9);
      expect(Object.keys(a.probabilities).sort()).toEqual(["none", "t1", "t2", "t3"]);
      expect(a.probabilities.t3).toBeCloseTo(a.confidence, 9);

      const b = (await mk("system1").ask(claimReq(`${MARK.profile} arithmetic 1/5, rates 4/4, logic 0/3`))).answers[QK.claim] as Choice;
      expect(b.choice).toBe("t2");
    });

    it("breaks ties with the first key and declines only when nothing else is offered", async () => {
      const tie = (await mk("system1").ask(claimReq("no profile"))).answers[QK.claim] as Choice;
      expect(tie.choice).toBe("t1");
      const onlyNone = (await mk("system1").ask(claimReq("x", { [NONE_CHOICE]: "nothing" }))).answers[QK.claim] as Choice;
      expect(onlyNone).toEqual({ type: "choice", choice: NONE_CHOICE, probabilities: { [NONE_CHOICE]: 1 }, confidence: 1 });
    });

    it("grows System-1 confidence with precedents; System 2 stays near 0.85", async () => {
      const meanConfidence = async (tier: Tier, precedents: number) => {
        const judge = mk(tier);
        let sum = 0;
        for (let i = 0; i < 100; i++) {
          const state = `${MARK.profile} arithmetic ${i % 5}/5${precedentLines(precedents)}`;
          sum += ((await judge.ask(claimReq(state))).answers[QK.claim] as Choice).confidence;
        }
        return sum / 100;
      };
      const early = await meanConfidence("system1", 0);
      const late = await meanConfidence("system1", 4);
      expect(early).toBeGreaterThan(0.5);
      expect(early).toBeLessThan(0.6);
      expect(late).toBeGreaterThan(0.9);
      expect(await meanConfidence("system2", 0)).toBeCloseTo(0.85, 1);
    });
  });

  it("makes System-1 adopt answers surer as precedents accumulate, so adopt escalations fall too", async () => {
    const escalationShare = async (precedents: number) => {
      const judge = mk("system1");
      let escalated = 0;
      for (let i = 0; i < 200; i++) {
        const r = await judge.ask({
          state: `gene ${i}${precedentLines(precedents)}`,
          questions: { [QK.adopt]: { type: "noul", instructions: "Adopt this gene?" } },
          meta: { runId: "r", purpose: "adopt", cellId: `c${i}` },
        });
        const p = noul(r.answers[QK.adopt]);
        expect(p).toBeGreaterThanOrEqual(0.5);
        if (Math.abs(2 * p - 1) < 0.5) escalated++;
      }
      return escalated / 200;
    };
    expect(await escalationShare(0)).toBeGreaterThan(0.6);
    expect(await escalationShare(2)).toBeLessThan(await escalationShare(0));
    expect(await escalationShare(3)).toBeLessThan(0.05);
  });

  it("answers adopt around 0.65 and unknown keys uninformatively", async () => {
    const judge = mk("system2");
    const r = await judge.ask({
      state: "gene: check units",
      questions: {
        [QK.adopt]: { type: "noul", instructions: "Adopt this gene?" },
        other: { type: "noul", instructions: "?" },
        pick: { type: "choice", instructions: "?", criteria: { a: "A", b: "B", c: "C", d: "D" } },
        rate: { type: "score", instructions: "?", criteria: ["low", "mid", "high"] },
      },
      meta: { runId: "r", purpose: "adopt", cellId: "c2" },
    });
    expect(Math.abs(noul(r.answers[QK.adopt]) - 0.65)).toBeLessThanOrEqual(0.05);
    expect(r.answers.other).toEqual({ type: "noul", noul: 0.5 });
    expect(r.answers.pick).toEqual({ type: "choice", choice: "a", probabilities: { a: 0.25, b: 0.25, c: 0.25, d: 0.25 }, confidence: 0.25 });
    expect(r.answers.rate).toEqual({ type: "score", score: 1, confidence: 0.5 });
  });

  it("meters usage per tier and is reproducible", async () => {
    const t = tasks[0] as Task;
    const req = verifyReq(t, "8");
    const s1 = await mk("system1").ask(req);
    const s2 = await mk("system2").ask(req);
    const base = Math.ceil(req.state.length / 4);
    expect(s1.usage).toEqual({ inputTokens: base + 40, outputTokens: 0, costUsd: (base + 40) * 0.042e-6 });
    expect(s2.usage.inputTokens).toBe(base + 150);
    expect(s2.usage.outputTokens).toBe(60);
    expect(s2.usage.costUsd).toBeCloseTo((base + 150) * 1e-6 + 60 * 5e-6, 12);
    expect(s1.model).toBe("mock-judge:system1");
    expect(mk("system2").id).toBe("mock-judge:system2");
    expect((await mk("system1").ask(req)).answers).toEqual(s1.answers);
  });

  it("sleeps within the default System-1 latency range", async () => {
    const r = await new MockJudge({ tier: "system1", seed: 2 }).ask(verifyReq(tasks[0] as Task, "8"));
    expect(r.latencyMs).toBeGreaterThanOrEqual(70);
    expect(r.latencyMs).toBeLessThanOrEqual(300);
  });
});
