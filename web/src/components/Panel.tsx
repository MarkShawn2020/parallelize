import type { ReactNode } from "react";

interface Props {
  title: string;
  en: string;
  right?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

export function Panel({ title, en, right, className = "", bodyClassName = "", children }: Props) {
  return (
    <section className={`flex min-h-0 min-w-0 flex-col border border-grid bg-panel/90 ${className}`}>
      <header className="flex items-center justify-between gap-3 border-b border-grid px-3 py-1.5">
        <h2 className="flex shrink-0 items-center gap-2 font-display text-[15px] tracking-[0.14em] whitespace-nowrap uppercase">
          <span aria-hidden className="h-3.5 w-[3px] bg-accent" />
          <span className="text-fg">{title}</span>
          <span className="text-muted">{en}</span>
        </h2>
        {right}
      </header>
      <div className={`min-h-0 flex-1 ${bodyClassName}`}>{children}</div>
    </section>
  );
}
