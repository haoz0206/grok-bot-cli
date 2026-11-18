import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const release = readFileSync(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
const notify = readFileSync(
  new URL("../.github/workflows/zstack-main-push.yml", import.meta.url),
  "utf8",
);

const job = (name) => {
  const match = release.match(
    new RegExp(`\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z-]+:\\n|$)`),
  );
  assert.ok(match, `missing job ${name}`);
  return match[1];
};

test("release publish is the only npm publish entry and waits on npm-publish", () => {
  const version = job("version");
  const gate = job("release-candidate");
  const publish = job("publish");
  assert.match(release, /workflow_dispatch:\n/);
  assert.match(release, /branches: \[main\]/);
  assert.match(job("main-only"), /github\.ref != 'refs\/heads\/main'/);
  assert.match(job("platform"), /github\.ref == 'refs\/heads\/main'/);
  assert.match(version, /github\.ref == 'refs\/heads\/main'/);
  assert.match(gate, /github\.ref == 'refs\/heads\/main'/);
  assert.match(publish, /github\.ref == 'refs\/heads\/main'/);
  assert.match(publish, /needs\.release-candidate\.outputs\.decision == 'publish'/);
  assert.doesNotMatch(publish.split("\n    steps:")[0], /has-changesets/);
  assert.match(publish, /environment: npm-publish\n/);
  assert.doesNotMatch(gate, /environment:/);
  assert.doesNotMatch(gate, /id-token: write/);
  assert.match(gate, /id-token: none/);
  assert.match(gate, /contents: read/);
  assert.match(gate, /check_release_candidate_gate\.py/);
  assert.doesNotMatch(gate, /npm run release|publish-script:|setup-node/);
  assert.doesNotMatch(version, /environment:/);
  assert.doesNotMatch(version, /publish-script:/);
  assert.match(version, /id-token: none/);
  assert.match(version, /create-github-releases: false/);
  assert.match(version, /push-git-tags: false/);
  assert.match(version, /name: Detect pending changesets/);
  assert.match(version, /find \.changeset -maxdepth 1 -type f -name '\*\.md' ! -name README\.md/);
  assert.match(version, /if: steps\.pending\.outputs\.pending == 'true'/);
  assert.match(publish, /actions: read\n/);
  assert.doesNotMatch(publish, /administration/);
  assert.match(publish, /id-token: write/);
  assert.match(publish, /check_npm_publish_environment\.py/);
  const guardAt = publish.indexOf("check_npm_publish_environment.py");
  const packAt = publish.indexOf("Pack and smoke-test the executable");
  const commitAt = publish.indexOf("check_publish_commit.py");
  const publishAt = publish.indexOf("publish-script: npm run release");
  assert.ok(guardAt !== -1 && packAt !== -1 && commitAt !== -1);
  assert.ok(guardAt < packAt && packAt < commitAt && commitAt < publishAt);
  assert.match(publish, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(publish, /PUBLISH_RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/);
  assert.match(release, /cancel-in-progress: true/);
  assert.match(publish, /publish-script: npm run release/);
  assert.equal(release.match(/publish-script: npm run release/g).length, 1);
  assert.match(version, /version-script: npm run release:version/);
  assert.doesNotMatch(version, /publish-script:/);
});

test("zstack wake is separate from release and cannot publish", () => {
  assert.match(notify, /on:\n {2}push:\n {4}branches:\n {6}- main\n/);
  assert.match(
    notify,
    /paths-ignore:[\s\S]*- "\.changeset\/\*\*"[\s\S]*- "CHANGELOG\.md"[\s\S]*- "\.claude-plugin\/marketplace\.json"[\s\S]*- "artifact\/\*\*"/,
  );
  assert.doesNotMatch(notify, /paths-ignore:[\s\S]*- "package\.json"/);
  assert.equal(notify.match(/permissions: \{\}/g).length, 2);
  assert.doesNotMatch(notify, /workflow_dispatch|pull_request|changesets\/action|npm run release|environment:/);
  assert.match(notify, /grok-bot-cli-main-sync/);
  assert.doesNotMatch(notify, /skills-main-sync/);
  assert.doesNotMatch(release, /ZSTACK_WEBHOOK/);
});
