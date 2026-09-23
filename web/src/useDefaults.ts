import { useEffect, useState } from "react";
import type { DefaultsResponse } from "../../src/core/api";
import { errorText, getDefaults } from "./api";

/** Refetches whenever the stream (re)connects: the page may load before the server is up. */
export function useDefaults(online: boolean): { defaults: DefaultsResponse | null; error: string | null } {
  const [defaults, setDefaults] = useState<DefaultsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDefaults()
      .then((d) => {
        if (cancelled) return;
        // An older server may omit the v2 fields.
        setDefaults({ ...d, models: Array.isArray(d.models) ? d.models : [], evomapNode: d.evomapNode === true });
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(`默认配置 defaults: ${errorText(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [online]);

  return { defaults, error };
}
