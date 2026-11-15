import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { connectGateway, GATEWAY_MAX_RESPONSE_BYTES, sendPrompt } from "../src/core/gateway.js";

function fixture(t, response = { delivery: "GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL" }) {
  const home = mkdtempSync(join(tmpdir(), "gbot-backend-send-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const [key, value] of Object.entries({
    GROK_BOT_TEST: "1", CURSOR_ACCESS_TOKEN: "fixture-access",
    CURSOR_API_BASE_URL: "http://127.0.0.1:1340",
    GROK_BOT_GATEWAY_URL: undefined, GROK_BOT_GATEWAY_TOKEN: undefined,
    GROK_BOT_GATEWAY_HEADERS: undefined, SAND_CLIENT_VERSION: "1.1.0",
  })) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const calls = [];
  const options = { appSessionOptions: { home, platform: "linux", env: { XDG_CONFIG_HOME: home } } };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const call = { path: new URL(url).pathname, init, body: JSON.parse(init.body) };
    calls.push(call);
    switch (call.path) {
      case "/aiserver.v1.GrokBotService/EnsureSandBox":
        return Response.json({ gatewayUrl: "http://127.0.0.1:1341", gatewayToken: "fixture-gateway" });
      case "/api/listAgents":
        return Response.json({ agents: [{ id: "bot-1", name: "Momo" }] });
      case "/api/sendPrompt":
        return Response.json({ message: "This Bot runs on the server, and this version of the app can't message it. Update the app and try again." }, { status: 409 });
      case "/aiserver.v1.GrokBotService/SendGrokBotUserMessage":
        return typeof response === "function" ? response(call) : Response.json(response);
      case "/api/getAgentTranscriptTail":
        return Response.json({ entries: [{ id: "entry-1", clientNonce: "stable-nonce", role: "user" }] });
      default:
        throw new Error(`Unexpected fixture request ${call.path}`);
    }
  });
  return { calls, options };
}

test("server Bot sends use the backend and a matching nonce receipt, not the legacy 409 route", async (t) => {
  const { calls, options } = fixture(t);
  const result = await sendPrompt(await connectGateway(options), "Momo", "hello", { clientNonce: "stable-nonce", replyToId: "parent-1" });
  assert.equal(result.delivery, "accepted");
  assert.equal(result.messageId, "entry-1");
  assert.deepEqual(calls.map(c => c.path), [
    "/aiserver.v1.GrokBotService/EnsureSandBox", "/api/listAgents",
    "/aiserver.v1.GrokBotService/SendGrokBotUserMessage", "/api/getAgentTranscriptTail",
  ]);
  const send = calls[2];
  assert.equal(send.body.agentId, "bot-1");
  assert.equal(send.body.messageId, "stable-nonce");
  assert.equal(send.body.text, "hello");
  assert.equal(send.body.replyToId, "parent-1");
  assert.match(send.body.sentAtMs, /^\d+$/);
  assert.equal(send.init.headers.authorization, "Bearer fixture-access");
  assert.equal(send.init.headers["x-cursor-client-version"], "1.1.0");
  assert.equal(send.init.headers["content-type"], "application/json");
  assert.equal(send.init.redirect, "error");
});

for (const delivery of [1, 2, 3, "GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_BOX", "GROK_BOT_USER_MESSAGE_DELIVERY_DUPLICATE"]) {
  test(`backend delivery ${delivery} still requires a matching receipt`, async (t) => {
    const { calls, options } = fixture(t, { delivery });
    const result = await sendPrompt(await connectGateway(options), "Momo", "hello", { clientNonce: "not-in-transcript" });
    assert.equal(result.delivery, "unknown");
    assert.equal(result.messageId, undefined);
    assert.equal(calls.filter(c => c.path.endsWith("/SendGrokBotUserMessage")).length, 1);
    assert.equal(calls.at(-1).path, "/api/getAgentTranscriptTail");
  });
}

for (const response of [null, {}, { accepted: true }, { messageId: "not-a-backend-receipt" }, { delivery: 0 }, { delivery: 99 }, { delivery: "ACCEPTED_TEMPORAL" }, { delivery: [] }, { delivery: 2, refusal: { message: "contradiction" } }]) {
  test(`backend HTTP success is not a receipt: ${JSON.stringify(response)}`, async (t) => {
    const { calls, options } = fixture(t, response);
    const result = await sendPrompt(await connectGateway(options), "Momo", "hello", { clientNonce: "stable-nonce" });
    assert.equal(result.delivery, "unknown");
    assert.equal(result.messageId, undefined);
    assert.equal(calls.length, 3, "an invalid acknowledgement neither resends nor reports a transcript receipt");
  });
}

for (const delivery of [4, "GROK_BOT_USER_MESSAGE_DELIVERY_REFUSED"]) {
  test(`backend refusal ${delivery} is rejected and redacted`, async (t) => {
    const { calls, options } = fixture(t, { delivery, refusal: { message: "denied Bearer fixture-secret" } });
    await assert.rejects(sendPrompt(await connectGateway(options), "Momo", "hello"), (error) => {
      assert.equal(error.delivery, "rejected");
      assert.equal(error.targetId, "bot-1");
      assert.match(error.message, /denied/);
      assert.doesNotMatch(error.message, /fixture-secret/);
      return true;
    });
    assert.equal(calls.length, 3);
  });
}

for (const [status, delivery] of [[403, "rejected"], [408, "unknown"], [499, "unknown"], [500, "unknown"], [504, "unknown"]]) {
  test(`backend HTTP ${status} is ${delivery}, with no gateway fallback or resend`, async (t) => {
    const { calls, options } = fixture(t, () => Response.json({ message: "failure Bearer fixture-secret" }, { status }));
    await assert.rejects(sendPrompt(await connectGateway(options), "Momo", "hello"), (error) => {
      assert.equal(error.delivery, delivery);
      assert.doesNotMatch(error.message, /fixture-secret/);
      return true;
    });
    assert.equal(calls.length, 3);
  });
}

test("backend timeout remains unknown without modifying or retrying the exception", async (t) => {
  const failure = new DOMException("deadline", "TimeoutError");
  const { calls, options } = fixture(t, () => { throw failure; });
  await assert.rejects(sendPrompt(await connectGateway(options), "Momo", "hello"), (error) => {
    assert.equal(error.delivery, "unknown");
    assert.equal(error.name, "TimeoutError");
    assert.equal(error.cause, failure);
    assert.match(error.message, /check the thread before resending/);
    return true;
  });
  assert.equal(failure.delivery, undefined);
  assert.equal(calls.length, 3);
});

test("backend response size is capped and oversized output remains unknown", async (t) => {
  const { calls, options } = fixture(t, () => new Response("x".repeat(GATEWAY_MAX_RESPONSE_BYTES + 1)));
  await assert.rejects(sendPrompt(await connectGateway(options), "Momo", "hello"), (error) => {
    assert.equal(error.delivery, "unknown");
    assert.match(error.message, /too large/);
    return true;
  });
  assert.equal(calls.length, 3);
});

test("cancellation after backend transmission preserves the confirmed receipt", async (t) => {
  const controller = new AbortController();
  const { calls, options } = fixture(t, ({ init }) => {
    controller.abort();
    assert.equal(init.signal.aborted, false);
    return Response.json({ delivery: 2 });
  });
  const result = await sendPrompt(await connectGateway(options), "Momo", "hello", { clientNonce: "stable-nonce", signal: controller.signal });
  assert.equal(result.delivery, "accepted");
  assert.equal(calls.length, 4);
});

test("backend URL rejection is a pre-transmission refusal", async (t) => {
  const { calls, options } = fixture(t);
  const session = await connectGateway(options);
  process.env.CURSOR_API_BASE_URL = "https://untrusted.invalid";
  await assert.rejects(sendPrompt(session, "Momo", "hello"), (error) => {
    assert.equal(error.delivery, "rejected");
    assert.match(error.message, /Rejected backend URL/);
    return true;
  });
  assert.equal(calls.length, 2);
});

test("explicit gateway overrides keep their transport even with Cursor credentials", async (t) => {
  const { calls, options } = fixture(t);
  process.env.GROK_BOT_GATEWAY_URL = "http://127.0.0.1:1341";
  process.env.GROK_BOT_GATEWAY_TOKEN = "explicit";
  await assert.rejects(sendPrompt(await connectGateway(options), "Momo", "hello"), { status: 409, delivery: "rejected" });
  assert.deepEqual(calls.map(c => c.path), ["/api/listAgents", "/api/sendPrompt"]);
  assert.equal(calls[1].init.headers.authorization, "Bearer explicit");
});

test("environment-created sessions retain their original access token", async (t) => {
  const { calls, options } = fixture(t);
  process.env.GROK_BOT_GATEWAY_HEADERS = JSON.stringify({ "x-anyrun-network-token": "box-only" });
  const session = await connectGateway(options);
  process.env.CURSOR_ACCESS_TOKEN = "different-account";
  await sendPrompt(session, "Momo", "hello", { clientNonce: "stable-nonce" });
  const send = calls.find(c => c.path.endsWith("/SendGrokBotUserMessage"));
  assert.equal(send.init.headers.authorization, "Bearer fixture-access");
  assert.equal(send.init.headers["x-anyrun-network-token"], undefined);
});
