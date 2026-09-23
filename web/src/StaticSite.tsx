import { useEffect, useState } from "react";
import { Landing } from "./landing/Landing";
import { QUICK_START } from "./site";

const isLiveRoute = (hash: string) => hash.startsWith("#/live") || hash.startsWith("#/eng");

/** The public site: the landing pages only. The live dashboard needs the local server, so its routes explain how to run it. */
export function StaticSite() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  if (!isLiveRoute(hash)) return <Landing liveRunning={false} />;
  return (
    <main className="mx-auto flex min-h-screen max-w-[760px] flex-col justify-center gap-5 px-4 py-20">
      <span className="font-mono text-sm tracking-widest text-accent">现场演示</span>
      <h1 className="text-4xl font-bold text-fg">现场演示要在本地跑</h1>
      <p className="text-lg leading-relaxed text-fg/80">
        大屏看板会真实调用模型、实时推送蜂群事件，需要本地服务端。这个网站是静态版，只能看回放和数据。
      </p>
      <pre className="overflow-x-auto border border-grid bg-panel p-4 font-mono text-sm text-s1">
        {"pnpm install\ncp .env.example .env   # 填 OPENROUTER_API_KEY\npnpm build && pnpm start\n# 打开 http://localhost:8787/#/live"}
      </pre>
      <div className="flex flex-wrap gap-3">
        <a href={QUICK_START} target="_blank" rel="noreferrer" className="bg-accent px-5 py-2.5 font-semibold text-bg hover:bg-accent/85">
          GitHub 快速开始 →
        </a>
        <a href="#/compare" className="border border-fg/40 px-5 py-2.5 text-fg hover:border-fg">
          看三路对照回放
        </a>
      </div>
    </main>
  );
}
