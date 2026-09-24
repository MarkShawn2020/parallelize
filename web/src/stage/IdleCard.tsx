// The markers repeat the graph legend's ring colours, so the audience learns 青圈 / 琥珀圈 before the first run.
const LINES: Array<{ text: string; tone: string; mark: string }> = [
  { text: "能写成规则的协调 → 规则：原子领题，0 token", tone: "text-fg", mark: "rounded-sm border-2 border-fg/60" },
  {
    text: "规则写不出来的判断 → Jev：只答是/否、选哪个，约半秒，只收输入的钱",
    tone: "text-s1",
    mark: "rounded-full border-[3px] border-s1",
  },
  {
    text: "Jev 拿不准、调用失败，或某一类判断和大模型分歧太大（校准守卫整类交还）→ 交给大模型",
    tone: "text-s2",
    mark: "rounded-full border-[3px] border-s2",
  },
];

export function IdleCard() {
  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden p-8">
      <div className="flex max-w-full flex-col gap-5">
        <h2 className="text-3xl font-semibold text-fg">一个没有指挥官的 Agent 蜂群</h2>
        <ul className="flex flex-col gap-3 text-xl leading-snug">
          {LINES.map((l) => (
            <li key={l.text} className={`flex items-start gap-3 ${l.tone}`}>
              <span aria-hidden className={`mt-1.5 size-4 shrink-0 ${l.mark}`} />
              <span>{l.text}</span>
            </li>
          ))}
        </ul>
        <p className="text-xl font-semibold text-fg">判断交给 Jev，大模型专心解题。</p>
      </div>
    </div>
  );
}
