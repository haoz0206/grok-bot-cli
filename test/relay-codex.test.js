import assert from "node:assert/strict";
import test from "node:test";
import { createRelayCodex } from "../src/core/relay/codex.js";
import { openCodexSession } from "../src/core/codex-bridge.js";
import { fakeAppServer } from "./helpers/codex-server.js";

test("failed session reconnect backs off with a bounded clock", async () => {
  let calls = 0,
    now = 0;
  const c = createRelayCodex({
    env: {},
    read: () => ({ records: {} }),
    clock: () => now,
    openSession: async () => {
      calls++;
      throw new Error("offline");
    },
  });
  await assert.rejects(c.verify({ threadId: "t" }));
  await assert.rejects(c.verify({ threadId: "t" }));
  assert.equal(calls, 1);
  now = 1000;
  await assert.rejects(c.verify({ threadId: "t" }));
  assert.equal(calls, 2);
  await assert.rejects(c.verify({ threadId: "t" }));
  assert.equal(calls, 2);
  now = 3000;
  await assert.rejects(c.verify({ threadId: "t" }));
  assert.equal(calls, 3);
  await c.close();
});
test("steer retries only definite stale guards and never falls back to turn/start", async () => {
  let tries = 0;
  const sends = [];
  const session = {
    client: {
      closed: false,
      onClose: () => {},
      close() {},
      request: async () => ({
        data: [{ id: "active", status: "inProgress" }],
        nextCursor: null,
      }),
    },
  };
  const c = createRelayCodex({
    env: {},
    read: () => ({ records: {} }),
    openSession: async () => session,
    openConversation: async () => ({
      close() {},
      cwd: process.cwd(),
      send: async (_, options) => {
        sends.push(options);
        tries++;
        return {
          delivery: "rejected",
          reason: "rejected",
          error: "expected turn guard mismatch",
        };
      },
    }),
  });
  const record = {
    threadId: "thread",
    expectedCwd: process.cwd(),
    busyPolicy: "steer",
    clientId: "client",
    correlationId: "corr",
    hop: 0,
    maxHops: 4,
    text: "message",
  };
  assert.equal((await c.send(record)).delivery, "rejected");
  assert.equal(tries, 3);
  assert.ok(sends.every((s) => s.whenBusy === "steer"));
  await c.close();
});

test("threadless resolved notifications clear the relay interaction registry", async t => {
  const fake = await fakeAppServer({
    initialize: (_, ok) => ok({}),
    "thread/resume": (p, ok, err, send) => {
      ok({ thread: { id: p.threadId, cwd: process.cwd() } });
      send({ id: "ask", method: "item/commandExecution/requestApproval", params: { threadId: p.threadId, turnId: "turn" } });
    },
    resolve: (_, ok, err, send) => {
      send({ method: "serverRequest/resolved", params: { requestId: "ask" } });
      ok({});
    },
  });
  let session;
  const c = createRelayCodex({
    env: { CODEX_HOME: fake.home },
    read: () => ({ records: { exchange: { id: "exchange", kind: "codex", threadId: "thread", turnId: "turn", submission: "accepted" } } }),
    openSession: async (env, options) => (session = await openCodexSession(env, options)),
  });
  t.after(async () => { await c.close(); await fake.close(); });
  await c.verify({ threadId: "thread" });
  assert.equal(c.interactions.list().length, 1);
  await session.client.request("resolve", {});
  assert.deepEqual(c.interactions.list(), []);
});
