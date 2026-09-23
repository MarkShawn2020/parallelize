# Parallelize 並列化

EvoTavern 第四届黑客松 SECTION 9（多 Agent 蜂群协作）参赛作品。

## 一句话 / Thesis

能写成规则的协调就不花 token：认领任务、试用期复核、随机抽查、低信任复核、隔离，全部是零 token 的规则。只有规则表达不了的判断才交给 System 1（TypeSafe 的 Jev，类型化决策模型，按输入计费）：这个提案要不要独立重解（verify）？这个基因适不适合我（adopt）？两个互相矛盾的答案哪个对，还是都说不准（dispute）？System 1 置信度低时升级给 System 2（LLM）；System 2 的裁决先挂起，等结果证实后才成为 System 1 的判例。真正的解题始终由 LLM 完成。

Coordination that can be written as a rule costs zero tokens. The fast typed judge (Jev) answers only the judgments rules cannot express; low confidence escalates to the LLM, whose verdicts become precedents only after the outcome confirms them. Problem solving always stays with the LLM.

协议规范见 [PROTOCOL.md](PROTOCOL.md)（Swarm Protocol v1：信封、能力卡、15 种消息、权限模型、接入新 Agent）。

## 评审维度对照 / SECTION 9 rubric

| 维度 | 机制 | 在哪里看 |
| --- | --- | --- |
| 涌现 Emergence | 三个消融对照证明"蜂群 > 单体之和"：`swarm-solo`（只并行认领 + 确定性合并，关掉复核与基因交换，即单体之和）、`swarm-rules`（固定规则、无裁判）、`single-vote`（同 token 预算、每题独立解 k 次多数投票）。共识按血缘不相交的独立来源计数，同源一致只算一个来源；分歧走 dispute 裁决，说不准就再要一次独立重解。 | 看板"模式对比"表；`pnpm bench` 对比表；"指标"面板的 Pass-through、≥2 源错放、Coord share |
| 协议与通信 Protocol | 传输无关的 JSON 信封 + 15 种消息（ANNOUNCE / DISCOVER / CLAIM / PROPOSE / REVIEW_REQUEST / ACCEPT / ECHO_ALARM / GENE_* / LIBRARY_* / QUARANTINE / DENIED 等）；能力卡（模型、各领域战绩、基因摘要、信任、状态）进注册表，按领域战绩与信任 `discover`；只交换有界摘要，每条消息带血缘父节点；经验通过本地经验库和 EvoMap 传给后来者。 | "注册表"页签（能力卡）、"协议"页签（消息轨迹）、"经验库"页签 |
| 容错与安全 Fault tolerance & security | 权限受限的 cell 句柄（越权提交被拒并广播 DENIED）；试用期 + 随机抽查 + 低信任强制复核；Beta 信任与自动隔离；演示用"入侵"开关让一个 cell 变成对抗者；"Jev 故障"开关让 System 1 离线，判断降级到 System 2；System 2 也失败时回退到保守默认值；校准守卫；基因文本注入过滤；租约到期自动回收任务。 | 顶栏"入侵 / Jev 故障 / 杀节点"按钮；告警条；注册表里的信任与隔离状态；"决策流" |
| 可扩展性 Extensibility | 运行中即插即用加入新 cell，可换模型（能力卡自动发布，被 `discover` 找到后参与基因交换）；`cellModels` 按轮转给 cell 分配不同模型；同一套蜂群直接跑"想法验证"场景（想法 → 论断 + 金丝雀 → 蜂群裁决 → 确定性的继续 / 放弃报告）；Judge / LLM 是接口，换供应商不动蜂群。 | 顶栏"加入 spawn"；"研究报告"页签；PROTOCOL.md 第 9 节 |

## 七种模式 / Seven modes

| 模式 | 看板名 | 为什么存在 |
| --- | --- | --- |
| `single` | 单上下文 | 所有题目塞进一次调用。小批量最省 token，批量大时准确率崩塌。 |
| `single-vote` | 同预算投票 | 公平的同预算基线：每题独立解 k 次，多数投票；k 按 token 预算定（bench 里预算 = 本轮 swarm-jev 的总 token）。回答"多花的 token 换来的是协作，还是单纯多采样"。 |
| `subagent` | Sub-Agent | EvoMap 的 Sub-Agent 基线：每题一个 worker，协调者有损合并。 |
| `swarm-llm` | LLM 协调蜂群 | 规则表达不了的判断全交给 LLM（升级率恒为 1），衡量 Jev 省下多少。 |
| `swarm-jev` | Jev 协调蜂群 | 完整方案：规则 + Jev + 按需升级 + 判例回灌。 |
| `swarm-rules` | 规则蜂群 | 消融：保留规则复核、基因交换、信任与隔离，但没有任何裁判调用。衡量 Jev 判断本身的贡献。 |
| `swarm-solo` | 仅并行 | 消融："单体之和"。只有并行认领和确定性合并，没有复核、没有基因、没有经验库。 |

## 安全模型 / Safety model

- 权限隔离：每个 cell 只拿到一个受限句柄，只能认领、续租、提交自己持有租约的任务。越权提交被拒绝，发出 `permission.denied` 和 DENIED 消息。被隔离的 cell 句柄立即失效，租约当场收回。
- 复核规则先于判断：cell 的前 `probation` 个提案必定复核；信任低于 `reviewTrust` 必定复核；其余提案按 `auditRate` 随机抽查。只有规则都没拦下的提案才去问 System 1 要不要重解。
- 信任与隔离：Beta 信任（先验 2:1），提案与最终接受答案一致则加分；判过 `probation` 次以上且信任低于 `quarantineTrust` 自动隔离，其提案不再计入任何裁决。默认参数下，连续 3 次与共识不一致就会被隔离。
- 对抗演示：看板"入侵"让一个 cell 暗中变坏（篡改答案、散播带注入的基因、尝试越权提交），只有看板知道，蜂群必须靠行为自己发现。
- 降级链：Jev 离线时每个判断直接升级到 System 2；System 2 也失败时用保守默认值（verify → 重解，adopt → 拒绝，dispute → 说不准），决策上标 `fallback`。
- 判例只在结果证实后生效：System 2 的裁决先挂起，接受答案与裁决一致才 confirm，否则 reject。持久化到经验库的只有已证实判例。
- 校准守卫：某类问题上 System 1 与 System 2 的分歧率在滚动窗口内超过 `guardMaxDisagreement`，这类问题以后跳过 System 1，看板提示"已改由大模型判断"。
- 基因文本注入过滤：来自邻居、经验库或 EvoMap 的基因文本先过 `sanitizeGeneText`（隐藏字符、"忽略之前指令"、强制答案等），可疑的直接拒绝并扣发送者信任。
- 秘密不出服务器：API key 与 EvoMap node secret 只在服务端；`/api/config/defaults` 只返回"是否已注册节点"的布尔值，不返回 claim URL。

## 知识继承 / Knowledge inheritance

- 本地经验库 `runs/library/`（`genes.jsonl` + `precedents.jsonl`）。开启 `inherit` 时：开局载入，按任务领域给 cell 播种最好的基因，已证实判例直接喂给 System 1；结束时沉淀本轮至少用过 2 次、平滑胜率不低于 0.6 的基因，以及本轮新证实的判例。基因证据按本轮增量合并，不重复计数。
- 卡住就查：同一任务复核失败达到 `stuckAfter` 次，下一个解题者先查本地经验库，再（开启 `evomapLookup` 时）查 EvoMap 公共基因库。命中的基因同样要过注入过滤和 adopt 判断，只用于这一次解题。
- 发布到 EvoMap（`evomapPublish`，默认关闭，需要先注册节点）：候选为本轮本地基因中平滑胜率不低于 0.7、至少 3 次试用、领域为合成题或 gsm8k、文本无注入嫌疑的前 2 个；每个候选在 `publishGateTasks` 道全新留出题上做 A/B（带基因 vs 不带基因），正确数之差至少 `publishGateMinDelta` 才算通过；通过后先调用 `/a2a/validate` 试发，试发通过才正式发布 Gene + Capsule + EvolutionEvent。模拟运行只跑验证门，从不向 EvoMap 发送模拟出来的证据。

## 快速开始 / Quick start

```bash
pnpm install
cp .env.example .env          # 填 OPENROUTER_API_KEY（Jev 与 LLM 共用）
pnpm dev                      # 服务端 :8787 + 看板 http://localhost:5173

# 离线模拟，不调用任何 API：七种模式同设置对比
pnpm bench --llm mock --judge mock --n 48 --cells 6

# 困难合成题（6-9 步、含干扰条件与单位换算 / 百分比），给复核与投票留出差异空间；运行标签带 /hard
pnpm bench --llm mock --judge mock --n 48 --cells 6 --difficulty hard

# 经验继承：冷启动（空经验库）与热启动（继承冷启动的经验）各跑一次
pnpm bench --llm mock --judge mock --inherit

# 想法验证场景
pnpm bench --llm mock --judge mock --mode swarm-jev,single --research "用 AI 帮猫咖做员工排班" --claims 5 --canaries 2

# 真实连通性检查：一次 Jev 调用 + 一次 LLM 解题
pnpm smoke:live

# EvoMap
pnpm evomap status            # 连通性（公开接口，无需认证）
pnpm evomap search "verify multi-step arithmetic by recomputing" --limit 3
pnpm evomap node              # 注册本机为 EvoMap 节点，打开输出的 claim URL 认领（只需一次）
pnpm evomap validate-sample   # 用示例 bundle 试发，确认 hub 接受格式后再开启发布
```

生产方式：`pnpm build && pnpm start`，看板由服务端托管在 `http://127.0.0.1:8787`。看板上可以启动运行、加入新 cell、入侵、Jev 故障、注入回声、杀节点、查看注册表 / 协议轨迹 / 经验库 / 研究报告。

`pnpm bench` 参数：`--mode <mode[,mode...]|all> --n --cells --seed --judge jev|mock --llm openrouter|mock --sim-pace 1-40 --source synthetic|gsm8k --difficulty normal|hard --path --max-cost --vote-budget --inherit --library-dir --evomap-lookup --cell-models a,b --research "<idea>" --claims --canaries`。`--sim-pace N` 把模拟 provider 的延迟乘以 N（默认 1；10 约等于真实运行节奏，断网兜底演示用）。`all` 的顺序是 swarm-jev 先跑，它的总 token 作为 single-vote 的预算（除非给了 `--vote-budget`）。对比表增加 `coord_share`、`pass_err`、`false_acc_verified`、`esc_rate` 列；完整结果写入 `runs/compare-<时间戳>.json`。每次运行写入 `runs/<runId>/`（`events.jsonl`、`ledger.jsonl`、`summary.json`，研究场景另有 `report.md`）。服务端只接受 `data/` 目录内的 gsm8k 文件。

EvoMap 节点文件默认在 `~/.config/parallelize/evomap-node.json`（`EVOMAP_NODE_FILE` 可覆盖），不会写进仓库或云同步目录。

## 指标 / Metrics

- 准确率：正确数 / 任务数，未接受的任务算错。研究场景只有金丝雀有真值，看板显示 N/A，bench 显示金丝雀准确率并加 `*`。
- Token：总量、工作（solve / single / report）、协调（其余全部，包括 plan），以及协调占比 `coordinationShare`。
- AIR：每千 token 的正确答案数。升级率：结束在 System 2 的判断占比。
- `passThroughErrorRate`：System 1 独自判定"无需复核"的提案里，实际答错的比例。
- `falseAcceptRate`：接受的答案里错的比例。`falseAcceptVerifiedRate`：有至少 2 个独立来源的接受答案里错的比例，衡量通过复核的相关错误。
- 另有回声警报、故障回收、基因采纳、隔离数、经验命中、继承基因数、Jev 是否离线。

## 架构 / Architecture

```
         ┌───────────── Blackboard (tasks, leases, proposals) ─────────────┐
         │ open ─claim─> claimed ─propose─> verifying ─independent─> accepted │
         └──────▲───────────────────▲──────────────────────▲────────────────┘
                │ rule claim (0 tok)│ scoped handle        │ lease expiry -> reopen
   ┌────────────┴──┐  genes  ┌──────┴───────┐  genes  ┌─────┴────────┐
   │ cell c01      │<──────> │ cell c02     │<──────> │ cell c05 (+) │  spawned mid-run, own model
   └──┬────────┬───┘         └──────────────┘         └──────────────┘
      │ solve  │ verify / adopt / dispute (only what rules cannot decide)
      v        v
   ┌──────┐  ┌────────────────────────────┐        Registry: capability cards, discover
   │ LLM  │  │ EscalatingJudge            │        Trust: Beta ledger -> review / quarantine
   │      │  │  Jev (S1) --low conf--> LLM│        Library: runs/library + EvoMap search/publish
   └──────┘  │  <- confirmed precedents   │        Lineage: independent sources, recollision
             └────────────────────────────┘
   every call metered (ledger, cost cap) · fault switches · events -> WebSocket -> dashboard (web/)
```

代码结构：`src/core`（契约、黑板、血缘、账本、指标）、`src/protocol`（消息、注册表、受限句柄、经验库）、`src/providers`（Jev、OpenAI 兼容 LLM、EvoMap、故障开关、模拟器、按模式组装的 provider 栈）、`src/judge`（升级、判例、dispute、校准）、`src/swarm`（cell、蜂群、基因、信任、注入过滤、对抗者）、`src/tasks`（合成题、gsm8k、想法验证）、`src/modes`（基线、同预算投票、研究报告、EvoMap 验证门与发布）、`src/run.ts`、`src/server.ts`、`src/cli`、`web/`。

## 局限 / Limitations

- Jev 不是神器。2026-09-23 在 48 道真实困难题上实测（DeepSeek V4.1 Flash 关闭推理作答，答对 30/48）：Jev 对"这个答案要不要复核"的区分度 AUC 0.67，错答案的平均概率 0.52、对答案 0.40，而且把握 |2p-1| 通常很小，原先 0.5 的升级门槛会让 40/48 的判断升级。因此真实运行默认升级门槛 0.2、复核门槛 0.4（`src/config.ts`，可显式覆盖）：约四分之一的判断升级，一半答案送去复核，能抓住三分之二的错答案。运行摘要里有按 verify 分箱的校准数据，校准守卫会在某类判断与大模型分歧过大时自动绕开 Jev。
- 同一个基础模型会犯相关错误：独立来源计数只能识别血缘上的依赖，两个用同一模型的 cell 可能独立地犯同一个错。`falseAcceptVerifiedRate` 专门量化这件事；用 `cellModels` 混用不同模型可以缓解，但不能消除。
- `--llm mock` / `--judge mock` 是模拟：结果来自设定的准确率、延迟和计费公式，用于演示机制和回归测试，不能当作真实模型的评测。看板和汇总会标注 SIMULATION。模拟中 swarm-jev 的协调 token 仍以 adopt / verify 升级到 System 2 为主；规则认领把认领的 token 降到了零，但第二轮还没有用真实 Jev 重新测量。
- 第一轮的真实测量（8 题 swarm-jev，升级率 0.65，协调 17.5k token 对工作 2.2k token，主要来自裁判认领）是第二轮改成规则认领的原因。
- 模型与网络：默认做题模型是 `deepseek/deepseek-v4.1-flash`，因为部分 OpenRouter 账户被限制使用闭源模型（Anthropic、Google、OpenAI）；可用 `LLM_MODEL` 改成 `anthropic/claude-haiku-4.5`（与 EvoMap 实验同款）。Node 自带的 fetch 默认不读 `HTTPS_PROXY`，在需要代理的网络里直连会在并发时被重置、重试后单次调用拖到约 10 秒，所以所有脚本都以 `--use-env-proxy` 启动。OpenRouter 上开源模型的供应商负载波动很大，同一组请求的中位延迟可以在 1.4 秒和 14 秒之间变化。
- 默认题目是合成的算术、速率、逻辑题（带种子、可复现），比真实基准简单；gsm8k 需要自备 `data/` 下的 jsonl 文件。
- 想法验证场景里的裁决来自模型自身知识，不是联网检索；金丝雀只检验这种知识判断是否可靠。bench 对每种模式分别调用一次规划器（温度 0），论断通常一致但不保证完全相同。
- EvoMap 发布：捆绑包格式已在真实 hub 上通过 `/a2a/validate`（`valid: true`、`dry_run: true`、无警告）。hub 要求 Capsule 的 `blast_radius` 文件数和行数都大于 0、`validation` 必须是不含管道符的 node/npm/npx 命令；这里如实把"采用这条 Gene"表述为"往策略库新增 1 个策略文件"，验证命令复核记录下来的留出集 A/B 数字是否达到发布门槛，内容字段里写明它不重跑实验。首次使用先运行 `pnpm evomap node` 和 `pnpm evomap validate-sample`。
- 面向外部 Agent 的 WebSocket 协议绑定已设计（见 PROTOCOL.md），尚未实现；当前所有 Agent 都在进程内。
