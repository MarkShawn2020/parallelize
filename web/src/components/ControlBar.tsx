import { useEffect, useRef, useState } from "react";
import type { DefaultsResponse, StartRunRequest } from "../../../src/core/api";
import { MODES, SWARM_MODES, type Mode, type RunConfig, type TaskSourceConfig } from "../../../src/core/types";
import { errorText, startRun } from "../api";
import { MODE_HINT, MODE_LABEL } from "../labels";
import { Button, Field, NumberInput, Select, Toggle, clampInt, inputClass } from "./controls";

interface Props {
  defaults: DefaultsResponse | null;
  defaultsError: string | null;
  running: boolean;
  simulated: boolean;
  hasRun: boolean;
}

type Judge = RunConfig["judge"];
type Llm = RunConfig["llm"];
type Source = "math" | "research";
type Difficulty = NonNullable<Extract<TaskSourceConfig, { kind: "synthetic" }>["difficulty"]>;

const DIFFICULTIES: ReadonlyArray<[Difficulty, string, string]> = [
  ["normal", "普通", "普通：3-5 步整数题 normal"],
  ["hard", "困难", "困难：6-9 步，含干扰条件、单位换算与百分比 hard"],
];

const LIMITS = { n: [1, 500], cells: [1, 64], claims: [3, 10], canaries: [0, 6], simPace: [1, 40] } as const;
// An offline demo should feel like a real run (~1.5-3 s per solve), not finish in five seconds.
const DEMO_SIM_PACE = 10;
export const IDEA_MAX = 500;
const PUBLISH_WARNING = "会把通过验证门的 Gene 公开发布到 EvoMap";

export function ControlBar({ defaults, defaultsError, running, simulated, hasRun }: Props) {
  const [mode, setMode] = useState<Mode>("swarm-jev");
  const [source, setSource] = useState<Source>("math");
  const [difficulty, setDifficulty] = useState<Difficulty>("normal");
  const [n, setN] = useState("40");
  const [cells, setCells] = useState("8");
  const [judge, setJudge] = useState<Judge>("mock");
  const [llm, setLlm] = useState<Llm>("mock");
  const [simPace, setSimPace] = useState(String(DEMO_SIM_PACE));
  const [reasoning, setReasoning] = useState<"off" | "low" | "default">("off");
  const [inherit, setInherit] = useState(true);
  const [evomapLookup, setEvomapLookup] = useState(false);
  const [evomapPublish, setEvomapPublish] = useState(false);
  const [idea, setIdea] = useState("");
  const [claims, setClaims] = useState("6");
  const [canaries, setCanaries] = useState("2");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const formSeeded = useRef(false);

  useEffect(() => {
    if (!defaults || formSeeded.current) return;
    formSeeded.current = true;
    const d = defaults.defaults;
    setN(String(d.n));
    setCells(String(d.cells));
    setJudge(defaults.providers.jev ? d.judge : "mock");
    setLlm(defaults.providers.llm ? d.llm : "mock");
    setInherit(d.inherit);
    setEvomapLookup(d.evomapLookup);
    // Publishing stays off until someone switches it on in this session.
  }, [defaults]);

  const research = source === "research";
  const ideaText = idea.trim();
  const swarm = SWARM_MODES.includes(mode);
  // System 1 only runs in swarm-jev, so elsewhere only a mock System 2 makes the run simulated.
  const simulating = llm === "mock" || (mode === "swarm-jev" && judge === "mock");
  const noNode = defaults?.evomapNode === false;
  const canStart = !running && !busy && (!research || ideaText.length > 0);

  const start = async () => {
    setBusy(true);
    setNotice(null);
    const fallback = defaults?.defaults;
    const taskSource: TaskSourceConfig = research
      ? {
          kind: "research",
          idea: ideaText,
          claims: clampInt(claims, LIMITS.claims, 6),
          canaries: clampInt(canaries, LIMITS.canaries, 2),
        }
      : { kind: "synthetic", difficulty };
    const req: StartRunRequest = {
      mode,
      cells: clampInt(cells, LIMITS.cells, fallback?.cells ?? 8),
      judge,
      llm,
      inherit,
      evomapLookup,
      evomapPublish: evomapPublish && !noNode,
      ...(research ? {} : { n: clampInt(n, LIMITS.n, fallback?.n ?? 40) }),
      ...(simulating ? { simPace: clampInt(simPace, LIMITS.simPace, DEMO_SIM_PACE) } : {}),
      ...(llm === "openrouter" ? { llmReasoning: reasoning } : {}),
      taskSource,
    };
    try {
      const res = await startRun(req);
      setNotice({ text: `已启动 started ${res.runId}`, error: false });
    } catch (e) {
      setNotice({ text: `启动 start: ${errorText(e)}`, error: true });
    } finally {
      setBusy(false);
    }
  };

  const shownNotice = notice ?? (defaultsError ? { text: defaultsError, error: true } : null);

  return (
    <div className="flex flex-col gap-2 border border-grid bg-panel/90 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div role="radiogroup" aria-label="模式 Mode" className="flex shrink-0 border border-grid">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              title={MODE_HINT[m]}
              disabled={running}
              onClick={() => setMode(m)}
              className={`px-2.5 py-1.5 font-display text-[15px] tracking-wide whitespace-nowrap transition-colors disabled:cursor-not-allowed ${
                mode === m ? "bg-accent text-bg" : "text-muted enabled:hover:bg-panel-2 enabled:hover:text-fg"
              }`}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>

        <div role="radiogroup" aria-label="任务来源 Task source" className="flex shrink-0 border border-grid">
          {(
            [
              ["math", "数学题"],
              ["research", "点子验证"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={source === k}
              disabled={running}
              onClick={() => setSource(k)}
              className={`px-2.5 py-1.5 font-display text-[15px] tracking-wide transition-colors disabled:cursor-not-allowed ${
                source === k ? "bg-s1 text-bg" : "text-muted enabled:hover:bg-panel-2 enabled:hover:text-fg"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {!research && (
          <div role="radiogroup" aria-label="难度 Difficulty" className="flex shrink-0 border border-grid">
            {DIFFICULTIES.map(([k, label, hint]) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={difficulty === k}
                title={hint}
                disabled={running}
                onClick={() => setDifficulty(k)}
                className={`px-2 py-1.5 text-[13px] transition-colors disabled:cursor-not-allowed ${
                  difficulty === k ? "bg-s1/15 text-s1" : "text-muted enabled:hover:bg-panel-2 enabled:hover:text-fg"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        <Field label="任务 n">
          <NumberInput value={n} onChange={setN} limits={LIMITS.n} disabled={running || research} />
        </Field>
        <Field label="单元 cells">
          <NumberInput value={cells} onChange={setCells} limits={LIMITS.cells} disabled={running || !swarm} />
        </Field>
        <Field label="System 1" provider={{ name: "Jev", ok: defaults?.providers.jev, model: defaults?.jevModel }}>
          <Select value={judge} options={["jev", "mock"]} onChange={setJudge} disabled={running || mode !== "swarm-jev"} />
        </Field>
        <Field label="System 2" provider={{ name: "LLM", ok: defaults?.providers.llm, model: defaults?.llmModel }}>
          <Select value={llm} options={["openrouter", "mock"]} onChange={setLlm} disabled={running} />
        </Field>
        {llm === "openrouter" && (
          <Field label="思考 Reasoning" hint="真实大模型的推理强度：off = 直接作答（快、会出错），low = 简短推理 llmReasoning">
            <Select value={reasoning} options={["off", "low", "default"]} onChange={(v) => setReasoning(v as "off" | "low" | "default")} disabled={running} />
          </Field>
        )}
        {simulating && (
          <Field label="模拟节奏 ×" hint="模拟调用的延迟倍数：1 = 快速模拟，10 ≈ 真实运行节奏 simPace">
            <NumberInput value={simPace} onChange={setSimPace} limits={LIMITS.simPace} disabled={running} />
          </Field>
        )}

        <Button
          onClick={() => void start()}
          disabled={!canStart}
          tone="accent"
          title={research && !ideaText ? "请先输入点子 enter an idea first" : undefined}
        >
          启动 Start
        </Button>

        {simulated && hasRun && (
          <span className="ml-auto shrink-0 animate-pulse bg-warn px-3 py-1 font-display text-base font-bold tracking-[0.2em] text-bg">
            模拟 SIMULATION
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-xs text-muted">选项 Options</span>
        <Toggle
          label="继承经验"
          hint="开局载入本地经验库（Gene + 已确认先例），结束时沉淀新经验 inherit"
          checked={inherit}
          onChange={setInherit}
          disabled={running}
        />
        <Toggle
          label="EvoMap 检索"
          hint="任务卡住时检索 EvoMap 公开 Gene evomapLookup"
          checked={evomapLookup}
          onChange={setEvomapLookup}
          disabled={running}
        />
        <Toggle
          label="发布到 EvoMap"
          hint={noNode ? "未注册 EvoMap 节点 no EvoMap node registered" : "通过留出集 A/B 验证门的 Gene 才会发布 evomapPublish"}
          checked={evomapPublish && !noNode}
          onChange={setEvomapPublish}
          disabled={running || noNode}
          tone="warn"
        />
        {evomapPublish && !noNode && (
          <span role="note" className="shrink-0 border border-warn/50 bg-warn/10 px-2 py-0.5 text-xs text-warn">
            {PUBLISH_WARNING}
          </span>
        )}
        {shownNotice && (
          <span
            title={shownNotice.text}
            role={shownNotice.error ? "alert" : "status"}
            className={`min-w-0 flex-1 truncate text-right text-xs ${shownNotice.error ? "text-danger" : "text-muted"}`}
          >
            {shownNotice.text}
          </span>
        )}
      </div>

      {research && !running && (
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <label className="flex min-w-[320px] flex-1 flex-col gap-1">
            <span className="flex justify-between text-xs text-muted">
              <span>
                <span className="text-fg/80">点子</span> Idea · 拆成可验证论断 + 已知真假的金丝雀论断
              </span>
              <span className={`tabular-nums ${idea.length >= IDEA_MAX ? "text-warn" : ""}`}>
                {idea.length}/{IDEA_MAX}
              </span>
            </span>
            <textarea
              value={idea}
              maxLength={IDEA_MAX}
              rows={2}
              onChange={(e) => setIdea(e.target.value.slice(0, IDEA_MAX))}
              placeholder="例如：用 AI 客服替小餐馆自动回复点评，三个月内能收回成本吗？"
              className={`${inputClass} resize-y leading-snug`}
            />
          </label>
          <div className="flex flex-col gap-2 pt-5">
            <Field label="论断 claims">
              <NumberInput value={claims} onChange={setClaims} limits={LIMITS.claims} disabled={false} />
            </Field>
            <Field label="金丝雀 canaries">
              <NumberInput value={canaries} onChange={setCanaries} limits={LIMITS.canaries} disabled={false} />
            </Field>
          </div>
        </div>
      )}
    </div>
  );
}
