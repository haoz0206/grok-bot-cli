# 核心 gateway、文件存储与 transcript 审查

目标是说明核心模块如何协作，找出能删除的复杂度，以及有证据的正确性、安全和效率问题。结论为 **ISSUES**。本报告发现 6 个已复现问题，另有 2 个受调用方式或供应商语义限制的风险，以及 3 项结构建议。审查只写文档，没有修改源码或测试。

审查基准为 `a1b1997d16ec7c03e20924c665d193ffd6aa88df`，日期为 2026-11-16。现有 `AGENTS.md`、`README.md`、Changeset 和发布文档改动均未触碰。构建期间出现的 `artifact/agent-bundle.manifest.json` 改动由父审查流程处理。

## 模块职责与调用关系

| 模块 | 当前职责和调用者 | 判断 |
| --- | --- | --- |
| `commands.js`，58 行 | `openBackend` 选择 live gateway 或文件目录，并把两套实现绑定为同一组方法。`src/cli/_shared.ts:34` 是 CLI 入口。 | 两个真实后端足以支持这层适配。无须引入后端基类、注册器或依赖注入框架。 |
| `gateway.js`，640 行 | 环境或桌面鉴权、EnsureSandBox、共享重连、受限 HTTP 读取、roster、profile、group、skill、发送与审批。CLI 经 `commands` 调用，MCP 经 `gbot.ts` 或 route 调用，relay 经 `relay/engine.js:25` 调用。 | 主要复杂度集中于此。传输与鉴权策略有价值，但业务方法发生不必要的完整 profile 回写和重复 roster 查询。 |
| `app-session.js`，344 行 | 读取显式 active account，解密 macOS、Linux、Windows Safe Storage，读取 gateway descriptor 与 app version。调用者是 gateway 和 headers。 | 平台差异及 account 绑定是真实边界。不能为了缩短代码合并成“尝试所有账号直到成功”。 |
| `headers.js`，55 行；`url-policy.js`，177 行 | 规范化 gateway routing header，创建两类授权 header，限制 credential 目的地并脱敏错误。 | backend 与 box 的 host policy 应分开。多 cookie 脱敏有漏洞。 |
| `store.js`，353 行 | 文件目录发现，profile、settings、group CRUD，名称或 UUID 解析，组去重。由 `commands` 的 files 分支调用。 | 简单同步实现适合 CLI；写入容错与完整目录重复扫描需要修正。 |
| `transcript.js`，77 行 | 正文解析、source id 与 bounded delta。`format.js`、`history.js`、`gbot.ts`、relay intake 共用。 | 正文解析是正确的共享位置；数组分支漏用自己的安全字符串转换。 |
| `history.js`，87 行 | 明确 opt-in 的本地 JSONL 历史、最少字段保存、离线过滤和最后 N 条。调用者为 CLI send、thread、history。 | 追加日志与原地 JSON 配置写入不能混为一谈。追加日志不应改为每次整体重写。 |
| `grok-approvals.js`，32 行 | 识别两类 pending 审批卡、限制字段和长度、生成要求显式用户决定的通知。gateway 与 relay intake 共用。 | 严格 request/entry id 匹配和截断后禁止 accept 都应保留。 |
| `sender-prefix.js`，44 行 | 从环境和已知 thread 构造单行来源与回复指引。调用者为 CLI send 和 relay。 | 用于跨机器回复定位，有真实调用者，不能当成日志装饰删除。 |
| `format.js` 的 Grok 输出 | `formatRecord` 用于 bots/groups list、get、members；`formatTranscript` 用于 `thread.tsx`。 | 同文件已有 terminal control 清理，但只覆盖 Codex 输出。 |

主要路径如下。

```text
CLI route → _shared.openBackendFromInput → commands.openBackend
  gateway → connectGateway → descriptor / active account / env
          → EnsureSandBox（需要时）→ gatewayCall / backendSendPrompt
  files   → resolveAgentsRoot → store 的同步 CRUD

thread → gateway.getTranscriptTail / getThread
       → transcriptDelta（可选）→ saveHistory → formatTranscript

MCP / relay → gateway 共享函数
relay intake → grokApprovalNotice 或 entryText → durable relay records
```

本范围没有超过 1000 行的文件。行数来自 `wc -l src/core/{gateway,app-session,commands,store,history,transcript,headers,url-policy,sender-prefix,grok-approvals}.js`，没有把文件规模本身当作缺陷。

## 已复现问题

### C1 · P1 · 多 cookie 经过公共脱敏函数后仍包含凭据

位置为 `src/core/url-policy.js:161`，同函数后续的字段正则在 `:171`。第一条 cookie 正则不允许值包含分号，却要求后面是另一 header 或行尾，因此普通 `Cookie: a=...; b=...; c=...` 不匹配。后续字段规则只吞掉没有空格的第一个片段。输入 `Cookie: sid=FIRST_FAKE; refresh=SECOND_FAKE; login=THIRD_FAKE`，连续运行两次 `redactSecrets` 后仍得到 `Cookie: <redacted> refresh=SECOND_FAKE; login=THIRD_FAKE`。

实际调用路径包括 `gateway.js:154`、`:257`、`:536` 的错误详情，`gbot.ts:16` 的 CLI/MCP 错误包装，`relay/worker.js:152` 的持久化错误，以及 `grok-approvals.js:22` 对 command、reason 等字段的脱敏。审批命令中包含 `curl -H 'Cookie: ...'` 就能将 cookie 带入返回的审批内容。额外套一层错误包装不能可靠消除泄漏。

最小修复是在 `redactSecrets` 内统一识别完整 cookie header 值，包含分号分隔的 cookie，保留下一 header 的边界。添加一个多 cookie 用例和一个换行用例，断言所有合成 cookie 值均消失。无需在每个调用者增加单独脱敏。此结论使用合成字符串，未读取或输出真实凭据。

### C2 · P2 · Grok 的 CLI 输出允许远端字段携带 terminal controls

位置为 `src/core/format.js:45`、`:52`、`:61`。这些字符串直接拼接 bot 名称、description、message text、role 和 id，没有使用同文件 `:4` 的 `stripTerminalControls`。调用者有 `src/cli/thread.tsx:62`、`:81`、`:95`，以及 bots/groups 的 list、get、members route。

本地先把一个临时文件 bot 的名字设为合成 OSC52 字符串，然后实际执行 `dist/bin/gbot.mjs bots list --files --dir <临时目录>`。捕获的 stdout 仍包含 `\u001b]52;c;RkFLRQ==\u0007`。因此现有 runtime 没有在这条输出路径上拦截这些字节。纯函数检查也证明 `formatTranscript` 保留相同字节。支持相应控制序列的终端可能处理剪贴板、标题或光标控制；本审查没有对真实终端执行剪贴板操作，也没有声称这些序列能执行 shell 命令。

最小修复是在 CLI 可见文本边界清理所有外部字段，复用已有清理思路，同时保留正文中的合法换行。现有 helper 会删除所有 C0，包括换行，因此不能不加区分地套在整个 transcript 上。结构化 JSON 与历史保存需要保留原消息数据。

### C3 · P2 · `entryText` 的 content 数组仍可能在安全转换前抛异常

位置为 `src/core/transcript.js:31`。对象数组元素返回 `part.text` 或 `part.content` 后，`:35` 的 `join` 先进行隐式字符串转换。外层 `normalizeText` 尚未执行，因此 `toSafeText` 的保护无法生效。纯 JSON 可表示的输入 `{"content":[{"text":{"toString":null}}]}` 会抛 `TypeError: Cannot convert object to primitive value`。

此函数供 `gbot.ts:62` 的 MCP transcript 正规化、`format.js:59` 的 CLI thread、`history.js:29` 以及 `relay/intake.js:180` 共用。MCP 和 CLI 会因一条异常正文失败；relay intake 的 catch 会把这一类解析错误归为 `message-size` 并暂停 target，见 `intake.js:181`。这与 `test/transcript.test.js` 中已有的“never throws”契约不符。

最小修复是在数组元素进入 join 前使用现成的 `toSafeText`，而不是增加一套异常消息格式或在每个调用者捕获。现有 `toSafeText` 已能把上述对象转换为 JSON 字符串。增加一个 JSON 可解码对象的断言即可覆盖根因。

### C4 · P2 · 仅修改 notify 或 hidden 也会回写旧 profile，覆盖并发编辑

位置为 `src/core/gateway.js:338` 到 `:345`。`updateAgent` 总是从第一次 roster 快照取 name 和 description 并调用 `updateAgent`，即使 patch 只有 `notifyOnAgentUpdates` 或 `hiddenFromSidebar`。真正设置开关的调用在 `:346` 和 `:349`，因此这种 profile 写入没有业务用途。文件后端 `store.js:278` 已按 `hasProfile` 判断是否需要写 profile。

调用者是 `commands.js:24`，再到 `src/cli/bots/update.tsx:43` 和 `groups/update.tsx:45`。本地 mock 在首个 listAgents 响应创建后，把服务器 description 从 `before` 改为 `external-new-description`，随后执行仅含 notify 的更新。最终 description 变回 `before`，调用顺序是 `listAgents, updateAgent, setAgentNotifyOnUpdates, listAgents`。此复现证明覆盖行为，不依赖网络延迟测量。

最小修复是按 profile 字段是否存在来决定是否发 profile RPC，保留独立的开关更新。能发送部分 profile patch 与否需要由实际 gateway 契约确认；仅跳过开关操作的多余 profile 写入已能完整修复这个触发条件。不要为两个开关新增事务框架。

### C5 · P2 · settings 读取失败被当作空对象，后续更新会毁掉原数据

位置为 `src/core/store.js:137` 到 `:145`，写入点为 `:223`。`readRawSettings` 在任意读取或解析失败时返回 `{}`，而 `mergeSettings` 把这个值当作真实旧配置继续写入。这样把只读展示时的容错用于读改写操作，错误地把“无法读取”解释成“没有设置”。

调用路径为 `commands.js:45` 到 `store.updateAgent:293`。复现向临时 settings 写入缺少最后一个 `}` 的 `{"notifyOnAgentUpdates":false,"operatorSetting":"KEEP"`，然后设置 hidden。命令成功，最终文件只有 `{"hiddenFromSidebar":true}`。原本仍可恢复的 notify 和额外设置全部消失。已有 `test/store.test.js` 只验证正常 JSON 的额外字段保留，没有覆盖读取失败。

最小修复是使“文件不存在”仍可返回空设置，而写路径上的 JSON 或 I/O 错误必须阻止覆盖。若列表仍希望用默认值展示，把容错留在 `readSettings`，不要让 `mergeSettings` 复用会吞错误的读取函数。

### C6 · P2 · 配置原地截断写，失败时无法保留上一份完整文件

位置为 `src/core/store.js:69`。所有 profile、settings 和 group 通过同一个 `writeJson` 使用 `writeFileSync` 的默认截断写入。调用者包括 `writeProfile:205`、`writeSettings:215`、`mergeSettings:223`、`writeGroup:227`。更新中磁盘满、I/O 错误或进程中断可能留下空文件或部分 JSON；下一次 `listRecords` 因解析失败而无法列出整个目录。

在只作用于临时 profile 的故障注入中，模拟 `writeFileSync` 截断旧文件、写入前 10 个字符后抛 `ENOSPC`。`updateAgent` 正确抛错，但旧完整 profile 已变成 `"{\n  \"name\""`，再次 JSON.parse 失败。这是受控故障注入，不是声称本机实际发生磁盘满。

最小修复在已有 `writeJson` 内把 JSON 写到同目录临时文件，再 rename 到目标，异常时清理临时文件并保留旧配置。修复不应扩展到 history 的追加日志，也不能宣称单文件 rename 自动解决多文件事务或并发 lost update。

## 有证据但影响受限的风险

### C7 · P3 · 共享 refresh 的取消信号属于第一个调用者

位置为 `src/core/gateway.js:195` 到 `:217`。`state.pending` 是同 session 所有读取共享的 Promise，但 `ensureSandbox` 使用创建这份 Promise 的首位读取者 signal。如果首位读取者取消，未取消的其他读取者也会失败。

隔离 mock 让两次 `listAgents(session)` 同时遇到 pod_hibernated，只有第一次带 signal。它们进入同一次 refresh 后取消首位，结果两次读取均以 `Gateway submission cancelled before transmission` 拒绝。`test/gateway-reconnect.test.js` 明确测试了共享 refresh 的正常并发，却没有取消场景。

当前 `relay/engine.js:25` 多数操作各自 connect，CLI 的单次方法也通常串行，因此本审查没有找到内置流程稳定触发这个跨调用者取消的证据。它是已复现的共享 session API 隐患，优先级低于上面的现有路径问题。若需要支持独立调用者共享 session，应让 refresh 使用自己的 deadline，每位等待者单独处理取消，且不因一个等待者取消而使所有等待者失败。

### C8 · 需确认协议 · direct gateway 对 408 和 499 的分类与 backend 不一致

位置为 `src/core/gateway.js:572`。direct gateway 分支把所有带 status 且小于 500 的错误默认分类为 rejected；`backendSendPrompt:537` 则显式把 408 和 499 标记为 unknown。mock 在实际经过 `/api/sendPrompt` 之后返回这两个状态，得到 delivery=rejected，且只有一次发送。

已确认的是两种发送方式的分类不一致。未确认的是 Grok legacy gateway 或其代理对 408、499 是否提供“没有执行”的保证，本报告没有供应商源码证据。不能据此宣称远端已收到了消息或必然产生重复发送。如果 direct gateway 同样没有这种保证，最小修复是像 backend 一样将这些状态保守归为 unknown，并增加两个断言。发布前应确认协议，不能为了统一代码把 backend 已有的 unknown 改成 rejected。

## 结构与效率建议，不计为已证明的运行故障

### S1 · 用一次 roster 快照完成解析和修改准备

`store.normalizeMemberIds:233` 先列出 records，却在每个成员上再次调用会重新 `listRecords` 的 `resolveRef:177`。设置 3 个已知 UUID 成员时，受控目录计数得到 6 次完整 readdir：目标解析一次、normalize 初始一次、3 个成员各一次、最终结果解析一次。每次完整扫描还要解析所有 profile、settings 和 group 并排序。gateway 的 `addGroupMember:479` 和 `removeGroupMember:488` 也先 list，再调用 `setGroupMembers:467` 重新 list。

最小改法是把“在已取得的 records 内解析 ref”作为纯函数，磁盘和 gateway 的操作各自只取得一次快照。文件后端可直接读取写后目标结果，不必再次读整个目录。gateway 内部 set 可以接收已经解析的 group 和 member IDs，公共入口继续负责边界验证。不要跨 CLI 进程缓存 roster，也不要为了这一点新增缓存失效机制。这是操作数与源码证据，没有测量实际耗时，不能给出速度提升比例。

### S2 · 拆分 gateway 的业务分组时保留一个传输策略入口

`gateway.js` 同时包含 credentials/reconnect/HTTP，roster/group，skills，审批和 send receipt。读取一个技能操作必须跳过与发送、鉴权状态相关的代码。最有价值的拆分是让传输和鉴权继续由一个模块拥有，将纯 roster/ref/member 规则与 skill 业务移出。保留 `gateway.js` 作为现有导出入口可降低调用者变更成本；若只是把每个方法移到文件再互相回调，概念数没有减少，不值得做。

`commands.js` 已有两个真实实现，不应删除它再让每个 CLI route 分支判断 files/gateway。`app-session.js` 的 Windows key 复用也有实际用途，不能粗暴复用会为每个字段重新读 DPAPI key 的 helper。

### S3 · history 暂不添加索引或数据库

`readHistory:55` 每次顺序扫描全部 JSONL，但仅保留过滤后的最后 limit 条，避免一次加载整个文件。`search.toLowerCase()` 可移到循环外；是否需要从尾部读取或索引，应先看真实 history 大小与查询时间。当前没有测量支持数据库、轮转服务或索引层。重复 thread 观察会保存重复行，`test/history.test.js` 明确将其作为行为测试，不应当作误去重缺陷。

## 必须保留的防护与排除项

本范围未找到可安全删除的活跃防护层。`gatewayCall` 的 30 秒 deadline、2 MiB response cap、redirect:error、每次 credential URL 检查有明确边界作用。只有指定只读方法、指定 417 和两个 anyrun header 才触发重连，并且最多重试一次；这些条件不能简化为所有 417 都重试。发送离开进程后保留 receipt 判断、unknown 与不盲目重发，避免重复消息。

`app-session` 仅用显式 active account，并在刷新或发送前后检查 account key。缺少 descriptor、无法解密和账号漂移不是同一种状态。跨平台解密、unsupported version、team id 格式检查均有独立测试覆盖。未读取任何真实桌面认证文件，也未调用真实 Keychain 或 DPAPI。

组禁止嵌套、6 人上限、空组限制与成员去重均有实际 CLI 调用。文件 `createGroup:315` 的同成员组复用是 intentional duplicate suppression，不能为“同名参数未生效”而删除。history 的默认关闭、最少字段保存、O_NOFOLLOW、0700/0600 新建权限、损坏行跳过和保存失败后仅警告也有实际安全或发送幂等理由。

`grokApprovalResponseSchema` 的 strict 输入、pending 状态、精确 entry/request 匹配、两种审批映射、truncated 后禁止 accept 属于授权边界。没有提出自动批准、放宽匹配或回放审批。comment-sicko 检查没有得出可优先于上述问题的注释删除项。Chromium 加密和 Windows 存储格式等外部事实本次没有联网核验，因此相关说明为 HOLD；不按注释文字擅自删除平台分支。

## 验证记录与覆盖缺口

执行了以下现有测试命令。

```sh
GROK_BOT_TEST=1 node --test test/store.test.js test/transcript.test.js test/app-session.test.js test/gateway.test.js test/gateway-groups.test.js test/gateway-send.test.js test/gateway-skills.test.js test/gateway-reconnect.test.js test/backend-send.test.js test/grok-approvals.test.js test/url-policy.test.js
```

结果为 160 个测试、159 通过、1 失败。失败项是 `gateway-send.test.js:18` 的 loopback fixture，错误为 `listen EPERM: operation not permitted 127.0.0.1`。它没有到达业务断言，不能算代码回归。父审查流程随后执行允许 loopback 的 `env CODEX_THREAD_ID= npm test`，其 `/private/tmp/gbot-architecture-baseline-tests.log` 确认 546 个 unit tests 和 97 个 route tests 全部通过。`history.test.js` 的 CLI 与本地 server 测试由该完整运行覆盖。基线绿灯不覆盖本报告新增的复现输入。

隔离复现全部运行成功，命令如下。脚本和所有模拟数据仅在本分片自己的临时目录。

```sh
node /private/tmp/gbot-audit-core-20261116/repro.mjs
node /private/tmp/gbot-audit-core-20261116/reconnect.mjs
node /private/tmp/gbot-audit-core-20261116/store-io.mjs
```

`repro.mjs` 逐项断言 C1 至 C5、C8，并捕获真实 built CLI 的 OSC52 stdout；`reconnect.mjs` 断言 C7 的两个 Promise 都拒绝；`store-io.mjs` 断言 C6 的失败写入破坏旧 JSON，并检查 S1 的目录扫描次数。所有 fetch 均为本地 mock，没有向生产网关发送消息，没有 daemon 操作、安装修改或 Git 操作。

详细阅读了上述 10 个核心文件，并跟踪了 `format.js` 的 Grok 输出、CLI `_shared`、bots/groups update/create、thread、审批 routes、relay 对核心函数的调用点和相关 tests。未深入审核 Codex bridge、desktop shim、Claude channel 或 ChatGPT Desktop 内部实现，这些属于其他分片。未测真实网络性能、长期 history 增长、文件系统掉电恢复、真实 Windows ACL 或供应商 408/499 处理。

本审查采用 Minimize Reader Load，将 S1 建议收敛到现有 records 解析，保留有两个实现的 backend 适配。采用 Prove It Works，对脱敏、异常正文、并发覆盖和存储故障运行断言，并用实际 CLI 捕获 terminal 字节，未把单元函数输出代替完整 CLI 证据。

没有删除代码、改变认证、重试消息或处理现有文档改动。上述故障已复现，但源码仍保持审查前状态。
