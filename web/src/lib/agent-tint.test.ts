import { describe, expect, test } from "bun:test";
import { AVATAR_TINTS, initialOf, resolveAvatar, tintFor } from "./agent-tint.ts";

describe("AVATAR_TINTS", () => {
  test("every tint the picker offers is storable — the same rule the BFF applies", () => {
    // A swatch showing `var(--accent)` displayed fine and answered 400 on Save,
    // which is the only reason this is a test and not an obvious fact.
    for (const tint of AVATAR_TINTS) {
      expect(tint).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("resolveAvatar", () => {
  test("with no preference it is exactly what the avatar always was", () => {
    expect(resolveAvatar("agent-a", "memo")).toEqual({
      background: tintFor("agent-a"),
      content: "M",
    });
    expect(resolveAvatar("agent-a", "memo", {})).toEqual(resolveAvatar("agent-a", "memo"));
  });

  test("a chosen tint wins over the hash, a chosen glyph over the initial", () => {
    expect(resolveAvatar("agent-a", "memo", { tint: "#7aa2f7" }).background).toBe("#7aa2f7");
    expect(resolveAvatar("agent-a", "memo", { glyph: "🦊" }).content).toBe("🦊");
    expect(resolveAvatar("agent-a", "memo", { tint: "#7aa2f7", glyph: "🦊" })).toEqual({
      background: "#7aa2f7",
      content: "🦊",
    });
  });

  test("the two fall through independently — a tint alone keeps the letter", () => {
    expect(resolveAvatar("agent-a", "memo", { tint: "#7aa2f7" }).content).toBe("M");
    expect(resolveAvatar("agent-a", "memo", { glyph: "🦊" }).background).toBe(tintFor("agent-a"));
  });

  test("an empty glyph is no glyph, not a blank face", () => {
    expect(resolveAvatar("agent-a", "memo", { glyph: "" }).content).toBe("M");
  });

  test("an unknown name still gets a face", () => {
    expect(initialOf("  ")).toBe("?");
    expect(resolveAvatar("", "").content).toBe("?");
  });

  test("the same id always hashes to the same tint", () => {
    expect(tintFor("agent-x")).toBe(tintFor("agent-x"));
  });
});
