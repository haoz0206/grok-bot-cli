import { listAgents, updateAgent as gatewayUpdateAgent } from "../src/core/gateway.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  headersFromEnsureSandbox,
  mergeGatewayHeaders,
  parseGatewayHeaders,
  requestHeaders,
} from "../src/core/headers.js";

test("parses env JSON headers", () => {
  const headers = parseGatewayHeaders('{"X-Anyrun-Network-Token":"abc","empty":""}');
  assert.deepEqual(headers, { "x-anyrun-network-token": "abc" });
});

test("reads EnsureSandBox gatewayHeaders", () => {
  const headers = headersFromEnsureSandbox({
    gatewayHeaders: { "X-Anyrun-Network-Token": "from-ensure" },
  });
  assert.equal(headers["x-anyrun-network-token"], "from-ensure");
});

test("reads EnsureSandBox token field", () => {
  const headers = headersFromEnsureSandbox({ anyrunNetworkToken: "field-token" });
  assert.equal(headers["x-anyrun-network-token"], "field-token");
});

test("env headers override EnsureSandBox", () => {
  const headers = mergeGatewayHeaders(
    { "x-anyrun-network-token": "ensure" },
    { "x-anyrun-network-token": "env" },
  );
  assert.equal(headers["x-anyrun-network-token"], "env");
});

test("request headers keep routing header", () => {
  const headers = requestHeaders({
    gatewayToken: "gw",
    gatewayHeaders: { "x-anyrun-network-token": "route" },
  });
  assert.equal(headers["x-anyrun-network-token"], "route");
  assert.match(headers.authorization, /^Bearer /);
});

test("empty env JSON is a no-op", () => {
  assert.deepEqual(parseGatewayHeaders(""), {});
  assert.deepEqual(parseGatewayHeaders(undefined), {});
});

test("rejects malformed successful gateway responses", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("not-json", { status: 200 }));

  await assert.rejects(
    listAgents({ gatewayUrl: "http://127.0.0.1:1340", gatewayToken: "fake" }),
    { name: "GatewayError", message: /invalid JSON/i },
  );
});

test("reports completed stages when an agent update fails partway", async (t) => {
  const agent = { id: "bot-1", name: "Alpha", description: "before" };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const method = new URL(url).pathname.split("/").pop();
    if (method === "listAgents") return new Response(JSON.stringify({ agents: [agent] }));
    if (method === "updateAgent") return new Response("{}", { status: 200 });
    if (method === "setAgentNotifyOnUpdates") {
      return new Response(JSON.stringify({ message: "notify route unavailable" }), { status: 503 });
    }
    return new Response("{}");
  });

  await assert.rejects(
    gatewayUpdateAgent(
      { gatewayUrl: "http://127.0.0.1:1340", gatewayToken: "fake" },
      agent.id,
      { description: "after", notifyOnAgentUpdates: true },
    ),
    {
      name: "GatewayError",
      message: /Failed to update notification settings for "Alpha" \(bot-1\)\. Completed: update the profile\. setAgentNotifyOnUpdates failed: 503/,
    },
  );
});

test("reports a missing agent after a successful mutation refresh", async (t) => {
  let rosterCalls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    const method = new URL(url).pathname.split("/").pop();
    if (method === "listAgents") {
      rosterCalls += 1;
      return new Response(JSON.stringify(rosterCalls === 1
        ? { agents: [{ id: "bot-1", name: "Alpha", description: "before" }] }
        : { agents: [] }));
    }
    return new Response("{}", { status: 200 });
  });

  await assert.rejects(
    gatewayUpdateAgent(
      { gatewayUrl: "http://127.0.0.1:1340", gatewayToken: "fake" },
      "bot-1",
      { description: "after" },
    ),
    {
      name: "GatewayError",
      message: /updated "Alpha" \(bot-1\), but the roster refresh no longer contains it/i,
    },
  );
});

for (const patch of [{ notifyOnAgentUpdates: false }, { hiddenFromSidebar: true }]) {
  test(`gateway ${Object.keys(patch)[0]} update never writes a stale profile`, async (t) => {
    const agent = { id: "bot-1", name: "Alpha", description: "before" };
    const calls = [];
    t.mock.method(globalThis, "fetch", async (url, options) => {
      const method = new URL(url).pathname.split("/").pop();
      const body = JSON.parse(options.body);
      calls.push(method);
      if (method === "listAgents") {
        const response = new Response(JSON.stringify({ agents: [agent] }));
        agent.description = "external edit";
        return response;
      }
      if (method === "updateAgent") Object.assign(agent, body.profile);
      return new Response("{}");
    });
    const out = await gatewayUpdateAgent({ gatewayUrl: "http://127.0.0.1:1340", gatewayToken: "fake" }, agent.id, patch);
    assert.equal(out.description, "external edit");
    assert.equal(calls.includes("updateAgent"), false);
    assert.equal(calls.filter((method) => method === "listAgents").length, 2);
  });
}
