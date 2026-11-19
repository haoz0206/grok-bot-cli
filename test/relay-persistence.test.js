import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRelayEngine } from "../src/core/relay/engine.js";
import { openRelayState } from "../src/core/relay/state.js";
import { createRecordFactory, op } from "../src/core/relay/records.js";

test(
  "reconciliation visits the observable 21st record after 20 unresolved records",
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "relay-reconcile-"));
    let engine;
    t.after(async () => {
      await engine?.close();
      await rm(dir, { recursive: true, force: true });
    });
    const factory = createRecordFactory({ env: {}, clock: () => 1000 });
    const rows = Array.from({ length: 21 }, (_, i) => ({
      ...factory.newRecord(
        "codex",
        "record-" + String(i).padStart(2, "0"),
        {
          threadId: "thread",
          targetId: "target",
          expectedCwd: process.cwd(),
          busyPolicy: "steer",
        },
        "hello",
      ),
      submission: "unknown",
    }));
    const store = await openRelayState({ dir, profile: "fairness" });
    await store.commit(rows.map((r) => op("records", r)));
    await store.close();
    let queries = 0;
    const session = {
      client: {
        closed: false,
        onClose() {},
        close() {},
        async request() {
          queries++;
          return {
            data: [
              {
                turnId: "turn-21",
                item: { type: "userMessage", clientId: rows[20].clientId },
              },
            ],
            nextCursor: null,
          };
        },
      },
    };
    engine = await openRelayEngine({
      stateDir: dir,
      profile: "fairness",
      gateway: {},
      openSession: async () => session,
      openConversation: async () => ({
        cwd: process.cwd(),
        close() {},
        wait: async () => ({ execution: { state: "unknown" } }),
      }),
    });
    await engine.tick();
    assert.equal(queries, 20);
    assert.equal(
      engine.status().receipts.find((r) => r.exchangeId === rows[20].id)
        .delivery,
      "unknown",
    );
    await engine.tick();
    assert.ok(queries <= 40);
    const receipt = engine
      .status()
      .receipts.find((r) => r.exchangeId === rows[20].id);
    assert.equal(receipt.delivery, "accepted");
    assert.equal(receipt.turnId, "turn-21");
    assert.equal(
      engine.status().receipts.filter((r) => r.delivery === "unknown").length,
      20,
    );
  },
);
