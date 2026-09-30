import { describe, expect, test } from "bun:test";
import { createLongPress } from "./long-press.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function controller(ms = 30) {
  const calls: string[] = [];
  const held: boolean[] = [];
  const c = createLongPress({
    enabled: () => true,
    onShort: () => calls.push("short"),
    onLong: () => calls.push("long"),
    ms,
    onHeldChange: (h) => held.push(h),
  });
  return { c, calls, held };
}

describe("createLongPress", () => {
  test("a release before the threshold is a short press", () => {
    const { c, calls } = controller();
    c.pointerDown();
    c.pointerUp();
    c.click();
    expect(calls).toEqual(["short"]);
  });

  test("holding past the threshold fires the long action once, release does nothing", async () => {
    const { c, calls } = controller();
    c.pointerDown();
    await sleep(60);
    c.pointerUp();
    c.click();
    expect(calls).toEqual(["long"]);
  });

  test("a keyboard click performs the short action", () => {
    const { c, calls } = controller();
    c.click();
    expect(calls).toEqual(["short"]);
  });

  test("a cancelled gesture fires nothing and does not swallow the next keyboard click", async () => {
    const { c, calls } = controller();
    c.pointerDown();
    c.pointerCancel();
    await sleep(60);
    expect(calls).toEqual([]);
    c.click();
    expect(calls).toEqual(["short"]);
  });

  test("held tracks the countdown", async () => {
    const { c, held } = controller();
    c.pointerDown();
    c.pointerUp();
    c.pointerDown();
    await sleep(60);
    expect(held).toEqual([true, false, true, false]);
  });

  test("the context menu is suppressed only while holding", () => {
    const { c } = controller();
    expect(c.contextMenu()).toBe(false);
    c.pointerDown();
    expect(c.contextMenu()).toBe(true);
    c.pointerUp();
    expect(c.contextMenu()).toBe(false);
  });

  test("a disabled controller ignores everything", () => {
    const calls: string[] = [];
    const c = createLongPress({
      enabled: () => false,
      onShort: () => calls.push("short"),
      onLong: () => calls.push("long"),
      ms: 5,
    });
    c.pointerDown();
    c.pointerUp();
    c.click();
    expect(calls).toEqual([]);
  });
});
