import { useEffect, useState } from "react";

/** The desktop breakpoint, the same one styles.css switches layouts at. */
const WIDE_QUERY = "(min-width: 900px)";

/** Whether the viewport is at the desktop breakpoint, kept current on resize. */
export function useWide(): boolean {
  const [wide, setWide] = useState(() => globalThis.matchMedia?.(WIDE_QUERY).matches ?? false);
  useEffect(() => {
    const query = globalThis.matchMedia?.(WIDE_QUERY);
    if (!query) return;
    const onChange = () => setWide(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return wide;
}
