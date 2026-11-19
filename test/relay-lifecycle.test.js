import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRelayEngine } from "../src/core/relay/engine.js";
import { fakeAppServer } from "./helpers/codex-server.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
for (const phase of [
  "history",
  "idle-history",
  "idle-resume",
  "retry-history",
  "send-resume",
  "retry-resume",
  "written",
  "written-unknown",
])
  test(
    `stopping one binding during ${phase} preserves other routes and delivery certainty`,
    { timeout: 5000 },
    async (t) => {
      const reached = deferred(),
        release = deferred();
      let historyCalls = 0,
        resumeCalls = 0,
        steers = 0,
        gateResume = false;
      const hold = async (ok) => {
        reached.resolve();
        await release.promise;
        ok();
      };
      const idle = phase.startsWith("idle-");
      const turns = idle ? [] : [{ id: "turn", status: "inProgress" }];
      const submit = (p, ok, err) => {
        const reply = () =>
          ok(
            p.expectedTurnId
              ? {
                  turnId:
                    phase === "written-unknown" && p.threadId === "thread-1"
                      ? "wrong-turn"
                      : "turn",
                }
              : { turn: { id: "turn", status: "inProgress" } },
          );
        if (p.threadId === "thread-1") {
          steers++;
          if (phase === "retry-history" || phase === "retry-resume") {
            err({ code: -32600, message: "expected turn guard mismatch" });
            return;
          }
          if (phase.startsWith("written")) {
            void hold(reply);
            return;
          }
        }
        reply();
      };
      const fake = await fakeAppServer({
        initialize: (_, ok) => ok({}),
        "thread/resume": (p, ok) => {
          const reply = () =>
            ok({
              thread: {
                id: p.threadId,
                cwd: process.cwd(),
                status: { type: idle ? "idle" : "active" },
              },
              cwd: process.cwd(),
            });
          if (p.threadId === "thread-1" && gateResume) {
            resumeCalls++;
            if (
              (["send-resume", "idle-resume"].includes(phase) &&
                resumeCalls === 1) ||
              (phase === "retry-resume" && resumeCalls === 2)
            ) {
              void hold(reply);
              return;
            }
          }
          reply();
        },
        "thread/turns/list": (p, ok) => {
          if (p.threadId === "thread-1") {
            historyCalls++;
            gateResume = true;
            if (
              (["history", "idle-history"].includes(phase) &&
                historyCalls === 1) ||
              (phase === "retry-history" && historyCalls === 2)
            ) {
              void hold(() =>
                ok({
                  data: turns,
                  nextCursor: null,
                }),
              );
              return;
            }
          }
          ok({ data: turns, nextCursor: null });
        },
        "turn/steer": submit,
        "turn/start": submit,
      });
      const dir = await mkdtemp(join(tmpdir(), "relay-stop-"));
      const engine = await openRelayEngine({
        stateDir: dir,
        profile: "stop",
        env: { CODEX_HOME: fake.home },
        gateway: { resolve: async (id) => ({ id }), tail: async () => ({ entries: [] }) },
      });
      t.after(async () => {
        release.resolve();
        await engine.close();
        await fake.close();
        await rm(dir, { recursive: true, force: true });
      });
      const first = await engine.startBinding({
        grokTarget: "target-1",
        codexThreadId: "thread-1",
      });
      const second = await engine.startBinding({
        grokTarget: "target-2",
        codexThreadId: "thread-2",
      });
      const pending = engine.sendToCodex({
        bindingId: first.id,
        message: "stop me",
        requestId: "stop-race",
      });
      await reached.promise;
      const before = steers;
      await engine.stopBinding({ bindingId: first.id });
      release.resolve();
      const receipt = await pending;
      assert.equal(steers, before, "no submission after stop returns");
      assert.equal(
        receipt.delivery,
        phase === "written"
          ? "accepted"
          : phase === "written-unknown"
            ? "unknown"
            : "rejected",
      );
      if (!phase.startsWith("written"))
        assert.equal(receipt.reason, "cancelled");
      assert.ok(engine.status().generation);
      assert.equal(
        (
          await engine.sendToCodex({
            bindingId: second.id,
            message: "keep working",
          })
        ).delivery,
        "accepted",
      );
      assert.equal(
        fake.received.filter((r) => r.method === "turn/interrupt").length,
        0,
      );
    },
  );
