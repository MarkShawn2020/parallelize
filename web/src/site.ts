/**
 * Build for the public static site (jis.lovstudio.ai): no server behind it, so only the landing pages mount and the
 * live demo points at the local quick start. Set by `pnpm build:site`.
 */
export const STATIC_SITE = import.meta.env.VITE_STATIC_SITE === "1";

export const REPO = "https://github.com/lovstudio/jis";
export const QUICK_START = `${REPO}#快速开始--quick-start`;
