"""复现论文《用决策模型替换多智能体系统中的大模型判断》的全部数字。
在仓库根目录运行：python3 docs/paper/analyze.py
依赖：仅标准库。输入：runs/<runId>/{events,ledger}.jsonl（每个执行者行按 ROW_SEEDS 用 pnpm matrix 选出）；
提案对错由 docs/paper/grade.ts 按种子重建题目、用系统自己的 checkAnswer 判定。
输出：docs/paper/data/{per-task-outcomes.csv, cells.json, tests.json, cost-model.json, judge-unit.json, rebound.json,
judge-quality.json}
"""
import csv, json, math, os, random, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "docs", "paper", "data")
# 与 scripts/judge-matrix.ts 的 JUDGE_PURPOSES 保持一致
JUDGE_PURPOSES = ("verify", "adopt", "adjudicate", "claim")
# 每个执行者行用哪些种子。7、11 是 v0.1 已看过的数据；13、17 的分配在跑之前定下：
# Sonnet 行准确率已在 95%–99.5%，接近天花板，同样的钱换来的不一致题对更少，所以只加 13。
ROW_SEEDS = {"Haiku 4.5": (7, 11, 13, 17), "Sonnet 5": (7, 11, 13)}
V01_SEEDS = (7, 11)
os.chdir(ROOT)

def load_matrix(seeds):
    tmp = os.path.join(OUT, "_matrix.json")
    subprocess.run(["./node_modules/.bin/tsx", "scripts/judge-matrix.ts", "--seeds", ",".join(map(str, seeds)),
                    "--json", tmp], check=True, capture_output=True)
    m = json.load(open(tmp)); os.remove(tmp); return m

def events(rid):
    with open(f"runs/{rid}/events.jsonl") as f:
        for l in f:
            try: yield json.loads(l)
            except json.JSONDecodeError: pass

DISPUTE_LOG = re.compile(r"^dispute on (t\d+): (.*) -> (.*)$")

def run_facts(rid):
    seed = None; metrics = None; outcomes = {}; reviews = 0
    accepted = []; verify = []; disputes = []; reasons = {}; latest = {}
    for e in events(rid):
        t = e.get("type")
        if t == "run.started": seed = e["config"]["seed"]
        elif t == "metrics": metrics = e["metrics"]
        elif t == "task.accepted":
            outcomes[e["taskId"]] = bool(e.get("correct")); accepted.append((e["taskId"], e["answer"], bool(e.get("correct"))))
        elif t == "task.verifying": reviews += 1
        elif t == "protocol.message":
            m = e["message"]
            if m["type"] == "PROPOSE": latest[(m["body"]["taskId"], m["from"])] = m["body"]["answer"]
            elif m["type"] == "REVIEW_REQUEST":
                r = m["body"].get("reason"); reasons[r] = reasons.get(r, 0) + 1
        elif t == "judge.decision" and e["decision"]["key"] == "verify":
            # 复核判断只在提案者刚提交、且只有一个有效提案时发出：判的就是该执行单元对这道题的最新提案
            d = e["decision"]
            verify.append((d["taskId"], latest[(d["taskId"], d["cellId"])], d["answer"]["noul"]))
        elif t == "log" and str(e.get("message", "")).startswith("dispute on "):
            tid, cands, win = DISPUTE_LOG.match(e["message"]).groups()
            disputes.append((tid, cands.split(" vs "), None if win.startswith("unclear") else win))
    judge_usd = solve = gene = 0.0; judge_calls = []
    with open(f"runs/{rid}/ledger.jsonl") as f:
        for l in f:
            x = json.loads(l); p = x.get("purpose")
            if p == "solve": solve += 1
            elif p == "gene": gene += 1
            elif p in JUDGE_PURPOSES:
                usd = x["usage"].get("costUsd", 0) or 0; judge_usd += usd; judge_calls.append((usd, x["latencyMs"]))
    return dict(runId=rid, seed=seed, correct=metrics["correct"], n=metrics["tasksTotal"], costUsd=metrics["costUsd"],
                wallS=metrics["elapsedMs"] / 1000, reviews=reviews, solveCalls=solve, geneCalls=gene,
                judgeUsd=judge_usd, judgeCalls=judge_calls, outcomes=outcomes,
                accepted=accepted, verify=verify, disputes=disputes, reasons=reasons)

def mcnemar_exact(b, c):
    n = b + c
    if n == 0: return 1.0
    k = min(b, c)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n
    return min(1.0, 2 * tail)

def holm(ps):
    order = sorted(range(len(ps)), key=lambda i: ps[i]); adj = [0.0] * len(ps); run = 0.0
    for rank, i in enumerate(order):
        run = max(run, min(1.0, (len(ps) - rank) * ps[i])); adj[i] = run
    return adj

def paired_bootstrap_ci(pairs, reps=20000, seed=20260924):
    rng = random.Random(seed); n = len(pairs); ds = []
    for _ in range(reps):
        s = 0
        for _ in range(n):
            a, b = pairs[rng.randrange(n)]; s += a - b
        ds.append(s / n)
    ds.sort(); return ds[int(0.025 * reps)], ds[int(0.975 * reps) - 1]

def grade(pairs):
    """[(seed, taskId, answer)] -> [bool]，与运行时的判分完全一致（见 main 里的自检）。"""
    r = subprocess.run(["./node_modules/.bin/tsx", "docs/paper/grade.ts"], check=True, capture_output=True, text=True,
                       input=json.dumps([dict(seed=a, taskId=b, answer=c) for a, b, c in pairs]))
    return json.loads(r.stdout)

def auc(pos, neg):
    """P(错提案的分数 > 对提案的分数)，平分记一半；按秩计算。"""
    xs = sorted([(v, 1) for v in pos] + [(v, 0) for v in neg]); ranks = [0.0] * len(xs); i = 0
    while i < len(xs):
        j = i
        while j + 1 < len(xs) and xs[j + 1][0] == xs[i][0]: j += 1
        for k in range(i, j + 1): ranks[k] = (i + j) / 2 + 1
        i = j + 1
    rp = sum(r for r, (_, lab) in zip(ranks, xs) if lab)
    return (rp - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg))

def auc_ci(pos, neg, reps=2000, seed=20260924):
    rng = random.Random(seed)
    bs = sorted(auc([rng.choice(pos) for _ in pos], [rng.choice(neg) for _ in neg]) for _ in range(reps))
    return bs[int(0.025 * reps)], bs[int(0.975 * reps) - 1]

def judge_quality(cells, threshold=0.4):
    """复核判断的判别力、分歧裁决的正确率、复核请求的来源。"""
    pairs = []; ix = {}
    def at(seed, tid, ans):
        k = (seed, tid, ans)
        if k not in ix: ix[k] = len(pairs); pairs.append(k)
        return ix[k]
    for c in cells:
        for r in c["runs"]:
            for tid, ans, _ in r["accepted"]: at(r["seed"], tid, ans)
            for tid, ans, _ in r["verify"]: at(r["seed"], tid, ans)
            for tid, cands, _ in r["disputes"]:
                for a in cands: at(r["seed"], tid, a)
    ok = grade(pairs)
    bad = [(c["executor"], c["judge"], r["seed"], tid) for c in cells for r in c["runs"]
           for tid, ans, flag in r["accepted"] if ok[ix[(r["seed"], tid, ans)]] != flag]
    if bad: sys.exit(f"判分与运行时标记不一致：{bad[:5]}")

    def verify_block(recs):
        wrong = [sc for good, sc in recs if not good]; right = [sc for good, sc in recs if good]
        lo, hi = auc_ci(wrong, right)
        return dict(judgments=len(recs), wrongProposals=len(wrong),
                    flagRate=sum(sc >= threshold for _, sc in recs) / len(recs),
                    hitRate=sum(sc >= threshold for sc in wrong) / len(wrong),
                    falseAlarmRate=sum(sc >= threshold for sc in right) / len(right),
                    auc=auc(wrong, right), auc95=[lo, hi])

    def dispute_block(recs):
        out = dict(disputes=len(recs), unclear=0, oneCorrect=0, pickedCorrect=0, pickedWrong=0, oneCorrectUnclear=0)
        for good, win in recs:
            if win is None: out["unclear"] += 1
            if sum(good.values()) != 1: continue
            out["oneCorrect"] += 1
            if win is None: out["oneCorrectUnclear"] += 1
            elif good[win]: out["pickedCorrect"] += 1
            else: out["pickedWrong"] += 1
        return out

    q = dict(threshold=threshold, gradedAccepted=sum(len(r["accepted"]) for c in cells for r in c["runs"]),
             verify=[], dispute=[], reviewReasons=[])
    for j in ("Jev", "Haiku 4.5", "Sonnet 5", "Opus 5"):
        for ex in list(ROW_SEEDS) + ["pooled"]:
            rs = [r for c in cells if c["judge"] == j and ex in (c["executor"], "pooled") for r in c["runs"]]
            v = [(ok[ix[(r["seed"], tid, ans)]], sc) for r in rs for tid, ans, sc in r["verify"]]
            d = [({a: ok[ix[(r["seed"], tid, a)]] for a in cands}, win) for r in rs for tid, cands, win in r["disputes"]]
            q["verify"].append(dict(executor=ex, judge=j, **verify_block(v)))
            q["dispute"].append(dict(executor=ex, judge=j, **dispute_block(d)))
    for c in cells:
        keys = sorted({k for r in c["runs"] for k in r["reasons"]})
        q["reviewReasons"].append(dict(executor=c["executor"], judge=c["judge"],
                                       perRun={k: sum(r["reasons"].get(k, 0) for r in c["runs"]) / len(c["runs"]) for k in keys}))
    return q

def ols(xs, ys):
    n = len(xs); mx = sum(xs) / n; my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs); sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    b = sxy / sxx; a = my - b * mx
    ss_tot = sum((y - my) ** 2 for y in ys); ss_res = sum((y - (a + b * x)) ** 2 for x, y in zip(xs, ys))
    return a, b, 1 - ss_res / ss_tot

def main():
    os.makedirs(OUT, exist_ok=True)
    cells = []
    for seeds in sorted(set(ROW_SEEDS.values())):
        for c in load_matrix(seeds)["cells"]:
            if ROW_SEEDS.get(c["executor"]) != seeds: continue
            runs = [run_facts(r) for r in c["runIds"]]
            cells.append(dict(executor=c["executor"], judge=c["judge"], runs=runs))
    order = {ex: i for i, ex in enumerate(ROW_SEEDS)}
    cells.sort(key=lambda c: order[c["executor"]])
    for ex, seeds in ROW_SEEDS.items():
        n = sum(1 for c in cells if c["executor"] == ex)
        if n != 5: sys.exit(f"{ex} 行只凑齐 {n}/5 个格子（种子 {seeds}）")

    with open(os.path.join(OUT, "per-task-outcomes.csv"), "w", newline="") as f:
        w = csv.writer(f); w.writerow(["executor", "judge", "seed", "taskId", "correct", "runId"])
        for c in cells:
            for r in c["runs"]:
                for tid, ok in sorted(r["outcomes"].items()):
                    w.writerow([c["executor"], c["judge"], r["seed"], tid, int(ok), r["runId"]])

    summary = []
    for c in cells:
        rs = c["runs"]
        summary.append(dict(executor=c["executor"], judge=c["judge"],
                            correct=sum(r["correct"] for r in rs), n=sum(r["n"] for r in rs),
                            costUsd=sum(r["costUsd"] for r in rs) / len(rs), wallS=sum(r["wallS"] for r in rs) / len(rs),
                            seeds=[r["seed"] for r in rs],
                            reviews=[r["reviews"] for r in rs], solveCalls=sum(r["solveCalls"] for r in rs) / len(rs),
                            judgeUsd=sum(r["judgeUsd"] for r in rs) / len(rs),
                            perSeed={str(r["seed"]): dict(correct=r["correct"], costUsd=r["costUsd"], wallS=r["wallS"],
                                                          reviews=r["reviews"], solveCalls=r["solveCalls"],
                                                          judgeCalls=len(r["judgeCalls"])) for r in rs},
                            runIds=[r["runId"] for r in rs]))
    json.dump(summary, open(os.path.join(OUT, "cells.json"), "w"), ensure_ascii=False, indent=1)

    # 每个执行者行一族检验（Jev 对其余四个判断者），族内 Holm 校正。
    # pooled = 该行全部种子；v01 = v0.1 的种子 7、11；new = v0.1 之后新跑的种子，作为对 v0.1 方向的样本外复现。
    pick = {"pooled": lambda s: True, "v01": lambda s: s in V01_SEEDS, "new": lambda s: s not in V01_SEEDS}
    tests = []
    for subset in pick:
        for ex in ROW_SEEDS:
            keep = [s for s in ROW_SEEDS[ex] if pick[subset](s)]
            if not keep: continue
            row = [c for c in cells if c["executor"] == ex]
            jev = next(c for c in row if c["judge"] == "Jev")
            jv = {(r["seed"], t): ok for r in jev["runs"] if r["seed"] in keep for t, ok in r["outcomes"].items()}
            block = []
            for other in row:
                if other["judge"] == "Jev": continue
                ov = {(r["seed"], t): ok for r in other["runs"] if r["seed"] in keep for t, ok in r["outcomes"].items()}
                keys = sorted(set(jv) & set(ov))
                pairs = [(int(jv[k]), int(ov[k])) for k in keys]
                b = sum(1 for a, o in pairs if a and not o); cc = sum(1 for a, o in pairs if o and not a)
                lo, hi = paired_bootstrap_ci(pairs)
                block.append(dict(subset=subset, seeds=keep, executor=ex, jev="Jev", other=other["judge"], n=len(pairs),
                                  jevOnly=b, otherOnly=cc, diffPp=100 * (b - cc) / len(pairs), ci95Pp=[100 * lo, 100 * hi],
                                  p=mcnemar_exact(b, cc)))
            for t, a in zip(block, holm([t["p"] for t in block])): t["pHolm"] = a
            tests += block
    json.dump(tests, open(os.path.join(OUT, "tests.json"), "w"), ensure_ascii=False, indent=1)

    model = {}
    for ex in sorted({c["executor"] for c in cells}):
        xs = []; ys = []
        for c in cells:
            if c["executor"] != ex: continue
            for r in c["runs"]:
                xs.append(r["solveCalls"]); ys.append(r["costUsd"] - r["judgeUsd"])
        a, b, r2 = ols(xs, ys)
        model[ex] = dict(interceptUsd=a, usdPerSolve=b, r2=r2, points=len(xs))
    for ex in model:
        xs = []; ys = []
        for c in cells:
            if c["executor"] != ex: continue
            for r in c["runs"]:
                xs.append(r["solveCalls"]); ys.append(r["wallS"])
        a, b, r2 = ols(xs, ys)
        model[ex].update(wallInterceptS=a, secondsPerSolve=b, wallR2=r2)
    json.dump(model, open(os.path.join(OUT, "cost-model.json"), "w"), ensure_ascii=False, indent=1)

    # 单次判断的价格与延迟：该判断者所有格子、所有种子的判断调用合在一起
    unit = {}
    for judge in ("Jev", "Haiku 4.5", "Sonnet 5", "Opus 5"):
        calls = [x for c in cells if c["judge"] == judge for r in c["runs"] for x in r["judgeCalls"]]
        lat = sorted(ms for _, ms in calls); k = len(lat)
        unit[judge] = dict(calls=k, usdPerCall=sum(u for u, _ in calls) / k,
                           medianLatencyS=(lat[k // 2] if k % 2 else (lat[k // 2 - 1] + lat[k // 2]) / 2) / 1000)
    json.dump(unit, open(os.path.join(OUT, "judge-unit.json"), "w"), ensure_ascii=False, indent=1)

    # 回弹分解：把某个大模型判断者换成 Jev，判断层省下的钱 vs 多出的做题花的钱
    by = {(c["executor"], c["judge"]): c for c in summary}
    runs_of = {(c["executor"], c["judge"]): c["runs"] for c in cells}
    mean = lambda rs, k: sum(r[k] for r in rs) / len(rs)
    rebound = []
    for ex in model:
        jev = by[(ex, "Jev")]; cs = model[ex]["usdPerSolve"]
        # 样本外检验：只用 v0.1 种子拟合做题单价，预测新种子上的净变化
        old_runs = [r for (e, _), rs in runs_of.items() if e == ex for r in rs if r["seed"] in V01_SEEDS]
        cs_v01 = ols([r["solveCalls"] for r in old_runs], [r["costUsd"] - r["judgeUsd"] for r in old_runs])[1]
        new_jev = [r for r in runs_of[(ex, "Jev")] if r["seed"] not in V01_SEEDS]
        for other in ("Haiku 4.5", "Sonnet 5", "Opus 5"):
            o = by.get((ex, other))
            if not o: continue
            d_judge = jev["judgeUsd"] - o["judgeUsd"]
            d_solve = jev["solveCalls"] - o["solveCalls"]
            extra = d_solve * cs
            new_o = [r for r in runs_of[(ex, other)] if r["seed"] not in V01_SEEDS]
            nd_judge = mean(new_jev, "judgeUsd") - mean(new_o, "judgeUsd")
            nd_solve = mean(new_jev, "solveCalls") - mean(new_o, "solveCalls")
            rebound.append(dict(executor=ex, replaced=other, judgeSavingUsd=-d_judge, extraSolves=d_solve,
                                extraSolveUsd=extra, predictedNetUsd=d_judge + extra,
                                observedNetUsd=jev["costUsd"] - o["costUsd"],
                                reboundRatio=extra / -d_judge if d_judge < 0 else None,
                                outOfSample=dict(usdPerSolveV01=cs_v01, seeds=sorted({r["seed"] for r in new_jev}),
                                                 predictedNetUsd=nd_judge + nd_solve * cs_v01,
                                                 observedNetUsd=mean(new_jev, "costUsd") - mean(new_o, "costUsd"))))
    json.dump(rebound, open(os.path.join(OUT, "rebound.json"), "w"), ensure_ascii=False, indent=1)
    json.dump(judge_quality(cells), open(os.path.join(OUT, "judge-quality.json"), "w"), ensure_ascii=False, indent=1)
    print(json.dumps(dict(cells=len(cells), tests=len(tests), costModel=model), ensure_ascii=False, indent=1))

if __name__ == "__main__":
    main()
