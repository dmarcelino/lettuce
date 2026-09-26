import { describe, expect, test } from "bun:test";
import { BackStack } from "./back-stack.ts";

/** A fake history: `length` counts entries; Back fires popstate right away. */
function setup() {
  const deferred: (() => void)[] = [];
  let length = 1;
  let stack: BackStack;
  const history = {
    pushState: () => {
      length += 1;
    },
    back: () => {
      length -= 1;
      stack.onPopState();
    },
  };
  stack = new BackStack(history, (fn) => deferred.push(fn));
  const flush = () => {
    while (deferred.length) deferred.shift()?.();
  };
  /** The user pressing the Back button. */
  const pressBack = () => {
    length -= 1;
    stack.onPopState();
  };
  return { stack, flush, pressBack, length: () => length };
}

describe("BackStack", () => {
  test("Back closes the open overlay and leaves the app's own entry", () => {
    const { stack, pressBack, length } = setup();
    let closed = false;
    stack.open(() => {
      closed = true;
    });
    expect(length()).toBe(2);
    pressBack();
    expect(closed).toBe(true);
    expect(length()).toBe(1);
    expect(stack.depth).toBe(0);
  });

  test("closing on screen removes the entry, so the next Back is not wasted", () => {
    const { stack, flush, length } = setup();
    const release = stack.open(() => {});
    release();
    flush();
    expect(length()).toBe(1);
  });

  test("nested overlays close top first", () => {
    const { stack, pressBack } = setup();
    const closed: string[] = [];
    stack.open(() => {
      closed.push("switcher");
    });
    stack.open(() => {
      closed.push("menu");
    });
    pressBack();
    expect(closed).toEqual(["menu"]);
    pressBack();
    expect(closed).toEqual(["menu", "switcher"]);
  });

  test("an overlay replacing another in one render reuses its entry", () => {
    const { stack, flush, pressBack, length } = setup();
    const releaseSwitcher = stack.open(() => {});
    releaseSwitcher(); // "New agent": the switcher closes…
    let editorClosed = false;
    stack.open(() => {
      editorClosed = true; // …and the agent editor opens in the same tick.
    });
    flush();
    expect(length()).toBe(2); // exactly one entry, the editor's
    pressBack();
    expect(editorClosed).toBe(true);
    expect(length()).toBe(1);
  });

  test("an undismissable overlay swallows Back instead of letting the app exit", () => {
    const { stack, pressBack, length } = setup();
    stack.open(() => false);
    pressBack();
    expect(stack.depth).toBe(1);
    expect(length()).toBe(2);
  });

  test("Back pressed before a stale entry is cleaned up consumes it, once", () => {
    const { stack, flush, pressBack, length } = setup();
    const release = stack.open(() => {});
    release();
    pressBack(); // lands on the stale entry
    flush(); // the deferred clean-up must not pop the app's own entry too
    expect(length()).toBe(1);
  });
});
