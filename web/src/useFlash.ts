import { useEffect, useState } from "react";

/** Returns `latest` for `ms` after it changes identity, then null. */
export function useFlash<T>(latest: T | undefined, ms: number): T | null {
  const [shown, setShown] = useState<T | null>(null);
  useEffect(() => {
    if (latest === undefined) {
      setShown(null);
      return;
    }
    setShown(latest);
    const timer = setTimeout(() => setShown(null), ms);
    return () => clearTimeout(timer);
  }, [latest, ms]);
  return shown;
}
