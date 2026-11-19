import test from "node:test";
import assert from "node:assert/strict";
import {
  addGroupMember,
  createGroup,
  removeGroupMember,
  setGroupMembers,
} from "../src/core/gateway.js";
import { MAX_GROUP_MEMBERS } from "../src/core/store.js";

const session = { gatewayUrl: "http://127.0.0.1:1340", gatewayToken: "test-token" };
const bots = Array.from({ length: MAX_GROUP_MEMBERS + 1 }, (_, i) => ({
  id: `bot-${i + 1}`,
  name: `Bot ${i + 1}`,
  title: `Title ${i + 1}`,
  isGroup: false,
}));
const group = { id: "group-1", name: "Launch", isGroup: true, memberIds: [bots[0].id] };

function mockGateway(t, currentGroup = group) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const method = new URL(url).pathname.split("/").pop();
    const body = JSON.parse(options.body);
    calls.push({ method, body });
    const data = method === "listAgents"
      ? { agents: [...bots, currentGroup] }
      : { agent: { ...currentGroup, memberIds: body.memberAgentIds } };
    return new Response(JSON.stringify(data), { status: 200 });
  });
  return calls;
}

for (const [name, run] of [
  ["create", (refs) => createGroup(session, { name: "New group", memberIds: refs })],
  ["set", (refs) => setGroupMembers(session, group.name, refs)],
]) {
  test(`${name} resolves and deduplicates member aliases before sending IDs`, async (t) => {
    const calls = mockGateway(t);
    const refs = bots.slice(0, MAX_GROUP_MEMBERS).flatMap((bot) => [
      bot.name, bot.id, bot.title.toUpperCase(),
    ]);
    const result = await run(refs);
    const expected = bots.slice(0, MAX_GROUP_MEMBERS).map((bot) => bot.id);
    assert.deepEqual(calls.at(-1).body.memberAgentIds, expected);
    assert.deepEqual(result.memberIds, expected);
  });

  for (const [label, refs, error] of [
    ["empty membership", [], /at least one existing member/],
    ["nested groups", [group.name], /Nested groups are not allowed/],
    ["too many members", bots.map((bot) => bot.id), /at most 6 members/],
    ["unknown members", ["Missing bot"], /No bot or group named/],
  ]) {
    test(`${name} rejects ${label} before any mutation`, async (t) => {
      const calls = mockGateway(t);
      await assert.rejects(run(refs), { name: "GatewayError", message: error });
      assert.ok(calls.length > 0);
      assert.ok(calls.every((call) => call.method === "listAgents"));
    });
  }
}

for (const [name, run] of [
  ["set", () => setGroupMembers(session, bots[0].name, [bots[1].id])],
  ["add", () => addGroupMember(session, bots[0].name, bots[1].id)],
  ["remove", () => removeGroupMember(session, bots[0].name, bots[1].id)],
]) {
  test(`${name} rejects a bot as the group target before any mutation`, async (t) => {
    const calls = mockGateway(t);
    await assert.rejects(run(), { name: "GatewayError", message: /is a bot, not a group/ });
    assert.ok(calls.every((call) => call.method === "listAgents"));
  });
}

test("add prefers bot-target error over unknown member", async (t) => {
  const calls = mockGateway(t);
  await assert.rejects(
    addGroupMember(session, bots[0].name, "Missing bot"),
    { name: "GatewayError", message: /is a bot, not a group/ },
  );
  assert.ok(calls.every((call) => call.method === "listAgents"));
});

test("add rejects a nested group before any mutation", async (t) => {
  const calls = mockGateway(t);
  await assert.rejects(addGroupMember(session, group.id, group.id), /Nested groups/);
  assert.ok(calls.every((call) => call.method === "listAgents"));
});

test("add rejects a seventh member before any mutation", async (t) => {
  const calls = mockGateway(t, {
    ...group,
    memberIds: bots.slice(0, MAX_GROUP_MEMBERS).map((bot) => bot.id),
  });
  await assert.rejects(addGroupMember(session, group.id, bots.at(-1).id), /at most 6 members/);
  assert.ok(calls.every((call) => call.method === "listAgents"));
});

test("reports the created group when its profile update fails", async (t) => {
  const calls = [];
  const createdGroup = { id: "group-created", name: "New group", isGroup: true };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const method = new URL(url).pathname.split("/").pop();
    const body = JSON.parse(options.body);
    calls.push({ method, body });
    if (method === "listAgents") {
      return new Response(JSON.stringify({ agents: [...bots, createdGroup] }));
    }
    if (method === "createGroup") {
      return new Response(JSON.stringify({ agent: createdGroup }));
    }
    if (method === "updateAgent") {
      return new Response(JSON.stringify({ message: "profile route unavailable" }), { status: 503 });
    }
    return new Response("{}");
  });

  await assert.rejects(
    createGroup(session, {
      name: "New group",
      memberIds: [bots[0].id],
      title: "Launch",
    }),
    {
      name: "GatewayError",
      message: /Group "New group" \(group-created\) was created, but its profile update failed/,
    },
  );
  assert.ok(calls.some((call) => call.method === "createGroup"));
});

test("does not call a successful profile update a failure when refresh fails", async (t) => {
  let listCalls = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const method = new URL(url).pathname.split("/").pop();
    const body = JSON.parse(options.body);
    if (method === "listAgents") {
      listCalls += 1;
      if (listCalls === 3) {
        return new Response(JSON.stringify({ message: "roster temporarily unavailable" }), { status: 503 });
      }
      return new Response(JSON.stringify({
        agents: listCalls === 1 ? bots : [...bots, { id: "group-created", name: "New group", isGroup: true }],
      }));
    }
    if (method === "createGroup") {
      return new Response(JSON.stringify({ agent: { id: "group-created", name: "New group", isGroup: true } }));
    }
    return new Response("{}");
  });

  await assert.rejects(
    createGroup(session, {
      name: "New group",
      memberIds: [bots[0].id],
      title: "Launch",
    }),
    (error) => {
      assert.equal(error.name, "GatewayError");
      assert.match(error.message, /listAgents failed: 503/);
      assert.doesNotMatch(error.message, /profile update failed/);
      return true;
    },
  );
});

test("remove rejects removing the last member before any mutation", async (t) => {
  const calls = mockGateway(t);
  await assert.rejects(removeGroupMember(session, group.id, bots[0].id), /at least one/);
  assert.ok(calls.every((call) => call.method === "listAgents"));
});

test("add and remove send valid updated membership", async (t) => {
  const calls = mockGateway(t, { ...group, memberIds: [bots[0].id, bots[1].id] });
  const added = await addGroupMember(session, group.name, bots[2].name);
  assert.deepEqual(added.memberIds, [bots[0].id, bots[1].id, bots[2].id]);
  const removed = await removeGroupMember(session, group.name, bots[0].name);
  assert.deepEqual(removed.memberIds, [bots[1].id]);
  assert.deepEqual(calls.filter((call) => call.method === "setGroupMembers").map((call) => call.body), [
    { id: group.id, memberAgentIds: [bots[0].id, bots[1].id, bots[2].id] },
    { id: group.id, memberAgentIds: [bots[1].id] },
  ]);
});

for (const operation of ["add", "remove"]) {
  test(`gateway group ${operation} takes one roster snapshot`, async (t) => {
    let scans = 0;
    t.mock.method(globalThis, "fetch", async (url, options) => {
      if (new URL(url).pathname.endsWith("/listAgents")) {
        scans += 1;
        return new Response(JSON.stringify({ agents: [
          { id: "a", name: "Alpha" }, { id: "b", name: "Beta" }, { id: "c", name: "Gamma" },
          { id: "group", name: "Group", isGroup: true, memberIds: ["a", "b"] },
        ] }));
      }
      return new Response(JSON.stringify({ agent: { id: "group", memberIds: JSON.parse(options.body).memberAgentIds } }));
    });
    const session = { gatewayUrl: "http://127.0.0.1:1340", gatewayToken: "fake" };
    const result = operation === "add" ? await addGroupMember(session, "group", "c") : await removeGroupMember(session, "group", "b");
    assert.equal(scans, 1);
    assert.deepEqual(result.memberIds, operation === "add" ? ["a", "b", "c"] : ["a"]);
  });
}
