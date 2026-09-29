import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readUiVersion } from "./version.ts";

const dirs: string[] = [];
function tempDir(): URL {
  const dir = mkdtempSync(join(tmpdir(), "letta-ui-version-"));
  dirs.push(dir);
  return pathToFileURL(`${dir}/`);
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

test("reads the tag from VERSION, trimmed", () => {
  const root = tempDir();
  writeFileSync(new URL("VERSION", root), "v0.1.0-letta_0.33.3\n");
  expect(readUiVersion(root)).toBe("v0.1.0-letta_0.33.3");
});

test("missing VERSION reads as dev", () => {
  expect(readUiVersion(tempDir())).toBe("dev");
});

test("empty VERSION reads as dev", () => {
  const root = tempDir();
  writeFileSync(new URL("VERSION", root), "  \n");
  expect(readUiVersion(root)).toBe("dev");
});

test("the repo checkout carries a well-formed release tag", () => {
  expect(readUiVersion()).toMatch(/^v\d+\.\d+\.\d+-letta_\d+\.\d+\.\d+$/);
});
