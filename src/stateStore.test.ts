import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

const testFile = path.join(os.tmpdir(), `hint-state-${process.pid}.json`);
process.env.HINT_STATE_FILE = testFile;

// require is intentionally delayed until after HINT_STATE_FILE is set.
const store = require("./stateStore") as typeof import("./stateStore");

const seed = store.seedThemeSnapshot({
  themeCode: "test",
  generation: "game-1",
  revision: 5,
  isRunning: 1,
  startedAt: 1_000,
  endTime: 3_601_000,
  hintCount: 1,
  usedHintCodes: ["A"],
  chatData: [{ id: "server-1", generation: "game-1", type: "server", data: "server", createdAt: "2026-01-01T00:00:01Z" }],
  resetAt: 500,
});

const reset = store.applyAction("test", "reset-1", { type: "reset", durationMs: 3_600_000 });
assert.equal(reset.status, "applied");
assert.notEqual(reset.snapshot?.generation, seed.generation);
const resetAgain = store.applyAction("test", "reset-2", { type: "reset", durationMs: 3_600_000 });
assert.equal(resetAgain.snapshot?.generation, reset.snapshot?.generation, "empty repeated reset must be coalesced");

store.applyAction("test", "start-server", { type: "start", durationMs: 3_600_000, startedAt: 10_000 });
const merged = store.reconcileAppSnapshot({
  themeCode: "test",
  generation: "local:1",
  localBranchId: "local:1",
  localResetAt: 9_000,
  baseGeneration: "game-1",
  baseRevision: 5,
  isRunning: 1,
  startedAt: 11_000,
  endTime: 3_611_000,
  usedHintCodes: ["B"],
  hintCount: 1,
  chatData: [{ id: "client-1", generation: "local:1", type: "client", data: "client", createdAt: "2026-01-01T00:00:02Z" }],
});
assert.equal(merged.status, "offlineBranchMerged");
assert.deepEqual(new Set(merged.snapshot.usedHintCodes), new Set(["B"]));
assert.equal(merged.snapshot.chatData.some((message) => message.id === "client-1"), true);
assert.equal(merged.snapshot.isRunning, 1, "a delayed reset must not stop the active game");

const stale = store.reconcileAppSnapshot({
  themeCode: "test",
  generation: "old-game",
  chatData: [{ id: "old", generation: "old-game", type: "client", data: "old", createdAt: "2025-01-01T00:00:00Z" }],
});
assert.equal(stale.status, "serverWins");
assert.equal(stale.snapshot.chatData.some((message) => message.id === "old"), false);

for (const file of [testFile, `${testFile}.tmp`]) {
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

console.log("state reconciliation tests passed");
