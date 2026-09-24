"""复现论文《用决策模型替换多智能体系统中的大模型判断》的全部数字。
在仓库根目录运行：python3 docs/paper/analyze.py
依赖：仅标准库。输入：runs/<runId>/{events,ledger}.jsonl（由 pnpm matrix --seeds 7,11 选出）。
输出：docs/paper/data/{per-task-outcomes.csv, cells.json, tests.json, cost-model.json}
"""
import csv, json, math, os, random, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "docs", "paper", "data")
# 与 scripts/judge-matrix.ts 的 JUDGE_PURPOSES 保持一致
JUDGE_PURPOSES = ("verify", "adopt", "adjudicate", "claim")
os.chdir(ROOT)

def load_matrix():
    tmp = os.path.join(OUT, "_matrix.json")
    subprocess.run(["./node_modules/.bin/tsx", "scripts/judge-matrix.ts", "--seeds", "7,11", "--json", tmp],
                   check=True, capture_output=True)
    m = json.load(open(tmp)); os.remove(tmp); return m

def events(rid):
    with open(f"runs/{rid}/events.jsonl") as f:
        for l in f:
            try: yield json.loads(l)
            except json.JSONDecodeError: pass

def run_facts(rid):
    seed = None; metrics = None; outcomes = {}; reviews = 0
    for e in events(rid):
        t = e.get("type")
        if t == "run.started": seed = e["config"]["seed"]
        elif t == "metrics": metrics = e["metrics"]
        elif t == "task.accepted": outcomes[e["taskId"]] = bool(e.get("correct"))
        elif t == "task.verifying": reviews += 1
    judge_usd = solve = gene = 0.0
    with open(f"runs/{rid}/ledger.jsonl") as f:
        for l in f:
            x = json.loads(l); p = x.get("purpose")
            if p == "solve": solve += 1
            elif p == "gene": gene += 1
            elif p in JUDGE_PURPOSES: judge_usd += x["usage"].get("costUsd", 0) or 0
    return dict(runId=rid, seed=seed, correct=metrics["correct"], n=metrics["tasksTotal"], costUsd=metrics["costUsd"],
                wallS=metrics["elapsedMs"] / 1000, reviews=reviews, solveCalls=solve, geneCalls=gene,
                judgeUsd=judge_usd, outcomes=outcomes)

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

def ols(xs, ys):
    n = len(xs); mx = sum(xs) / n; my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs); sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    b = sxy / sxx; a = my - b * mx
    ss_tot = sum((y - my) ** 2 for y in ys); ss_res = sum((y - (a + b * x)) ** 2 for x, y in zip(xs, ys))
    return a, b, 1 - ss_res / ss_tot

def main():
    os.makedirs(OUT, exist_ok=True)
    m = load_matrix()
    cells = []
    for c in m["cells"]:
        runs = [run_facts(r) for r in c["runIds"]]
        cells.append(dict(executor=c["executor"], judge=c["judge"], runs=runs))

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
                            reviews=[r["reviews"] for r in rs], solveCalls=sum(r["solveCalls"] for r in rs) / len(rs),
                            judgeUsd=sum(r["judgeUsd"] for r in rs) / len(rs),
                            perSeed={str(r["seed"]): dict(correct=r["correct"], costUsd=r["costUsd"], wallS=r["wallS"],
                                                          reviews=r["reviews"], solveCalls=r["solveCalls"]) for r in rs},
                            runIds=[r["runId"] for r in rs]))
    json.dump(summary, open(os.path.join(OUT, "cells.json"), "w"), ensure_ascii=False, indent=1)

    tests = []
    for ex in sorted({c["executor"] for c in cells}):
        row = [c for c in cells if c["executor"] == ex]
        jev = next(c for c in row if c["judge"] == "Jev")
        jv = {(r["seed"], t): ok for r in jev["runs"] for t, ok in r["outcomes"].items()}
        block = []
        for other in row:
            if other["judge"] == "Jev": continue
            ov = {(r["seed"], t): ok for r in other["runs"] for t, ok in r["outcomes"].items()}
            keys = sorted(set(jv) & set(ov))
            pairs = [(int(jv[k]), int(ov[k])) for k in keys]
            b = sum(1 for a, o in pairs if a and not o); cc = sum(1 for a, o in pairs if o and not a)
            lo, hi = paired_bootstrap_ci(pairs)
            block.append(dict(executor=ex, jev="Jev", other=other["judge"], n=len(pairs), jevOnly=b, otherOnly=cc,
                              diffPp=100 * (b - cc) / len(pairs), ci95Pp=[100 * lo, 100 * hi], p=mcnemar_exact(b, cc)))
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

    # 回弹分解：把某个大模型判断者换成 Jev，判断层省下的钱 vs 多出的做题花的钱
    by = {(c["executor"], c["judge"]): c for c in summary}
    rebound = []
    for ex in model:
        jev = by[(ex, "Jev")]; cs = model[ex]["usdPerSolve"]
        for other in ("Haiku 4.5", "Sonnet 5", "Opus 5"):
            o = by.get((ex, other))
            if not o: continue
            d_judge = jev["judgeUsd"] - o["judgeUsd"]
            d_solve = jev["solveCalls"] - o["solveCalls"]
            extra = d_solve * cs
            rebound.append(dict(executor=ex, replaced=other, judgeSavingUsd=-d_judge, extraSolves=d_solve,
                                extraSolveUsd=extra, predictedNetUsd=d_judge + extra,
                                observedNetUsd=jev["costUsd"] - o["costUsd"],
                                reboundRatio=extra / -d_judge if d_judge < 0 else None))
    json.dump(rebound, open(os.path.join(OUT, "rebound.json"), "w"), ensure_ascii=False, indent=1)
    print(json.dumps(dict(cells=len(cells), tests=len(tests), costModel=model), ensure_ascii=False, indent=1))

if __name__ == "__main__":
    main()
