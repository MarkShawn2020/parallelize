import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { EVIDENCE_BOXES, EVIDENCE_FOOTNOTE, EVIDENCE_ROWS, EVIDENCE_TITLE, pct } from "../evidence";
import { PARADIGMS, radarValues } from "../paradigms";
import { ExamBank } from "./ExamBank";
import { ParadigmExplorer } from "./ParadigmExplorer";
import { Race } from "./Race";
import { Radar } from "./Radar";
import { ReplaySwarm } from "./ReplaySwarm";
import { ReportPage } from "./ReportPage";
import { QUICK_START, REPO, STATIC_SITE } from "../site";
import { COMPARE_ROUTE, COMPARE_SECTIONS, PAGES, REPORT_ROUTE, isLandingHref, parseLandingHash, type Page } from "./routes";

interface Props {
  /** A live run is going on the local server right now. */
  liveRunning: boolean;
}

const EVOMAP_ASSET = "https://evomap.ai/asset/sha256:f09e2dd70fd8ad55c1110922f679c80bd59b08ae7f4f26b273746354888e333c";
/** The live dashboard runs on the local server; the public static site sends people to the quick start instead. */
const DEMO = STATIC_SITE ? QUICK_START : "#/live";
const DEMO_TARGET = STATIC_SITE ? { target: "_blank", rel: "noreferrer" } : {};

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

const INDUSTRY: ReadonlyArray<[string, string, string]> = [
  ["2024", "OpenAI Swarm", "Agent + 交接（handoff）的教学框架，后被 Agents SDK 取代：先解决「谁接手」。"],
  ["2025.06", "Anthropic 多 Agent 研究系统", "主 Agent 派子 Agent，比单 Agent 强 90.2%，token 用量约为聊天的 15 倍。"],
  ["2025.06", "Cognition：别做多 Agent", "子 Agent 看不到完整上下文，各自的隐含决定会互相冲突。"],
  ["2026.07", "EvoMap 蜂群实验", "563 题、Haiku 4.5：单上下文 26% → Sub-Agent 38% → EvoX 蜂群 71%；子 Agent 做对的 373 个答案，汇总后只剩 207 个还对。"],
  ["2026.09", "Jev：只判断、不写字", "System 1 模型，发布一周 X 上约 982 条讨论（jev-hub 统计）；主流用法是塞进单个 Agent 当判官。"],
];

const EXAMPLES: ReadonlyArray<[string, string, string]> = [
  [
    "算术 · 第 79 题",
    "Stone Oven bakes 120 loaves a day, each using 420 grams of flour. Corner Loaf bakes 100 loaves a day, each using 50% more flour than one of Stone Oven's loaves. Flour comes only in whole 20-kg sacks at $14 per sack. Corner Loaf sells each loaf for $7. Each loaf bakes for 33 minutes. If the two bakeries place one joint order with just enough whole sacks to cover 14 days of baking, how many dollars does the order cost?",
    "干扰：售价、烘烤时间 · 换算：克 → 千克、整袋向上取整",
  ],
  [
    "比率 · 第 26 题",
    "Elstow and Ashford are 542 km apart by rail. A local train leaves Elstow for Ashford at 7:45 a.m. and runs at a steady 100 km/h. The local train has 7 carriages. A freight train leaves Ashford for Elstow at 9:15 a.m. on the other track and runs at a steady 1600 meters per minute. The freight train is carrying 415 passengers. Neither train stops on the way. How many kilometers from Elstow are the trains when they pass each other?",
    "干扰：车厢数、乘客数 · 换算：米/分钟 → 千米/小时、错峰发车",
  ],
  [
    "逻辑 · 第 30 题",
    "2 years ago, the ages of Noah, Leila and Omar added up to 68. The family moved to their current house 9 years ago. Their grandmother is 80 years old. Noah is four times as old as Omar. Leila is 96 months older than Omar. What will the sum of Noah's and Leila's ages be 9 years from now?",
    "干扰：搬家时间、奶奶年龄 · 换算：96 个月 = 8 岁",
  ],
];

const GHOST: ReadonlyArray<[string, string]> = [
  ["Jev 判断", "只答是/否、选哪个、打几分，约半秒，每万次约 $0.2；从不产出答案"],
  ["大模型兜底", "Jev 调用失败时交给大模型；也可以设一个置信度阈值，把拿不准的判断交回大模型"],
  ["校准守卫", "某一类判断 Jev 和大模型分歧太大，整类自动交还大模型"],
];
const SHELL: ReadonlyArray<[string, string]> = [
  ["黑板 + 租约", "原子领题，谁有空谁领；掉线租约到期自动退回，别人接手"],
  ["能力卡 + 协议", "15 种消息，谁找谁不写死；运行中能加入别的模型的 Agent（目前在同一进程内）"],
  ["谱系 + 独立来源", "每个答案带来源；抄来的一致只算一个出处，防虚假共识"],
  ["Gene + 信誉", "经验在邻居间传递，收不收由 Jev 判断；信誉过低自动隔离"],
];

/** Seed 7, the same 96 hard tasks, 8 cells; only the executor and the judge change. [correct, cost USD, wall s] per judge. */
const JUDGES = ["规则", "Jev", "Haiku 4.5", "Sonnet 5", "Opus 5"] as const;
const JUDGE_MATRIX: ReadonlyArray<[string, ReadonlyArray<readonly [number, number, number]>]> = [
  [
    "Haiku 4.5 做题",
    [
      [81, 0.154, 44],
      [88, 0.323, 124],
      [80, 0.31, 101],
      [90, 0.571, 134],
      [85, 0.731, 152],
    ],
  ],
  [
    "Sonnet 5 做题",
    [
      [89, 0.374, 71],
      [95, 0.749, 159],
      [92, 0.602, 126],
      [93, 0.746, 154],
      [93, 0.836, 123],
    ],
  ],
];

type Status = "已上线" | "开发中" | "规划中";
const STATUS_TONE: Record<Status, string> = { 已上线: "text-accent", 开发中: "text-s2", 规划中: "text-muted" };
const USAGE: ReadonlyArray<[string, string, string, Status]> = [
  ["大屏 Dashboard", "讲解视图给观众看，工程视图看细节；现场注入入侵、回声、掉线、断开 Jev。", "pnpm start  →  http://localhost:8787/#/live", "已上线"],
  ["HTTP API", "启动一轮、实时操控、WebSocket 推送全部事件。", `curl -X POST localhost:8787/api/runs -H 'Content-Type: application/json' -d '{"mode":"swarm-jev","n":96}'`, "已上线"],
  ["命令行 CLI", "一条命令跑完 7 种范式的对照表；换判断模型重跑同一张卷。", "pnpm bench --mode all --n 96 --difficulty hard", "已上线"],
  ["协议 PROTOCOL.md", "15 种消息 + 能力卡；进程内已实现，外部 Agent 联网接入尚未实现。", "ANNOUNCE · CLAIM · PROPOSE · REVIEW_REQUEST · GENE_OFFER …", "已上线"],
  ["判断中间件", "Jev 先判、大模型兜底、校准守卫，打包成一个可以接进任何 Agent 系统的接口。", "new EscalatingJudge({ s1: jev, s2: llm, threshold, guard })", "开发中"],
  ["JIS Skill", "扫描项目里的大模型调用，找出是/否、选择、打分这类判断，估算换成 Jev 能省多少。", "「用 JIS 看看这个项目哪些调用能换成 Jev」", "规划中"],
  ["生态接入", "EvoMap 协议与 EvoX、Claude Code、Codex、DeepSeek Harness：把其中的判断调用接到 Jev。", "gossip · adopt · forget · 合并验证 …", "规划中"],
];

function Section({ id, eyebrow, title, children, lead }: { id: string; eyebrow: string; title: string; lead?: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 border-t border-grid py-16">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-8 px-4">
        <div className="flex flex-col gap-3">
          <span className="font-mono text-sm tracking-widest text-accent">{eyebrow}</span>
          <h2 className="text-3xl font-bold text-fg md:text-4xl">{title}</h2>
          {lead && <p className="max-w-[820px] text-lg leading-relaxed text-fg/75">{lead}</p>}
        </div>
        {children}
      </div>
    </section>
  );
}

function Stat({ value, label, tone = "text-accent", onOpen }: { value: string; label: string; tone?: string; onOpen?: () => void }) {
  const body = (
    <>
      <span className={`font-mono text-4xl font-bold tabular-nums ${tone}`}>{value}</span>
      <span className="text-sm leading-relaxed text-fg/75">{label}</span>
    </>
  );
  if (!onOpen) return <div className="flex flex-col gap-1 border border-grid bg-panel/90 px-5 py-4">{body}</div>;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex flex-col gap-1 border border-accent/60 bg-panel/90 px-5 py-4 text-left transition-colors hover:border-accent hover:bg-panel-2"
    >
      {body}
      <span className="mt-1 text-sm font-semibold text-accent">查看全部题目 →</span>
    </button>
  );
}

const BAR_TONE: Record<string, string> = {
  muted: "bg-muted/60",
  fg: "bg-fg/70",
  dim: "bg-muted/40",
  accent: "bg-accent",
  hatched: "bg-[repeating-linear-gradient(45deg,var(--color-muted)_0_6px,transparent_6px_12px)]",
};

function FrameworkPage() {
  return (
    <>
      <section className="relative overflow-hidden">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-10 px-4 py-20 md:py-28">
          <div className="flex flex-col gap-5">
            <span className="font-mono text-sm tracking-widest text-accent">EvoTavern 4th · SECTION 9 多 Agent 蜂群协作 · P2501 Team</span>
            <h1 className="font-display text-7xl leading-none font-bold tracking-[0.06em] text-fg md:text-8xl">
              <span className="text-accent">JIS</span> · Jev in the Shell
            </h1>
            <p className="max-w-[860px] text-xl leading-relaxed text-fg/85 md:text-2xl">
              把 Agent 系统里的判断从大模型换成 Jev 的框架：要不要复核、收不收经验、两个答案听谁的，交给 Jev；大模型专心解题。8 个 Agent 的蜂群实测：
              <span className="text-accent">每次判断便宜约 27 倍，准确率与大模型判断打平。</span>
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat value="约 27×" label="每次判断的花费：Jev 约 $0.2 / 万次，Haiku 当判断者约 $5.4 / 万次；Jev 一次约半秒（实测）" tone="text-s1" />
            <Stat value="88 · 90 · 85" label="同一批 96 道困难题、Haiku 4.5 做题，只换判断者：Jev 88、Sonnet 5 90、Opus 5 85，配对检验分不出高下" />
            <Stat value="34 : 9" label="两批共 288 题按题配对：只有 JIS 蜂群答对 34 题，只有每题各做各的答对 9 题（p = 0.00017）" />
          </div>
          <div className="flex flex-wrap gap-3">
            <a href={COMPARE_ROUTE} className="bg-accent px-6 py-3 text-lg font-semibold text-bg hover:bg-accent/85">
              看框架对比 →
            </a>
            <a href={DEMO} {...DEMO_TARGET} className="border border-fg/40 px-6 py-3 text-lg text-fg hover:border-fg">
              {STATIC_SITE ? "在本地跑现场演示" : "进入现场演示"}
            </a>
            <a href={REPORT_ROUTE} className="border border-fg/40 px-6 py-3 text-lg text-fg hover:border-fg">
              读研究报告
            </a>
          </div>
        </div>
      </section>

      <Section
        id="overview"
        eyebrow="OVERVIEW"
        title="业内怎么做多 Agent"
        lead="多 Agent 能更强，但更贵、会丢信息、会互相冲突。真正的问题是：什么时候值得协作？协调花多少？坏了怎么办？"
      >
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
          {INDUSTRY.map(([date, title, body]) => (
            <article key={title} className="flex flex-col gap-2 border border-grid bg-panel/90 p-4">
              <span className="font-mono text-sm text-accent">{date}</span>
              <h3 className="text-lg font-semibold text-fg">{title}</h3>
              <p className="text-sm leading-relaxed text-fg/75">{body}</p>
            </article>
          ))}
        </div>
        <a href={REPORT_ROUTE} className="self-start text-base font-semibold text-accent hover:underline">
          67 个来源的完整调研：读研究报告 →
        </a>
      </Section>

      <Section
        id="framework"
        eyebrow="JIS 框架"
        title="Jev in the Shell：壳管协作，魂管判断"
        lead="壳（Shell）是协作规则：领题、租约、合并、隔离都不调用模型。魂（Ghost）是判断层，默认装 Jev。做题的 Agent 可以是不同模型，说同一套协议就能进同一个壳。"
      >
        {[
          ["GHOST", "魂 · 判断层", GHOST, "border-s1", "text-s1", "lg:grid-cols-[180px_repeat(3,minmax(0,1fr))]"],
          ["SHELL", "壳 · 协作层（规则）", SHELL, "border-accent", "text-accent", "lg:grid-cols-[180px_repeat(4,minmax(0,1fr))]"],
        ].map(([name, sub, items, border, text, cols]) => (
          <div key={name as string} className={`grid gap-3 border-2 ${border as string} bg-panel/90 p-5 ${cols as string}`}>
            <div className="flex flex-col justify-center gap-1">
              <span className={`font-display text-5xl font-bold ${text as string}`}>{name as string}</span>
              <span className="text-sm text-fg/75">{sub as string}</span>
            </div>
            {(items as ReadonlyArray<[string, string]>).map(([t, b]) => (
              <div key={t} className="flex flex-col gap-1 border border-grid bg-bg p-4">
                <span className={`text-base font-semibold ${text as string}`}>{t}</span>
                <span className="text-sm leading-relaxed text-fg/75">{b}</span>
              </div>
            ))}
          </div>
        ))}
      </Section>

      <Section
        id="replay"
        eyebrow="看得见的蜂群"
        title="每个 Agent 在干什么、彼此传了什么"
        lead="下面是主对照里 JIS 蜂群那一轮（Jev 与大模型混合判断）的真实事件流回放：节点下写着它此刻在做什么，外圈闪青色是 Jev 在判断、琥珀色是交给了大模型，紫色光点是经验在邻居间传。"
      >
        <ReplaySwarm />
      </Section>

      <Section
        id="judges"
        eyebrow="只换判断者"
        title="判断换成 Jev，准确率没有掉"
        lead="同一个 8 Agent 蜂群、同一批 96 道困难题，只换两样：谁做题，谁判断。10 格是 10 次真实运行。"
      >
        <div className="overflow-x-auto border border-grid bg-panel/90 p-5">
          <div className="grid min-w-[520px] grid-cols-[80px_repeat(5,minmax(0,1fr))] gap-2 md:min-w-[760px] md:grid-cols-[150px_repeat(5,minmax(0,1fr))]">
            <span className="self-end text-sm text-muted">做题 \ 判断</span>
            {JUDGES.map((j) => (
              <span key={j} className={`text-center text-sm font-semibold ${j === "Jev" ? "text-s1" : "text-fg/85"}`}>
                {j}
              </span>
            ))}
            {JUDGE_MATRIX.map(([row, cells]) => (
              <div key={row} className="contents">
                <span className="self-center text-base font-semibold text-fg">{row}</span>
                {cells.map(([correct, usd, wall], i) => (
                  <div
                    key={JUDGES[i]}
                    className={`flex flex-col items-center gap-0.5 border px-2 py-3 ${JUDGES[i] === "Jev" ? "border-s1 bg-s1/10" : "border-grid bg-bg"}`}
                  >
                    <span className={`font-mono text-3xl font-bold tabular-nums ${JUDGES[i] === "Jev" ? "text-s1" : "text-fg"}`}>{correct}</span>
                    <span className="font-mono text-xs text-muted tabular-nums">${usd.toFixed(2)}</span>
                    <span className="font-mono text-xs text-muted tabular-nums">{wall} 秒</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
        <ul className="flex flex-col gap-1.5 text-sm leading-relaxed text-fg/80">
          <li>配对检验：两种做题模型下，Jev 与 Sonnet 5、Opus 5 判断都分不出高下；Haiku 做题时，Jev 比 Haiku 自己判多对 8 题（10 : 2，p = 0.039，单次运行、未做多重比较校正）。</li>
          <li>Jev 判断一轮约 $0.003；Haiku 做题时整轮 $0.32，Sonnet 5 判断 $0.57。换 Sonnet 5 做题后，做题本身变贵，两者整轮花费持平。</li>
          <li>分数来自更多独立复核：判断便宜，蜂群就对更多答案再做一遍（Haiku 做题时复核 108 次，Sonnet 5 判断时 48 次）。</li>
        </ul>
        <p className="text-xs text-muted">seed 7 · 每格一次真实运行（2026-09-23/24）· 答对题数 / 96 · 原始记录在仓库 runs/</p>
      </Section>

      <Section id="usage" eyebrow="怎么用" title="现在能用的，和接下来要接的">
        <div className="flex flex-col gap-3">
          {USAGE.map(([title, body, code, status]) => (
            <div key={title} className="grid items-center gap-3 border border-grid bg-panel/90 p-4 md:grid-cols-[200px_minmax(0,1fr)_minmax(0,1.2fr)_80px]">
              <span className="text-lg font-semibold text-fg">{title}</span>
              <span className="text-sm leading-relaxed text-fg/75">{body}</span>
              <code className="overflow-x-auto bg-bg px-3 py-2 font-mono text-xs whitespace-nowrap text-s1">{code}</code>
              <span className={`text-center text-sm ${STATUS_TONE[status]}`}>{status}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section
        id="value"
        eyebrow="经济价值"
        title="把判断变便宜，复核才划算"
        lead="Agent 系统里有大量判断：这条经验收不收、两个答案算不算真分歧、要不要再复核。交给大模型，每次都按大模型计费；交给 Jev，约半秒、几乎不花钱，省下的钱可以多复核一轮。"
      >
        <div className="grid gap-3 md:grid-cols-3">
          <Stat value="$5.4 → $0.2" label="每 1 万次判断：Haiku 当判断者 → Jev（主对照实测，约 27 倍）" tone="text-s1" />
          <Stat value="$0.32 对 $0.57" label="Haiku 做题时，判断交给 Jev 与交给 Sonnet 5 准确率打平（88 对 90，p = 0.69），整轮便宜 43%" />
          <Stat value="0 token" label="领题、租约、合并、回声检测、隔离全是规则，不调用模型" tone="text-fg" />
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {[
            ["判断密集的批处理", "客服分单、内容审核、批量评测：每一条都要回答「是不是、选哪个」。"],
            ["需要留痕的结论", "点子验证、尽调、研究：每条论断报独立来源数，混入金丝雀防被带偏。"],
            ["先选型，再上蜂群", "不是每件事都值得上蜂群：框架对比页的七种范式就是一张选型表。"],
          ].map(([t, b]) => (
            <article key={t} className="flex flex-col gap-2 border border-grid bg-panel/90 p-5">
              <h3 className="text-lg font-semibold text-fg">{t}</h3>
              <p className="text-sm leading-relaxed text-fg/75">{b}</p>
            </article>
          ))}
        </div>
      </Section>
    </>
  );
}

function ComparePage({ onRaceReady, onOpenBank }: { onRaceReady: () => void; onOpenBank: () => void }) {
  return (
    <>
      <section className="border-b border-grid">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-4 px-4 pt-14 pb-8 md:pt-20">
          <span className="font-mono text-sm tracking-widest text-accent">框架对比 · 同一张考卷、同一个做题模型</span>
          <h1 className="text-4xl leading-tight font-bold text-fg md:text-5xl">单 Agent、规则 / LLM 蜂群、JIS 蜂群，同时做 96 道题</h1>
          <p className="max-w-[860px] text-lg leading-relaxed text-fg/80">
            三种方式考同一张卷、用同一个做题模型 Haiku 4.5，只换协作方式。下面先是三种方式各自交卷后的结果：每个格子是一道题，绿色答对、红色答错。点「重跑一遍」，看三条车道同时从头做题：青色是 Jev
            在判断，琥珀色是交给了大模型。
          </p>
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {COMPARE_SECTIONS.map(([id, label]) => (
              <a key={id} href={`${COMPARE_ROUTE}/${id}`} className="text-fg/75 hover:text-accent">
                {label} ↓
              </a>
            ))}
          </div>
        </div>
      </section>
      <div className="mx-auto max-w-[1200px] px-4 py-10">
        <Race onReady={onRaceReady} />
      </div>

      <Section
        id="exam"
        eyebrow="同一张考卷"
        title="测试题目与模型"
        lead="所有范式考同一张卷，只换协作方式。题目按随机种子合成，答案唯一且精确，能自动判分。"
      >
        <div className="grid gap-3 md:grid-cols-3">
          <Stat
            value="96 道"
            label="困难档合成数学题：6–9 步推理，混入无关条件，至少一次单位、比率或百分比换算；算术 / 比率 / 逻辑各 32 道"
            tone="text-fg"
            onOpen={() => onOpenBank()}
          />
          <Stat value="Haiku 4.5" label="做题模型：Claude Haiku 4.5，与 EvoMap 蜂群实验同款" tone="text-fg" />
          <Stat value="Jev 1.13" label="判断模型：typesafe/jev-1.13（经 OpenRouter）；这一轮里一部分判断交回 Haiku" tone="text-s1" />
        </div>
        <div className="grid gap-3 lg:grid-cols-3">
          {EXAMPLES.map(([title, prompt, note]) => (
            <article key={title} className="flex flex-col gap-3 border border-grid bg-panel/90 p-5">
              <span className="font-mono text-sm text-accent">{title}</span>
              <p className="font-mono text-sm leading-relaxed text-fg/90">{prompt}</p>
              <p className="mt-auto text-sm text-s2">{note}</p>
            </article>
          ))}
        </div>
        <button
          type="button"
          onClick={() => onOpenBank()}
          className="self-start border border-accent bg-accent/10 px-5 py-2.5 font-semibold text-accent hover:bg-accent hover:text-bg"
        >
          查看全部 96 道题，以及每种范式各答了什么 →
        </button>
      </Section>

      <Section
        id="paradigms"
        eyebrow="七种范式 · 怎么切换、怎么对比"
        title="从单 Agent 一步步演化到 JIS 蜂群"
        lead="每一讲只多加一样东西。点左边切换范式，右边选一个对比对象：雷达上叠出两种范式各自的长短。"
      >
        <ParadigmExplorer />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {PARADIGMS.map((p) => (
            <div key={p.runId} className={`flex flex-col items-center gap-2 border bg-panel/90 p-3 ${p.tone === "accent" ? "border-accent" : "border-grid"}`}>
              <Radar
                series={[
                  {
                    label: p.name,
                    values: radarValues(p),
                    stroke: p.tone === "accent" ? "stroke-accent" : p.tone === "s2" ? "stroke-s2" : p.tone === "fg" ? "stroke-fg" : "stroke-muted",
                    fill: p.tone === "accent" ? "fill-accent/25" : p.tone === "s2" ? "fill-s2/20" : p.tone === "fg" ? "fill-fg/20" : "fill-muted/25",
                  },
                ]}
                size={110}
                labels={false}
              />
              <span className="text-center text-sm text-fg">
                {p.lecture} · {p.name}
              </span>
            </div>
          ))}
        </div>
        <p className="text-sm text-muted">小雷达三个角：上准确率 · 右下成本 · 左下速度，越往外越准、越省、越快。没有全能冠军，只有该用谁。</p>
      </Section>

      <Section id="data" eyebrow="数据报告" title={EVIDENCE_TITLE} lead="准确率不是越往上越高：单 Agent 投票最准但最贵；能站住的结论是蜂群胜过个体之和。">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <div className="flex flex-col gap-3 border border-grid bg-panel/90 p-5">
            {EVIDENCE_ROWS.map((r) => (
              <div key={r.runId} className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)_56px] items-center gap-3" title={r.runId}>
                <span className={`text-sm ${r.style === "accent" ? "font-semibold text-accent" : "text-fg/85"}`}>
                  {r.label}
                  {r.badge && <span className="ml-2 bg-accent px-1.5 text-xs text-bg">{r.badge}</span>}
                </span>
                <div className="flex flex-col gap-1">
                  <div className="h-4 bg-grid">
                    <div className={`h-full ${BAR_TONE[r.style] ?? "bg-muted"}`} style={{ width: `${pct(r)}%` }} />
                  </div>
                  <span className="font-mono text-xs text-muted tabular-nums">
                    {r.correct}/{r.total} · ${r.costUsd.toFixed(2)} · {Math.round(r.wallS)} 秒{r.note ? ` · ${r.note}` : ""}
                  </span>
                </div>
                <span className={`text-right font-mono text-xl font-bold tabular-nums ${r.style === "accent" ? "text-accent" : "text-fg"}`}>{pct(r)}%</span>
              </div>
            ))}
            <p className="text-xs text-muted">{EVIDENCE_FOOTNOTE}</p>
          </div>
          <div className="flex flex-col gap-3">
            {EVIDENCE_BOXES.map((b) => (
              <article key={b.title} className="flex flex-col gap-2 border border-grid bg-panel/90 p-5">
                <h3 className="flex items-center justify-between text-lg font-semibold text-fg">
                  {b.title}
                  {b.tag && <span className="border border-grid px-2 text-xs font-normal text-muted">{b.tag}</span>}
                </h3>
                <ul className="flex flex-col gap-1.5 text-sm leading-relaxed text-fg/80">
                  {b.lines.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </div>
      </Section>
    </>
  );
}

export function Landing({ liveRunning }: Props) {
  const { page, section } = parseLandingHash(useHash());
  const [bankOpen, setBankOpen] = useState(false);

  const lastPage = useRef<Page | null>(null);
  const sectionRef = useRef(section);
  sectionRef.current = section;

  // Land at the top of a new page, or on the section a link asked for. Leaving a section within a page (Back) keeps the
  // browser's restored position; the report scrolls itself once loaded.
  useEffect(() => {
    const entering = lastPage.current !== page;
    lastPage.current = page;
    if (page === "report") return;
    if (section) document.getElementById(section)?.scrollIntoView({ block: "start" });
    else if (entering) window.scrollTo({ top: 0 });
  }, [page, section]);

  // A link to where the reader already is (the logo, the current tab, a citation clicked twice) fires no hashchange;
  // scroll for it by hand.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const href = (e.target as Element | null)?.closest?.("a[href^='#']")?.getAttribute("href");
      if (!href || !isLandingHref(href)) return;
      const next = parseLandingHash(href);
      const now = parseLandingHash(window.location.hash);
      if (next.page !== now.page || next.section !== now.section) return;
      e.preventDefault();
      if (next.section) document.getElementById(next.section)?.scrollIntoView({ block: "start" });
      else window.scrollTo({ top: 0 });
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  // Once the race board is in, a deep link to a compare section lands again (Safari has no scroll anchoring).
  const raceReady = useCallback(() => {
    const target = sectionRef.current;
    if (target) document.getElementById(target)?.scrollIntoView({ block: "start" });
  }, []);

  const openBank = useCallback(() => setBankOpen(true), []);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-grid bg-bg/90 backdrop-blur">
        <nav className="mx-auto flex max-w-[1200px] items-center gap-3 px-4 py-3 sm:gap-6" aria-label="网站导航">
          <a href="#/" className="flex shrink-0 items-baseline gap-2 font-display text-2xl font-semibold tracking-[0.12em]">
            <span className="text-accent">JIS</span>
            <span className="hidden text-fg xl:inline">Jev in the Shell</span>
          </a>
          <div className="flex items-center gap-1 sm:gap-2">
            {PAGES.map(([p, href, label]) => (
              <a
                key={p}
                href={href}
                aria-current={page === p ? "page" : undefined}
                className={`border-b-2 px-2 py-1 text-sm whitespace-nowrap sm:px-3 sm:text-base ${
                  page === p ? "border-accent font-semibold text-accent" : "border-transparent text-fg/75 hover:text-fg"
                }`}
              >
                {label}
              </a>
            ))}
          </div>
          <span className="flex-1" />
          <a href={REPO} className="hidden text-sm text-fg/75 hover:text-fg md:inline">
            GitHub
          </a>
          <a
            href={DEMO}
            {...DEMO_TARGET}
            className="hidden border border-accent bg-accent/10 px-4 py-1.5 text-sm font-semibold whitespace-nowrap text-accent hover:bg-accent hover:text-bg sm:inline-block"
          >
            {STATIC_SITE ? "本地跑现场演示 →" : liveRunning ? "现场正在跑 →" : "现场演示 →"}
          </a>
        </nav>
      </header>

      <main id="top">
        {page === "framework" && <FrameworkPage />}
        {page === "compare" && <ComparePage onRaceReady={raceReady} onOpenBank={openBank} />}
        {page === "report" && <ReportPage section={section} />}
      </main>

      {bankOpen && <ExamBank onClose={() => setBankOpen(false)} />}

      <footer className="border-t border-grid py-10">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-8 gap-y-4 px-4">
          <img src="/brand/shougongchuan-logo-white.png" alt="手工川" className="h-9 w-auto" />
          <span className="text-sm text-fg/75">P2501 Team · 手工川 · Lovstudio.AI · EvoTavern 4th</span>
          <span className="flex-1" />
          <a href={REPO} className="text-sm text-fg/75 hover:text-fg">
            GitHub
          </a>
          <a href={EVOMAP_ASSET} className="text-sm text-fg/75 hover:text-fg">
            EvoMap 已发布 Gene
          </a>
          <a href={DEMO} {...DEMO_TARGET} className="text-sm text-accent hover:underline">
            {STATIC_SITE ? "本地跑现场演示" : "现场演示"}
          </a>
        </div>
      </footer>
    </div>
  );
}
