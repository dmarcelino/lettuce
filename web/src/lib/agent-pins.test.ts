import { describe, expect, test } from "bun:test";
import { orderByPins } from "./agent-pins.ts";

const a = (id: string) => ({ id });

describe("orderByPins", () => {
  test("pinned first in pin order, the rest as listed", () => {
    const listed = [a("x"), a("y"), a("z"), a("w")];
    expect(orderByPins(listed, ["z", "x"]).map((agent) => agent.id)).toEqual(["z", "x", "y", "w"]);
  });

  test("a pin for an agent that no longer exists is ignored", () => {
    expect(orderByPins([a("x")], ["gone", "x"]).map((agent) => agent.id)).toEqual(["x"]);
  });

  test("nothing pinned keeps the list as it is", () => {
    const listed = [a("x"), a("y")];
    expect(orderByPins(listed, [])).toEqual(listed);
  });
});
