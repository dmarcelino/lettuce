/**
 * A port of letta-code's `parseFrontmatter` (`src/utils/frontmatter.ts`).
 *
 * Not YAML: upstream's parser is line-based — `key: value` taken verbatim,
 * `|` / `>` block scalars, and top-level `- item` lists — and a SKILL.md is
 * only listed the way the agent sees it if we read it the same way. The npm
 * package does not export the parser, so this mirrors it; `sync-upstream.sh`
 * flags the source when it changes.
 */

export type Frontmatter = Record<string, string | string[]>;

function parseBlockScalar(lines: string[], style: "|" | ">", chomping: "" | "+" | "-"): string {
  const contentIndent = lines.reduce<number | null>((minimum, line) => {
    if (!line.trim()) return minimum;
    const indentation = line.length - line.trimStart().length;
    return minimum === null ? indentation : Math.min(minimum, indentation);
  }, null);
  const deindented = lines.map((line) =>
    line.trim() && contentIndent !== null ? line.slice(contentIndent) : "",
  );

  let value: string;
  if (style === "|") {
    value = deindented.join("\n");
  } else {
    let pendingBreaks = 0;
    value = "";
    for (const line of deindented) {
      if (!line) {
        pendingBreaks += 1;
        continue;
      }
      if (value) value += pendingBreaks > 0 ? "\n".repeat(pendingBreaks) : " ";
      else if (pendingBreaks > 0) value += "\n".repeat(pendingBreaks);
      value += line;
      pendingBreaks = 0;
    }
    value += "\n".repeat(pendingBreaks);
  }

  if (chomping === "+") return `${value}\n`;
  const trimmed = value.replace(/\n+$/, "");
  return chomping === "-" ? trimmed : `${trimmed}\n`;
}

export function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
  const normalized = content.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/);
  if (!match || match[1] === undefined) return { frontmatter: {}, body: normalized };

  const body = match[2] ?? "";
  const frontmatter: Frontmatter = {};
  const lines = match[1].split("\n");
  let currentKey: string | null = null;
  let currentArray: string[] = [];

  const savePendingKey = () => {
    if (!currentKey) return;
    frontmatter[currentKey] = currentArray.length > 0 ? currentArray : "";
    currentKey = null;
    currentArray = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmedLine = line.trim();
    const indentation = line.length - line.trimStart().length;

    if (indentation > 0) {
      if (indentation <= 2 && trimmedLine.startsWith("-") && currentKey) {
        currentArray.push(trimmedLine.slice(1).trim());
      }
      continue;
    }

    savePendingKey();

    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();

    const block = value.match(/^([|>])([+-]?)$/);
    if (block?.[1]) {
      const blockLines: string[] = [];
      let next = index + 1;
      for (; next < lines.length; next += 1) {
        const blockLine = lines[next] ?? "";
        if (blockLine.trim() && blockLine === blockLine.trimStart()) break;
        blockLines.push(blockLine);
      }
      frontmatter[key] = parseBlockScalar(
        blockLines,
        block[1] as "|" | ">",
        (block[2] ?? "") as "" | "+" | "-",
      );
      index = next - 1;
      continue;
    }

    if (value) {
      frontmatter[key] = value;
    } else {
      currentKey = key;
      currentArray = [];
    }
  }
  savePendingKey();

  return { frontmatter, body: body.trim() };
}

function stripSurroundingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function frontmatterString(frontmatter: Frontmatter, key: string): string | undefined {
  const value = frontmatter[key];
  return typeof value === "string" ? stripSurroundingQuotes(value) : undefined;
}

export function frontmatterBoolean(frontmatter: Frontmatter, key: string): boolean | undefined {
  const value = frontmatterString(frontmatter, key)?.toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}
