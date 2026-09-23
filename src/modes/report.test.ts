import { describe, expect, it } from "vitest";
import type { Proposal, Task, TaskEntry } from "../core/types";
import { normalizeAnswer } from "../tasks/check";
import { researchPrompt } from "../tasks/research";
import { buildResearchReport, entriesFromAnswers, reportMarkdown } from "./report";

type Spec = { claim: string; canary?: "supported" | "refuted"; accepted?: string; proposals?: string[]; sources?: number };

function world(specs: Spec[]): { tasks: Task[]; entries: TaskEntry[] } {
  const tasks = specs.map((s, i): Task => ({
    id: `r${String(i + 1).padStart(2, "0")}`,
    domain: "research",
    prompt: researchPrompt(s.claim),
    answer: s.canary ?? "",
  }));
  const entries = specs.map((s, i): TaskEntry => {
    const { answer: _truth, ...task } = tasks[i] as Task;
    const proposals = (s.proposals ?? []).map((answer, j): Proposal => ({ id: `p${i}-${j}`, taskId: task.id, cellId: `c${j}`, answer, summary: "", at: j }));
    return {
      task,
      status: s.accepted === undefined ? "failed" : "accepted",
      attempts: proposals.length,
      proposals,
      proposers: proposals.map((p) => p.cellId),
      ...(s.accepted === undefined ? {} : { acceptedAnswer: s.accepted, independentSources: s.sources ?? 2 }),
    };
  });
  return { tasks, entries };
}

const report = (specs: Spec[]) => buildResearchReport({ idea: "A pet vet app", ...world(specs), normalize: normalizeAnswer });
const canaries = (n: number): Spec[] =>
  Array.from({ length: n }, (_, i) => {
    const truth = i % 2 === 0 ? "supported" : "refuted";
    return { claim: `canary ${i}`, canary: truth, accepted: truth };
  });
const ideas = (verdicts: Array<string | undefined>): Spec[] =>
  verdicts.map((v, i) => ({ claim: `claim ${i}`, ...(v === undefined ? {} : { accepted: v }) }));

describe("buildResearchReport: per-claim results", () => {
  it("strips the prompt boilerplate, normalises verdicts and counts dissent", () => {
    const r = report([
      { claim: "Pet owners pay for tele-vet", accepted: "Supported.", proposals: ["supported", "支持", "refuted"], sources: 2 },
      { claim: "水在标准大气压下100摄氏度沸腾", canary: "supported", accepted: "支持", proposals: ["支持"], sources: 1 },
      { claim: "No prior art", proposals: ["supported", "refuted", "refuted", "uncertain"] },
      { claim: "Odd answer", accepted: "42", proposals: ["42"] },
    ]);
    expect(r.claims).toEqual([
      { taskId: "r01", claim: "Pet owners pay for tele-vet", verdict: "supported", independentSources: 2, proposals: 3, dissent: 1 },
      { taskId: "r02", claim: "水在标准大气压下100摄氏度沸腾", canary: "supported", verdict: "supported", independentSources: 1, proposals: 1, dissent: 0 },
      { taskId: "r03", claim: "No prior art", verdict: "unresolved", independentSources: 0, proposals: 4, dissent: 2 },
      { taskId: "r04", claim: "Odd answer", verdict: "unresolved", independentSources: 2, proposals: 1, dissent: 0 },
    ]);
    expect(r).toMatchObject({ idea: "A pet vet app", canaryPassed: 1, canaryTotal: 1 });
  });

  it("treats a task with no entry as unresolved", () => {
    const { tasks } = world([{ claim: "lonely" }]);
    const r = buildResearchReport({ idea: "x", tasks, entries: [], normalize: normalizeAnswer });
    expect(r.claims[0]).toMatchObject({ verdict: "unresolved", proposals: 0, dissent: 0, independentSources: 0 });
  });
});

describe("buildResearchReport: recommendation rules", () => {
  it("is inconclusive when any canary is wrong or unresolved", () => {
    const wrong = report([...ideas(["supported", "supported"]), { claim: "sun", canary: "refuted", accepted: "supported" }, ...canaries(1)]);
    expect(wrong.recommendation).toBe("inconclusive");
    expect(wrong.rule).toBe("金丝雀 1/2 判对 → 金丝雀论断未全部判对，结论不可信");
    const unresolved = report([...ideas(["supported"]), { claim: "sun", canary: "refuted" }]);
    expect(unresolved.rule).toBe("金丝雀 0/1 判对 → 金丝雀论断未全部判对，结论不可信");
    expect(unresolved.canaryPassed).toBe(0);
  });

  it("continues when support is at least 60% and refutation under 25%", () => {
    const r = report([...canaries(4), ...ideas(["supported", "supported", "refuted", "supported", "uncertain", "supported"])]);
    expect(r.recommendation).toBe("continue");
    expect(r.rule).toBe("金丝雀 4/4 判对；论断 6 条：支持 4、反驳 1、不确定 1 → 支持占比 67% ≥ 60% 且反驳 17% < 25% → 建议继续");
  });

  it("abandons when refutation reaches 40%, even with 60% support", () => {
    const r = report([...canaries(2), ...ideas(["supported", "refuted", "supported", "refuted", "supported"])]);
    expect(r.recommendation).toBe("abandon");
    expect(r.rule).toBe("金丝雀 2/2 判对；论断 5 条：支持 3、反驳 2、不确定 0 → 反驳占比 40% ≥ 40% → 建议放弃");
  });

  it("is inconclusive with enough support but too much refutation", () => {
    const r = report([...canaries(2), ...ideas(["supported", "supported", "supported", "supported", "supported", "refuted", "refuted", "uncertain"])]);
    expect(r.recommendation).toBe("inconclusive");
    expect(r.rule).toBe(
      "金丝雀 2/2 判对；论断 8 条：支持 5、反驳 2、不确定 1 → 支持占比 63% ≥ 60% 但反驳 25% ≥ 25%，且反驳未达放弃线 40% → 结论待定",
    );
  });

  it("is inconclusive with weak support, counting unresolved claims against it", () => {
    const r = report([...canaries(2), ...ideas(["supported", "supported", "refuted", undefined])]);
    expect(r.recommendation).toBe("inconclusive");
    expect(r.rule).toBe("金丝雀 2/2 判对；论断 4 条：支持 2、反驳 1、不确定 0、未决 1 → 支持占比 50% < 60% 且反驳 25% < 40% → 结论待定");
  });

  it("never prints a share below a threshold as reaching it", () => {
    const verdicts = [...Array<string>(25).fill("supported"), ...Array<string>(17).fill("uncertain")];
    const r = report(ideas(verdicts));
    expect(r.recommendation).toBe("inconclusive");
    expect(r.rule).toBe("未设金丝雀；论断 42 条：支持 25、反驳 0、不确定 17 → 支持占比 59.5% < 60% 且反驳 0% < 40% → 结论待定");
  });

  it("is inconclusive when only canaries exist", () => {
    const r = report(canaries(2));
    expect(r.recommendation).toBe("inconclusive");
    expect(r.rule).toBe("金丝雀 2/2 判对；论断 0 条 → 无可评估的论断，结论待定");
  });
});

describe("entriesFromAnswers", () => {
  it("synthesises accepted and failed entries for modes without a blackboard", () => {
    const { tasks } = world([{ claim: "a" }, { claim: "b" }]);
    const entries = entriesFromAnswers(tasks, new Map([["r01", "supported"]]));
    expect(entries[0]).toMatchObject({ status: "accepted", acceptedAnswer: "supported", independentSources: 1, proposals: [] });
    expect(entries[0]?.task).toEqual({ id: "r01", domain: "research", prompt: researchPrompt("a") });
    expect(entries[1]).toMatchObject({ status: "failed", proposals: [] });
    expect(entries[1]?.acceptedAnswer).toBeUndefined();
    const r = buildResearchReport({ idea: "x", tasks, entries, normalize: normalizeAnswer });
    expect(r.claims.map((c) => c.verdict)).toEqual(["supported", "unresolved"]);
  });
});

describe("reportMarkdown", () => {
  it("renders the recommendation, rule and one escaped row per claim", () => {
    const r = report([
      { claim: "sun | moon", canary: "refuted", accepted: "refuted", proposals: ["refuted"] },
      { claim: "water", canary: "supported", accepted: "refuted" },
      ...ideas(["supported"]),
    ]);
    const md = reportMarkdown(r);
    expect(md).toContain("# 研究报告");
    expect(md).toContain("**想法**：A pet vet app");
    expect(md).toContain("**建议**：待定（inconclusive）");
    expect(md).toContain(`**依据**：${r.rule}`);
    expect(md).toContain("**金丝雀**：1/2 判对");
    expect(md).toContain("| r01 | sun \\| moon | 金丝雀（真值：反驳） | 反驳（判对） | 2 | 1 | 0 |");
    expect(md).toContain("| r02 | water | 金丝雀（真值：支持） | 反驳（判错） | 2 | 0 | 0 |");
    expect(md).toContain("| r03 | claim 0 | 论断 | 支持 | 2 | 0 | 0 |");
    expect(md.split("\n").filter((l) => l.startsWith("| r"))).toHaveLength(3);
  });
});
