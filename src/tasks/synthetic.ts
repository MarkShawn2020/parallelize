import { mulberry32 } from "../core/rng";
import type { Domain, Task, TaskSource } from "../core/types";

export type SyntheticDomain = Exclude<Domain, "gsm8k" | "research">;
export const SYNTHETIC_DOMAINS: readonly SyntheticDomain[] = ["arithmetic", "rates", "logic"];

export interface Rng {
  /** Uniform integer in [lo, hi]. */
  int(lo: number, hi: number): number;
  pick<T>(items: readonly T[]): T;
  /** k distinct items in random order. */
  sample<T>(items: readonly T[], k: number): T[];
  coin(): boolean;
}

export function createRng(seed: number): Rng {
  const rand = mulberry32(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)]!;
  const sample = <T>(items: readonly T[], k: number): T[] => {
    const pool = items.slice();
    return Array.from({ length: k }, () => pool.splice(int(0, pool.length - 1), 1)[0]!);
  };
  return { int, pick, sample, coin: () => rand() < 0.5 };
}

export interface Problem {
  prompt: string;
  answer: number;
}
export type Template = (r: Rng) => Problem;

// ---------------------------------------------------------------- helpers

const NAMES = [
  "Maya", "Liam", "Priya", "Diego", "Aiko", "Omar", "Sofia", "Chen", "Noah", "Amara", "Lucas", "Zara",
  "Ivan", "Leila", "Mateo", "Hana", "Kofi", "Elena", "Ravi", "Greta", "Tomas", "Nadia", "Yusuf", "Ines",
];
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const ORDINALS = ["", "first", "second", "third", "fourth"];
const MULTIPLES = ["", "", "twice", "three times", "four times", "five times", "six times"];

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const lcm = (a: number, b: number) => (a / gcd(a, b)) * b;
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const definite = (s: string) => s.replace(/^an? /, "the ");

// ---------------------------------------------------------------- arithmetic

const SHOPS = [
  { store: "stationery shop", pack: "boxes of markers", single: "notebooks" },
  { store: "grocery store", pack: "bags of oranges", single: "loaves of bread" },
  { store: "garden center", pack: "trays of seedlings", single: "clay pots" },
  { store: "hardware store", pack: "boxes of screws", single: "paintbrushes" },
  { store: "pet shop", pack: "bags of cat food", single: "chew toys" },
];

const bundlesAndChange: Template = (r) => {
  const name = r.pick(NAMES);
  const shop = r.pick(SHOPS);
  const packs = r.int(2, 6);
  const packPrice = r.int(4, 15);
  const singles = r.int(2, 8);
  const singlePrice = r.int(2, 9);
  const threshold = r.pick([30, 40, 50, 60, 75]);
  const off = r.int(3, 10);
  const subtotal = packs * packPrice + singles * singlePrice;
  const total = subtotal > threshold ? subtotal - off : subtotal;
  const bill = r.pick([10, 20, 50]);
  const bills = Math.floor(total / bill) + 1;
  const paid = bills === 1 ? `a single $${bill} bill` : `${bills} $${bill} bills`;
  return {
    prompt:
      `At a ${shop.store}, ${name} buys ${packs} ${shop.pack} at $${packPrice} each and ${singles} ${shop.single} ` +
      `at $${singlePrice} each. The store takes $${off} off any purchase that comes to more than $${threshold} ` +
      `before the discount. ${name} pays with ${paid}. How many dollars in change does ${name} get back?`,
    answer: bills * bill - total,
  };
};

const SALE_ITEMS = [
  { items: "board games", one: "game" },
  { items: "desk lamps", one: "lamp" },
  { items: "pairs of headphones", one: "pair" },
  { items: "potted ferns", one: "fern" },
  { items: "concert posters", one: "poster" },
];

const saleSplit: Template = (r) => {
  const name = r.pick(NAMES);
  const item = r.pick(SALE_ITEMS);
  const pct = r.pick([10, 15, 20, 25, 30, 40, 50]);
  // A multiple of 20 times a multiple of 5 percent keeps the discount a whole dollar amount.
  const price = 20 * r.int(2, 8);
  const salePrice = price - (price * pct) / 100;
  const qty = r.int(2, 5);
  const people = r.int(2, 5);
  const share = Math.ceil((qty * salePrice + r.int(4, 12)) / people);
  const fee = share * people - qty * salePrice;
  const friends = people === 2 ? "a friend" : `${people - 1} friends`;
  return {
    prompt:
      `${name} and ${friends} order ${qty} ${item.items} online. Each ${item.one} normally costs $${price}, but a ` +
      `sale takes ${pct}% off the price of every ${item.one}. The shop also adds one $${fee} delivery fee to the ` +
      `whole order. If they split the final bill equally, how many dollars does each person pay?`,
    answer: share,
  };
};

const BAKES = ["muffins", "croissants", "bagels", "cookies", "dumplings", "cinnamon rolls"];

const bakeryBoxes: Template = (r) => {
  const item = r.pick(BAKES);
  const trays = r.int(3, 9);
  const perTray = r.pick([12, 15, 16, 18, 20, 24]);
  const ruined = r.int(2, 11);
  const box = r.pick([4, 6, 8, 10]);
  const price = r.int(6, 18);
  const boxes = Math.floor((trays * perTray - ruined) / box);
  return {
    prompt:
      `A bakery makes ${trays} trays of ${item} with ${perTray} on each tray. Of these, ${ruined} are dropped or ` +
      `burnt and thrown away. The rest are packed into boxes of ${box}, and any that cannot fill a whole box go ` +
      `home with the staff. Each full box sells for $${price}. If every full box is sold, how many dollars does ` +
      `the bakery take in?`,
    answer: boxes * price,
  };
};

const SIDE_JOBS = [
  { job: "walking dogs", treat: "snacks" },
  { job: "tutoring", treat: "bus fares" },
  { job: "mowing lawns", treat: "comic books" },
  { job: "washing cars", treat: "movie tickets" },
  { job: "babysitting", treat: "phone credit" },
];
const BIG_BUYS = ["a skateboard", "a used guitar", "a pair of sneakers", "a small telescope", "a camping tent"];

const savingsPlan: Template = (r) => {
  const name = r.pick(NAMES);
  const { job, treat } = r.pick(SIDE_JOBS);
  const start = r.int(10, 90);
  const earn = r.int(12, 35);
  const spend = r.int(3, earn - 5);
  const weeks = r.int(3, 10);
  const saved = start + weeks * (earn - spend);
  const cost = r.int(Math.ceil(saved / 3), saved - 5);
  return {
    prompt:
      `${name} has $${start} saved. Every week ${name} earns $${earn} from ${job} and spends $${spend} of it on ` +
      `${treat}. After ${weeks} weeks of this, ${name} buys ${r.pick(BIG_BUYS)} for $${cost}. How many dollars ` +
      `does ${name} have left?`,
    answer: saved - cost,
  };
};

const RECIPES = [
  { dish: "pancakes", a: { qty: "cups of flour", per: "per cup of flour" }, b: { qty: "eggs", per: "per egg" } },
  { dish: "vegetable soup", a: { qty: "carrots", per: "per carrot" }, b: { qty: "potatoes", per: "per potato" } },
  { dish: "fried rice", a: { qty: "cups of rice", per: "per cup of rice" }, b: { qty: "eggs", per: "per egg" } },
  { dish: "banana bread", a: { qty: "bananas", per: "per banana" }, b: { qty: "cups of flour", per: "per cup of flour" } },
  { dish: "chili", a: { qty: "cans of beans", per: "per can of beans" }, b: { qty: "onions", per: "per onion" } },
];

const recipeScaling: Template = (r) => {
  const name = r.pick(NAMES);
  const recipe = r.pick(RECIPES);
  const serves = r.pick([2, 3, 4, 6, 8]);
  const factor = r.int(2, 5);
  const qa = r.int(2, 5);
  const qb = r.int(2, 4);
  const ca = r.int(1, 4);
  const cb = r.int(1, 3);
  return {
    prompt:
      `A recipe for ${recipe.dish} that serves ${serves} people calls for ${qa} ${recipe.a.qty} and ${qb} ` +
      `${recipe.b.qty}. ${name} is making ${recipe.dish} for ${serves * factor} people, scaling the recipe exactly. ` +
      `The market charges $${ca} ${recipe.a.per} and $${cb} ${recipe.b.per}. How many dollars do these two ` +
      `ingredients cost in total?`,
    answer: factor * (qa * ca + qb * cb),
  };
};

const SHOWS = ["matinee", "opening night", "school play", "comedy show", "puppet show"];

const theaterTickets: Template = (r) => {
  const rows = r.int(8, 24);
  const seats = r.pick([12, 15, 16, 18, 20, 24, 25, 30]);
  const capacity = rows * seats;
  const pct = r.pick([20, 25, 40, 50, 60, 75, 80].filter((p) => (capacity * p) % 100 === 0));
  const sold = (capacity * pct) / 100;
  const children = r.int(Math.max(1, Math.floor(sold / 5)), Math.floor((sold * 3) / 5));
  const adultPrice = r.int(9, 18);
  const childPrice = r.int(4, adultPrice - 3);
  return {
    prompt:
      `A theater has ${rows} rows with ${seats} seats in each row. For the ${r.pick(SHOWS)}, ${pct}% of the seats ` +
      `are sold. Of the tickets sold, ${children} are child tickets at $${childPrice} each and the rest are adult ` +
      `tickets at $${adultPrice} each. How many dollars does the theater collect in ticket sales?`,
    answer: (sold - children) * adultPrice + children * childPrice,
  };
};

// ---------------------------------------------------------------- rates

const PLACES = ["the coast", "a mountain village", "the lake", "a cousin's farm", "the old mill", "the harbor"];
const TRAVEL = [
  { verb: "drives", speeds: [40, 50, 60, 70, 80, 90, 100, 110] },
  { verb: "cycles", speeds: [12, 14, 16, 18, 20, 24] },
];

const tripWithStop: Template = (r) => {
  const name = r.pick(NAMES);
  const mode = r.pick(TRAVEL);
  const [first, second] = r.sample(PLACES, 2);
  const v1 = r.pick(mode.speeds);
  const v2 = r.pick(mode.speeds);
  // Even speeds and half-hour legs keep every distance a whole number of km.
  const t1 = 30 * r.int(1, 6);
  const t2 = 30 * r.int(1, 6);
  const stop = r.pick([10, 15, 20, 25, 35, 45]);
  return {
    prompt:
      `${name} ${mode.verb} ${(v1 * t1) / 60} km to ${first} at a steady ${v1} km/h, stops there for ${stop} ` +
      `minutes, and then ${mode.verb} another ${(v2 * t2) / 60} km to ${second} at ${v2} km/h. How many minutes ` +
      `does the whole trip take, including the stop?`,
    answer: t1 + stop + t2,
  };
};

const WORK_PLANS = (() => {
  const plans: Array<{ fast: number; slow: number; together: number; alone: number }> = [];
  for (let fast = 2; fast <= 12; fast++) {
    for (let slow = fast + 1; slow <= 24; slow++) {
      const job = lcm(fast, slow);
      const rFast = job / fast;
      const rSlow = job / slow;
      for (let together = 1; together * (rFast + rSlow) < job; together++) {
        const rest = job - together * (rFast + rSlow);
        if (rest % rSlow === 0) plans.push({ fast, slow, together, alone: rest / rSlow });
      }
    }
  }
  return plans;
})();
const CHORES = [
  "paint a fence",
  "tile a bathroom floor",
  "assemble a set of bookshelves",
  "weed the community garden",
  "sort a mountain of mail",
];

const workTogether: Template = (r) => {
  const [a, b] = r.sample(NAMES, 2);
  const plan = r.pick(WORK_PLANS);
  return {
    prompt:
      `Working alone, ${a} can ${r.pick(CHORES)} in ${plan.fast} hours, while ${b} would need ${plan.slow} hours ` +
      `for the same job. They start together, but after ${count(plan.together, "hour", "hours")} ${a} is called ` +
      `away and ${b} finishes the rest alone at the same pace. How many hours after they started is the job done?`,
    answer: plan.together + plan.alone,
  };
};

const TANKS = ["rain barrel", "fish tank", "water trough", "garden pond", "storage tank"];

const leakyTank: Template = (r) => {
  const tank = r.pick(TANKS);
  const inflow = r.int(6, 20);
  const leak = r.int(2, inflow - 2);
  const before = r.int(3, 12);
  const after = r.int(4, 20);
  const start = 10 * r.int(0, 6);
  const capacity = start + inflow * before + (inflow - leak) * after;
  const initially = start === 0 ? "starts empty" : `already contains ${start} liters`;
  return {
    prompt:
      `A ${tank} holds ${capacity} liters and ${initially}. A hose fills it at ${inflow} liters per minute. After ` +
      `${before} minutes, a crack opens that leaks ${leak} liters per minute, but the hose keeps running. How ` +
      `many minutes after the hose was turned on is the ${tank} full?`,
    answer: before + after,
  };
};

const RETURN_TRIPS: Array<{ verb: string; back: string; pairs: Array<[number, number]> }> = [
  { verb: "drives", back: "because of roadworks", pairs: [[60, 40], [60, 45], [80, 60], [90, 60], [100, 75], [120, 80], [50, 40], [75, 50]] },
  { verb: "cycles", back: "into a headwind", pairs: [[20, 15], [24, 16], [18, 12], [15, 10], [30, 20]] },
];

const returnTrip: Template = (r) => {
  const name = r.pick(NAMES);
  const trip = r.pick(RETURN_TRIPS);
  const [fast, slow] = r.pick(trip.pairs);
  // A multiple of both speeds keeps each leg a whole number of hours.
  const distance = lcm(fast, slow) * r.int(1, 3);
  const extra = distance / slow - distance / fast;
  return {
    prompt:
      `${name} ${trip.verb} to ${r.pick(PLACES)} at an average of ${fast} km/h and comes back along the same road ` +
      `at ${slow} km/h ${trip.back}. The way back takes ${count(extra, "hour", "hours")} longer than the way ` +
      `there. How many kilometers does ${name} travel in total, there and back?`,
    answer: 2 * distance,
  };
};

const PRODUCTS = ["widgets", "glass bottles", "circuit boards", "bricks", "T-shirts", "toy cars"];

const factoryBreakdown: Template = (r) => {
  const product = r.pick(PRODUCTS);
  const machines = r.int(4, 12);
  const rate = r.int(5, 40);
  const before = r.int(2, 6);
  const broken = r.int(1, machines - 2);
  const after = r.int(2, 9);
  const target = machines * rate * before + (machines - broken) * rate * after;
  return {
    prompt:
      `A workshop runs ${machines} identical machines, each making ${rate} ${product} per hour. After ${before} ` +
      `hours, ${count(broken, "machine breaks", "machines break")} down and the others keep running at the same ` +
      `pace. How many hours after the start has the workshop made ${target} ${product} in total?`,
    answer: before + after,
  };
};

const CHASES = (() => {
  const plans: Array<{ speed: number; gain: number; lead: number; hours: number }> = [];
  for (const speed of [40, 50, 60, 70, 80, 90]) {
    for (const gain of [10, 15, 20, 25, 30, 40]) {
      for (const lead of [1, 2, 3]) {
        const hours = (speed * lead) / gain;
        if (Number.isInteger(hours) && hours <= 12) plans.push({ speed, gain, lead, hours });
      }
    }
  }
  return plans;
})();
const CHASERS = [
  { slow: "a freight train", fast: "an express train", origin: "the central station", route: "on a parallel track" },
  { slow: "a delivery van", fast: "a courier on a motorbike", origin: "the warehouse", route: "along the same highway" },
  { slow: "a tour bus", fast: "a sports car", origin: "the city gate", route: "along the same road" },
];

const catchUp: Template = (r) => {
  const c = r.pick(CHASERS);
  const plan = r.pick(CHASES);
  return {
    prompt:
      `${capitalize(c.slow)} leaves ${c.origin} traveling at ${plan.speed} km/h. ` +
      `${count(plan.lead, "hour", "hours")} later, ${c.fast} leaves ${c.origin} heading the same way ` +
      `${c.route} at ${plan.speed + plan.gain} km/h. How many kilometers from ${c.origin} does ${definite(c.fast)} ` +
      `catch up with ${definite(c.slow)}?`,
    answer: (plan.speed + plan.gain) * plan.hours,
  };
};

// ---------------------------------------------------------------- logic

const AGE_PLANS = (() => {
  const plans: Array<{ now: number; later: number; young: number; years: number }> = [];
  for (let now = 3; now <= 6; now++) {
    for (let later = 2; later < now; later++) {
      for (let young = 2; young <= 15; young++) {
        const years = ((now - later) * young) / (later - 1);
        if (Number.isInteger(years) && years >= 1 && years <= 30) plans.push({ now, later, young, years });
      }
    }
  }
  return plans;
})();

const ageRatios: Template = (r) => {
  const [a, b] = r.sample(NAMES, 2);
  const plan = r.pick(AGE_PLANS);
  const ahead = r.int(1, 12);
  return {
    prompt:
      `${a} is ${MULTIPLES[plan.now]} as old as ${b}. In ${count(plan.years, "year", "years")}, ${a} will be ` +
      `${MULTIPLES[plan.later]} as old as ${b}. What will the sum of their ages be ` +
      `${count(ahead, "year", "years")} from now?`,
    answer: (plan.now + 1) * plan.young + 2 * ahead,
  };
};

const CHAIN_TRAITS = [
  {
    lo: 120, hi: 210, step: 12,
    more: (d: number) => `is ${d} cm taller than`, less: (d: number) => `is ${d} cm shorter than`,
    anchor: (v: number) => `is ${v} cm tall`, ask: (p: string) => `How tall is ${p}, in centimeters?`,
  },
  {
    lo: 5, hi: 400, step: 30,
    more: (d: number) => `has $${d} more than`, less: (d: number) => `has $${d} less than`,
    anchor: (v: number) => `has $${v}`, ask: (p: string) => `How many dollars does ${p} have?`,
  },
  {
    lo: 10, hi: 200, step: 20,
    more: (d: number) => `scored ${d} points more than`, less: (d: number) => `scored ${d} points fewer than`,
    anchor: (v: number) => `scored ${v} points`, ask: (p: string) => `How many points did ${p} score?`,
  },
  {
    lo: 1, hi: 45, step: 9,
    more: (d: number) => `lives ${d} floors above`, less: (d: number) => `lives ${d} floors below`,
    anchor: (v: number) => `lives on floor ${v}`, ask: (p: string) => `On which floor does ${p} live?`,
  },
];

const offsetChain: Template = (r) => {
  const trait = r.pick(CHAIN_TRAITS);
  const people = r.sample(NAMES, r.int(4, 5));
  const values = people.map(() => 0);
  const last = people.length - 1;
  values[last] = r.int(trait.lo + trait.step * 2, trait.hi - trait.step * 2);
  for (let i = last - 1; i >= 0; i--) {
    const next = values[i + 1]!;
    const delta = r.int(1, trait.step) * (r.coin() ? 1 : -1);
    values[i] = next + delta >= trait.lo && next + delta <= trait.hi ? next + delta : next - delta;
  }
  const facts = people.slice(0, last).map((p, i) => {
    const q = people[i + 1]!;
    const diff = values[i]! - values[i + 1]!;
    if (r.coin()) return `${p} ${diff > 0 ? trait.more(diff) : trait.less(-diff)} ${q}.`;
    return `${q} ${diff > 0 ? trait.less(diff) : trait.more(-diff)} ${p}.`;
  });
  facts.push(`${people[last]} ${trait.anchor(values[last]!)}.`);
  return {
    prompt: `${r.sample(facts, facts.length).join(" ")} ${trait.ask(people[0]!)}`,
    answer: values[0]!,
  };
};

const GROUPS = [
  { group: "students", verb: "study", items: ["French", "Spanish", "German"] },
  { group: "club members", verb: "play", items: ["chess", "tennis", "the piano"] },
  { group: "survey respondents", verb: "own", items: ["a cat", "a dog", "a bicycle"] },
  { group: "campers", verb: "signed up for", items: ["kayaking", "archery", "rock climbing"] },
];

const threeSets: Template = (r) => {
  const g = r.pick(GROUPS);
  const [x, y, z] = g.items;
  const [onlyX, onlyY, onlyZ] = [r.int(2, 15), r.int(2, 15), r.int(2, 15)];
  const [xyOnly, xzOnly, yzOnly] = [r.int(1, 8), r.int(1, 8), r.int(1, 8)];
  const all = r.int(1, 6);
  const none = r.int(1, 12);
  const total = onlyX + onlyY + onlyZ + xyOnly + xzOnly + yzOnly + all + none;
  const askNone = r.coin();
  return {
    prompt:
      `In a group of ${total} ${g.group}, ${onlyX + xyOnly + xzOnly + all} ${g.verb} ${x}, ` +
      `${onlyY + xyOnly + yzOnly + all} ${g.verb} ${y}, and ${onlyZ + xzOnly + yzOnly + all} ${g.verb} ${z}. ` +
      `Also, ${xyOnly + all} ${g.verb} both ${x} and ${y}, ${xzOnly + all} ${g.verb} both ${x} and ${z}, ` +
      `${yzOnly + all} ${g.verb} both ${y} and ${z}, and ${all} ${g.verb} all three (they are included in every ` +
      `count above). How many of the ${g.group} ${g.verb} ${askNone ? "none" : "exactly one"} of the three?`,
    answer: askNone ? none : onlyX + onlyY + onlyZ,
  };
};

const CYCLES = [
  { first: "Red-line buses leave the depot", second: "blue-line buses leave", unit: "minutes" },
  { first: "One lighthouse flashes", second: "a second lighthouse flashes", unit: "seconds" },
  { first: "A kitchen timer beeps", second: "a wall clock chimes", unit: "minutes" },
  { first: "A gardener waters the ferns", second: "a caretaker cleans the aquarium", unit: "days" },
];
const PERIODS = [4, 6, 8, 9, 10, 12, 14, 15, 18, 20, 21, 24];

const cycleSync: Template = (r) => {
  const c = r.pick(CYCLES);
  const [p, q] = r.sample(PERIODS, 2) as [number, number];
  const period = lcm(p, q);
  const laps = r.int(3, 15);
  // Ending strictly between two coincidences removes any "is the endpoint included?" ambiguity.
  const span = period * laps + r.int(1, period - 1);
  return {
    prompt:
      `${c.first} every ${p} ${c.unit}, and ${c.second} every ${q} ${c.unit}. Both happen together right at the ` +
      `start. Counting that first time, how many times do both happen at the same moment during the first ` +
      `${span} ${c.unit}?`,
    answer: laps + 1,
  };
};

const MONTHS: Array<[string, number]> = [
  ["January", 31], ["March", 31], ["April", 30], ["June", 30],
  ["August", 31], ["September", 30], ["October", 31], ["November", 30],
];
const MEETINGS = [
  { who: "A book club", event: "meets", follow: "its newsletter goes out" },
  { who: "The town council", event: "holds its hearing", follow: "the minutes are published" },
  { who: "A chess club", event: "holds its tournament", follow: "the prizes are handed out" },
];

const calendarDate: Template = (r) => {
  const [month, days] = r.pick(MONTHS);
  const m = r.pick(MEETINGS);
  const firstDay = r.int(0, 6);
  const target = r.int(0, 6);
  const nth = r.int(1, 4);
  const date = 1 + ((target - firstDay + 7) % 7) + 7 * (nth - 1);
  const delay = r.int(2, Math.min(12, days - date));
  return {
    prompt:
      `In a certain year, ${month} 1 falls on a ${WEEKDAYS[firstDay]}. ${m.who} ${m.event} on the ` +
      `${ORDINALS[nth]} ${WEEKDAYS[target]} of ${month}, and ${m.follow} ${delay} days after that. On which date ` +
      `of ${month} does that happen? Give the day of the month as a number.`,
    answer: date + delay,
  };
};

const PAIRINGS = [
  {
    before: (h: number) => `At a reunion, every guest shook hands exactly once with every other guest, for ${h} handshakes in all.`,
    after: (k: number) => `Then ${k} more guests arrived, and each newcomer shook hands once with everyone else in the room, including the other newcomers.`,
    ask: "How many handshakes took place in total?",
  },
  {
    before: (h: number) => `In a local league, every team played every other team exactly once this season, for ${h} games in total.`,
    after: (k: number) => `Next season ${k} new teams join, and again every team plays every other team exactly once.`,
    ask: "How many games will be played next season?",
  },
];

const pairings: Template = (r) => {
  const p = r.pick(PAIRINGS);
  const n = r.int(5, 16);
  const joined = r.int(2, 6);
  const pairs = (m: number) => (m * (m - 1)) / 2;
  // Both framings land on the same count: all pairs in the enlarged group.
  return {
    prompt: `${p.before(pairs(n))} ${p.after(joined)} ${p.ask}`,
    answer: pairs(n + joined),
  };
};

const HEADCOUNTS = [
  {
    intro: "A farmyard holds only chickens and goats.", low: 2, high: 4, things: "heads", parts: "legs",
    ask: (m: number, d: number) => `Each goat eats ${m} kilograms of hay per day. How many kilograms of hay do the goats eat in ${d} days?`,
  },
  {
    intro: "A rental shop has only bicycles and tricycles.", low: 2, high: 3, things: "vehicles", parts: "wheels",
    ask: (m: number, d: number) => `Each tricycle rents for $${m} per hour. How many dollars does it cost to rent every tricycle for ${d} hours?`,
  },
  {
    intro: "A terrarium holds only beetles and spiders.", low: 6, high: 8, things: "creatures", parts: "legs",
    ask: (m: number, d: number) => `Each spider catches ${m} flies per day. How many flies do the spiders catch in ${d} days?`,
  },
  {
    intro: "A cafe has only three-legged stools and four-legged tables.", low: 3, high: 4, things: "pieces of furniture", parts: "legs",
    ask: (m: number, d: number) => `Each table is wiped ${m} times a day. How many table wipes happen in ${d} days?`,
  },
];

const headsAndParts: Template = (r) => {
  const h = r.pick(HEADCOUNTS);
  const lows = r.int(3, 30);
  const highs = r.int(3, 20);
  const perHigh = r.int(2, 6);
  const days = r.int(2, 7);
  return {
    prompt:
      `${h.intro} Altogether there are ${lows + highs} ${h.things} and ${lows * h.low + highs * h.high} ` +
      `${h.parts}. ${h.ask(perHigh, days)}`,
    answer: highs * perHigh * days,
  };
};

// ---------------------------------------------------------------- source

export const TEMPLATES: Record<SyntheticDomain, readonly Template[]> = {
  arithmetic: [bundlesAndChange, saleSplit, bakeryBoxes, savingsPlan, recipeScaling, theaterTickets],
  rates: [tripWithStop, workTogether, leakyTank, returnTrip, factoryBreakdown, catchUp],
  logic: [ageRatios, offsetChain, threeSets, cycleSync, calendarDate, pairings, headsAndParts],
};

const MAX_DRAWS = 200;

/** True if the answer shows up as a standalone number in the prompt. */
export function leaksAnswer(prompt: string, answer: number): boolean {
  return new RegExp(`(?<![\\d.,])${answer}(?![\\d]|[.,]\\d)`).test(prompt);
}

function draw(r: Rng, domain: SyntheticDomain): Problem {
  for (let i = 0; i < MAX_DRAWS; i++) {
    const p = r.pick(TEMPLATES[domain])(r);
    if (Number.isSafeInteger(p.answer) && p.answer > 0 && !leaksAnswer(p.prompt, p.answer)) return p;
  }
  throw new Error(`synthetic: no valid ${domain} problem after ${MAX_DRAWS} draws`);
}

export class SyntheticTaskSource implements TaskSource {
  async load(n: number, seed: number): Promise<Task[]> {
    if (!Number.isInteger(n) || n < 0) throw new RangeError(`task count must be a non-negative integer, got ${n}`);
    // One sequential stream: task i depends only on draws made for tasks 0..i, so load(k) is a prefix of load(n).
    const r = createRng(seed);
    return Array.from({ length: n }, (_, i) => {
      const domain = SYNTHETIC_DOMAINS[i % SYNTHETIC_DOMAINS.length]!;
      const { prompt, answer } = draw(r, domain);
      return { id: `t${String(i + 1).padStart(3, "0")}`, domain, prompt, answer: String(answer) };
    });
  }
}
