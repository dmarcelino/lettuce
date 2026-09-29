/**
 * The `Content-Disposition` value for a downloaded workspace file.
 *
 * The filename here is the last component of a path an agent wrote, so it is
 * attacker-influenced text being placed inside a response header. Two things
 * have to be neutralised before it goes out:
 *
 * - **Header injection.** A CR or LF in the value would let the filename end
 *   this header and start arbitrary ones. Control characters are stripped
 *   outright rather than escaped, because a header must not contain them at all.
 * - **Quoted-string breakout.** A `"` or backslash would close the
 *   `filename="..."` early and leave the remainder as unparsed junk that
 *   different browsers resolve differently. Both are removed from the
 *   ASCII fallback.
 *
 * Non-ASCII names survive by going through RFC 5987's `filename*` parameter,
 * percent-encoded, so a filename like `отчёт.pdf` renders correctly instead of
 * turning into underscores. The plain `filename` is still sent alongside it for
 * clients that do not implement `filename*`.
 */

const FALLBACK_NAME = "download";

/** Control characters, including CR and LF — never legal in a header value. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the whole point.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** The filename with control characters and surrounding whitespace removed. */
function cleanFilename(filename: string): string {
  return filename.replace(CONTROL_CHARS, "").trim();
}

/**
 * The ASCII `filename="..."` value: printable ASCII only, with the two
 * characters that would break the quoted string removed.
 */
function asciiFallback(filename: string): string {
  const cleaned = cleanFilename(filename)
    .replace(/["\\]/g, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .trim();
  return cleaned === "" ? FALLBACK_NAME : cleaned;
}

/** RFC 5987 percent-encoding for the `filename*` parameter. */
function percentEncode(filename: string): string {
  return encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Whether the name has anything a plain ASCII `filename` cannot carry. */
function needsExtendedParameter(filename: string): boolean {
  return /[^\x20-\x7e]/.test(filename);
}

/**
 * The full header value for `filename` under `disposition`.
 *
 * `filename*` is only added when the name actually needs it, so the common
 * ASCII case stays a single short parameter.
 */
export function contentDisposition(filename: string, disposition: "inline" | "attachment"): string {
  const cleaned = cleanFilename(filename);
  const params = [`${disposition}; filename="${asciiFallback(cleaned)}"`];
  if (needsExtendedParameter(cleaned)) {
    params.push(`filename*=UTF-8''${percentEncode(cleaned)}`);
  }
  return params.join("; ");
}
