import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

describe("workspace scaffold", () => {
  test("declares plugin workspaces and pins the plugin SDK", () => {
    expect(pkg.workspaces).toEqual(["packages/*"]);
    expect(pkg.dependencies["@opencode/plugin"]).toBe("2.0.12");
  });
});
