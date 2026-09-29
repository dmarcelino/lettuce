import { readFileSync } from "node:fs";

/**
 * The release tag of this build, e.g. `v0.1.0-letta_0.33.7`.
 *
 * The version cannot be derived at image build time — `.dockerignore` excludes
 * `.git/` and the image carries no `git` — so it travels as the repo's
 * `VERSION` file, updated in the same commit that is tagged (see CLAUDE.md
 * "Versioning and tags"). The bff image COPYs it next to the source, and the
 * same relative path resolves to the repo root in a dev checkout.
 *
 * A missing or empty file means an untagged dev checkout, not a failure: the
 * About section shows `dev` rather than hiding the row.
 */
export function readUiVersion(root: URL = new URL("../../", import.meta.url)): string {
  try {
    const text = readFileSync(new URL("VERSION", root), "utf8").trim();
    return text === "" ? "dev" : text;
  } catch {
    return "dev";
  }
}
