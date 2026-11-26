import { expect, it } from "vitest";
import type { Env } from "../src/env";
import { weeklyThreads } from "../src/bot";

it("opens a weekly thread in each theme but Suggestions", async () => {
  const themes = [{ id: "c:general", title: "General" }, { id: "c:suggestions", title: "Suggestions" }];
  const posted: unknown[] = [];
  const prepare = (sql: string) => ({
    bind: (...args: unknown[]) => ({
      sql,
      args,
      first: async () => null,
      all: async () => ({ results: themes.filter((t) => !args.includes(t.id)) }),
    }),
  });
  const batch = async (stmts: { sql: string; args: unknown[] }[]) => posted.push(...stmts.filter((s) => s.sql.startsWith("INSERT INTO posts")).map((s) => s.args[1]));
  expect(await weeklyThreads({ DB: { prepare, batch } } as unknown as Env)).toHaveLength(1);
  expect(posted).toEqual(["c:general"]);
});
