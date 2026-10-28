import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/store.ts";

test("register, end, list", () => {
  const store = openStore(":memory:");
  const a = store.register({ id: "a", repo: "/r1", worktree: "/r1", branch: "main" });
  store.register({ id: "b", repo: "/r1", worktree: "/r1-wt", branch: "feat" });
  assert.equal(a.ended_at, null);

  assert.equal(store.end("a", 0), true);
  assert.equal(store.end("a", 1), false, "a second end is refused");
  assert.equal(store.end("nope", 0), false);

  const byId = Object.fromEntries(store.list().map((s) => [s.id, s]));
  assert.equal(byId.a.exit_code, 0);
  assert.ok(byId.a.ended_at);
  assert.equal(byId.b.ended_at, null);
  assert.equal(store.list().length, 2);
  store.close();
});
