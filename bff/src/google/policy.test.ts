import { describe, expect, test } from "bun:test";
import {
  coveredPermissions,
  IDENTITY_SCOPES,
  NO_PERMISSIONS,
  narrows,
  permissionArgs,
  scopesForLevel,
  scopesForPermissions,
} from "./policy.ts";

const G = "https://www.googleapis.com/auth/";

describe("scopes", () => {
  test("levels are cumulative", () => {
    expect(scopesForLevel("gmail", "readonly")).toEqual([`${G}gmail.readonly`]);
    expect(scopesForLevel("gmail", "drafts")).toEqual([
      `${G}gmail.readonly`,
      `${G}gmail.labels`,
      `${G}gmail.modify`,
      `${G}gmail.compose`,
    ]);
    expect(scopesForLevel("gmail", null)).toEqual([]);
  });

  test("read-only Gmail never asks for a sending scope", () => {
    const scopes = scopesForPermissions({ gmail: "readonly", calendar: "full", tasks: "manage" });
    expect(scopes).not.toContain(`${G}gmail.send`);
    expect(scopes).not.toContain(`${G}gmail.compose`);
    expect(scopes).not.toContain(`${G}gmail.modify`);
    expect(scopes).toContain(`${G}tasks`);
    expect(scopes).toContain(`${G}calendar.events`);
    for (const scope of IDENTITY_SCOPES) expect(scopes).toContain(scope);
  });

  test("tasks manage and full need the same scope", () => {
    expect(scopesForLevel("tasks", "manage")).toEqual(scopesForLevel("tasks", "full"));
  });
});

describe("coveredPermissions", () => {
  const wanted = { gmail: "send", calendar: "full", tasks: "full" } as const;

  test("everything granted runs at the wanted levels", () => {
    expect(coveredPermissions(wanted, scopesForPermissions(wanted))).toEqual(wanted);
  });

  test("a scope unticked on the consent screen lowers that service only", () => {
    const granted = scopesForPermissions(wanted).filter((scope) => scope !== `${G}gmail.send`);
    expect(coveredPermissions(wanted, granted)).toEqual({ ...wanted, gmail: "drafts" });
  });

  test("never goes above what is wanted, even if the token allows it", () => {
    const granted = scopesForPermissions(wanted);
    expect(coveredPermissions({ ...NO_PERMISSIONS, gmail: "readonly" }, granted)).toEqual({
      ...NO_PERMISSIONS,
      gmail: "readonly",
    });
  });
});

test("narrows", () => {
  const current = { gmail: "send", calendar: null, tasks: "manage" } as const;
  expect(narrows(current, { ...current, gmail: "readonly" })).toBe(true);
  expect(narrows(current, { ...current, tasks: null })).toBe(true);
  expect(narrows(current, { ...current, calendar: "full" })).toBe(false);
});

test("permissionArgs lists enabled services only", () => {
  expect(permissionArgs({ gmail: "readonly", calendar: null, tasks: "manage" })).toEqual([
    "gmail:readonly",
    "tasks:manage",
  ]);
});
