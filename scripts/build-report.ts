// Builds web/public/report/swarm-landscape-2026-09-15.md, the site copy of the pre-hackathon research report.
// The source stays untouched; the site copy drops what should not be published: a quote from a private group chat,
// notes about the author's local tools and proxy, and pointers to data files that are not published. It also redraws
// the ASCII decision diagram as Mermaid, since box-drawing art misaligns wherever CJK glyphs are not exactly two cells.
// Every edit must match exactly once, so a changed source fails loudly instead of leaking. Run: pnpm report:build
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_ROOT } from "../src/config";

const SOURCE = process.env.REPORT_SRC ?? join(PROJECT_ROOT, "..", "output", "reports", "手工川-多智能体蜂群协同开源全景与深度调研-2026-09-15-v0.1.md");
const OUT = join(PROJECT_ROOT, "web", "public", "report", "swarm-landscape-2026-09-15.md");

/**
 * Whole lines to replace, keyed by the first 16 hex digits of the SHA-256 of the original line. Hashes, not the text:
 * this repository is public, so the wording being removed must not be spelled out here.
 */
const LINE_EDITS: ReadonlyArray<[string, string]> = [
  ["7d302af1318d6c23", "采用 ultradeep 模式的八阶段流程。检索工具为 WebSearch 与 WebFetch；仓库事实一律通过 GitHub REST API 现场拉取，检索日期统一记为 2026-09-15，不采信文章中的二手 star 数。检索期间 api.github.com 多次超时，统一加最多 5 次重试。"],
  ["bb3daf8de02ccd1d", "最终 67 个来源、134 条证据整理成结构化台账，仓库层面的可复用判断另存一份开源方案清单（原始台账未随网站发布）。"],
  ["11a43fe707aa26e7", "把 token 效率当作一等约束而不是事后优化，这个判断来自赛前讨论形成的共识，也被 Anthropic 的 80% 方差数据佐证[2]；如果评委更看重绝对能力而非效率，本报告的推荐方向需要调整权重。"],
  ["84f1ffd8f0a5ce86", "完整记录共 34 条，含验证状态与风险标注。下表为决策相关的浓缩视图，所有仓库指标为 2026-09-15 通过 GitHub REST API 现场拉取。"],
  ["d87044a98f077b68", "只列会改变决策的主张。"],
  ["628fbf3303d7f585", "以下来源参与三角验证或背景判断：Tran et al. *Multi-Agent Collaboration Mechanisms: A Survey of LLMs*（arXiv:2501.06322）；Yan et al. *Beyond Self-Talk: A Communication-Centric Survey*（arXiv:2502.14321）；Du, P. *Memory for Autonomous LLM Agents*（arXiv:2603.07670）；Kim et al. *Multi-Agent Transactive Memory*（arXiv:2606.19911）；*Hallucination Cascade*（arXiv:2606.07937）；*Agora: Auction-Based Task Allocation*（arXiv:2607.09600）；Zhang et al. *Swarm Skills*（arXiv:2605.10052）；A2A 协议规范与 Agent Discovery 文档（a2a-protocol.org）；AgentNetworkProtocol、AGNTCY、sigma.js、cosmos.gl、OpenJS Foundation 等仓库与项目页。"],
  ["5e4d38df77f96267", "| SCOPE | 从赛事沟通与入选邮件确定决策背景（赛道、时间、队伍、既有资产），锁定五个赛道维度为分析框架 |"],
];

/** The Decision Guide's box-drawing flowchart, node for node, plus its two cross-cutting rules as a list. */
const DIAGRAM = /```\n┌─ Q1[\s\S]*?\n```\n/;
const MERMAID = `\`\`\`mermaid
flowchart TD
  Q1(["Q1 · 你的多个 agent 是否都需要#quot;写#quot;同一份产物（代码/文档/状态）？"])
  Q2(["Q2 · 能否把写操作收敛成单线程？<br/>（一个 writer + N 个顾问）"])
  Q3(["Q3 · 冲突是#quot;结构性#quot;的还是#quot;语义性#quot;的？"])
  Q4(["Q4 · 有没有可自动验证的收敛判据（测试/schema）？"])
  A["终点 A · 放手做并行蜂群<br/>这是 Anthropic 90.2% 增益的适用域，<br/>也是 Cognition 认可的#quot;只贡献智能不贡献动作#quot;模式"]
  B["终点 B · 单写者 + 顾问群<br/>Cognition 2026 的三种可行范式<br/>（评审环/Smart Friend/管理者）"]
  C["终点 C · CRDT / worktree 隔离即可解决<br/>CodeCRDT 实测 100% 收敛、零合并失败"]
  D["终点 D · 黑板架构 + 沙箱验证<br/>高性能 Gene 进主干"]
  E["终点 E · 停：先建评测<br/>没有收敛判据的多 agent 是在赌运气，不是在协同"]
  Q1 -->|是| Q2
  Q1 -->|否（只读调研/评审/咨询）| A
  Q2 -->|能| B
  Q2 -->|不能| Q3
  Q3 -->|结构性| C
  Q3 -->|语义性| Q4
  Q4 -->|有| D
  Q4 -->|没有| E
\`\`\`

横切约束（任何终点都必须满足，否则回到起点）：

- ✗ 无法归因失败到具体 agent 与步骤 → 不可上生产（自动归因当前仅 53.5%/14.2%）
- ✗ 无法度量每 token 协同收益 → 无法证明架构必要性（token 解释 80% 方差）
`;

/** The appendix ends with a tree of local data files; the site says what they hold instead. */
const DATA_SECTION = /### 数据产物\n[\s\S]*$/;
const DATA_TEXT =
  "### 数据产物\n\n报告之外另有五份结构化台账：67 个来源、134 条证据（含原文引用与定位）、34 个开源仓库的验证与风险记录、编排框架的 GitHub 指标快照，以及检索配置与工具回退记录。它们没有随网站发布。\n";

const lineHash = (line: string) => createHash("sha256").update(line).digest("hex").slice(0, 16);

const lines = (await readFile(SOURCE, "utf8")).split("\n");
for (const [hash, to] of LINE_EDITS) {
  const at = lines.flatMap((line, i) => (lineHash(line) === hash ? [i] : []));
  if (at.length !== 1) throw new Error(`expected exactly one line with hash ${hash}, found ${at.length}; the source report changed`);
  lines[at[0] ?? 0] = to;
}
let text = lines.join("\n");
const diagram = DIAGRAM.exec(text)?.[0] ?? "";
for (const line of ["无法归因失败到具体 agent 与步骤 → 不可上生产（自动归因当前仅 53.5%/14.2%）", "无法度量每 token 协同收益 → 无法证明架构必要性（token 解释 80% 方差）"]) {
  if (!diagram.includes(line)) throw new Error(`decision diagram changed; check the Mermaid copy: ${line.slice(0, 20)}`);
}
text = text.replace(DIAGRAM, MERMAID);
if (!DATA_SECTION.test(text)) throw new Error("data-products section not found");
text = text.replace(DATA_SECTION, DATA_TEXT);

for (const banned of ["output/data", "本机", "微信", "/Users/"]) {
  if (text.includes(banned)) throw new Error(`site copy still mentions ${banned}`);
}

await mkdir(join(OUT, ".."), { recursive: true });
await writeFile(OUT, text);
console.log(`wrote ${Math.round(text.length / 1024)} KB: ${LINE_EDITS.length} lines replaced, diagram redrawn, data section summarised`);
