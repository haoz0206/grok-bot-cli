# ChatGPT Desktop 模块设计审查

本分区检查 Desktop 的 CDP、app-server 和远端状态路径能否继续简化，同时保留发送安全性、兼容性和分页完整性。结论为 **ISSUES**。确认 5 项 P2 问题，其中 4 项涉及结果正确性或调用期限，1 项涉及重复远程工作。没有修改源码、测试、安装或 Git 状态。

审查基线为 `a1b1997d16ec7c03e20924c665d193ffd6aa88df`。`git rev-parse HEAD` 返回同一 SHA。本分区只新增此报告，保留其他代理的文档。

## 覆盖与证据边界

已阅读 `src/core/chatgpt-desktop/` 全部 16 个模块，共 4,469 行。调用方覆盖 `src/cli/chatgpt-desktop/` 的 6 个 CLI 路由，以及 `src/mcp/grok-bot/tools/chatgpt_desktop_*.tsx` 的 8 个 MCP 工具。读取并检索 4 份 `tests/route-unit/chatgpt-desktop*.test.ts` 的对应测试，重点核对真实表达式与测试替身的差别。另检查共享 `src/core/codex-bridge.js` 的 list/session 生命周期、`src/core/codex/remote-control.js` 的状态读取和已安装 Agent Bundle 的 render 期限实现。

| 模块 | 当前职责与判断 |
| --- | --- |
| `routes.ts` | Zod 输入、结果编码、错误映射和进程内操作队列。队列保护单一 Desktop 选中会话和 composer，应保留。 |
| `facade.ts` | 组合后端、分页 snapshot、筛选、host 汇总及安全回退。824 行，最值得减小的是重复 inventory 所有权。 |
| `adapter.ts`、`types.ts` | CLI、MCP、facade、CDP 之间的稳定契约。提供真实替换边界，不能仅因接口薄就删除。 |
| `cdp-adapter.ts` | 持有 browser session、page session、选中 target 和最近一次提交的 baseline。负责把 DOM 操作组合成 Desktop 操作。 |
| `cdp-session.ts` | 本机 HTTP discovery、WebSocket、pending request、timeout、关闭清理。没有再造 app-server transport。 |
| `cdp-dom.ts` | 选择器、页面表达式、交互顺序、历史采集和 reply polling。852 行，内容多但仍围绕同一个外部 DOM 协议。 |
| `app-server-fallback.ts` | 复用共享桥接，做 thread 映射、受限 RPC 分页、结果分页、字段分片和旧方法兼容。 |
| `remote-threads.ts` | 解析远端 summaries、host 标签和 managed connections，不连接远端。 |
| `project-state.ts` | 用 persisted assignment、workspace hint、cwd 解析 project。 |
| `payload-budget.ts` | 600 KiB 结果预算、显示压缩和 cursor 编解码。 |
| `thread-ids.ts` | Desktop、app-server、temporary ID 的转换，委托共享 Codex ID 规则。 |
| `loopback.ts`、`errors.ts` | 网络边界验证及可判断的失败类型，职责清楚。 |
| `relaunch.ts` | 独立的显式 macOS 重启工具，本次只读，没有运行。 |
| `index.ts` | 模块导出入口。部分兼容导出只有测试调用，但不宜在未确认外部使用前删除。 |

本次仅运行 `/private/tmp/gbot-desktop-architecture-audit/` 内的隔离断言。Node resolver 将 `codex-bridge.js` 替换成固定数据 fixture，将 shared global-state 边界替换成返回 `null` 的 fixture，其余 Desktop 源码直接从工作区载入。没有读取真实 operator 配置、凭据或状态文件，没有连接任何 Desktop、CDP、app-server 或远端，没有发送消息、重启应用、安装包或启动 daemon。

这证明源码对指定输入的行为，不能证明正在运行的 Desktop 当前 DOM 排列、真实网络延迟、用户 inventory 大小或端到端取消行为。完整 baseline 测试由父审查统一执行，此处不重复声称运行。

## 运行路径与状态归属

CLI 和 MCP 调用同一个 `routes.ts`。`withAdapter` 将操作放入队列，先尝试连接 CDP，再运行具体操作，最后关闭。连接失败后，读取仍可使用 app-server。模块单例保留 facade 的 snapshot 和 CDP adapter 的最近提交 baseline，连接对象由每次操作关闭。

`listThreads` 收集全部 app-server inventory，再叠加 CDP sidebar 与 remote summaries，解析 project、筛选、去重、排序后保存 snapshot。后续 cursor 页使用 snapshot。全量合并是保证跨来源统一排序和不丢页的设计选择，不能把它直接改成“拿第一页就返回”。

`searchThreads` 先收集 app-server 的全部匹配，再合并 sidebar 和远端 rows。`readThread` 对 durable ID 优先使用 app-server，并用 `thread/turns/list` 的小页获取历史。temporary ID 使用 CDP。无 cursor 的本地读取失败可以回退 CDP，回退结果标记为不完整。已知远端未加载和既有 read cursor 不跨后端回退，避免伪装完整结果或误读其他会话。

`sendMessage`、`openThread`、`waitForReply` 使用 CDP 的单一当前页面。发送会检查草稿、streaming 状态、project 路由和 durable conversation ID。只有显式 `unarchive:true` 才调用 app-server mutation。发送结果不明确时不会盲目重发。远端摘要只用于发现与归属判断，不能当成远端 transport。

## 确认问题

### D1，P2：hosts 为同一 inventory 重复读取两遍，另加一个探测页

位置为 `src/core/chatgpt-desktop/facade.ts:272`、`:337`、`:360` 和 `src/core/chatgpt-desktop/app-server-fallback.ts:184`。活跃入口为 `listHostsOperation`，对应 CLI `hosts.tsx` 和 MCP `chatgpt_desktop_list_hosts.tsx`。

一次冷 `listHosts()` 先调用 `listThreads(limit:25)`，随后 `discoverModelProviders()` 扫描全部 inventory，最后 `#buildListSnapshot()` 再扫描相同 inventory。CDP sidebar 也先在 `:267` 读取，再在 snapshot builder 的 `:232` 读取。最末才得到用于最终 threadCount 的 snapshot，前面的局部 counts 大部分被覆盖。共享 `listCodexThreads()` 每次调用还会打开 session、initialize 并关闭，因此重复不只发生在数组遍历上。

隔离 fixture 有 50 个 thread，每页 25 条。一次 `listHosts()` 实际调用共享 `listCodexThreads` 5 次、CDP inventory 2 次，最终 local count 为 50。该数字是确定性调用计数，不是延迟 benchmark。一次共享 inventory 需要 2 个 app-server 页和 1 次 CDP 读取，足以同时导出 counts 与 provider IDs。真实延迟和节省秒数未测量。

最小结构修正是让 hosts 从同一份未按 provider 过滤的 inventory 得出 provider IDs、host counts 和来源状态，保留 managed connections 中零 thread 的 host，再删除单页探测及独立 provider 全扫描。保留部分来源失败时的 warnings 和 fallback counts，不应为了复用而把有用的失败信息删除。无需引入新缓存框架或第二套 inventory service。

### D2，P2：远端和 CDP 独有线程先截断显示字段，再进行搜索

位置为 `src/core/chatgpt-desktop/facade.ts:448`、`:454` 和 `:715` 的 `filtered.slice(...).map(compactThreadRow)`。活跃入口为 `searchThreadsOperation`，对应 CLI `search.tsx` 和 MCP `chatgpt_desktop_search_threads.tsx`。后者明确承诺搜索完整 thread metadata。

`#buildSearchSnapshot()` 把远端及 CDP rows 传给 `finalizeThreadList()`，该函数先把 title、preview 等字段压缩。之后 `threadMatchesQuery()` 才判断 query。app-server 已匹配的 rows 能通过 `appMatches` 保留，但 remote-only 和 CDP-only rows 没有这个通道。title 第 201 个字符以后的匹配词因此丢失，preview、project、hostName 的尾部也有同类问题。

fixture 的远端 title 为 250 个 `x` 加 ` unique-tail`。搜索 `unique-tail` 返回 0 条，搜索 `xxx` 返回 1 条，原始 title 确实包含 `unique-tail`。直接执行了真实 facade、finalize 和 compaction。现有 oversized title 搜索测试只执行 `appServerSearchThreads()`，因此覆盖不到这个组合错误。

最小修正是让合并和筛选阶段保留完整 metadata，完成 query 匹配后才压缩输出。压缩应由分页输出拥有，不能隐藏在供搜索复用的 merge helper 中。保留 app-server 已匹配集合，避免它的完整 metadata 在映射后消失而再次漏结果。增加 remote-only 与 CDP-only 长 title 的行为测试即可。

### D3，P2：正常空 inventory 被当成两个后端都不可达

位置为 `src/core/chatgpt-desktop/facade.ts:237`。活跃入口为 `listThreadsOperation`，也影响 `listHosts()` 的 merged count 获取。

app-server 正常返回空 `threads`，CDP 没启动，远端摘要也为空时，当前判断根据 `!appRows.length` 抛出 `CDP_UNREACHABLE`。前面已有 `appSucceeded=true`，但这里没有使用。用户第一次运行、切到尚无线程的 provider，或清空 inventory 后会得到错误状态，而不是正常空列表。

fixture 返回 `{threads:[], nextCursor:null}`，CDP fixture 抛 `CdpUnreachableError`。真实 facade 最终抛出 `CDP_UNREACHABLE`，消息为 `ChatGPT Desktop listThreads: CDP and app-server unreachable`，与成功的 app-server 调用矛盾。

最小修正是让失败判定检查 app-server 是否成功，不用记录条数代表可达性。保留部分分页成功后失败的 warning 语义。这个修正不需要新增状态字段，`appSucceeded` 已存在。回归测试使用空 app-server inventory 与不可达 CDP 即可。

### D4，P2：页面内首次去重提前丢弃 selected 和 pinned 行

位置为 `src/core/chatgpt-desktop/cdp-dom.ts:196`、`:200`。调用路径为 `listThreadsFromDom()`、CDP adapter 的 `listThreads()`、facade list/search/hosts。它还给 temporary-thread 打开检查与新线程 receipt 提供 sidebar 状态。

`LIST_THREADS_EXPRESSION` 在页面里用 thread ID 保留第一行，随后 Node 侧 `dedupeThreadsById()` 再用 selected、pinned 和 ID 形式评分。Recent 与 project 可同时列出同一 thread，代码自身对此已有专门 helper 和注释。若第一行未选中而第二行是 selected 或 pinned，后者已在页面表达式里消失，评分 helper 无法纠正。返回的 `selected:false` 可以与 Desktop 的选中状态不同。

fixture 用同 ID 的两行真实执行 `LIST_THREADS_EXPRESSION`，第一行 `selected=false,pinned=false`，第二行两者为 `true`，再调用真实 `listThreadsFromDom()`。输出只有一行，两个字段仍为 `false`。这证明处理重复行时丢失信息，但没有验证当前运行 Desktop 是否恰好渲染此顺序。

最小修正是删除页面表达式中的首次去重，让已有 `dedupeThreadsById()` 处理全部 rows。不要再引入第三个合并规则。增加表达式到 `listThreadsFromDom()` 的组合测试，不能继续只给 helper 传已经抽取好的 rows。

### D5，P2：MCP open 和 send 的 render 期限短于允许的操作等待

位置为 `src/mcp/grok-bot/tools/chatgpt_desktop_open_thread.tsx:17` 和 `src/mcp/grok-bot/tools/chatgpt_desktop_send.tsx:20`。输入范围位于 `src/core/chatgpt-desktop/routes.ts:73`、`:83`。活跃路径分别调用 `openThreadOperation()`、`sendOperation()`，最终进入 CDP adapter 的打开等待。

open 工具没有 `render`，使用 Agent Bundle 默认 60,000 ms，但 `openTimeoutMs` 默认 90,000 ms，最大 600,000 ms。一个在 70 秒正确打开的会话已经无法在框架期限内返回成功。send 工具声明 180,000 ms，却同样接受 600,000 ms 的打开等待。CLI send、MCP read 和 wait 已声明 660,000 ms，说明仓库已有一致的长等待配置办法。

检查已安装 `agent-bundle/dist/routes/public.d.ts:399` 可知 compiler、MCP、CLI 和 route-unit harness 会应用此 budget。实际 runtime `@agent-bundle/runtime/dist/302.js:360` 创建序列，并在 `:376` 的 `emit()` 检查同一期限，`dist/index.js:465` 还会在等待边界时执行 deadline race。隔离运行真实 `createAgentRenderEventSequence()` 并注入时钟，默认序列在 70,000 ms 抛 `elapsed-time-exceeded`，180,000 ms 序列在 190,000 ms 抛相同错误。`openThreadSchema` 的默认值和 `sendSchema` 对 600,000 ms 的接受也通过真实解析确认。没有等待真实分钟，也没有调用实际工具或发送消息。

最小修正是给 open 声明与现有长等待路由一致的 render budget，并把 send 的 budget 对齐，给连接和收尾留出时间。无需增加通用 timeout 包装器。可用注入时钟验证 route budget 与 schema 最大等待的一致性。宿主自己的 MCP timeout 属于另一边界，本次没有检查或修改。

## 可选结构改进

`remote-threads.ts` 和共享 `codex/remote-control.js` 都有 summary entry、host name、thread ID 的解析。Desktop 版本还识别 managed connections，而共享 lookup 版本的字段集合并不完全一致。`project-state.ts` 以及 Desktop 的 remote 列表、host 列表会反复读取并解析同一 global-state 文件。后续可由共享 Codex 层产出一次解析后的 state 数据，Desktop 只添加展示 metadata。先迁移 lookup 与 list 的调用方，再删除重复 parser。不能直接让 shared lookup 调用 Desktop 模块，这会倒置依赖。未测量磁盘读取成本，这项只作为所有权和维护改进。

`facade.ts` 的 list 与 search 分别实现 snapshot fingerprint、缓存淘汰和恢复，字段基本相同。优先修 D1、D2 后再看是否仍需提取共享收尾函数。分页顺序和来源合并是业务语义，不建议为了消除几段重复代码建立可配置 pipeline。

`mergeThreadLists()` 的 CDP-only 检查对每条 sidebar row 扫描已有 merged rows，并反复规范化 ID。已有 `Map` 用于另一个方向的查找，最终存在复用 key 集合的空间。CDP 读取当前最多 200 行，因此这里不作未测量的“热点”或阻断项。若实际 inventory 很大，可用已规范化 ID 的 `Set` 替换 `.some()`，无需改变 API。

`cdp-dom.ts` 当前将 DOM 表达式与操作 polling 放在一处。这是合理的外部协议边界。单纯按文件行数拆开不会减少调用概念。应先删除 D4 的重复逻辑，再考虑把纯 sidebar 提取和 merge policy 独立出来；没有证据支持大规模重写 adapter。

## 必须保留的防御与兼容

保留 loopback hostname、URL scheme、用户信息和 redirect 验证。CDP discovery 返回的 URL 属于外部输入，不能因为最初连接 127.0.0.1 就信任返回地址。HTTP body 的 abort、WebSocket pending command timeout 和 close reject 均防止无期限挂起。

保留 route 的串行队列。Desktop 只有一个当前选中会话和 composer，`Promise.all` 并行 send/open/wait 会互相切换目标。未来若把纯 app-server 读取分离，可单独讨论并发，不能直接删除目前的锁。

保留 project root、禁用按钮、真实 mouse event、空白页面与 project scope 验证。现有 tests 证明这些分支保护不向错误 project 或未切换页面发送。草稿检查和提交未知状态下不重试，直接保护 operator 内容及重复发送。

保留 small RPC pages、字节预算和 lossless continuation。RPC frame 限制与 MCP result 限制是两个不同边界，两层分页不是天然重复。`itemsView` 和 `turns/list` 兼容回退只针对明确的 RPC 错误码，也不应作为“过度防御”删除。

保留 temporary/durable ID 区分、打开后 conversation ID 核对、等待期间会话变更检测、最新 turn 与 final marker 核对。这些判断阻止错读、把旧回复当成新回复或返回无法后续使用的 ID。

保留已知远端归属的 typed error。远端摘要不是可读正文，不应通过猜测 SSH、app-server resume 或其他 transport 自动补救。读取时不用 `thread/resume` 的非附着行为也应保持。

注释检查只读，删除数量为 0。与外部 DOM、分页协议及安全语义对应的注释保留。没有为追求删除注释而建议去掉必要防御。`@deprecated appServerThreadIdCandidates` 在生产内部无直接调用，但作为 barrel 导出仍需先确认外部契约，不列为立即删除项。

## 验证命令与结果

执行以下命令定位源码、调用方和测试。

```sh
git rev-parse HEAD
wc -l src/core/chatgpt-desktop/*
rg --files src/core/chatgpt-desktop
rg -n 'chatgpt-desktop|ChatGPTDesktop|ChatgptDesktop' src test* package.json
rg -n '^(it|test|describe)\(' tests/route-unit/chatgpt-desktop*.test.ts
rg -n -uuu 'maxElapsedMs' node_modules/@agent-bundle/runtime node_modules/agent-bundle
node /private/tmp/gbot-desktop-architecture-audit/check.mjs
```

最后一条命令退出码为 0，断言及输出如下。该 fixture 留在本机临时目录，未写入仓库源码或测试。

```text
SEARCH_TAIL {"originalTitleMatches":true,"tailMatches":0,"prefixMatches":1}
SIDEBAR_DUPLICATE {"inputRows":2,"selectedRows":1,"outputRows":1,"selected":false,"pinned":false}
EMPTY_APP_INVENTORY {"appServerSucceeded":true,"exitError":"CDP_UNREACHABLE","message":"ChatGPT Desktop listThreads: CDP and app-server unreachable"}
HOST_SCAN_WORK {"threads":50,"actualListCodexThreadsCalls":5,"actualCdpInventoryCalls":2,"localCount":50,"minimalSharedInventoryCalls":2}
MCP_DEADLINES {"openDefaultWaitMs":90000,"openRuntimeBudgetMs":60000,"openAt70000ms":"elapsed-time-exceeded","acceptedSendWaitMs":600000,"sendRuntimeBudgetMs":180000,"sendAt190000ms":"elapsed-time-exceeded","realWaiting":false}
```

本次没有运行真实 Desktop 或线上服务，未检查真实耗时、真实 UI duplicate 排列或宿主取消是否中止后续 JavaScript 操作。没有给出延迟提升数字。建议先修 D2、D3、D4、D5 的行为，再以 D1 收敛 inventory 所有权；修复时需要保留上文列出的边界和回归行为。
