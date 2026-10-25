import { describe, expect, test } from "bun:test";
import { toolsetLabel } from "./ModelPicker.tsx";

const toolset = (id: string, label: string, featured = true) => ({
  id,
  label,
  description: "",
  featured,
});

describe("toolsetLabel", () => {
  const toolsets = [
    toolset("auto", "Auto"),
    toolset("full", "Full"),
    toolset("x", "Hidden one", false),
  ];

  test("the toolset in force is named by its own label", () => {
    expect(toolsetLabel("full", toolsets)).toBe("Full");
  });

  test("nothing chosen yet reads as Auto", () => {
    // The preference is "auto" until the first device-status frame reports a
    // choice, and `null` is before that frame entirely.
    expect(toolsetLabel("auto", [])).toBe("Auto");
    expect(toolsetLabel(null, toolsets)).toBe("Auto");
  });

  test("a toolset that is not offered still does not crash the header", () => {
    // A preference set before the endpoint changed what it serves: the header is
    // the only place the user can see what is in force while it is collapsed.
    expect(toolsetLabel("gone", toolsets)).toBe("Auto");
  });

  test("a non-featured toolset in force is still named", () => {
    expect(toolsetLabel("x", toolsets)).toBe("Hidden one");
  });
});
