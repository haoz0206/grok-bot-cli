import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as store from "../src/core/store.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  addGroupMember,
  createAgent,
  createGroup,
  defaultCandidateRoots,
  deleteAgent,
  listRecords,
  removeGroupMember,
  setGroupMembers,
  updateAgent,
} from "../src/core/store.js";

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "gbot-"));
  return Promise.resolve()
    .then(() => fn(root))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

test("agent root discovery ignores removed sand env aliases", () => {
  const previousAgentsDir = process.env.GROK_BOT_AGENTS_DIR;
  const previousSandAgentsDir = process.env.SAND_AGENTS_DIR;
  const previousSandDataRoot = process.env.SAND_DATA_ROOT;
  try {
    process.env.GROK_BOT_AGENTS_DIR = "/canonical";
    process.env.SAND_AGENTS_DIR = "/removed-agents";
    process.env.SAND_DATA_ROOT = "/removed-data";
    const candidates = defaultCandidateRoots();
    assert.equal(candidates[0], "/canonical");
    assert.equal(candidates.includes("/removed-agents"), false);
    assert.equal(candidates.some((path) => path.startsWith("/removed-data")), false);
  } finally {
    if (previousAgentsDir === undefined) delete process.env.GROK_BOT_AGENTS_DIR;
    else process.env.GROK_BOT_AGENTS_DIR = previousAgentsDir;
    if (previousSandAgentsDir === undefined) delete process.env.SAND_AGENTS_DIR;
    else process.env.SAND_AGENTS_DIR = previousSandAgentsDir;
    if (previousSandDataRoot === undefined) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previousSandDataRoot;
  }
});

test("create list delete bots", async () => {
  await withRoot((root) => {
    const a = createAgent(root, { name: "Oncall", description: "pages" });
    assert.equal(a.name, "Oncall");
    assert.equal(listRecords(root).length, 1);
    deleteAgent(root, "Oncall");
    assert.equal(listRecords(root).length, 0);
  });
});

test("group add remove set", async () => {
  await withRoot((root) => {
    createAgent(root, { name: "Alpha" });
    createAgent(root, { name: "Beta" });
    createAgent(root, { name: "Gamma" });
    const g = createGroup(root, { name: "Launch", memberIds: ["Alpha", "Beta"] });
    assert.equal(g.isGroup, true);
    assert.equal(g.memberIds.length, 2);
    assert.equal(addGroupMember(root, "Launch", "Gamma").memberIds.length, 3);
    assert.equal(removeGroupMember(root, "Launch", "Beta").memberIds.length, 2);
    assert.equal(setGroupMembers(root, "Launch", ["Alpha"]).memberIds.length, 1);
  });
});

test("rejects nested and empty groups", async () => {
  await withRoot((root) => {
    createAgent(root, { name: "Alpha" });
    createGroup(root, { name: "Launch", memberIds: ["Alpha"] });
    assert.throws(() => createGroup(root, { name: "Nope", memberIds: [] }), /at least one/);
    assert.throws(() => addGroupMember(root, "Launch", "Launch"), /Nested groups/);
  });
});

test("update merges profile, clears title, changes description, toggles settings, rejects blank name", async () => {
  await withRoot((root) => {
    const a = createAgent(root, {
      name: "Oncall",
      description: "pages",
      title: "pager",
      avatarShape: "blob",
      avatarColor: "red",
    });
    assert.equal(a.notifyOnAgentUpdates, true);
    assert.equal(a.hiddenFromSidebar, false);
    assert.equal(a.avatarShape, "blob");
    assert.equal(a.avatarColor, "red");

    const merged = updateAgent(root, a.id, { description: "night pages" });
    assert.equal(merged.name, "Oncall");
    assert.equal(merged.description, "night pages");
    assert.equal(merged.title, "pager");
    assert.equal(merged.avatarShape, "blob");
    assert.equal(merged.avatarColor, "red");

    const cleared = updateAgent(root, a.id, { title: "" });
    assert.equal(cleared.title, "");
    assert.equal(cleared.description, "night pages");

    const renamed = updateAgent(root, a.id, { name: "Pagerduty" });
    assert.equal(renamed.name, "Pagerduty");
    assert.equal(renamed.description, "night pages");

    const notifyOff = updateAgent(root, a.id, { notifyOnAgentUpdates: false });
    assert.equal(notifyOff.notifyOnAgentUpdates, false);
    assert.equal(notifyOff.hiddenFromSidebar, false);

    const hidden = updateAgent(root, a.id, { hiddenFromSidebar: true });
    assert.equal(hidden.hiddenFromSidebar, true);
    assert.equal(hidden.notifyOnAgentUpdates, false);

    const listed = listRecords(root)[0];
    assert.equal(listed.avatarShape, "blob");
    assert.equal(listed.notifyOnAgentUpdates, false);
    assert.equal(listed.hiddenFromSidebar, true);

    assert.throws(() => updateAgent(root, a.id, { name: "   " }), /blank/);
    assert.throws(() => updateAgent(root, a.id, { avatarShape: "triangle" }), /avatar shape/);
  });
});

test("update settings merge preserves extra keys", async () => {
  await withRoot((root) => {
    const a = createAgent(root, { name: "Oncall" });
    const settingsPath = join(a.path, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ notifyOnAgentUpdates: true, prLinkStyle: "short" }, null, 2) + "\n");
    updateAgent(root, a.id, { hiddenFromSidebar: true });
    const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(raw.notifyOnAgentUpdates, true);
    assert.equal(raw.hiddenFromSidebar, true);
    assert.equal(raw.prLinkStyle, "short");
  });
});

function rootFor(t) {
  const root = fs.mkdtempSync(join(tmpdir(), "gbot-core-audit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function mockFs(t, name, replacement) {
  t.mock.method(fs, name, replacement);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

for (const invalid of ['{"operatorSetting":"KEEP"', "[]", "null", "42"]) {
  test(`settings update refuses invalid old JSON ${invalid}`, (t) => {
    const root = rootFor(t);
    const bot = store.createAgent(root, { name: "Alpha" });
    const path = join(bot.path, "settings.json");
    fs.writeFileSync(path, invalid);
    assert.equal(store.listRecords(root)[0].notifyOnAgentUpdates, true);
    assert.throws(() => store.updateAgent(root, bot.id, { hiddenFromSidebar: true }));
    assert.equal(fs.readFileSync(path, "utf8"), invalid);
  });
}

test("settings update refuses read errors instead of replacing old data", (t) => {
  const root = rootFor(t);
  const bot = store.createAgent(root, { name: "Alpha" });
  const path = join(bot.path, "settings.json");
  const previous = fs.readFileSync(path, "utf8");
  const read = fs.readFileSync;
  mockFs(t, "readFileSync", function (target, ...args) {
    if (target === path) throw Object.assign(new Error("synthetic permission denial"), { code: "EACCES" });
    return read.call(this, target, ...args);
  });
  assert.throws(() => store.updateAgent(root, bot.id, { hiddenFromSidebar: true }), /permission denial/);
  assert.equal(read(path, "utf8"), previous);
});

test("missing settings can be created by an update", (t) => {
  const root = rootFor(t);
  const bot = store.createAgent(root, { name: "Alpha" });
  fs.unlinkSync(join(bot.path, "settings.json"));
  assert.equal(store.updateAgent(root, bot.id, { hiddenFromSidebar: true }).hiddenFromSidebar, true);
});

for (const failure of ["partial write", "rename"]) {
  for (const linked of [false, true]) {
    test(`atomic profile update preserves original bytes after ${failure} failure, symlink=${linked}`, { skip: linked && process.platform === "win32" }, (t) => {
      const root = rootFor(t);
      const bot = store.createAgent(root, { name: "Alpha" });
      const path = join(bot.path, "profile.json");
      const previous = fs.readFileSync(path, "utf8");
      if (linked) {
        const actual = join(root, "operator-profile.json");
        fs.renameSync(path, actual);
        fs.symlinkSync(actual, path);
      }
      if (failure === "partial write") {
        const write = fs.writeFileSync;
        mockFs(t, "writeFileSync", function (target, value, ...args) {
          write.call(this, target, value.slice(0, 10), ...args);
          throw Object.assign(new Error("synthetic disk full"), { code: "ENOSPC" });
        });
      } else {
        mockFs(t, "renameSync", () => { throw new Error("synthetic rename failure"); });
      }
      assert.throws(() => store.updateAgent(root, bot.id, { name: "Renamed" }), /synthetic/);
      assert.equal(fs.readFileSync(path, "utf8"), previous);
      assert.equal(fs.lstatSync(path).isSymbolicLink(), linked);
      assert.equal(store.listRecords(root)[0].name, "Alpha");
      assert.deepEqual(fs.readdirSync(bot.path).sort(), ["automations", "memory", "profile.json", "settings.json"]);
    });
  }
}

test("dangling settings symlink fails without replacing the link or creating its target", { skip: process.platform === "win32" }, (t) => {
  const root = rootFor(t);
  const bot = store.createAgent(root, { name: "Alpha" });
  const path = join(bot.path, "settings.json");
  const target = join(root, "missing-settings.json");
  fs.unlinkSync(path);
  fs.symlinkSync(target, path);
  assert.throws(() => store.updateAgent(root, bot.id, { hiddenFromSidebar: true }), /ENOENT/);
  assert.equal(fs.lstatSync(path).isSymbolicLink(), true);
  assert.equal(fs.existsSync(target), false);
});

test("ownership preservation failure leaves the old profile untouched", { skip: process.platform === "win32" }, (t) => {
  const root = rootFor(t);
  const bot = store.createAgent(root, { name: "Alpha" });
  const path = join(bot.path, "profile.json");
  const previous = fs.readFileSync(path, "utf8");
  const stat = fs.statSync;
  mockFs(t, "statSync", function (target, ...args) {
    const result = stat.call(this, target, ...args);
    if (String(target).endsWith(".tmp")) result.uid += 1;
    return result;
  });
  mockFs(t, "fchownSync", () => { throw new Error("synthetic ownership failure"); });
  assert.throws(() => store.updateAgent(root, bot.id, { name: "Renamed" }), /ownership failure/);
  assert.equal(fs.readFileSync(path, "utf8"), previous);
  assert.equal(fs.readdirSync(bot.path).some(name => name.endsWith(".tmp")), false);
});

test("atomic update preserves file mode, ownership and a valid symlink", { skip: process.platform === "win32" }, (t) => {
  const root = rootFor(t);
  const bot = store.createAgent(root, { name: "Alpha" });
  const path = join(bot.path, "profile.json");
  const actual = join(root, "operator-profile.json");
  fs.renameSync(path, actual);
  fs.chmodSync(actual, 0o640);
  const previous = fs.statSync(actual);
  fs.symlinkSync(actual, path);
  assert.equal(store.updateAgent(root, bot.id, { name: "Renamed" }).name, "Renamed");
  assert.equal(fs.lstatSync(path).isSymbolicLink(), true);
  assert.equal(JSON.parse(fs.readFileSync(actual, "utf8")).name, "Renamed");
  const changed = fs.statSync(actual);
  assert.equal(changed.mode & 0o7777, 0o640);
  assert.equal(changed.uid, previous.uid);
  assert.equal(changed.gid, previous.gid);
});

for (const operation of ["create", "set", "add", "remove"]) {
  test(`file group ${operation} resolves all members from one records snapshot`, (t) => {
    const root = rootFor(t);
    const a = store.createAgent(root, { name: "Alpha" });
    const b = store.createAgent(root, { name: "Beta" });
    const c = store.createAgent(root, { name: "Gamma" });
    const group = store.createGroup(root, { name: "Group", memberIds: [a.id, b.id] });
    const read = fs.readdirSync;
    let scans = 0;
    mockFs(t, "readdirSync", function (path, ...args) {
      if (path === root) scans += 1;
      return read.call(this, path, ...args);
    });
    const result = operation === "create" ? store.createGroup(root, { name: "New group", memberIds: [a.id, c.id] })
      : operation === "set" ? store.setGroupMembers(root, group.id, [a.id, c.id])
      : operation === "add" ? store.addGroupMember(root, group.id, c.id)
      : store.removeGroupMember(root, group.id, b.id);
    assert.equal(scans, 1);
    assert.deepEqual(result.memberIds, operation === "add" ? [a.id, b.id, c.id] : operation === "remove" ? [a.id] : [a.id, c.id]);
  });
}
