import { updateAgent as gatewayUpdateAgent } from "../src/core/gateway.js";
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
