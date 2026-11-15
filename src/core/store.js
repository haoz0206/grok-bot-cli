import { randomUUID } from "node:crypto";
import {
  existsSync,
  closeSync,
  fchmodSync,
  fchownSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, basename, join } from "node:path";

const GROUP_JSON_VERSION = 1;
export const MAX_GROUP_MEMBERS = 6;
const PROFILE_FILE = "profile.json";
const GROUP_FILE = "group.json";
const SETTINGS_FILE = "settings.json";

export const AVATAR_SHAPES = [
  "blob",
  "pebble",
  "bean",
  "egg",
  "squircle",
  "tablet",
  "capsule",
  "cylinder",
  "hex",
  "gem",
  "crystal",
  "wedge",
  "shield",
  "dome",
  "arch",
  "cloud",
  "teardrop",
  "leaf",
];

export const AVATAR_COLORS = [
  "black",
  "brown",
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "violet",
  "magenta",
  "gray",
];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class StoreError extends Error {
  constructor(message) {
    super(message);
    this.name = "StoreError";
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  let previous;
  try {
    previous = lstatSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (previous) {
    path = realpathSync(path);
    previous = statSync(path);
  }
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", previous ? 0o600 : 0o666);
  try {
    try {
      writeFileSync(fd, bytes, "utf8");
      if (previous) {
        const created = statSync(temporary);
        if (created.uid !== previous.uid || created.gid !== previous.gid) {
          fchownSync(fd, previous.uid, previous.gid);
        }
        fchmodSync(fd, previous.mode & 0o7777);
      }
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function isUuid(value) {
  return UUID_RE.test(value);
}

export function defaultCandidateRoots() {
  const home = homedir();
  const env = [process.env.GROK_BOT_AGENTS_DIR].filter(Boolean);

  return [
    ...env,
    "/home/box/agent-data/agents",
    "/home/box/sand-data/agents",
    join(home, ".grokbot", "agent-data", "agents"),
    join(home, ".grokbot", "sand-data", "agents"),
    join(home, "Library", "Application Support", "Grok Bot", "agent-data", "agents"),
    join(home, "Library", "Application Support", "Grok Bot", "sand-data", "agents"),
  ];
}

export function looksLikeAgentsRoot(dir) {
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) return false;
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.some(
    (e) => e.isDirectory() && isUuid(e.name) && existsSync(join(dir, e.name, PROFILE_FILE)),
  );
}

export function resolveAgentsRoot(explicit) {
  if (explicit) {
    mkdirSync(explicit, { recursive: true });
    return explicit;
  }
  for (const candidate of defaultCandidateRoots()) {
    if (looksLikeAgentsRoot(candidate)) return candidate;
  }
  throw new StoreError(
    "Could not find a Grok Bot agents directory. Pass --dir or set GROK_BOT_AGENTS_DIR.\nThe macOS app keeps the live roster on its cloud computer (agent-data/agents), not in ~/Library/Application Support/Grok Bot.",
  );
}

function readProfile(dir) {
  const path = join(dir, PROFILE_FILE);
  const raw = readJson(path);
  return {
    name: String(raw.name ?? ""),
    description: String(raw.description ?? ""),
    title: String(raw.title ?? ""),
    avatarShape: String(raw.avatarShape ?? ""),
    avatarColor: String(raw.avatarColor ?? ""),
  };
}

function readGroup(dir) {
  const path = join(dir, GROUP_FILE);
  if (!existsSync(path)) return null;
  const raw = readJson(path);
  const memberIds = Array.isArray(raw.memberIds) ? raw.memberIds.map(String) : [];
  return {
    version: Number(raw.version ?? GROUP_JSON_VERSION),
    memberIds,
  };
}

function readRawSettings(dir) {
  const path = join(dir, SETTINGS_FILE);
  try {
    const raw = readJson(path);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new StoreError(`Settings must be a JSON object: ${path}`);
    }
    return raw;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function readSettings(dir) {
  let raw;
  try {
    raw = readRawSettings(dir);
  } catch {
    raw = {};
  }
  return {
    notifyOnAgentUpdates: typeof raw.notifyOnAgentUpdates === "boolean" ? raw.notifyOnAgentUpdates : true,
    hiddenFromSidebar: typeof raw.hiddenFromSidebar === "boolean" ? raw.hiddenFromSidebar : false,
  };
}

export function listRecords(root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isUuid(entry.name)) continue;
    const dir = join(root, entry.name);
    if (!existsSync(join(dir, PROFILE_FILE))) continue;
    out.push(readRecord(dir, entry.name));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function readRecord(dir, id) {
  const profile = readProfile(dir);
  const group = readGroup(dir);
  return {
    id,
    path: dir,
    ...profile,
    ...readSettings(dir),
    isGroup: group != null,
    memberIds: group?.memberIds ?? [],
  };
}

export function resolveRef(root, ref) {
  return resolveFromList(listRecords(root), ref);
}

function resolveFromList(records, ref) {
  if (isUuid(ref)) {
    const exact = records.find((r) => r.id.toLowerCase() === ref.toLowerCase());
    if (!exact) throw new StoreError(`No bot or group with id ${ref}`);
    return exact;
  }
  const needle = ref.trim().toLowerCase();
  const matches = records.filter(
    (r) => r.name.toLowerCase() === needle || r.title.toLowerCase() === needle,
  );
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new StoreError(`No bot or group named "${ref}"`);
  throw new StoreError(
    `Ambiguous name "${ref}": ${matches.map((m) => `${m.name} (${m.id})`).join(", ")}`,
  );
}

function assertAvatar(kind, value, allowed) {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "";
  if (!allowed.includes(trimmed)) {
    throw new StoreError(`Unknown avatar ${kind} "${value}". Use: ${allowed.join(" ")}`);
  }
  return trimmed;
}

function writeProfile(dir, profile) {
  writeJson(join(dir, PROFILE_FILE), {
    name: profile.name.trim(),
    description: (profile.description ?? "").trim(),
    title: (profile.title ?? "").trim(),
    avatarShape: assertAvatar("shape", profile.avatarShape, AVATAR_SHAPES),
    avatarColor: assertAvatar("color", profile.avatarColor, AVATAR_COLORS),
  });
}

function writeSettings(dir) {
  writeJson(join(dir, SETTINGS_FILE), { notifyOnAgentUpdates: true });
}

function mergeSettings(dir, patch) {
  const update = {};
  if (patch.notifyOnAgentUpdates !== undefined) update.notifyOnAgentUpdates = Boolean(patch.notifyOnAgentUpdates);
  if (patch.hiddenFromSidebar !== undefined) update.hiddenFromSidebar = Boolean(patch.hiddenFromSidebar);
  if (Object.keys(update).length === 0) return;
  writeJson(join(dir, SETTINGS_FILE), { ...readRawSettings(dir), ...update });
}

function writeGroup(dir, memberIds) {
  writeJson(join(dir, GROUP_FILE), {
    version: GROUP_JSON_VERSION,
    memberIds,
  });
}

function normalizeMemberIds(records, memberRefs) {
  const resolved = [];
  const seen = new Set();
  for (const ref of memberRefs) {
    const rec = resolveFromList(records, ref);
    if (rec.isGroup) {
      throw new StoreError(`Cannot add group "${rec.name}" as a member. Nested groups are not allowed.`);
    }
    if (seen.has(rec.id)) continue;
    seen.add(rec.id);
    resolved.push(rec.id);
  }
  if (resolved.length > MAX_GROUP_MEMBERS) {
    throw new StoreError(`A group can have at most ${MAX_GROUP_MEMBERS} members.`);
  }
  return resolved;
}

export function createAgent(root, input) {
  const name = (input.name ?? "").trim();
  if (!name) throw new StoreError("Name is required.");
  const id = randomUUID();
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "memory"), { recursive: true });
  mkdirSync(join(dir, "automations"), { recursive: true });
  writeProfile(dir, {
    name,
    description: input.description ?? "",
    title: input.title ?? "",
    avatarShape: input.avatarShape ?? "",
    avatarColor: input.avatarColor ?? "",
  });
  writeSettings(dir);
  return readRecord(dir, id);
}

export function updateAgent(root, ref, patch = {}) {
  const rec = resolveRef(root, ref);
  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (!name) throw new StoreError("Name cannot be blank.");
  }
  const hasProfile =
    patch.name !== undefined ||
    patch.description !== undefined ||
    patch.title !== undefined ||
    patch.avatarShape !== undefined ||
    patch.avatarColor !== undefined;
  if (hasProfile) {
    writeProfile(rec.path, {
      name: patch.name !== undefined ? String(patch.name) : rec.name,
      description: patch.description !== undefined ? String(patch.description) : rec.description,
      title: patch.title !== undefined ? String(patch.title) : rec.title,
      avatarShape: patch.avatarShape !== undefined ? String(patch.avatarShape) : rec.avatarShape,
      avatarColor: patch.avatarColor !== undefined ? String(patch.avatarColor) : rec.avatarColor,
    });
  }
  mergeSettings(rec.path, patch);
  return readRecord(rec.path, rec.id);
}

export function deleteAgent(root, ref) {
  const rec = resolveRef(root, ref);
  rmSync(rec.path, { recursive: true, force: true });
  for (const other of listRecords(root).filter((r) => r.isGroup)) {
    if (!other.memberIds.includes(rec.id)) continue;
    writeGroup(
      other.path,
      other.memberIds.filter((id) => id !== rec.id),
    );
  }
  return rec;
}

export function createGroup(root, input) {
  const records = listRecords(root);
  const memberIds = normalizeMemberIds(records, input.memberIds ?? []);
  if (memberIds.length === 0) {
    throw new StoreError("A group needs at least one existing member agent.");
  }
  const existing = records.find(
    (r) =>
      r.isGroup &&
      r.memberIds.length === memberIds.length &&
      r.memberIds.every((id) => memberIds.includes(id)),
  );
  if (existing) return existing;
  const group = createAgent(root, {
    name: input.name,
    description: input.description ?? "",
    title: input.title ?? "",
    avatarShape: input.avatarShape ?? "",
    avatarColor: input.avatarColor ?? "",
  });
  writeGroup(join(root, group.id), memberIds);
  return readRecord(group.path, group.id);
}

export function setGroupMembers(root, groupRef, memberRefs) {
  const records = listRecords(root);
  const group = resolveFromList(records, groupRef);
  return setMembers(records, group, memberRefs);
}

function setMembers(records, group, memberRefs) {
  if (!group.isGroup) throw new StoreError(`"${group.name}" is a bot, not a group.`);
  const memberIds = normalizeMemberIds(records, memberRefs);
  if (memberIds.length === 0) {
    throw new StoreError("A group needs at least one existing member agent.");
  }
  writeGroup(group.path, memberIds);
  return readRecord(group.path, group.id);
}

export function addGroupMember(root, groupRef, memberRef) {
  const records = listRecords(root);
  const group = resolveFromList(records, groupRef);
  return setMembers(records, group, [...group.memberIds, memberRef]);
}

export function removeGroupMember(root, groupRef, memberRef) {
  const records = listRecords(root);
  const group = resolveFromList(records, groupRef);
  const member = resolveFromList(records, memberRef);
  return setMembers(records, group, group.memberIds.filter((id) => id !== member.id));
}
