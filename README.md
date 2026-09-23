# Parallelize 並列化

EvoTavern 第四届黑客松 SECTION 9（多 Agent 蜂群协作）参赛作品。

## 一句话 / Thesis

蜂群里的每个协调决策（要不要认领这个任务？这个答案需不需要独立重解？要不要采纳邻居的策略基因？）本质上都是封闭式判断。Parallelize 让 System 1（TypeSafe 的 Jev，类型化决策模型，70–500ms，只按输入计费）回答这些判断；只有 System 1 置信度低于阈值时才升级给 System 2（LLM），并把 System 2 的裁决存成判例喂回 System 1，升级率随运行下降（策略压缩）。真正的解题工作始终由 LLM 完成。

In a swarm, every coordination decision is a closed-form judgment. A fast typed judge answers them; the LLM is consulted only when the judge is unsure, and its verdicts become precedents that make the next escalation less likely. Problem solving always stays with the LLM.

## 对应五个评审维度 / SECTION 9 judging dimensions

| 维度 | 实现 |
| --- | --- |
| 分工 Division of labour | 黑板自认领：没有中心调度器，每个 cell 从黑板拉取候选任务，由 System 1 选择最可能做对的一项（stigmergy）。 |
| 编排 Orchestration | 原子拆分（一题一任务）+ 按 task id 的确定性合并（`Blackboard.results()`），没有 LLM 改写最终答案。 |
| 通信协议 Protocol | 只交换有界摘要（METHOD 行，上限 550 tokens）与血缘图（lineage）：每个提案记录它看过哪些提案，基因传播带消息节点。 |
| 冲突解决 Conflict resolution | 按独立来源计数而非投票：同源的一致答案只算一个来源，触发回声 / 假共识警报并要求血缘不相交的 cell 重解；低置信协调决策升级给 System 2。 |
| 故障恢复 Fault recovery | 租约（lease）机制：cell 在 LLM 调用期间续租，被杀的 cell 停止续租，租约到期后任务自动重开并由其他 cell 接手。 |

## 四种模式 / Modes

| 模式 | 说明 |
| --- | --- |
| `single` | 单上下文：所有题目塞进一次调用。小批量省 token，批量大时准确率崩塌。 |
| `subagent` | EvoMap 的 Sub-Agent 基线：每题一个 worker，协调者合并报告；只评分协调者输出，合并有损。 |
| `swarm-llm` | 蜂群，协调决策全部由 LLM 回答（升级率恒为 1）。 |
| `swarm-jev` | 蜂群，协调决策由 Jev 回答，低置信时升级到 LLM，裁决回灌为判例。 |

指标：准确率（未接受的任务算错）、总 / 工作 / 协调 token、成本、AIR（每千 token 正确答案数）、升级率、回声警报、故障恢复次数。

## 快速开始 / Quick start

```bash
pnpm install
cp .env.example .env          # 填 OPENROUTER_API_KEY（Jev 与 LLM 共用）
pnpm dev                      # 服务端 :8787 + 看板 http://localhost:5173

# 离线模拟，不调用任何 API
pnpm bench --mode all --llm mock --judge mock --n 128

# 真实连通性检查：一次 Jev 调用 + 一次 LLM 解题
pnpm smoke:live
```

生产方式：`pnpm build && pnpm start`，看板由服务端直接托管在 `http://127.0.0.1:8787`。看板上可以启动运行、击杀 cell（演示租约恢复）、注入回声（演示假共识检测）。

`pnpm bench` 参数：`--mode <mode|all> --n --cells --seed --judge jev|mock --llm openrouter|mock --source synthetic|gsm8k --path --max-cost`。每次运行写入 `runs/<runId>/`（`events.jsonl`、`ledger.jsonl`、`summary.json`），对比表写入 `runs/compare-<时间戳>.json`。服务端只接受 `data/` 目录内的 gsm8k 文件。

## 架构 / Architecture

```
                 ┌──────────────── Blackboard (tasks, leases, proposals) ────────────────┐
                 │  open ─claim─> claimed ─propose─> verifying ─independent agree─> accepted │
                 └───────▲──────────────────────▲───────────────────────▲─────────────────┘
                         │ pull (no scheduler)  │                       │ lease expiry -> reopen
   ┌─────────┐    ┌──────┴─────┐          ┌─────┴──────┐          ┌─────┴──────┐
   │  gossip │<──>│  cell c01  │<──genes─>│  cell c02  │<──genes─>│  cell c03  │ ...
   └─────────┘    └──┬──────┬──┘          └────────────┘          └────────────┘
                     │      │
      claim / verify / adopt │ solve / distil gene
                     v      v
   ┌──────────────────────────┐        ┌───────────────┐
   │ EscalatingJudge          │        │ LLM (System 2)│  work: always the LLM
   │  System 1: Jev  ──low────┼──────> │               │
   │  confidence?  <─precedent┼─────── │ LLMJudge      │
   └──────────────────────────┘        └───────────────┘
            │ every call metered (Ledger, cost cap)      Lineage graph: proposals, genes, messages
            v                                            -> independent-source counting, recollision
   events -> WebSocket -> dashboard (web/)
```

代码结构：`src/core`（契约、黑板、血缘、账本、指标）、`src/providers`（Jev、OpenAI 兼容 LLM、模拟器）、`src/judge`（升级、判例、LLM 裁判、校准）、`src/swarm`（cell、蜂群、基因、拓扑、共识判定）、`src/modes`（两个基线）、`src/run.ts`、`src/server.ts`、`web/`。

## 局限 / Limitations

- Jev 是第三方模型：它在这些协调问题上的准确率与置信度校准未经独立验证。运行摘要里有按 claim / verify 分箱的校准数据，可以直接检查。
- `--llm mock` / `--judge mock` 是模拟：模拟器按设定的准确率、延迟和计费公式生成结果（包括单上下文随批量增大而崩塌、协调者合并约 55% 保真度），用于演示机制和回归测试，不能当作真实模型的评测结果。看板和汇总会标注 SIMULATION。
- 默认题目是合成的算术、速率、逻辑题（带种子、可复现），比真实基准简单；gsm8k 需要自备 `data/` 下的 jsonl 文件。
- 在模拟中 System 1 的 token 优势主要来自更少的输出与格式开销，判例会占用一部分输入 token；成本与延迟优势比 token 优势更明显。
