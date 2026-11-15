# CLI、MCP、构建与跨层契约审查

结论：ISSUES。基线提交为 `a1b1997d16ec7c03e20924c665d193ffd6aa88df`。
审查保留工作区已有的文档修改，没有修改运行代码、发布包或用户安装。

## 结构和覆盖

`agent-bundle.config.ts` 负责将声明式 CLI、MCP、skills 和 host 配置构建为 `artifact/`
及 npm 的 `dist/`。`src/cli/` 和 `src/mcp/` 多数文件只负责 schema、调用共享 operation
和输出，分别约 2,432 行和 1,028 行。多个入口共享 core 层是合理结构，不应因文件多就改成
动态注册框架。生成的 bundle 也不应按手写源码的大小标准拆分。

`src/core/commands.js` 为 gateway/files 提供一致接口，`src/cli/_shared.ts` 统一后端选择
和错误脱敏。Codex、relay、ChatGPT Desktop 的共享 operation 已让多数 CLI/MCP 入口保持较薄。
例外是 `src/cli/send.tsx` 的 manual 路径仍自行组装消息、记录历史和解释回执，容易与 MCP 输出分叉。

检查覆盖了全部 CLI/MCP 文件的内部依赖关系，并重点逐行检查 send/thread、shared、doctor、history、
bot/group CRUD、Claude channel，以及三个 workflow、包配置、测试运行器和现有路由测试。
各后端 operation 的内部实现由其他分区负责。没有运行真实 GUI、远端主机或消息发送。

## S1：总字符预算无法约束后续条目元数据

优先级 P2，已用真实源函数和合成 JSON 复现。
[`transcriptEntries`](../../../src/gbot.ts#L82) 每次仅缩短 `entry.text`，但在 `remaining`
为零后仍返回完整的 id/kind/role。每字段长度受限，不等于整个数组的预算受限。
活跃入口是 [`gbot_thread`](../../../src/mcp/grok-bot/tools/gbot_thread.tsx#L63) 的 `full: true`。

复现构造 200 条记录，每条 id/kind/role 各 200 字符、text 9,000 字符。
输入 JSON 为 1,928,013 字节，小于 gateway 的 2,097,152 字节限制；输出这些字段合计
307,400 字符，超过声明的 200,000。这里统计的是实现实际扣减的内容字符，不把 JSON 标点冒充预算。

现有 `tests/route-unit/tools.test.ts:381` 仅检查正文被截断，后续保留 metadata；没有断言
正文与 metadata 的合计。最小修复是先为所有需要保留的有界 metadata 预留总预算，再分配文本预算。
保留 entryCount、cursor 和 truncation 语义，不应简单丢弃尾部记录导致增量游标漏读。
如果 metadata 本身就超过总预算，需要明确分页或拒绝的契约；仅预留 metadata 并不能覆盖这个边界。

可在仓库根目录运行以下纯函数复现：

```sh
node --input-type=module <<'JS'
import { transcriptEntries } from './src/gbot.ts';
const entries = Array.from({ length: 200 }, (_, i) => ({
  id: String(i).padEnd(200, 'i'), kind: 'k'.repeat(200),
  role: 'r'.repeat(200), text: 'x'.repeat(9000),
}));
const result = transcriptEntries({ entries });
console.log(result.reduce((n, e) => n + e.id.length + e.kind.length + (e.role?.length ?? 0) + e.text.length, 0));
JS
```

## S2：manual send 的普通输出误称不确定投递为 Sent

优先级 P2，已使用构建后的真实 CLI 和 loopback fixture 复现。
[`send.tsx:184`](../../../src/cli/send.tsx#L184) 只根据 `exitCode === 0` 选择 `Sent to ...`。
但 [`deliver`](../../../src/cli/send.tsx#L129) 保留 `delivery: unknown`，并明确返回 exitCode 0。
gateway 返回 `{ok:true}` 而无 receipt 时，JSON 是 unknown，普通输出却是成功语气。

同一个隔离假网关分别接受两次独立测试请求。普通输出为 `Sent to bot Fixture ...`；
JSON 输出为 `delivery: unknown, exitCode: 0`。不是重试或实际重复发消息的复现。
脚本位于 `/private/tmp/gbot-root-review/reproduce.mjs`，所有请求只到 127.0.0.1，HOME 为临时目录。

最小修复是让文字根据 delivery 区分 accepted/unknown，并提示先查 thread 再决定是否重发。
优先复用已有 `describeDelivery` 的语义。不要在这项文本修复中顺手改变 exit code；
`test/backend-send-cli.test.js` 已明确把无 receipt 的正常响应预期为 unknown + exit 0。
若要改变机器调用契约，需要独立兼容性评估。

## S3：小回执路径仍构造最终不会返回的全部正文

优先级 P3，静态调用路径确认，未做耗时基准。
[`gbot_thread.tsx:66`](../../../src/mcp/grok-bot/tools/gbot_thread.tsx#L66) 在判断 `full` 之前
调用 `transcriptEntries`。因此默认 `full:false` 仍为每条记录做 Zod 解析、正文提取、字符串截断和数组分配，
随后只返回 cursor/count/summary。频繁轮询有内容的 thread 时，这部分工作无输出用途。

将构造 entries 的语句移到 `if (!full) return ...` 之后即可删除这条路径的工作，
无需缓存或新抽象。`transcriptDelta` 仍必须执行，因为它决定 cursor 和 count。
当前输出与网络请求行为不变。没有证据声称整体延迟可提高某个百分比。

## S4：测试继承 Codex 会话环境，导致正常命令行为被误判失败

优先级 P3，使用已有测试复现。
[`run-unit-tests.mjs:39`](../../../scripts/run-unit-tests.mjs#L39) 原样继承环境，
[`history.test.js:21`](../../../test/history.test.js#L21) 清理了 GROK_BOT/CURSOR/SAND 变量，
却没有清理 CODEX_THREAD_ID。实际 CLI 会合法地给消息加来源前缀，测试却按原始字符串统计发送次数。

```sh
env GROK_BOT_TEST=1 CODEX_THREAD_ID=review-fixture node --test --test-name-pattern='failed sends and empty threads' test/history.test.js
```

该命令在 `history.test.js:204` 失败，得到 `0 !== 1`。清空会话 ID 的完整测试则全部通过。
最小修复是在需要固定消息体的 fixture 中显式隔离这个变量，保留专门的 sender-prefix 测试。
不要修改用户进程环境，也不要为了让测试通过去掉产品的来源前缀。

## 应保留的边界与不建议的改写

`backendFlagsSchema`、外部 RPC 的 runtime schema、输出截断和 `withRedactedErrors`
保护不同边界，不能因有重复判断就整体删除。`openBackendFromInput` 的 Proxy 确有隐藏控制流，
但它集中防止 backend 异常泄露凭据；本轮没有证明换一层 wrapper 会减少总复杂度。

Zod schema 与 `inputJsonSchema` 的重叠受当前框架静态声明契约影响。可以审查是否漂移，
但不能直接删掉一份，更不建议为此编写自有 schema 编译器。
`summarizeTarget` 看似只有导出，实际被 relay/routes 使用，不是死代码。

package 的 bin/plugin 身份和 scoped npm 名称不同是已记录的兼容性选择。
Release 的“两阶段 Changesets + registry 验证”也不属于多余防御，不能把绿色的 PR 准备运行
当作 npm 已发布。此次没有改动发布配置。

## 验证结果

`env CODEX_THREAD_ID= npm test` 通过 546 个 Node 测试和 97 个路由测试。
输出记录在 `/private/tmp/gbot-architecture-baseline-tests.log`。这里是功能基线，不是性能基准。
`reproduce.mjs` 对预算溢出和 misleading send 输出的断言均成功。
会话环境复现按预期失败，日志位于 `/private/tmp/gbot-root-review/history-environment.log`。

没有测量真实服务延迟、CPU 或内存峰值。代码注释审查未发现值得单独提交的删除项；
发现的注释与实现不一致处应随对应行为修复，而非仅删除注释掩盖问题。
