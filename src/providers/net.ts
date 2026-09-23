import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

/**
 * Node's built-in env proxy (--use-env-proxy) funnelled every request of a long run through one proxy
 * connection, serialising concurrent calls (8 in flight -> ~18 s each). An explicit pooled agent keeps
 * HTTP(S)_PROXY / NO_PROXY semantics with many connections, and is a plain pooled agent when no proxy is set.
 * Call once from entry points only; tests keep the default dispatcher so local test servers stay direct.
 */
export function configureNetwork(connections = 64): void {
  setGlobalDispatcher(new EnvHttpProxyAgent({ connections }));
}
