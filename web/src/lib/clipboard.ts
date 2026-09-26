/**
 * Put text on the clipboard. True when it worked.
 *
 * `navigator.clipboard` exists only in a secure context, and this app is also
 * reached over plain http on the LAN (local mode), where it is undefined. The
 * old `execCommand("copy")` path still works there, from a user gesture.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    // Typed as always present, but undefined outside a secure context.
    const clipboard = globalThis.navigator?.clipboard as Clipboard | undefined;
    if (clipboard) {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied or unavailable: fall through to the legacy path.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
