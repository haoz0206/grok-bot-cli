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
  const publish = job("publish");
  assert.match(release, /workflow_dispatch:\n/);
  assert.match(release, /branches: \[main\]/);
  assert.match(job("main-only"), /github\.ref != 'refs\/heads\/main'/);
  assert.match(job("platform"), /github\.ref == 'refs\/heads\/main'/);
  assert.match(version, /github\.ref == 'refs\/heads\/main'/);
  assert.match(publish, /github\.ref == 'refs\/heads\/main'/);
  assert.match(publish, /needs\.version\.outputs\.has-changesets == 'false'/);
  assert.match(publish, /environment: npm-publish\n/);
  assert.doesNotMatch(version, /environment:/);
  assert.doesNotMatch(version, /publish-script:/);
  assert.match(version, /id-token: none/);
  assert.match(version, /create-github-releases: false/);
  assert.match(version, /push-git-tags: false/);
  assert.match(publish, /actions: read\n/);
  assert.doesNotMatch(publish, /administration/);
  assert.match(publish, /id-token: write/);
  assert.match(publish, /check_npm_publish_environment\.py/);
  const guardAt = publish.indexOf("check_npm_publish_environment.py");
  const publishAt = publish.indexOf("publish-script: npm run release");
  assert.ok(guardAt !== -1 && guardAt < publishAt);
  assert.match(publish, /publish-script: npm run release/);
  assert.equal(release.match(/publish-script: npm run release/g).length, 1);
  assert.match(version, /version-script: npm run release:version/);
  assert.doesNotMatch(version, /publish-script:/);
});

test("zstack wake is separate from release and cannot publish", () => {
  assert.match(notify, /on:\n {2}push:\n {4}branches:\n {6}- main\n/);
  assert.equal(notify.match(/permissions: \{\}/g).length, 2);
  assert.doesNotMatch(notify, /workflow_dispatch|pull_request|changesets\/action|npm run release|environment:/);
  assert.match(notify, /grok-bot-cli-main-sync/);
  assert.doesNotMatch(notify, /skills-main-sync/);
  assert.doesNotMatch(release, /ZSTACK_WEBHOOK/);
});
