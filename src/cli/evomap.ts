import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { EvoMapClient, type EvoMapBundleInput } from "../providers/evomap";
import { configureNetwork } from "../providers/net";

const USAGE = `usage: pnpm evomap status
       pnpm evomap node
       pnpm evomap search <query> [--min-gdi 0-100] [--limit 5]
       pnpm evomap validate-sample`;

/** A realistic arithmetic strategy gene for rehearsing the publish format against /a2a/validate. */
export function sampleBundleInput(now: number): EvoMapBundleInput {
  const id = "sample-arithmetic-inverse-check";
  return {
    gene: {
      id,
      kind: "solve",
      domain: "arithmetic",
      text: "For multi-step arithmetic, write every intermediate result on its own line, then confirm the final answer by inverting the last operation before answering.",
      origin: "parallelize-sample",
      lineageId: id,
      wins: 7,
      trials: 8,
      createdAt: now,
      source: "local",
      evidence: { wins: 7, trials: 8, independentSources: 2 },
    },
    modelName: "anthropic/claude-haiku-4.5",
    signals: ["arithmetic", "multi-step calculation", "order of operations", "answer verification"],
    strategy: [
      "Rewrite the word problem as an explicit ordered list of arithmetic operations",
      "Compute each intermediate value on its own line before combining them",
      "Invert the final operation to confirm the answer before committing to it",
    ],
    confidence: 0.8,
    score: 0.875,
    successStreak: 7,
    cycles: 3,
    mutations: 2,
    gate: { tasks: 8, withGene: 7, withoutGene: 5 },
  };
}

function num(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`--${name} must be a number, got ${raw}`);
  return v;
}

export async function runCli(argv: string[], deps: { client?: EvoMapClient; out?: (line: string) => void } = {}): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "min-gdi": { type: "string" },
      limit: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const out = deps.out ?? ((line: string) => console.log(line));
  const [command, ...rest] = positionals;
  if (values.help || command === undefined) {
    out(USAGE);
    return values.help ? 0 : 1;
  }
  const client = deps.client ?? new EvoMapClient();

  switch (command) {
    case "status": {
      const node = await client.node();
      const exists = existsSync(client.nodeFile);
      out(`base URL:  ${client.baseUrl}`);
      out(`node file: ${client.nodeFile} (${exists ? (node ? "present" : "unreadable or malformed") : "missing"})`);
      if (node) {
        out(`node id:   ${node.nodeId}`);
        out(`claim URL: ${node.claimUrl ?? "unknown"}`);
      } else if (!exists) {
        out("no node registered yet: run `pnpm evomap node`");
      }
      return 0;
    }
    case "node": {
      const node = await client.ensureNode();
      out(node.created ? `registered EvoMap node ${node.nodeId}` : `EvoMap node already registered: ${node.nodeId}`);
      out(`claim URL: ${node.claimUrl ?? "unknown (see your EvoMap account)"}`);
      out("Open the claim URL while signed in to your EvoMap account to bind this node to it.");
      out(`The node secret stays in ${client.nodeFile} (mode 0600) and is never printed.`);
      return 0;
    }
    case "search": {
      const query = rest.join(" ").trim();
      if (query === "") throw new Error("search needs a query");
      const limit = num("limit", values.limit);
      const minGdi = num("min-gdi", values["min-gdi"]);
      const hits = await client.search(query, {
        ...(limit === undefined ? {} : { limit }),
        ...(minGdi === undefined ? {} : { minGdi }),
      });
      if (hits.length === 0) {
        out(`no genes found${client.lastError ? ` (${client.lastError})` : ""}`);
        return client.lastError ? 1 : 0;
      }
      hits.forEach((h, i) => {
        out(`${String(i + 1).padStart(2)}. [gdi ${h.gdi.toFixed(1)} | ${h.trustTier}] ${h.title}`);
        out(`    ${h.url}`);
      });
      return 0;
    }
    case "validate-sample": {
      const bundle = client.buildBundle(sampleBundleInput(Date.now()));
      const node = await client.node();
      const res = await client.validate(bundle);
      out(`validate: ${res.ok ? "ok" : "FAILED"} (status: ${res.status})`);
      out(`sender:   ${node ? node.nodeId : "no node registered, sent with a throwaway sender id"}`);
      ["gene", "capsule", "event"].forEach((name, i) => out(`${name.padEnd(8)}  ${res.assetIds[i] ?? "?"}`));
      for (const w of res.warnings ?? []) out(`warning:  ${w}`);
      if (res.error) out(`error:    ${res.error}`);
      return res.ok ? 0 : 1;
    }
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  configureNetwork();
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      console.error(USAGE);
      process.exit(1);
    },
  );
}
