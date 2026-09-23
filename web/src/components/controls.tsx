import type { ReactNode } from "react";

export const inputClass =
  "border border-grid bg-panel-2 px-2 py-1 text-fg tabular-nums outline-none focus:border-accent disabled:opacity-40";

export function clampInt(raw: string, [lo, hi]: readonly [number, number], fallback: number): number {
  const v = Number.parseInt(raw, 10);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

interface Provider {
  name: string;
  ok: boolean | undefined;
  model: string | undefined;
}

export function Field({ label, hint, provider, children }: { label: string; hint?: string; provider?: Provider; children: ReactNode }) {
  const title = provider
    ? `${provider.name} ${provider.ok === undefined ? "未知 unknown" : provider.ok ? "就绪 ready" : "无密钥 no key"}${provider.model ? ` · ${provider.model}` : ""}`
    : hint;
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

export function NumberInput(props: {
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

export function Select<T extends string>(props: {
  value: T;
  options: readonly T[];
  labels?: Partial<Record<T, string>>;
  onChange: (v: T) => void;
  disabled: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <select
      value={props.value}
      disabled={props.disabled}
      aria-label={props.ariaLabel}
      onChange={(e) => {
        const next = props.options.find((o) => o === e.target.value);
        if (next !== undefined) props.onChange(next);
      }}
      className={`${inputClass} ${props.className ?? ""}`}
    >
      {props.options.map((o) => (
        <option key={o} value={o}>
          {props.labels?.[o] ?? o}
        </option>
      ))}
    </select>
  );
}

export function Toggle(props: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
  tone?: "accent" | "warn";
}) {
  const on = props.tone === "warn" ? "border-warn bg-warn/15 text-warn" : "border-accent bg-accent/15 text-accent";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      title={props.hint}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
      className={`flex shrink-0 items-center gap-2 border px-2.5 py-1 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
        props.checked ? on : "border-grid text-muted hover:border-fg hover:text-fg"
      }`}
    >
      <span aria-hidden className={`size-2.5 border ${props.checked ? "border-current bg-current" : "border-muted"}`} />
      {props.label}
    </button>
  );
}

const BUTTON_TONE = {
  plain: "border-grid text-fg enabled:hover:border-fg",
  accent: "border-accent text-accent enabled:hover:bg-accent enabled:hover:text-bg",
  danger: "border-danger/70 text-danger enabled:hover:bg-danger enabled:hover:text-bg",
  warn: "border-warn/70 text-warn enabled:hover:bg-warn enabled:hover:text-bg",
  gene: "border-gene/70 text-gene enabled:hover:bg-gene enabled:hover:text-bg",
} as const;

export type ButtonTone = keyof typeof BUTTON_TONE;

export function Button(props: {
  onClick: () => void;
  disabled: boolean;
  tone?: ButtonTone;
  title?: string;
  /** Stage buttons scale with the root font size so they stay legible on a projector. */
  size?: "stage";
  children: ReactNode;
}) {
  const size = props.size === "stage" ? "px-4 py-2 text-base" : "px-3 py-1.5 text-[15px]";
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
      className={`shrink-0 border ${size} font-display tracking-wide whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
        BUTTON_TONE[props.tone ?? "plain"]
      }`}
    >
      {props.children}
    </button>
  );
}
