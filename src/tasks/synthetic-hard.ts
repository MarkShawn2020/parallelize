// Hard synthetic problems: 6-9 dependent steps, 2-3 distractor facts, at least one unit, rate or percentage
// conversion, and several entities to keep apart. Every template is built backwards so all intermediates stay
// whole numbers and the answer is one exact integer.
// Type-only imports: synthetic.ts imports HARD_TEMPLATES from here, so a value import would be circular.
import type { Rng, SyntheticDomain, Template } from "./synthetic";

const PEOPLE = [
  "Maya", "Liam", "Priya", "Diego", "Aiko", "Omar", "Sofia", "Chen", "Noah", "Amara", "Lucas", "Zara",
  "Ivan", "Leila", "Mateo", "Hana", "Kofi", "Elena", "Ravi", "Greta", "Tomas", "Nadia", "Yusuf", "Ines",
];
const TIMES: Record<number, string> = { 2: "twice", 3: "three times", 4: "four times" };
const ORDINAL: Record<number, string> = { 3: "third", 4: "fourth", 5: "fifth" };

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const lcm = (a: number, b: number) => (a / gcd(a, b)) * b;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const withArticle = (s: string) => `${/^[aeiou]/i.test(s) ? "an" : "a"} ${s}`;
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** Minutes after midnight as "9:05 a.m.". */
function clock(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "a.m." : "p.m."}`;
}

/** Seconds as "1 hour, 4 minutes and 10 seconds", leaving out zero parts. */
function duration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [h && plural(h, "hour"), m && plural(m, "minute"), s && plural(s, "second")].filter(
    (p): p is string => typeof p === "string",
  );
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** Slots 2-3 of the distractors in after random facts (never before the first one), then asks the question. */
function compose(r: Rng, facts: readonly string[], distractors: readonly string[], question: string): string {
  const out = facts.slice();
  for (const d of r.sample(distractors, r.int(2, 3))) out.splice(r.int(1, out.length), 0, d);
  return `${out.join(" ")} ${question}`;
}

// ---------------------------------------------------------------- arithmetic

const RAFFLE_GROUPS = [
  ["Class 6A", "Class 6B", "Class 6C"],
  ["the chess club", "the drama club", "the robotics club"],
  ["the red team", "the blue team", "the green team"],
  ["the morning shift", "the day shift", "the night shift"],
] as const;
const CAUSES = ["the animal shelter", "the children's hospital", "the food bank", "the library fund", "the flood relief fund"];

const raffle: Template = (r) => {
  const [x, y, z] = r.pick(RAFFLE_GROUPS);
  const cause = r.pick(CAUSES);
  const price = r.int(2, 5);
  const first = r.int(30, 80);
  const more = r.int(6, 25);
  const base = 4 * first + 3 * more;
  // This makes the tickets sold a multiple of 20, so any whole-number percentage of the takings is whole dollars.
  const fewer = (base % 20) + (base % 20 < 5 ? 20 : 0);
  const sold = base - fewer;
  const printed = 100 * Math.ceil((sold + r.int(10, 150)) / 100);
  const cents = r.int(4, 15);
  const pct = r.pick([10, 15, 20, 25, 30]);
  const takings = sold * price;
  const facts = [
    `${capitalize(x)}, ${y} and ${z} are selling raffle tickets at $${price} each to raise money for ${cause}.`,
    `${capitalize(x)} sells ${first} tickets.`,
    `${capitalize(y)} sells ${more} more tickets than ${x}.`,
    `${capitalize(z)} sells ${fewer} fewer than twice as many tickets as ${y}.`,
    `The printer charged ${cents} cents for every ticket printed, and ${printed} tickets were printed in total, including the unsold ones.`,
    `The printing bill is paid out of the ticket money, the organizers also keep ${pct}% of the total ticket sales for next year's event, and everything left goes to ${cause}.`,
  ];
  const distractors = [
    `The grand prize, a $${r.int(150, 400)} bicycle, was donated by a local shop.`,
    `${capitalize(x)} has ${r.int(18, 32)} members.`,
    `The draw takes place at ${r.int(5, 8)} p.m. on Friday.`,
    `Last year's raffle raised $${r.int(600, 1500)}.`,
  ];
  return {
    prompt: compose(r, facts, distractors, `How many dollars go to ${cause}?`),
    answer: takings - (takings * pct) / 100 - (printed / 100) * cents,
  };
};

const SHOPPING = [
  { a: ["sketchbook", "sketchbooks"], b: ["set of paints", "sets of paints"], extra: "brushes" },
  { a: ["notebook", "notebooks"], b: ["pack of pens", "packs of pens"], extra: "erasers" },
  { a: ["pack of paper plates", "packs of paper plates"], b: ["bag of balloons", "bags of balloons"], extra: "party hats" },
  { a: ["gas canister", "gas canisters"], b: ["headlamp", "headlamps"], extra: "tent pegs" },
] as const;
const STORES = ["Bright Mart", "Corner Store", "ValueHub", "Parkside Market", "QuickShop", "Main Street Supplies"];

const twoShops: Template = (r) => {
  const name = r.pick(PEOPLE);
  const kit = r.pick(SHOPPING);
  const [pctShop, dealShop] = r.sample(STORES, 2) as [string, string];
  const qa = r.int(6, 20);
  const qb = r.int(3, 12);
  // $5 price steps keep the subtotal a multiple of 5, so 20% and 40% off always come to whole dollars.
  const pa = 5 * r.int(1, 6);
  const pb = 5 * r.int(1, 8);
  const subtotal = qa * pa + qb * pb;
  const pct = r.pick([10, 15, 20, 25, 30, 40].filter((p) => (subtotal * p) % 100 === 0));
  const every = r.int(3, 5);
  const da = pa + r.int(-2, 3);
  const pctTotal = subtotal - (subtotal * pct) / 100;
  const paidItems = (qa - Math.floor(qa / every)) * da;
  const near = pb + r.int(-3, 2);
  // A tie would leave nothing to save, so nudge one price to break it.
  const db = paidItems + qb * near === pctTotal ? near + 1 : near;
  const dealTotal = paidItems + qb * db;
  const pctOffer = `At ${pctShop}, a ${kit.a[0]} costs $${pa} and a ${kit.b[0]} costs $${pb}, and the whole bill gets ${pct}% off at the till.`;
  const dealOffer =
    `At ${dealShop}, a ${kit.a[0]} costs $${da} and a ${kit.b[0]} costs $${db} with no discount on the bill, ` +
    `but every ${ORDINAL[every]} ${kit.a[0]} in an order is free.`;
  const facts = [
    `${name} needs ${qa} ${kit.a[1]} and ${qb} ${kit.b[1]} and will buy the whole order at one of two shops.`,
    ...(r.coin() ? [pctOffer, dealOffer] : [dealOffer, pctOffer]),
  ];
  const distractors = [
    `${dealShop} is ${r.int(2, 9)} km farther from ${name}'s home.`,
    `${pctShop} also sells ${kit.extra} at $${r.int(2, 6)} each, but ${name} does not need any.`,
    `Last month ${dealShop} had ${r.pick([15, 20, 30, 35])}% off everything.`,
  ];
  return {
    prompt: compose(
      r,
      facts,
      distractors,
      `By buying the whole order at the cheaper shop, how many dollars does ${name} save compared with the other shop?`,
    ),
    answer: Math.abs(pctTotal - dealTotal),
  };
};

const WORKPLACES = ["café", "bike shop", "bookshop", "bakery", "print shop", "garden center"];

const payroll: Template = (r) => {
  const [a, b, c] = r.sample(PEOPLE, 3) as [string, string, string];
  const place = r.pick(WORKPLACES);
  // Even hourly rates keep time-and-a-half pay whole.
  const [ra, rb, rc] = [2 * r.int(7, 16), 2 * r.int(7, 16), 2 * r.int(7, 16)];
  const ha = r.int(41, 50);
  const fewer = r.int(3, 12);
  const days = r.int(4, 6);
  const hc = r.int(34, 48);
  const pay = (hours: number, rate: number) => rate * Math.min(hours, 40) + ((rate * 3) / 2) * Math.max(hours - 40, 0);
  const facts = [
    `A ${place} pays three staff by the hour: ${a} earns $${ra} an hour, ${b} earns $${rb} an hour, and ${c} earns $${rc} an hour.`,
    `Any hours beyond 40 in a week are paid at time-and-a-half, that is 150% of the person's normal hourly rate.`,
    `This week ${a} worked ${ha} hours, ${b} worked ${fewer} hours fewer than ${a}, and ${c} worked ${(hc * 60) / days} minutes on each of ${days} days.`,
  ];
  const distractors = [
    `The ${place} serves about ${r.int(120, 400)} customers a day.`,
    `${b} has worked there for ${r.int(2, 9)} years.`,
    `${a}'s shift usually starts at ${r.int(6, 9)} a.m.`,
    `Staff get ${r.pick([10, 15, 20, 25])}% off anything they buy at the ${place}.`,
  ];
  return {
    prompt: compose(r, facts, distractors, `How many dollars does the ${place} pay the three of them in total for this week?`),
    answer: pay(ha, ra) + pay(ha - fewer, rb) + pay(hc, rc),
  };
};

const BAKERIES = ["Sunrise Bakery", "Corner Loaf", "Golden Crust", "Mill Street Bakery", "Daily Bread", "Stone Oven"];

const flourOrder: Template = (r) => {
  const [first, second] = r.sample(BAKERIES, 2) as [string, string];
  const loaves1 = r.int(40, 120);
  // Multiples of 20 g keep a whole-percentage increase a whole number of grams.
  const grams1 = 20 * r.int(20, 30);
  const loaves2 = r.int(30, 100);
  const pct = r.pick([10, 15, 20, 25, 30, 50]);
  const grams2 = grams1 + (grams1 * pct) / 100;
  const days = r.int(5, 14);
  const sack = r.pick([10, 20, 25]);
  const price = r.int(12, 35);
  const facts = [
    `${first} bakes ${loaves1} loaves a day, each using ${grams1} grams of flour.`,
    `${second} bakes ${loaves2} loaves a day, each using ${pct}% more flour than one of ${first}'s loaves.`,
    `Flour comes only in whole ${sack}-kg sacks at $${price} per sack.`,
  ];
  const distractors = [
    `${second} sells each loaf for $${r.int(3, 7)}.`,
    `${first} opens at ${r.int(5, 7)} a.m. every day.`,
    `A ${sack}-kg sack of rye flour costs $${price + r.int(3, 9)}.`,
    `Each loaf bakes for ${r.int(30, 50)} minutes.`,
  ];
  const sacks = Math.ceil((days * (loaves1 * grams1 + loaves2 * grams2)) / (sack * 1000));
  return {
    prompt: compose(
      r,
      facts,
      distractors,
      `If the two bakeries place one joint order with just enough whole sacks to cover ${days} days of baking, how many dollars does the order cost?`,
    ),
    answer: sacks * price,
  };
};

// ---------------------------------------------------------------- rates

const TANK_PAIRS = [
  ["the north tank", "the south tank"],
  ["the upper tank", "the lower tank"],
  ["the red tank", "the blue tank"],
  ["the old tank", "the new tank"],
] as const;
const START_TIMES = ["noon", "8 a.m.", "6 p.m.", "midnight"];

const twoTanks: Template = (r) => {
  const [fill, drain] = r.pick(TANK_PAIRS);
  const start = r.pick(START_TIMES);
  const a = 10 * r.int(20, 80);
  const drainPerMin = r.int(3, 9);
  const leak = r.int(1, 4);
  const hose = r.int(leak + 4, leak + 15);
  const delay = r.int(5, 20);
  const minutes = r.int(6, 30);
  // Backwards from "equal after `minutes` more": the gap when the hose starts is closing speed x minutes.
  const b = a - leak * delay + drainPerMin * delay + (hose - leak + drainPerMin) * minutes;
  const level = a - leak * delay + (hose - leak) * minutes;
  const facts = [
    `At ${start}, ${fill} contains ${a} liters of water and ${drain} contains ${b} liters.`,
    `From ${start} on, a valve drains ${drain} at ${60 * drainPerMin} liters per hour, and a crack in ${fill} leaks ${leak} liters per minute.`,
    `${delay} minutes after ${start}, a hose starts filling ${fill} at ${hose} liters per minute, while the crack keeps leaking.`,
  ];
  const distractors = [
    `Each tank can hold up to ${100 * Math.ceil(b / 100) + 100 * r.int(1, 5)} liters.`,
    `The hose is ${r.int(10, 30)} meters long.`,
    `Water from the mains costs ${r.int(2, 6)} cents per liter.`,
    `${capitalize(drain)} stands ${r.int(2, 4)} meters tall.`,
  ];
  return {
    prompt: compose(r, facts, distractors, `At the moment the two tanks hold the same amount of water, how many liters do they hold together?`),
    answer: 2 * level,
  };
};

const TOWNS = ["Ashford", "Bramley", "Carlow", "Dunmore", "Elstow", "Fenwick", "Hollin", "Marston"];
const TRAINS = ["freight train", "passenger train", "express train", "night train", "local train"];

const trainsMeet: Template = (r) => {
  const [from, to] = r.sample(TOWNS, 2) as [string, string];
  const [t1, t2] = r.sample(TRAINS, 2) as [string, string];
  // km/h in steps of 4 (12 for the one given in m/min) and quarter-hour times keep every distance whole.
  const v1 = 4 * r.int(15, 30);
  const v2 = 12 * r.int(5, 10);
  const depart = 60 * r.int(6, 15) + 5 * r.int(0, 11);
  const lag = 15 * r.int(1, 6);
  const meet = 15 * r.int(2, 10);
  const d1 = (v1 * (lag + meet)) / 60;
  const d2 = (v2 * meet) / 60;
  const fromFirst = r.coin();
  const facts = [
    `${from} and ${to} are ${d1 + d2} km apart by rail.`,
    `${capitalize(withArticle(t1))} leaves ${from} for ${to} at ${clock(depart)} and runs at a steady ${v1} km/h.`,
    `${capitalize(withArticle(t2))} leaves ${to} for ${from} at ${clock(depart + lag)} on the other track and runs at a steady ${(v2 * 1000) / 60} meters per minute.`,
    `Neither train stops on the way.`,
  ];
  const distractors = [
    `The ${t1} has ${r.int(6, 14)} carriages.`,
    `The ${t2} is carrying ${r.int(150, 600)} passengers.`,
    `A one-way ticket between the two towns costs $${r.int(20, 80)}.`,
    `The ${t1} left from platform ${r.int(2, 9)}.`,
  ];
  return {
    prompt: compose(r, facts, distractors, `How many kilometers from ${fromFirst ? from : to} are the trains when they pass each other?`),
    answer: fromFirst ? d1 : d2,
  };
};

const MACHINE_SITES = [
  { place: "An office", machines: "printers", one: "Printer", unit: "pages", verb: "prints", base: "print", job: "print job" },
  { place: "A drinks factory", machines: "bottling lines", one: "Line", unit: "bottles", verb: "fills", base: "fill", job: "order" },
  { place: "A warehouse", machines: "packing robots", one: "Robot", unit: "parcels", verb: "packs", base: "pack", job: "shipment" },
] as const;

const threeMachines: Template = (r) => {
  const s = r.pick(MACHINE_SITES);
  const a = r.int(12, 40);
  const b = r.int(10, 35);
  const c = r.int(8, 30);
  const start = 60 * r.int(7, 14) + 5 * r.int(0, 11);
  const together = r.int(8, 40);
  const after = r.int(6, 40);
  const total = (a + b) * together + (a + c) * after;
  const facts = [
    `${s.place} has three ${s.machines}: ${s.one} A ${s.verb} ${a} ${s.unit} per minute, ${s.one} B ${s.verb} ${b} ${s.unit} per minute, and ${s.one} C ${s.verb} ${60 * c} ${s.unit} per hour.`,
    `The ${s.job} is ${total} ${s.unit}.`,
    `At ${clock(start)}, ${s.one} A and ${s.one} B start on it together.`,
    `At ${clock(start + together)}, ${s.one} B is switched off for maintenance and ${s.one} C is switched on, and A and C finish the ${s.job} together.`,
  ];
  const distractors = [
    `${s.one} D, which ${s.verb} ${r.int(10, 40)} ${s.unit} per minute, is out of service all day.`,
    `${s.one} B is ${r.int(3, 9)} years old.`,
    `The site has ${r.int(8, 30)} staff on duty.`,
    `The ${s.job} is due by ${clock(start + together + after + r.int(20, 90))}.`,
  ];
  return {
    prompt: compose(r, facts, distractors, `How many ${s.unit} does ${s.one} A ${s.base} for this ${s.job}?`),
    answer: a * (together + after),
  };
};

const FLEET_OWNERS = ["bakery", "florist", "furniture shop", "courier firm", "catering company"];
const VAN_PAIRS = [
  ["white van", "blue van"],
  ["small van", "large van"],
  ["old van", "new van"],
] as const;

const vanFuel: Template = (r) => {
  const owner = r.pick(FLEET_OWNERS);
  const [v1, v2] = r.pick(VAN_PAIRS);
  const c1 = r.int(8, 14);
  // Daily km in steps of 100/gcd(c, 100) keep each day's diesel whole.
  const step1 = 100 / gcd(c1, 100);
  const d1 = step1 * r.int(Math.ceil(80 / step1), Math.floor(300 / step1));
  const days1 = r.int(16, 24);
  const c2 = r.pick([8, 10, 12, 16]);
  // Here a normal day's diesel is also a multiple of 4 liters, so 25%, 50% or 75% more stays whole.
  const step2 = 400 / gcd(c2, 400);
  const d2 = step2 * r.int(Math.ceil(100 / step2), Math.floor(300 / step2));
  const days2 = r.int(16, 24);
  const heavy = r.int(3, days2 - 3);
  const pct = r.pick([25, 50, 75]);
  const normal = (d2 * c2) / 100;
  const facts = [
    `A ${owner} runs two delivery vans.`,
    `This month the ${v1} drove ${d1} km on each of its ${days1} working days, using ${c1} liters of diesel per 100 km.`,
    `The ${v2} drove ${d2} km on each of its ${days2} working days and normally uses ${c2} liters per 100 km, but on ${heavy} of those days it carried heavy loads and used ${pct}% more fuel than normal.`,
  ];
  const distractors = [
    `Diesel costs $1.${r.int(50, 99)} per liter.`,
    `The ${v1} is ${r.int(2, 9)} years old.`,
    `The ${v2}'s fuel tank holds ${r.int(60, 90)} liters.`,
    `Each working day starts at ${r.int(5, 8)} a.m.`,
  ];
  return {
    prompt: compose(r, facts, distractors, `How many liters of diesel did the two vans use altogether this month?`),
    answer: (d1 * days1 * c1) / 100 + (days2 - heavy) * normal + heavy * (normal + (normal * pct) / 100),
  };
};

// ---------------------------------------------------------------- logic

const agePuzzle: Template = (r) => {
  const [a, b, c] = r.sample(PEOPLE, 3) as [string, string, string];
  const young = r.int(5, 14);
  const times = r.int(2, 4);
  const gap = r.int(2, 8);
  const ago = r.int(2, Math.min(young - 1, 6));
  const ahead = r.int(2, 9);
  const ageA = times * young;
  const ageB = young + gap;
  const facts = r.sample(
    [
      `${b} is ${12 * gap} months older than ${c}.`,
      `${a} is ${TIMES[times]} as old as ${c}.`,
      `${ago} years ago, the ages of ${a}, ${b} and ${c} added up to ${ageA + ageB + young - 3 * ago}.`,
    ],
    3,
  );
  const distractors = [
    `Their grandmother is ${r.int(70, 92)} years old.`,
    `${a}'s dog is ${r.int(2, 12)} years old.`,
    `The family moved to their current house ${r.int(3, 9)} years ago.`,
    `${c} is ${r.int(110, 160)} cm tall.`,
  ];
  return {
    prompt: compose(r, facts, distractors, `What will the sum of ${a}'s and ${b}'s ages be ${ahead} years from now?`),
    answer: ageA + ageB + 2 * ahead,
  };
};

const COLLECTIBLES = ["stamps", "stickers", "marbles", "trading cards", "seashells", "coins"];

const percentChain: Template = (r) => {
  const [p0, p1, p2, p3, p4, other] = r.sample(PEOPLE, 6) as [string, string, string, string, string, string];
  const unit = r.pick(COLLECTIBLES);
  // Multiples of 20 make any whole-number percentage increase whole.
  const v3 = 20 * r.int(3, 15);
  const d = r.int(3, 25);
  const v4 = r.coin() ? v3 + d : v3 - d;
  const pct = r.pick([10, 20, 25, 30, 40, 50]);
  const v2 = v3 + (v3 * pct) / 100;
  const times = r.int(2, 3);
  const v1 = times * v2;
  const e = r.int(5, 40);
  const v0 = r.coin() ? v1 + e : v1 - e;
  /** "x has |diff| more/fewer than y", stated from either side. */
  const offset = (x: string, y: string, diff: number) =>
    r.coin()
      ? `${x} has ${Math.abs(diff)} ${diff > 0 ? "more" : "fewer"} ${unit} than ${y}.`
      : `${y} has ${Math.abs(diff)} ${diff > 0 ? "fewer" : "more"} ${unit} than ${x}.`;
  const relations = [
    offset(p3, p4, v3 - v4),
    // 25% more one way is exactly 20% fewer the other way.
    pct === 25 && r.coin() ? `${p3} has 20% fewer ${unit} than ${p2}.` : `${p2} has ${pct}% more ${unit} than ${p3}.`,
    `${p1} has ${TIMES[times]} as many ${unit} as ${p2}.`,
    offset(p0, p1, v0 - v1),
    `${p4} has ${v4} ${unit}.`,
  ];
  const [n0, n1, n2, n3, n4] = r.sample([p0, p1, p2, p3, p4], 5);
  const facts = [`${n0}, ${n1}, ${n2}, ${n3} and ${n4} collect ${unit}.`, ...r.sample(relations, relations.length)];
  const distractors = [
    `${other} has ${r.int(40, 400)} ${unit}.`,
    `${p3} started collecting ${r.int(2, 9)} years ago.`,
    `A new album holds ${r.pick([120, 200, 250, 300])} ${unit}.`,
    `${p1} hopes to reach ${100 * r.int(5, 12)} ${unit} by next year.`,
  ];
  return {
    prompt: compose(r, facts, distractors, `How many ${unit} do ${p0} and ${p2} have together?`),
    answer: v0 + v2,
  };
};

const SURVEYS = [
  { who: "residents", verb: "own", items: ["a car", "a bicycle", "a scooter"] },
  { who: "students", verb: "take", items: ["French", "music", "chemistry"] },
  { who: "gym members", verb: "use", items: ["the pool", "the sauna", "the climbing wall"] },
  { who: "employees", verb: "speak", items: ["Spanish", "German", "Japanese"] },
] as const;
const OVERLAP_ASKS = ["none", "exactly one", "exactly two"] as const;

const surveyOverlap: Template = (r) => {
  const { who, verb, items } = r.pick(SURVEYS);
  const [x, y, z] = items;
  const s = r.int(2, 6);
  const total = 100 * s;
  const [xy, xz, yz] = [r.int(2 * s, 8 * s), r.int(2 * s, 8 * s), r.int(2 * s, 8 * s)];
  const all = r.int(s, 4 * s);
  // Rounding each "only" region up makes every set total a multiple of s, i.e. a whole percentage of 100*s.
  const only = (pairs: number) => {
    const o = r.int(5 * s, 15 * s);
    return o + ((s - ((o + pairs + all) % s)) % s);
  };
  const [ox, oy, oz] = [only(xy + xz), only(xy + yz), only(xz + yz)];
  const none = total - (ox + oy + oz + xy + xz + yz + all);
  const pctOf = (count: number) => count / s;
  const ask = r.int(0, 2);
  const facts = [
    `A survey asked ${total} ${who} about three things.`,
    `${pctOf(ox + xy + xz + all)}% of them ${verb} ${x}, ${pctOf(oy + xy + yz + all)}% ${verb} ${y}, and ${pctOf(oz + xz + yz + all)}% ${verb} ${z}.`,
    `Also, ${xy + all} ${verb} both ${x} and ${y}, ${xz + all} ${verb} both ${x} and ${z}, and ${yz + all} ${verb} both ${y} and ${z}; each of these counts includes the ${all} ${who} who ${verb} all three.`,
  ];
  const distractors = [
    `Another ${r.int(10, 40)} ${who} declined to answer and are not part of the ${total}.`,
    `The survey took ${r.int(2, 6)} weeks to complete.`,
    `The average age of those surveyed was ${r.int(25, 60)}.`,
    `A similar survey last year asked ${100 * r.int(2, 6) + 50} ${who}.`,
  ];
  return {
    prompt: compose(r, facts, distractors, `How many of the ${total} ${who} ${verb} ${OVERLAP_ASKS[ask]} of the three?`),
    answer: [none, ox + oy + oz, xy + xz + yz][ask]!,
  };
};

const FLEETS = [
  {
    intro: "A parking garage holds only motorcycles, cars and six-wheeled trucks.",
    kinds: [["motorcycles", 2], ["cars", 4], ["six-wheeled trucks", 6]],
    noun: "garage",
    used: "parked",
  },
  {
    intro: "A rental shop has only bicycles, tricycles and quad bikes for hire.",
    kinds: [["bicycles", 2], ["tricycles", 3], ["quad bikes", 4]],
    noun: "shop",
    used: "rented out",
  },
] as const;

const vehicleMix: Template = (r) => {
  const f = r.pick(FLEETS);
  const [[light, lightWheels], [mid, midWheels], [heavy, heavyWheels]] = f.kinds;
  const pct = r.pick([10, 20, 25]);
  const heavyCount = r.int(2, 10);
  const total = (heavyCount * 100) / pct;
  const midCount = r.int(1, total - heavyCount - 1);
  const lightCount = total - heavyCount - midCount;
  const wheels = lightCount * lightWheels + midCount * midWheels + heavyCount * heavyWheels;
  const askLight = r.coin();
  const asked = askLight ? light : mid;
  const fee = r.int(2, 6);
  const hours = r.int(2, 8);
  const facts = [
    f.intro,
    `Altogether there are ${total} vehicles with ${wheels} wheels, and exactly ${pct}% of the vehicles are ${heavy}.`,
    `${capitalize(asked)} are charged $${fee} per hour each.`,
  ];
  const distractors = [
    `${capitalize(heavy)} are charged $${r.int(7, 12)} per hour each.`,
    `The ${f.noun} has room for ${total + r.int(20, 80)} vehicles.`,
    `The ${f.noun} opens at ${r.int(5, 8)} a.m.`,
  ];
  return {
    prompt: compose(r, facts, distractors, `How many dollars are collected from the ${asked} if every one of them is ${f.used} for ${hours} hours?`),
    answer: (askLight ? lightCount : midCount) * fee * hours,
  };
};

const BEACON_SETS = [
  {
    intro: "Three lighthouses along one coast flash together at the same instant at dusk.",
    lights: ["the north light", "the harbor light", "the island light"],
    verb: "flashes",
    base: "flash",
    spare: "A fourth lighthouse",
    extra: (n: number) => `A ferry leaves the harbor every ${n} minutes.`,
    size: (n: number) => `The harbor light stands ${n} meters tall.`,
  },
  {
    intro: "Three warning beacons on a radio mast blink together at the same instant at midnight.",
    lights: ["the red beacon", "the white beacon", "the amber beacon"],
    verb: "blinks",
    base: "blink",
    spare: "A fourth beacon",
    extra: (n: number) => `A plane passes overhead about every ${n} minutes.`,
    size: (n: number) => `The mast is ${n} meters tall.`,
  },
] as const;
const PERIODS_S = [12, 15, 18, 20, 24, 30, 36, 40, 45, 48, 60, 72, 75, 80, 90, 100, 120];
const BEACON_TRIPLES = (() => {
  const out: Array<[number, number, number]> = [];
  PERIODS_S.forEach((a, i) =>
    PERIODS_S.slice(i + 1).forEach((b, j) =>
      PERIODS_S.slice(i + j + 2).forEach((c) => {
        const cycle = lcm(lcm(a, b), c);
        // Skip triples where one period is already the common cycle: that removes a whole step of the puzzle.
        if (cycle > c && cycle <= 1800) out.push([a, b, c]);
      }),
    ),
  );
  return out;
})();

const beaconSync: Template = (r) => {
  const set = r.pick(BEACON_SETS);
  const periods = r.sample(r.pick(BEACON_TRIPLES), 3);
  const cycle = periods.reduce(lcm);
  const laps = r.int(3, 14);
  // Ending strictly between two coincidences removes any "is the endpoint included?" ambiguity.
  const span = cycle * laps + r.int(1, cycle - 1);
  const facts = [
    set.intro,
    ...set.lights.map((light, i) => `${capitalize(light)} ${set.verb} once every ${duration(periods[i]!)}.`),
  ];
  const distractors = [
    set.extra(r.int(15, 40)),
    set.size(r.int(20, 90)),
    `${set.spare}, which ${set.verb} every ${r.pick(PERIODS_S)} seconds, is switched off for repairs.`,
  ];
  return {
    prompt: compose(
      r,
      facts,
      distractors,
      `Counting that first moment, how many times do all three ${set.base} at the same instant during the first ${duration(span)}?`,
    ),
    answer: laps + 1,
  };
};

// ---------------------------------------------------------------- table

export const HARD_TEMPLATES: Record<SyntheticDomain, readonly Template[]> = {
  arithmetic: [raffle, twoShops, payroll, flourOrder],
  rates: [twoTanks, trainsMeet, threeMachines, vanFuel],
  logic: [agePuzzle, percentChain, surveyOverlap, vehicleMix, beaconSync],
};
