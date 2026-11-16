# Agent instructions

This is the maintained fork `haoz0206/grok-bot-cli`, published as
`@haoz0206/grok-bot-cli`. The original upstream is `ScriptedAlchemy/grok-bot-cli`
at https://github.com/ScriptedAlchemy/grok-bot-cli. Both use `main`.
Use `origin` for this fork and `upstream` for the original repository.
Periodically sync upstream while maintaining fork-specific features and fixes.
Follow README.md's "Maintain this fork" section. Preserve the scoped package,
fork repository links, release ownership, and existing behavior during syncs.
Remove duplicate fork fixes only after verifying the upstream replacement.
Keep upstream attribution and the MIT license.

Publish exclusively through `.github/workflows/release.yml` with GitHub OIDC.
Its package release script is a workflow entrypoint: never publish locally,
request npm publishing tokens/login, or troubleshoot local publishing auth.
Use the existing Changesets flow and verify Actions plus the registry before
updating installations.

For commit, push, release, or manual Actions guidance, read
[docs/releasing.md](docs/releasing.md). It is the release procedure for this fork.
An explicit request to publish authorizes the necessary in-scope commit, push,
PR preparation, reviewed merge, workflow execution, and verification unless the
user reserves a step. Do not ask again for already-authorized routine steps.
A commit/push-only or documentation request does not authorize publication.
Inspect the complete release contents and preserve unrelated work. Never bypass
failed checks or branch protection. Track the release commit's Actions run and
registry version, not just the earlier run that created a release PR.
Update this guide when the workflow or release commands change.

Delete dead code, obsolete scripts, duplicate workarounds, and unused legacy
installs. Check active owners/references first; preserve auth, operator env,
durable data, and intentional duplicate suppression. Prefer existing helpers,
stdlib, and native features over new wrappers or fallback frameworks.
