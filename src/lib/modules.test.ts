import { describe, expect, it } from "vitest";
import { moduleCount, modules } from "./modules";
describe("foundation module definitions", () => {
 it("lists six unique planned modules", () => {
  expect(moduleCount()).toBe(6);
  expect(new Set(modules.map((m)=>m.title)).size).toBe(6);
 });
});
