import { useEffect, useState } from "react";

/** Executor x judge matrix, built by `pnpm matrix --seeds … --json web/public/matrix/judge-matrix.json`. */
interface MatrixCell {
  executor: string;
  judge: string;
  runIds: string[];
  correct: number;
  n: number;
  /** Means per 96-task run. */
  costUsd: number;
  wallS: number;
  judgeCalls: number;
  judgeUsd: number;
  /** Executor calls per run: solving (first attempts and review re-solves) and gene writing. */
  solveCalls: number;
  geneCalls: number;
}

interface MatrixTest {
  executor: string;
  a: string;
  b: string;
  onlyA: number;
  onlyB: number;
  p: number;
  /** Holm-corrected within the executor row; "significant" means pHolm < 0.05. */
  pHolm: number;
}

interface MatrixData {
  seeds: number[];
  tasksPerRun: number;
  judges: string[];
  executors: string[];
  cells: MatrixCell[];
  tests: MatrixTest[];
}

const pct = (c: MatrixCell) => Math.round((c.correct / c.n) * 1000) / 10;
const usd = (x: number) => (x === 0 ? "$0" : x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`);
const fmtP = (p: number) => (p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(p < 0.1 ? 3 : 2)}`);
const range = (xs: number[]) => {
  const lo = usd(Math.min(...xs));
  const hi = usd(Math.max(...xs));
  return lo === hi ? lo : `${lo}–${hi}`;
};
const ascii = /[\x00-\x7f]/;
/** A Chinese lead word plus a list, with a space only where Latin text meets Chinese. */
const lead = (word: string, names: string[], after = "") => {
  const text = names.join("、");
  const before = ascii.test(text[0] ?? "") ? " " : "";
  const tail = after && ascii.test(text.at(-1) ?? "") ? " " : "";
  return `${word}${before}${text}${tail}${after}`;
};

function useMatrix(): MatrixData | null | "error" {
  const [data, setData] = useState<MatrixData | null | "error">(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/matrix/judge-matrix.json")
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<MatrixData>;
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setData("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return data;
}

/** One sentence per executor row: where Jev is significantly ahead or behind, and where the gap is noise. */
function rowFinding(data: MatrixData, executor: string): string | null {
  const jev = data.cells.find((c) => c.executor === executor && c.judge === "Jev");
  if (!jev) return null;
  const tests = data.tests.filter((t) => t.executor === executor);
  const ahead = tests.filter((t) => t.pHolm < 0.05 && t.onlyA > t.onlyB).map((t) => `${t.b}（${t.onlyA}:${t.onlyB}，校正后 ${fmtP(t.pHolm)}）`);
  const behind = tests.filter((t) => t.pHolm < 0.05 && t.onlyA < t.onlyB).map((t) => `${t.b}（${t.onlyA}:${t.onlyB}，校正后 ${fmtP(t.pHolm)}）`);
  const ties = tests.filter((t) => t.pHolm >= 0.05).map((t) => t.b);
  const parts = [`${executor} 做题：Jev 判断答对 ${jev.correct}/${jev.n}（${pct(jev)}%）`];
  if (ahead.length) parts.push(lead("显著好于", ahead));
  if (behind.length) parts.push(lead("显著不如", behind));
  if (ties.length) parts.push(lead("和", ties, "的差距不显著"));
  return `${parts.join("；")}。`;
}

export function JudgeMatrix() {
  const data = useMatrix();
  if (data === "error") return <p className="border border-grid bg-panel p-6 text-fg/80">矩阵数据没有加载成功，刷新页面再试。</p>;
  if (!data) return <p className="border border-grid bg-panel p-6 text-muted">加载矩阵数据…</p>;

  const cell = (executor: string, judge: string) => data.cells.find((c) => c.executor === executor && c.judge === judge);
  const judgeCost = (judge: string) => range(data.cells.filter((c) => c.judge === judge).map((c) => c.judgeUsd));
  // Against the strongest LLM judge that ran in every row: how much more the executor did under Jev.
  const vs = data.executors.flatMap((ex) => {
    const jev = cell(ex, "Jev");
    const llm = cell(ex, "Sonnet 5");
    return jev && llm ? [{ ex, jev, llm }] : [];
  });
  const spread = (xs: number[], f: (x: number) => string) => {
    const lo = f(Math.min(...xs));
    const hi = f(Math.max(...xs));
    return lo === hi ? lo : `${lo}–${hi}`;
  };
  const moreSolves = spread(vs.map((v) => v.jev.solveCalls / v.llm.solveCalls - 1), (x) => `${Math.round(x * 100)}%`);
  const moreGenes = spread(vs.map((v) => v.jev.geneCalls / v.llm.geneCalls), (x) => x.toFixed(1));
  const runs = data.seeds.length;

  return (
    <div className="flex flex-col gap-5">
      <div className="overflow-x-auto border border-grid bg-panel/90">
        <table className="w-full min-w-[880px] border-collapse text-left">
          <thead>
            <tr className="border-b border-grid">
              <th className="px-4 py-3 text-sm font-normal text-muted">执行者 \ 判断者</th>
              {data.judges.map((j) => (
                <th key={j} className={`px-4 py-3 text-base font-semibold ${j === "Jev" ? "bg-accent/10 text-accent" : "text-fg"}`}>
                  {j}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.executors.map((ex) => {
              const best = Math.max(...data.judges.map((j) => cell(ex, j)?.correct ?? 0));
              return (
                <tr key={ex} className="border-b border-grid last:border-b-0">
                  <th className="px-4 py-4 align-top">
                    <span className="block text-lg font-semibold text-fg">{ex}</span>
                    <span className="text-xs font-normal text-muted">做题 · 写经验</span>
                  </th>
                  {data.judges.map((j) => {
                    const c = cell(ex, j);
                    if (!c) {
                      return (
                        <td key={j} className="px-4 py-4 text-muted">
                          —
                        </td>
                      );
                    }
                    const top = c.correct === best;
                    return (
                      <td key={j} className={`px-4 py-4 align-top ${j === "Jev" ? "bg-accent/10" : ""}`}>
                        <span className={`block font-mono text-2xl font-bold tabular-nums ${top ? "text-accent" : "text-fg"}`}>
                          {pct(c)}%{top && <span className="ml-2 align-middle text-xs font-normal">本行最高</span>}
                        </span>
                        <span className="block font-mono text-sm text-fg/80 tabular-nums">
                          {c.correct}/{c.n}
                        </span>
                        <span className="block font-mono text-xs text-muted tabular-nums">
                          {usd(c.costUsd)} · {Math.round(c.wallS)} 秒
                        </span>
                        <span className={`block font-mono text-xs tabular-nums ${j === "Jev" ? "text-s1" : j === "规则" ? "text-muted" : "text-s2"}`}>
                          判断 {usd(c.judgeUsd)}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ul className="flex flex-col gap-2 text-base leading-relaxed text-fg/85">
        {data.executors.map((ex) => {
          const line = rowFinding(data, ex);
          return line ? (
            <li key={ex} className="border-l-2 border-accent/60 pl-3">
              {line}
            </li>
          ) : null;
        })}
        <li className="border-l-2 border-accent/60 pl-3">
          每轮判断花费：Jev {judgeCost("Jev")}；
          {data.judges
            .filter((j) => j !== "Jev" && j !== "规则")
            .map((j) => `${j} ${judgeCost(j)}`)
            .join("；")}
          。规则不花钱，但写不出「这条经验收不收」「算不算真分歧」这类判断。
        </li>
        {vs.length > 0 && (
          <li className="border-l-2 border-accent/60 pl-3">
            Jev 省下的是判断的钱，但它让执行者多做了 {moreSolves} 的题、多写了 {moreGenes} 倍的经验（和 Sonnet 5 当判断者比），这些都要执行者付费。整轮花费：
            {vs.map((v) => `${v.ex} 做题时 Jev ${usd(v.jev.costUsd)} 对 Sonnet 5 判断 ${usd(v.llm.costUsd)}`).join("，")}。
          </li>
        )}
      </ul>

      <p className="text-sm leading-relaxed text-muted">
        同一个 8 Agent 蜂群、同一套困难合成题，只换两样：谁做题和写经验（执行者），谁做协调判断（判断者：要不要复核、收不收经验、算不算真分歧）。
        {runs === 1 ? `种子 ${data.seeds[0]}，每格 1 次运行、${data.tasksPerRun} 题` : `种子 ${data.seeds.join(" 和 ")}，每格 ${runs} 次运行、共 ${data.tasksPerRun * runs} 题`}
        ；花费、用时为每轮 {data.tasksPerRun} 题的平均。Jev 组所有判断都由 Jev 做，不升级给大模型。p 为按题配对的精确 McNemar 检验，每一行内的 4 个比较做了 Holm 校正，「显著」指校正后 p &lt; 0.05。
      </p>
    </div>
  );
}

/** The home page's short version: each executor's accuracy under every judge, what judging costs, and a link on. */
export function JudgeMatrixSummary({ href }: { href: string }) {
  const data = useMatrix();
  if (data === "error") return <p className="border border-grid bg-panel p-6 text-fg/80">矩阵数据没有加载成功，刷新页面再试。</p>;
  if (!data) return <p className="border border-grid bg-panel p-6 text-muted">加载矩阵数据…</p>;
  const cell = (executor: string, judge: string) => data.cells.find((c) => c.executor === executor && c.judge === judge);
  const judgeCost = (judge: string) => range(data.cells.filter((c) => c.judge === judge).map((c) => c.judgeUsd));
  const total = data.cells.reduce((s, c) => s + c.runIds.length, 0);
  // LLM judges that Jev cannot be told apart from under every executor.
  const ties = data.judges.filter(
    (j) => j !== "Jev" && j !== "规则" && data.executors.every((ex) => data.tests.some((t) => t.executor === ex && t.b === j && t.pHolm >= 0.05)),
  );

  return (
    <div className="flex flex-col gap-4 border border-grid bg-panel/90 p-5">
      {data.executors.map((ex) => (
        <div key={ex} className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
          <span className="w-32 shrink-0 text-base font-semibold text-fg">{ex} 做题</span>
          {data.judges.map((j) => {
            const c = cell(ex, j);
            return c ? (
              <span key={j} className={`font-mono text-sm tabular-nums ${j === "Jev" ? "text-s1" : "text-fg/80"}`}>
                {j} <span className={`text-xl font-bold ${j === "Jev" ? "text-s1" : "text-fg"}`}>{pct(c)}%</span>
              </span>
            ) : null;
          })}
        </div>
      ))}
      <p className="text-sm leading-relaxed text-fg/75">
        每轮判断花费：Jev {judgeCost("Jev")}；
        {data.judges
          .filter((j) => j !== "Jev" && j !== "规则")
          .map((j) => `${j} ${judgeCost(j)}`)
          .join("；")}
        。{total} 次真实运行
        {ties.length > 0 ? `；两种执行者下，Jev 和 ${ties.join("、")} 当判断者的差距都不显著` : ""}。
      </p>
      <a href={href} className="self-start text-base font-semibold text-accent hover:underline">
        看完整对照：{data.judges.length * data.executors.length} 种组合的花费、用时和显著性 →
      </a>
    </div>
  );
}
