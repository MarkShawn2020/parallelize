import { useState } from "react";
import { SWARM_MODES, type Mode } from "../../../src/core/types";
import { compromise, errorText, injectEcho, kill, resetLibrary, setFault, spawn, stopRun } from "../api";
import { shortModel } from "../format";
import { MAX_SELECTED, primaryTarget } from "../selection";
import { family } from "../stageText";
import { Button, Select } from "./controls";

interface Props {
  runId: string | null;
  running: boolean;
  mode: Mode | null;
  liveCells: number;
  jevDown: boolean;
  /** Live selected cells, oldest pick first. */
  selected: string[];
  models: string[];
  onConsumeSelection: (ids: string[]) => void;
  onLibraryReset: () => void;
  /** Stage dock: plain labels, projector-size buttons, plus start and settings. Same API calls either way. */
  variant?: "stage";
  onStart?: () => Promise<string | null>;
  onSettings?: () => void;
  settingsOpen?: boolean;
}

const DEFAULT_MODEL = "";

export function RuntimeBar(props: Props) {
  const { runId, running, mode, liveCells, jevDown, selected, models } = props;
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);

  async function act(label: string, fn: () => Promise<string>) {
    setBusy(label);
    setNotice(null);
    try {
      setNotice({ text: await fn(), error: false });
    } catch (e) {
      setNotice({ text: `${label}: ${errorText(e)}`, error: true });
    } finally {
      setBusy(null);
    }
  }

  const onRun = (label: string, fn: (id: string) => Promise<string>) => () => {
    if (runId) void act(label, () => fn(runId));
  };

  const swarm = mode !== null && SWARM_MODES.includes(mode);
  const target = primaryTarget(selected);
  const echoCells = selected.length >= 1 && selected.length <= MAX_SELECTED ? selected : [];
  const idle = busy === null;
  const cellActions = running && swarm && liveCells > 0 && idle;
  const modelOptions = [DEFAULT_MODEL, ...models.filter((m) => m !== DEFAULT_MODEL)];

  const addAgent = onRun("加入 spawn", async (id) => {
    const res = await spawn(id, model || undefined);
    return `加入 joined ${res.cellId} · ${shortModel(res.model)}`;
  });
  const hack = onRun("入侵 compromise", async (id) => {
    const res = await compromise(id, target);
    if (target) props.onConsumeSelection([target]);
    return `入侵 compromised ${res.cellId}`;
  });
  const toggleJev = onRun("Jev 故障 fault", async (id) => {
    await setFault(id, { provider: "jev", down: !jevDown });
    return jevDown ? "Jev 恢复请求已发送 restore sent" : "Jev 离线请求已发送 offline sent";
  });
  const echo = onRun("回声 echo", async (id) => {
    const res = await injectEcho(id, echoCells);
    props.onConsumeSelection(echoCells);
    return `注入回声 echo → ${res.taskId}${echoCells.length ? ` · ${echoCells.join(", ")}` : ""}`;
  });
  const killCell = onRun("杀节点 kill", async (id) => {
    const res = await kill(id, target);
    if (target) props.onConsumeSelection([target]);
    return `阵亡 killed ${res.cellId}`;
  });
  const stop = onRun("停止 stop", async (id) => {
    await stopRun(id);
    return "已停止 stopped";
  });
  const reset = () => {
    if (!window.confirm("清空本地经验库（Gene 与先例）？下一次运行将冷启动。\nReset the local experience library?")) return;
    void act("重置经验库 reset", async () => {
      await resetLibrary();
      props.onLibraryReset();
      return "经验库已清空 library reset";
    });
  };

  if (props.variant === "stage") {
    const start = () => {
      if (!props.onStart) return;
      setBusy("开始");
      setNotice(null);
      void props.onStart().then((err) => {
        setBusy(null);
        if (err) setNotice({ text: err, error: true });
      });
    };
    return (
      <div className="flex flex-col gap-1 border border-grid bg-panel/90 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={start} disabled={running || !idle || !props.onStart} tone="accent" size="stage">
            {running ? "运行中…" : "开始"}
          </Button>
          <span aria-hidden className="mx-1 h-8 w-px bg-grid" />
          <Button onClick={hack} disabled={!cellActions} tone="danger" size="stage">
            入侵一个 → {target ?? "随机"}
          </Button>
          <Button onClick={echo} disabled={!running || !swarm || !idle} tone="danger" size="stage">
            {echoCells.length ? `让 ${echoCells.join("、")} 互相抄答案` : "让 3 个 Agent 互相抄答案"}
          </Button>
          <Button onClick={killCell} disabled={!cellActions} tone="danger" size="stage">
            拔掉一个 → {target ?? "随机"}
          </Button>
          <Button onClick={toggleJev} disabled={!running || mode !== "swarm-jev" || !idle} tone={jevDown ? "accent" : "danger"} size="stage">
            {jevDown ? "恢复 Jev" : "断开 Jev"}
          </Button>
          <span aria-hidden className="mx-1 h-8 w-px bg-grid" />
          <Button onClick={addAgent} disabled={!running || !swarm || !idle} tone="accent" size="stage">
            加入新 Agent
          </Button>
          <Select
            value={model}
            options={modelOptions}
            labels={{ [DEFAULT_MODEL]: "同款模型", ...Object.fromEntries(models.map((m) => [m, family(m)])) }}
            onChange={setModel}
            disabled={!running || !swarm || !idle}
            ariaLabel="新 Agent 用的模型"
            className="text-base"
          />
          <span aria-hidden className="mx-1 h-8 w-px bg-grid" />
          <Button onClick={stop} disabled={!running || !idle} size="stage">
            停止
          </Button>
          <Button onClick={() => props.onSettings?.()} disabled={false} size="stage" tone={props.settingsOpen ? "accent" : "plain"}>
            设置
          </Button>
        </div>
        {(selected.length > 0 || notice?.error) && (
          <div className="flex flex-wrap items-center gap-x-6 text-base">
            {selected.length > 0 && <span className="text-fg">已选：{selected.join("、")}（在图上点节点，最多 {MAX_SELECTED} 个）</span>}
            {notice?.error && (
              <span role="alert" className="text-danger">
                {notice.text}
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-2 border border-grid bg-panel/90 px-3 py-2 text-sm">
      <span className="mr-1 shrink-0 font-display text-[15px] tracking-[0.18em] text-accent">现场 LIVE</span>

      <Button onClick={addAgent} disabled={!running || !swarm || !idle} tone="accent" title="新 Agent 即插即用加入蜂群">
        加入 Agent
      </Button>
      <Select
        value={model}
        options={modelOptions}
        labels={{ [DEFAULT_MODEL]: "默认模型 default", ...Object.fromEntries(models.map((m) => [m, shortModel(m)])) }}
        onChange={setModel}
        disabled={!running || !swarm || !idle}
        ariaLabel="新 Agent 模型 model"
        className="max-w-[200px]"
      />

      <span aria-hidden className="mx-1 h-6 w-px bg-grid" />

      <Button onClick={hack} disabled={!cellActions} tone="danger" title="演示：让一个单元变成对抗者，蜂群并不知情">
        入侵 → {target ?? "随机"}
      </Button>
      <Button
        onClick={toggleJev}
        disabled={!running || mode !== "swarm-jev" || !idle}
        tone={jevDown ? "accent" : "warn"}
        title={mode === "swarm-jev" ? "System 1 故障开关" : "仅 JIS 蜂群 swarm-jev only"}
      >
        {jevDown ? "恢复 Jev" : "Jev 离线"}
      </Button>
      <Button
        onClick={echo}
        disabled={!running || !swarm || !idle}
        tone="danger"
        title="让选中的单元先看到第一个答案，制造同源一致"
      >
        注入回声 → {echoCells.length ? echoCells.join(",") : "自动"}
      </Button>
      <Button onClick={killCell} disabled={!cellActions} tone="danger">
        杀节点 → {target ?? "随机"}
      </Button>

      <span aria-hidden className="mx-1 h-6 w-px bg-grid" />

      <Button onClick={stop} disabled={!running || !idle}>
        停止 Stop
      </Button>
      <Button onClick={reset} disabled={running || !idle} title={running ? "运行结束后再重置 reset between runs" : "冷启动 cold start"}>
        重置经验库
      </Button>

      {notice && (
        <span
          title={notice.text}
          role={notice.error ? "alert" : "status"}
          className={`min-w-0 flex-1 truncate text-right text-xs ${notice.error ? "text-danger" : "text-muted"}`}
        >
          {notice.text}
        </span>
      )}
    </div>
  );
}
