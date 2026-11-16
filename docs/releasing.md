# 从 commit 到 npm 发布

这份指南适用于 `haoz0206/grok-bot-cli`，发布目标只有
[`@haoz0206/grok-bot-cli`](https://www.npmjs.com/package/@haoz0206/grok-bot-cli)。
用户和 agent 都通过 [Release 工作流](https://github.com/haoz0206/grok-bot-cli/actions/workflows/release.yml)
发布。npm 首次创建和 Trusted Publisher 配置已经完成，日常发布不需要重复初始化。

## 分清提交、推送与发布

| 操作 | 结果 | npm 用户能否安装这次修改 |
| --- | --- | --- |
| `git commit` | 把选中的修改保存为本地 Git 提交 | 不能 |
| `git push` | 把本地提交上传到 GitHub 对应分支 | 不能，仅上传代码不代表 npm 已更新 |
| 功能 PR 合并到 `main` | Release 工作流处理待发布的 Changeset | 通常先生成发版 PR |
| 合并 `Release packages` PR | 版本进入 `main`，`publish` 等待 Environment `npm-publish` 批准 | 批准且 npm 确认新版本后可以安装 |

可以积累多次 commit 和 push，再发布一个 npm 版本。已安装的用户不会自动升级。

Changeset 是 `.changeset/` 下的 Markdown 文件，记录用户能观察到的变化和版本增量。
选择 `patch` 表示兼容修复，`minor` 表示兼容的新功能，`major` 表示不兼容变化。
本仓库使用 Changesets 计算版本并更新 CHANGELOG，不手工运行 `npm version`。

## 准备要发布的修改

1. 检查 `git status`、当前分支和 `git remote -v`。确认 `origin` 指向自己的
   `haoz0206/grok-bot-cli`，识别本次修改，保留其他未提交工作。
2. 为修改添加 Changeset。运行 `npm run changeset`，选择 `@haoz0206/grok-bot-cli`
   和合适的版本增量。检查 `.changeset/config.json` 的范围；README 也属于随包发布的内容。
3. 运行 `npm ci` 和 `npm run check`。后者会构建、校验产物、检查类型并运行测试。
   如果继承的 Codex 会话环境导致历史记录测试失败，可以用
   `env -u CODEX_THREAD_ID npm run check` 在不继承该会话 ID 的环境中验证。
4. 检查差异，将本次源码或文档、Changeset、生成的 `artifact/` 和有变化的 marketplace
   文件一起提交。只暂存属于本次修改的文件。
5. 推送功能分支，在这个 fork 中创建目标为 `main` 的 PR。检查 Package CI 和 Changeset
   检查结果，处理失败后再合并。已经明确获准直接推送 `main` 时，仍需先完成本地验证。

例如，一个小修复的 Changeset 内容可以是：

```md
---
"@haoz0206/grok-bot-cli": patch
---

Fix delivery receipts for server-hosted bots.
```

不要照抄示例的说明，要写本次实际变化。不要把包名换回上游的 `grok-bot-cli`。

## 判断 Release 工作流会做什么

[release.yml](../.github/workflows/release.yml) 在 `main` 收到 push 时自动运行，也支持手动触发。
手动触发只在 `refs/heads/main` 上继续；其他 ref 会使 `main-only` 失败，并且不会进入发布 job。
工作流读取 GitHub 上的代码，不包含本机未提交或未推送的修改。

版本 PR 和 npm 发布是两个 job：

| Job | 何时运行 | 是否等待批准 | 结果 |
| --- | --- | --- | --- |
| `version` | `main` 上还有待发布 Changeset | 否 | 创建或更新 `Release packages` PR。没有 `id-token`，也没有 `publish-script` |
| `publish` | `main` 上没有待发布 Changeset | 是，GitHub Environment `npm-publish` | 批准后才执行 `npm run release`，并创建 GitHub Release |
| 两者之外 | 手动触发的 ref 不是 `main` | 否 | 工作流失败，不发布 |

`publish` 在步骤开始前等待 Environment 批准。生成版本 PR 的 job 不使用该 Environment。
发布命令之前还有一道只读校验：`npm-publish` 必须有 required reviewer `haoz0206`（id `236642726`），`prevent_self_review` 为 false，并且部署分支恰好是 `main`。校验失败就不执行 `npm run release`。
zstack 对发版 PR 的审查是仓库外的审核，不是 GitHub required reviewer。
Environment 的 required reviewer 是 GitHub 用户 `haoz0206`。`prevent_self_review` 必须保持关闭，否则唯一批准人无法批准自己触发的部署。

当前 `main` 若没有待发布 Changeset，合并只改 workflow 的 PR 也会排队 `publish`。
在批准部署之前不会执行 `npm publish`。不打算重跑已发布版本时，拒绝该部署。

所以，点击 **Run workflow** 不一定立刻发布 npm。准备发版 PR 的运行可以成功，
但那次运行不证明 npm 已有新版本。不要靠反复运行工作流来增加版本号。

## 让 agent 代办发布

用户可以明确说“把这批修改发布到 npm”，或“合并发版 PR 并验证发布结果”。
在授权范围明确时，agent 按以下步骤完成工作，不需要为同一发布反复索要确认。
如果用户只要求 commit、push、准备 PR 或更新文档，不合并发版 PR，也不触发可能发布的工作流。
如果用户保留了手动合并权，则在 PR 就绪时交接。

1. 确认本次发布范围，读取 `AGENTS.md` 和本指南，检查工作区、远程 `main`、待发布 Changeset、
   现有发版 PR、正在运行的 Release 和 npm 当前版本。不要将无关工作混入提交，
   也不要忽略发版 PR 中积累的其他修改。
2. 如有尚未提交的授权修改，完成上一节的检查、commit、push 和代码合并。
   如果目标版本已经发布且没有新修改，核验现有发布后报告完成。
3. 优先等待已有的 Release 运行。没有对应运行时，可手动触发：

   ```sh
   gh workflow run release.yml --ref main --repo haoz0206/grok-bot-cli
   ```

4. 如工作流创建了发版 PR，核对目标仓库、base 为 `main`、head 为 `changeset-release/main`、
   版本号、CHANGELOG 和完整差异。确认它只包含预期的版本更新及生成产物。
   检查 CI 和仓库合并要求。失败、缺失或等待审批的检查都不能当作通过。
5. 用户已授权本次发布时，合并审核过的发版 PR。记录审核过的 head SHA，
   合并时用它防止 PR 更新后误合并未经检查的内容。以下变量须先替换为真实值：

   ```sh
   pr_number=123
   reviewed_head_sha=REPLACE_WITH_REVIEWED_HEAD_SHA
   gh pr checks "$pr_number" --repo haoz0206/grok-bot-cli
   gh pr merge "$pr_number" --merge --match-head-commit "$reviewed_head_sha" --repo haoz0206/grok-bot-cli
   ```

   如果 head 改变，重新审核。不要用 `--admin` 绕过检查或分支保护。
6. 记录实际合并到 `main` 的提交 SHA 和目标版本，跟踪该提交的 Release 运行。
   不要把较早的“创建发版 PR”运行当作发布成功。`publish` 被批准并完成前都不是发布成功。
   完成下面的发布验证。
7. 报告版本、发布提交、PR 链接、Release 运行链接、npm 验证结果和未完成事项。
   只有用户还要求更新本机安装时，才执行全局升级。

这些命令只是操作示例，不是无条件执行的脚本。agent 应使用可用的 GitHub 工具或 CLI
读取实际状态，遵守用户对提交、推送和合并的限制。缺少 GitHub 权限时，交接明确的页面和操作步骤，
不要改用本地 npm 发布。

## 手动在 GitHub 发布

1. 确认要发布的修改及 Changeset 已经进入 GitHub `main`。
2. 打开 [Actions → Release](https://github.com/haoz0206/grok-bot-cli/actions/workflows/release.yml)。
   如果已有该提交的运行，等待它完成。否则点击 **Run workflow**，选择 `main` 并运行。
3. 如果出现 [Release packages PR](https://github.com/haoz0206/grok-bot-cli/pulls)，
   检查版本、发布内容和 CI，然后合并。合并会再触发 Release。此时 `publish` 等待
   Environment `npm-publish` 的批准，批准前不会发布。
4. 在该次运行的 `publish` job 上批准部署。等它完成，并确认
   **Verify package.json version resolves on npm** 为成功，而不是跳过。
5. 按下一节检查 npm 上的目标版本。若合并后没有自动运行，确认该提交已在 `main`，
   再在 `main` 手动运行 Release，并同样批准 `npm-publish`。

## 验证发布成功

从发版合并提交的 `package.json` 读取目标版本。不要依赖可能落后的本地 `main`。
用合并提交 SHA 查找对应运行，随后检查该运行的步骤与结果：

```sh
release_sha=REPLACE_WITH_MERGED_MAIN_SHA
gh run list --repo haoz0206/grok-bot-cli --workflow release.yml --branch main --commit "$release_sha" --json databaseId,headSha,status,conclusion,url
```

必须同时确认以下结果：

- 对应提交的 Release 运行成功，发布路径已执行，registry 验证步骤成功。
- npm 能查询到目标版本，`latest` 指向本次正式版本。如果有更新版本并发发布，先查清对应运行。
- 从 registry 安装目标版本后，三个 CLI 命令入口可以运行。

把下面示例版本替换为本次目标版本，再执行只读查询：

```sh
release_version=0.12.6
npm view "@haoz0206/grok-bot-cli@$release_version" version bin dist.attestations --json --registry=https://registry.npmjs.org/
npm view @haoz0206/grok-bot-cli dist-tags --json --registry=https://registry.npmjs.org/
```

使用临时目录验证实际发布包，不替换用户的全局安装。沿用上一步的 `release_version`：

```sh
install_root=$(mktemp -d)
npm install --prefix "$install_root" "@haoz0206/grok-bot-cli@$release_version" --registry=https://registry.npmjs.org/ --no-audit --no-fund
npm exec --prefix "$install_root" --no -- gbot --help
npm exec --prefix "$install_root" --no -- grok-bot --help
npm exec --prefix "$install_root" --no -- gbot-install --help
```

确认成功且用户要求升级后，使用明确版本更新安装：

```sh
npm install --global "@haoz0206/grok-bot-cli@$release_version" --registry=https://registry.npmjs.org/
```

## 处理等待和失败

- **npm 暂时返回 404。** 发布处理可能延迟。现有工作流最多等待约 20 分钟查询目标版本。
  等待期间报告“发布仍待 registry 确认”，不要提前宣布成功或重复发布。
- **已有 Release 正在运行。** 跟踪原运行。相同分支的新运行会取消旧运行，避免重复点击。
- **工作流失败。** 查看对应运行的失败步骤和日志，区分构建、权限、发布和 registry 验证失败。
  修复实际问题后，在 `main` 重试；不要重跑旧提交来代替验证已经改变的代码。
- **PR 检查没有运行。** 2026-11-15 的 [Package CI run 43738853007](https://github.com/haoz0206/grok-bot-cli/actions/runs/43738853007)
  和 2026-11-16 的 [Package CI run 43853306634](https://github.com/haoz0206/grok-bot-cli/actions/runs/43853306634)
  都是 0 个 job。运行页面原文是 “This workflow run required approval but was not approved before it expired.”
  这两次 PR 的 head 仓库都是本仓库，actor 是 `github-actions[bot]`。运行的 `updated_at` 与 PR 合并时间相同。
  没有 job 或被跳过的检查不是测试通过。需要看到真实 job 成功后，才能把检查设为 required。
  Actions 权限接口本次返回 403，所以没有改 “Approve and run workflows” 设置。
- **无法创建发版 PR。** 检查仓库 Actions 设置中的
  **Allow GitHub Actions to create and approve pull requests**。
- **OIDC 发布失败。** 检查下面的 Trusted Publisher 配置、工作流的 `id-token: write` 和
  GitHub 托管 runner。不要请求 npm token、执行 npm 登录，或在本机运行发布命令。

已有版本不能靠重新发布覆盖。修复已发布内容时，添加 Changeset 并发布新版本。
GitHub Release 页面、发布步骤显示成功或单独存在 provenance 信息，都不能替代上述验证。

## 维护发布配置

发布逻辑以 [release.yml](../.github/workflows/release.yml) 为准，版本策略在
[Changesets 配置](../.changeset/config.json)，发布入口在 [package.json](../package.json)。
修改这些文件后，同时更新本指南。

| npm Trusted Publisher 字段 | 仓库侧现状 | 仍需在 npm 完成 |
| --- | --- | --- |
| Provider | GitHub Actions | 保持 |
| Organization or user | `haoz0206` | 保持 |
| Repository | `grok-bot-cli` | 保持 |
| Workflow filename | `release.yml` | 保持 |
| Environment name | workflow 使用 `npm-publish` | 把 Trusted Publisher 的 Environment name 改成 `npm-publish` |
| Allowed actions | 发布 job 只在批准后请求 OIDC | 保持允许 `npm publish` |

本次没有创建出 `npm-publish`。`PUT /repos/haoz0206/grok-bot-cli/environments/npm-publish` 返回 403 `Resource not accessible by integration`，随后 GET 为 404。在合并含有 `environment: npm-publish` 的 workflow 之前，用有管理员权限的账号在仓库 Settings → Environments 创建它，否则第一次 `publish` 可能先生成一个没有 reviewer 的同名 Environment。创建时使用这些值：

- Name: `npm-publish`
- Required reviewers: `haoz0206`（用户 id `236642726`）
- Prevent self-review: 关闭
- Deployment branches: Selected branches，只添加 `main`。不要选 Protected branches，因为 `main` 目前没有分支保护，那样会没有任何分支可以部署

创建后读回：

```sh
gh api repos/haoz0206/grok-bot-cli/environments/npm-publish
gh api repos/haoz0206/grok-bot-cli/environments/npm-publish/deployment-branch-policies
```

确认 reviewer 是 `haoz0206`，`prevent_self_review` 为 false，分支策略只有 `main`。读回不符合时不要合并。

GitHub Environment 只决定本仓库的 `publish` job 能否开始。它不会改 npm 上的 Trusted Publisher。
在 npm 仍把 Environment name 留空时，一旦有人改掉 workflow 并不再进入 `npm-publish`，npm 仍可能接受该 workflow 的 OIDC。
把 npm 的 Environment name 设为 `npm-publish` 之后，没有这个 Environment 的运行不能通过 npm 的发布方检查。
仓库文件不能代替这一步。改 npm 时打开包 `@haoz0206/grok-bot-cli` 的 Trusted Publisher，Environment name 填 `npm-publish`，不要填别的名字。

`package.json` 的 `publishConfig` 保持公共 registry 和 public access。
`npm run release` 和 `npm run release:version` 是工作流入口，不是本地日常操作。
不要执行本地 `npm publish`、重新做首次初始化，或配置长期 npm 发布 token。
需要调整 npm 设置时，参考 [npm Trusted Publisher 文档](https://docs.npmjs.com/trusted-publishers/)。

`main` 推送还会触发独立的 [zstack 唤醒](../.github/zstack/README.md)。它只发送仓库、ref 和 SHA，不参与版本或发布。
