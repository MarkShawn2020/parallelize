import { describe, expect, it } from "vitest";
import { SYNTHETIC_DOMAINS, createRng, leaksAnswer } from "./synthetic";
import type { SyntheticDomain } from "./synthetic";
import { HARD_TEMPLATES } from "./synthetic-hard";

// Each solver reads only the prompt text and reaches the answer its own way (brute force or step-by-step
// simulation where possible), so a template whose wording and answer disagree is caught.

/** Every capture group of `re` as a number; the tuple type lets callers destructure up to three groups. */
function nums(prompt: string, re: RegExp): [number, number, number] {
  const m = re.exec(prompt);
  if (!m || m.slice(1).some((g) => g === undefined)) throw new Error(`no match for ${re} in: ${prompt}`);
  return m.slice(1).map(Number) as [number, number, number];
}
const num = (prompt: string, re: RegExp): number => nums(prompt, re)[0]!;
function word(prompt: string, re: RegExp): string {
  const m = re.exec(prompt);
  if (!m?.[1]) throw new Error(`no match for ${re} in: ${prompt}`);
  return m[1];
}
const sentences = (prompt: string) => prompt.split(/(?<=[.?])\s+(?=[A-Z0-9])/);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function clockMinutes(s: string): number {
  const [, h, m, half] = /^(\d+):(\d\d) ([ap])\.m\.$/.exec(s) ?? [];
  if (h === undefined) throw new Error(`bad clock ${s}`);
  return ((Number(h) % 12) + (half === "p" ? 12 : 0)) * 60 + Number(m);
}
function seconds(s: string): number {
  const part = (re: RegExp) => Number(re.exec(s)?.[1] ?? 0);
  return part(/(\d+) hours?/) * 3600 + part(/(\d+) minutes?/) * 60 + part(/(\d+) seconds?/);
}
function only<T>(solutions: T[]): T {
  expect(solutions).toHaveLength(1);
  return solutions[0]!;
}

const CLOCK = String.raw`(\d+:\d\d [ap]\.m\.)`;
const WHEELS: Record<string, number> = { motorcycles: 2, cars: 4, "six-wheeled trucks": 6, bicycles: 2, tricycles: 3, "quad bikes": 4 };
const TIMES: Record<string, number> = { twice: 2, "three times": 3, "four times": 4 };
const ORDINALS: Record<string, number> = { third: 3, fourth: 4, fifth: 5 };

const SOLVERS: Record<SyntheticDomain, Array<(p: string) => number>> = {
  arithmetic: [
    // raffle
    (p) => {
      const price = num(p, /tickets at \$(\d+) each/);
      const first = num(p, /sells (\d+) tickets\./);
      const second = first + num(p, /sells (\d+) more tickets than/);
      const third = 2 * second - num(p, /sells (\d+) fewer than twice as many tickets as/);
      const [cents, printed] = nums(p, /charged (\d+) cents for every ticket printed, and (\d+) tickets were printed/);
      const pct = num(p, /keep (\d+)% of the total ticket sales/);
      const takingsCents = (first + second + third) * price * 100;
      return (takingsCents - (takingsCents * pct) / 100 - printed * cents) / 100;
    },
    // two shops: walk the deal shop's items one by one
    (p) => {
      const [qa, qb] = nums(p, /needs (\d+) .+? and (\d+) .+? and will buy/);
      const [pa, pb, pct] = nums(p, /costs \$(\d+) and a [a-z ]+ costs \$(\d+), and the whole bill gets (\d+)% off/);
      const [da, db] = nums(p, /costs \$(\d+) and a [a-z ]+ costs \$(\d+) with no discount/);
      const every = ORDINALS[word(p, /every (third|fourth|fifth) /)]!;
      let deal = qb * db;
      for (let item = 1; item <= qa; item++) if (item % every !== 0) deal += da;
      const discounted = ((qa * pa + qb * pb) * (100 - pct)) / 100;
      return Math.abs(discounted - deal);
    },
    // payroll: pay each hour at its own rate
    (p) => {
      const rates = [...p.matchAll(/earns \$(\d+) an hour/g)].map((m) => Number(m[1]));
      const ha = num(p, /worked (\d+) hours,/);
      const [perDay, days] = nums(p, /worked (\d+) minutes on each of (\d+) days/);
      const hours = [ha, ha - num(p, /worked (\d+) hours fewer than/), (perDay * days) / 60];
      let total = 0;
      hours.forEach((h, i) => {
        for (let hour = 1; hour <= h; hour++) total += hour > 40 ? rates[i]! * 1.5 : rates[i]!;
      });
      return total;
    },
    // flour: add sacks until the need is covered
    (p) => {
      const [loaves1, grams1] = nums(p, /bakes (\d+) loaves a day, each using (\d+) grams/);
      const [loaves2, pct] = nums(p, /bakes (\d+) loaves a day, each using (\d+)% more flour/);
      const [sackKg, price] = nums(p, /whole (\d+)-kg sacks at \$(\d+) per sack/);
      const days = num(p, /cover (\d+) days/);
      const needGrams = days * (loaves1 * grams1 + (loaves2 * grams1 * (100 + pct)) / 100);
      let sacks = 0;
      while (sacks * sackKg * 1000 < needGrams) sacks++;
      return sacks * price;
    },
  ],
  rates: [
    // two tanks: step minute by minute until the levels meet
    (p) => {
      const [a, b] = nums(p, /contains (\d+) liters of water and [a-z ]+ contains (\d+) liters/);
      const drainPerMinute = num(p, /drains [a-z ]+ at (\d+) liters per hour/) / 60;
      const leak = num(p, /leaks (\d+) liters per minute/);
      const [delay, hose] = nums(p, /(\d+) minutes after [^,]+, a hose starts filling [a-z ]+ at (\d+) liters per minute/);
      let [fill, drain] = [a, b];
      for (let t = 0; t < 10_000; t++) {
        if (fill === drain) return fill + drain;
        fill += (t >= delay ? hose : 0) - leak;
        drain -= drainPerMinute;
      }
      throw new Error("tanks never level");
    },
    // trains: advance both a minute at a time, in units of 1/60 m
    (p) => {
      const km = num(p, /are (\d+) km apart/);
      const first = new RegExp(String.raw`leaves (\w+) for \w+ at ${CLOCK} and runs at a steady (\d+) km/h`).exec(p)!;
      const [depart2, metersPerMinute] = new RegExp(String.raw`at ${CLOCK} on the other track and runs at a steady (\d+) meters per minute`)
        .exec(p)!
        .slice(1);
      const [start2, v2] = [clockMinutes(depart2!), Number(metersPerMinute)];
      const [town, v1] = [first[1], Number(first[3])];
      let [x1, x2] = [0, 0];
      for (let t = clockMinutes(first[2]!); x1 + x2 < km * 60_000; t++) {
        x1 += v1 * 1000;
        if (t >= start2) x2 += v2 * 60;
      }
      expect(x1 + x2).toBe(km * 60_000);
      return (word(p, /How many kilometers from (\w+)/) === town ? x1 : x2) / 60_000;
    },
    // three machines: run the job minute by minute
    (p) => {
      const perMinute = Object.fromEntries(
        [...p.matchAll(/ ([ABC]) \w+ (\d+) \w+ per (minute|hour)/g)].map((m) => [m[1], Number(m[2]) / (m[3] === "hour" ? 60 : 1)]),
      );
      const total = num(p, /is (\d+) (?:pages|bottles|parcels)\./);
      const start = clockMinutes(word(p, new RegExp(`At ${CLOCK}, \\w+ A and \\w+ B start`)));
      const swap = clockMinutes(word(p, new RegExp(`At ${CLOCK}, \\w+ B is switched off`)));
      let [done, byA] = [0, 0];
      for (let t = start; done < total; t++) {
        done += perMinute.A! + (t < swap ? perMinute.B! : perMinute.C!);
        byA += perMinute.A!;
      }
      expect(done).toBe(total);
      return byA;
    },
    // vans: add up the diesel day by day
    (p) => {
      const [d1, days1, c1] = nums(p, /drove (\d+) km on each of its (\d+) working days, using (\d+) liters/);
      const [d2, days2, c2] = nums(p, /drove (\d+) km on each of its (\d+) working days and normally uses (\d+) liters/);
      const heavy = num(p, /on (\d+) of those days/);
      const pct = num(p, /used (\d+)% more fuel/);
      let liters = 0;
      for (let day = 0; day < days1; day++) liters += (d1 * c1) / 100;
      for (let day = 0; day < days2; day++) liters += (d2 * c2 * (day < heavy ? 100 + pct : 100)) / 10_000;
      return liters;
    },
  ],
  logic: [
    // ages: try every age for the youngest
    (p) => {
      const gapYears = num(p, /is (\d+) months older than/) / 12;
      const times = TIMES[word(p, /is (twice|three times|four times) as old as/)]!;
      const [ago, total] = nums(p, /(\d+) years ago, the ages of .+? added up to (\d+)\./);
      const ahead = num(p, /ages be (\d+) years from now/);
      const answers: number[] = [];
      for (let c = 1; c <= 120; c++) {
        const [a, b] = [times * c, c + gapYears];
        if (a - ago + (b - ago) + (c - ago) === total) answers.push(a + b + 2 * ahead);
      }
      return only(answers);
    },
    // collections: propagate every stated relation outward from the known counts
    (p) => {
      const unit = word(p, /collect ([a-z ]+)\./);
      const known = new Map<string, number>();
      const rels: Array<{ x: string; y: string; to: (y: number) => number; from: (x: number) => number }> = [];
      for (const s of sentences(p)) {
        let m: RegExpExecArray | null;
        if ((m = new RegExp(`^(\\w+) has (\\d+) ${unit}\\.$`).exec(s))) known.set(m[1]!, Number(m[2]));
        else if ((m = new RegExp(`^(\\w+) has (\\d+) (more|fewer) ${unit} than (\\w+)\\.$`).exec(s))) {
          const d = (m[3] === "more" ? 1 : -1) * Number(m[2]);
          rels.push({ x: m[1]!, y: m[4]!, to: (y) => y + d, from: (x) => x - d });
        } else if ((m = new RegExp(`^(\\w+) has (\\d+)% (more|fewer) ${unit} than (\\w+)\\.$`).exec(s))) {
          const k = m[3] === "more" ? 100 + Number(m[2]) : 100 - Number(m[2]);
          rels.push({ x: m[1]!, y: m[4]!, to: (y) => (y * k) / 100, from: (x) => (x * 100) / k });
        } else if ((m = new RegExp(`^(\\w+) has (twice|three times) as many ${unit} as (\\w+)\\.$`).exec(s))) {
          const k = TIMES[m[2]!]!;
          rels.push({ x: m[1]!, y: m[3]!, to: (y) => y * k, from: (x) => x / k });
        }
      }
      expect(rels).toHaveLength(4);
      for (let changed = true; changed; ) {
        changed = false;
        for (const r of rels) {
          if (known.has(r.y) && !known.has(r.x)) known.set(r.x, r.to(known.get(r.y)!));
          else if (known.has(r.x) && !known.has(r.y)) known.set(r.y, r.from(known.get(r.x)!));
          else continue;
          changed = true;
        }
      }
      const [, a, b] = /do (\w+) and (\w+) have together/.exec(p)!;
      return known.get(a!)! + known.get(b!)!;
    },
    // survey: inclusion-exclusion from the percentages
    (p) => {
      const total = num(p, /asked (\d+)/);
      const sets = [...p.matchAll(/(\d+)% /g)].map((m) => (Number(m[1]) * total) / 100);
      const pairs = [...p.matchAll(/(\d+) \w+ both/g)].map((m) => Number(m[1]));
      const all = num(p, /includes the (\d+)/);
      expect([sets.length, pairs.length]).toEqual([3, 3]);
      const exactlyTwo = sum(pairs) - 3 * all;
      const anyOfThem = sum(sets) - sum(pairs) + all;
      const ask = word(p, /(none|exactly one|exactly two) of the three\?/);
      return ask === "none" ? total - anyOfThem : ask === "exactly two" ? exactlyTwo : anyOfThem - exactlyTwo - all;
    },
    // vehicles: try every split of the vehicles that are not the percentage kind
    (p) => {
      const kinds = /only (.+?), (.+?) and (.+?)(?: for hire)?\./.exec(p)!.slice(1) as [string, string, string];
      const [vehicles, wheels] = nums(p, /there are (\d+) vehicles with (\d+) wheels/);
      const pct = num(p, /exactly (\d+)% of the vehicles/);
      const heavy = word(p, /% of the vehicles are ([a-z -]+)\./);
      const asked = word(p, /collected from the ([a-z -]+) if/);
      const fee = num(p, new RegExp(`${asked.charAt(0).toUpperCase()}${asked.slice(1)} are charged \\$(\\d+)`));
      const hours = num(p, /for (\d+) hours\?/);
      const heavyCount = (vehicles * pct) / 100;
      const [k0, k1] = kinds.filter((k) => k !== heavy) as [string, string];
      const counts: Array<Record<string, number>> = [];
      for (let n0 = 0; n0 <= vehicles - heavyCount; n0++) {
        const n1 = vehicles - heavyCount - n0;
        if (n0 * WHEELS[k0]! + n1 * WHEELS[k1]! + heavyCount * WHEELS[heavy]! === wheels) counts.push({ [k0]: n0, [k1]: n1 });
      }
      return only(counts)[asked]! * fee * hours;
    },
    // beacons: tick through every second of the window
    (p) => {
      const periods = sentences(p)
        .map((s) => /^The \w+ (?:light|beacon) (?:flashes|blinks) once every (.+)\.$/.exec(s)?.[1])
        .filter((d): d is string => d !== undefined)
        .map(seconds);
      expect(periods).toHaveLength(3);
      const span = seconds(word(p, /during the first (.+)\?$/));
      let together = 0;
      for (let t = 0; t < span; t++) if (periods.every((q) => t % q === 0)) together++;
      return together;
    },
  ],
};

describe("hard templates", () => {
  it("has at least four templates per domain", () => {
    for (const domain of SYNTHETIC_DOMAINS) expect(HARD_TEMPLATES[domain].length).toBeGreaterThanOrEqual(4);
  });

  it("gives a positive integer answer that an independent solver reproduces from the prompt alone", () => {
    for (const domain of SYNTHETIC_DOMAINS) {
      expect(SOLVERS[domain]).toHaveLength(HARD_TEMPLATES[domain].length);
      HARD_TEMPLATES[domain].forEach((template, i) => {
        for (let seed = 0; seed < 150; seed++) {
          const { prompt, answer } = template(createRng(seed * 37 + i));
          const label = `${domain}#${i} seed ${seed * 37 + i}: ${prompt}`;
          expect(Number.isSafeInteger(answer) && answer > 0, label).toBe(true);
          expect(prompt, label).not.toMatch(/undefined|NaN|\[object|\d,\d{3}/);
          expect(SOLVERS[domain][i]!(prompt), label).toBe(answer);
        }
      });
    }
  });

  it("adds two or three distractor facts and never repeats a sentence", () => {
    for (const domain of SYNTHETIC_DOMAINS) {
      HARD_TEMPLATES[domain].forEach((template, i) => {
        const lengths = new Set<number>();
        for (let seed = 0; seed < 60; seed++) {
          const parts = sentences(template(createRng(seed)).prompt);
          expect(new Set(parts).size, `${domain}#${i}`).toBe(parts.length);
          lengths.add(parts.length);
        }
        // Same template, same facts: only the distractor count (2 or 3) changes the sentence count.
        expect(lengths.size, `${domain}#${i}`).toBe(2);
      });
    }
  });

  it("varies its wording within a template", () => {
    for (const domain of SYNTHETIC_DOMAINS) {
      HARD_TEMPLATES[domain].forEach((template) => {
        const prompts = new Set(Array.from({ length: 20 }, (_, s) => template(createRng(s)).prompt));
        expect(prompts.size).toBe(20);
      });
    }
  });
});

describe("hand-checked hard answers", () => {
  // One instance per template, worked through by hand from the prompt; the working is in each comment.
  it.each([
    // 74 + 98 + (2*98-8=188) = 360 tickets * $3 = 1080; keep 15% = 162; printing 400 * 4c = 16; 1080-162-16
    ["arithmetic", 0, "The chess club, the drama club and the robotics club", 902],
    // QuickShop (13*30 + 8*35) * 0.9 = 603; Main Street 4 free -> 9*29 + 8*35 = 541
    ["arithmetic", 1, "Tomas needs 13 sketchbooks and 8 sets of paints", 62],
    // Noah 40*22 + 8*33 = 1144; Ines 45 h: 40*14 + 5*21 = 665; Amara 504*5/60 = 42 h: 40*30 + 2*45 = 1290
    ["arithmetic", 2, "A garden center pays three staff", 3099],
    // (96*480 + 48*720) * 5 = 403200 g = 403.2 kg -> 17 sacks of 25 kg * $34
    ["arithmetic", 3, "Corner Loaf bakes 96 loaves", 578],
    // at 6 min: 410-24 = 386 vs 608-54 = 554; gap 168 closes at (9-4)+9 = 14/min -> 12 min; 386+60 = 446 each
    ["rates", 0, "the upper tank contains 410 liters", 892],
    // 30 min head start at 88 km/h = 44 km; 1600 m/min = 96 km/h; 138 km at 184 km/h = 45 min; 44 + 66
    ["rates", 1, "Hollin and Bramley are 182 km apart", 110],
    // C = 30/min; 37 min at 60/min = 2220; 2100 left at 70/min = 30 min; A: 40 * 67
    ["rates", 2, "Line A fills 40 bottles per minute", 2680],
    // old van 200*18*12/100 = 432; new van 16 L/day, 28 L on heavy days: 4*16 + 20*28 = 624
    ["rates", 3, "the old van drove 200 km on each of its 18 working days", 1056],
    // 2 years ago: (4N-2) + N + (N-2) = 74 -> N = 13; Sofia 52, Elena 15; +4 each
    ["logic", 0, "Sofia is four times as old as Noah", 75],
    // Lucas 268 -> Yusuf 260 -> Elena 312 -> Aiko 936 -> Tomas 897
    ["logic", 1, "Lucas, Tomas, Yusuf, Elena and Aiko collect coins", 1209],
    // French 168, music 132, chemistry 120; only-one: (168-33-55+7) + (132-33-34+7) + (120-55-34+7)
    ["logic", 2, "A survey asked 600 students", 197],
    // 8 trucks; 2m + 4c = 118 - 48, m + c = 24 -> c = 11, m = 13; 13 * $6 * 2
    ["logic", 3, "32 vehicles with 118 wheels", 156],
    // lcm(75, 40, 48) = 1200 s; 4010 s -> coincidences at 0, 1200, 2400, 3600
    ["logic", 4, "The red beacon blinks once every 1 minute and 15 seconds", 4],
  ] as const)("%s hard template #%i (%s) answers %i", (domain, index, fragment, expected) => {
    const { prompt, answer } = HARD_TEMPLATES[domain][index]!(createRng(500 + index));
    expect(prompt).toContain(fragment);
    expect(answer).toBe(expected);
    expect(leaksAnswer(prompt, expected)).toBe(false);
  });
});
