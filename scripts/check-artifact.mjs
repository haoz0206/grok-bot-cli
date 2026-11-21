// Fails when a commit's artifact/agent-bundle.manifest.json no longer matches its files.
// agent-bundle hashes every non-ignored project file, docs and workflows included, into
// compiler.project.sourceInputs, and CI rejects the commit when any hash is stale. So any
// edit needs `npm run build` and a commit of the regenerated artifact/.
// Reads the commit (default HEAD) rather than the working tree, so a dirty checkout gives
// the answer CI will give.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const rev = process.argv[2] ?? "HEAD";
// Build outputs: agent-bundle writes these and does not hash them.
const outputs = new Set([
  ".agents/plugins/marketplace.json",
  ".claude-plugin/marketplace.json",
  ".cursor-plugin/marketplace.json",
]);
const isOutput = (path) => path.startsWith("artifact/") || outputs.has(path);

const git = (args, input) => execFileSync("git", args, { input, maxBuffer: 1 << 30 });

const manifest = JSON.parse(git(["show", `${rev}:artifact/agent-bundle.manifest.json`]));
const tree = new Map(
  git(["ls-tree", "-r", "-z", rev])
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split("\t");
      const [mode, , oid] = meta.split(" ");
      return [path, { executable: mode === "100755", oid }];
    }),
);

// One `git cat-file --batch` call; each record is "<oid> blob <size>\n<bytes>\n".
const files = [...tree.values()];
const batch = git(["cat-file", "--batch"], files.map((file) => file.oid).join("\n") + "\n");
for (let offset = 0, index = 0; index < files.length; index += 1) {
  const header = batch.indexOf(10, offset);
  const size = Number(batch.subarray(offset, header).toString().split(" ")[2]);
  files[index].sha256 = createHash("sha256").update(batch.subarray(header + 1, header + 1 + size)).digest("hex");
  offset = header + 1 + size + 1;
}

const stale = [];
const inputs = new Set();
for (const input of manifest.compiler.project.sourceInputs) {
  inputs.add(input.path);
  const file = tree.get(input.path);
  if (file === undefined) stale.push(`${input.path} (in the manifest, not in ${rev})`);
  else if (file.sha256 !== input.sha256 || file.executable !== input.executable) stale.push(`${input.path} (changed)`);
}
for (const path of tree.keys()) if (!isOutput(path) && !inputs.has(path)) stale.push(`${path} (added)`);

if (stale.length > 0) {
  console.error(`artifact/ is stale for ${stale.length} file(s) in ${rev}:`);
  for (const line of stale) console.error(`  ${line}`);
  console.error("Run `npm run build`, then commit artifact/ and the marketplace files.");
  process.exit(1);
}
console.log(`artifact/ matches ${rev} (${inputs.size} source files)`);
