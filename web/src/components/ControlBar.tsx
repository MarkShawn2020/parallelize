import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DefaultsResponse } from "../../../src/core/api";
import { MODES, type Mode, type RunConfig } from "../../../src/core/types";
import { errorText, getDefaults, injectEcho, kill, startRun, stopRun } from "../api";
import { MODE_LABEL } from "../labels";

interface Props {
  runId: string | null;
  running: boolean;
  simulated: boolean;
  liveCells: number;
  /** True while the event stream is connected. */
  online: boolean;
}

type Judge = RunConfig["judge"];
type Llm = RunConfig["llm"];

const LIMITS = { n: [1, 500], cells: [1, 64] } as const;

function clampInt(raw: string, [lo, hi]: readonly [number, number], fallback: number): number {
  const v = Number.parseInt(raw, 10);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

export function ControlBar({ runId, running, simulated, liveCells, online }: Props) {
  const [mode, setMode] = useState<Mode>("swarm-jev");
  const [n, setN] = useState("40");
  const [cells, setCells] = useState("8");
  const [judge, setJudge] = useState<Judge>("mock");
  const [llm, setLlm] = useState<Llm>("mock");
  const [defaults, setDefaults] = useState<DefaultsResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);

  const formSeeded = useRef(false);

  // Refetch whenever the stream (re)connects: the page may load before the server is up.
  useEffect(() => {
    let cancelled = false;
    getDefaults()
      .then((d) => {
        if (cancelled) return;
        setDefaults(d);
        setNotice((prev) => (prev?.error ? null : prev));
        if (formSeeded.current) return;
        formSeeded.current = true;
        setN(String(d.defaults.n));
        setCells(String(d.defaults.cells));
        setJudge(d.providers.jev ? d.defaults.judge : "mock");
        setLlm(d.providers.llm ? d.defaults.llm : "mock");
      })
      .catch((e: unknown) => {
        if (!cancelled) setNotice({ text: `默认配置 defaults: ${errorText(e)}`, error: true });
      });
    return () => {
      cancelled = true;
    };
  }, [online]);

  async function act(label: string, fn: () => Promise<string | undefined>) {
    setBusy(label);
    setNotice(null);
    try {
      const text = await fn();
      if (text) setNotice({ text, error: false });
    } catch (e) {
      setNotice({ text: `${label}: ${errorText(e)}`, error: true });
    } finally {
      setBusy(null);
    }
  }

  const start = () =>
    void act("启动 start", async () => {
      const fallback = defaults?.defaults;
      const res = await startRun({
        mode,
        n: clampInt(n, LIMITS.n, fallback?.n ?? 40),
        cells: clampInt(cells, LIMITS.cells, fallback?.cells ?? 8),
        judge,
        llm,
      });
      return `已启动 started ${res.runId}`;
    });
  const onRun = (label: string, fn: (id: string) => Promise<string>) => () => {
    if (runId) void act(label, () => fn(runId));
  };
  const stop = onRun("停止 stop", async (id) => {
    await stopRun(id);
    return "已停止 stopped";
  });
  const killRandom = onRun("击杀 kill", async (id) => `击杀 killed ${(await kill(id)).cellId}`);
  const echo = onRun("回声 echo", async (id) => `注入回声 echo → ${(await injectEcho(id)).taskId}`);

  const swarm = mode === "swarm-llm" || mode === "swarm-jev";

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border border-grid bg-panel/90 px-3 py-2 text-sm 2xl:flex-nowrap">
      <div role="radiogroup" aria-label="模式 Mode" className="flex shrink-0 border border-grid">
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            disabled={running}
            onClick={() => setMode(m)}
            className={`px-3 py-1.5 font-display text-[15px] tracking-wide transition-colors disabled:cursor-not-allowed ${
              mode === m ? "bg-accent text-bg" : "text-muted hover:bg-panel-2 hover:text-fg disabled:hover:bg-transparent"
            }`}
          >
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>

      <Field label="任务 n">
        <NumberInput value={n} onChange={setN} limits={LIMITS.n} disabled={running} />
      </Field>
      <Field label="单元 cells">
        <NumberInput value={cells} onChange={setCells} limits={LIMITS.cells} disabled={running || !swarm} />
      </Field>
      <Field label="System 1" provider={{ name: "Jev", ok: defaults?.providers.jev, model: defaults?.jevModel }}>
        <Select
          value={judge}
          options={["jev", "mock"]}
          onChange={setJudge}
          disabled={running || mode !== "swarm-jev"}
        />
      </Field>
      <Field label="System 2" provider={{ name: "LLM", ok: defaults?.providers.llm, model: defaults?.llmModel }}>
        <Select
          value={llm}
          options={["openrouter", "mock"]}
          onChange={setLlm}
          disabled={running}
        />
      </Field>

      <div className="flex shrink-0 gap-2">
        <Button onClick={start} disabled={running || busy !== null} tone="accent">
          启动 Start
        </Button>
        <Button onClick={stop} disabled={!running || busy !== null}>
          停止 Stop
        </Button>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button onClick={killRandom} disabled={!running || liveCells === 0 || busy !== null} tone="danger">
          随机击杀 Kill cell
        </Button>
        <Button onClick={echo} disabled={!running || busy !== null} tone="danger">
          注入回声 Inject echo
        </Button>
      </div>

      {notice && (
        <span
          title={notice.text}
          role={notice.error ? "alert" : "status"}
          className={`min-w-0 flex-1 truncate text-xs ${notice.error ? "text-danger" : "text-muted"}`}
        >
          {notice.text}
        </span>
      )}

      {simulated && runId && (
        <span className="ml-auto shrink-0 animate-pulse bg-warn px-3 py-1 font-display text-base font-bold tracking-[0.2em] text-bg">
          模拟 SIMULATION
        </span>
      )}
    </div>
  );
}

interface Provider {
  name: string;
  ok: boolean | undefined;
  model: string | undefined;
}

function Field({ label, provider, children }: { label: string; provider?: Provider; children: ReactNode }) {
  const title = provider
    ? `${provider.name} ${provider.ok === undefined ? "未知 unknown" : provider.ok ? "就绪 ready" : "无密钥 no key"}${provider.model ? ` · ${provider.model}` : ""}`
    : undefined;
  return (
    <label className="flex shrink-0 items-center gap-2" title={title}>
      {provider && (
        <span
          aria-label={title}
          className={`size-2 ${provider.ok === undefined ? "bg-muted" : provider.ok ? "bg-ok" : "bg-danger"}`}
        />
      )}
      <span className="text-xs text-muted">{label}</span>
      {children}
    </label>
  );
}

const inputClass =
  "border border-grid bg-panel-2 px-2 py-1 text-fg tabular-nums outline-none focus:border-accent disabled:opacity-40";

function NumberInput(props: {
  value: string;
  onChange: (v: string) => void;
  limits: readonly [number, number];
  disabled: boolean;
}) {
  return (
    <input
      type="number"
      inputMode="numeric"
      min={props.limits[0]}
      max={props.limits[1]}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value)}
      className={`${inputClass} w-16`}
    />
  );
}

function Select<T extends string>(props: {
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
  disabled: boolean;
}) {
  return (
    <select
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => {
        const next = props.options.find((o) => o === e.target.value);
        if (next) props.onChange(next);
      }}
      className={inputClass}
    >
      {props.options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

const BUTTON_TONE = {
  plain: "border-grid text-fg hover:border-fg",
  accent: "border-accent text-accent hover:bg-accent hover:text-bg",
  danger: "border-danger/70 text-danger hover:bg-danger hover:text-bg",
} as const;

function Button(props: { onClick: () => void; disabled: boolean; tone?: keyof typeof BUTTON_TONE; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className={`border px-3 py-1.5 font-display text-[15px] tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent ${
        BUTTON_TONE[props.tone ?? "plain"]
      }`}
    >
      {props.children}
    </button>
  );
}
