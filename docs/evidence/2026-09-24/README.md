# 2026-09-24 · 执行者 × 判断者矩阵

同一个 8 Agent 蜂群、同一套困难合成题（每轮 96 题），只换两样：执行者（做题、写经验）和判断者（要不要复核、收不收经验、算不算真分歧）。执行者有 Haiku 4.5 和 Sonnet 5 两种，判断者有规则、Jev（全部由 Jev 判断，不升级）、Haiku 4.5、Sonnet 5、Opus 5 五种。每一格在种子 7 和 11 上各跑一次，一共 20 次真实运行。其中两次的汇总在 `../2026-09-23/`，其余在本目录。

复现：`scripts/run-judge-matrix.sh <执行者模型> <种子>` 跑一行，`pnpm matrix --seeds 7,11 --json web/public/matrix/judge-matrix.json` 出表，并按题配对做 McNemar 检验。
