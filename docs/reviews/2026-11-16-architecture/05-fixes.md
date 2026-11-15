# opt 分支修复结果

本次工作修复[基线审查](00-summary.md)中的 20 项主要发现，并删除重复读取和无用途计算。保留现有 CLI、MCP 和共享 core 分层，没有引入通用后端框架、额外哈希或新的缓存层。

## 实现对应关系

| 审查项 | 实现 |
| --- | --- |
| Core-C1 | 公共脱敏函数处理完整 cookie header、内部引号和 JSON/shell 引用。下一 header 必须使用冒号，避免把名为 authorization 的 cookie 当成分隔符。 |
| Core-C2 | Grok 列表、thread、九个 roster 修改回执和 manual send 的人类可读文本清理终端控制字符。正文换行保留，JSON 和历史数据保持原值。 |
| Core-C3 | content 数组的元素在 join 前使用已有安全字符串转换。 |
| Core-C4 | 仅修改 notify/hidden 时跳过 profile RPC，保留其他调用方对 profile 的修改。 |
| Core-C5 | 写路径只把 ENOENT 当成缺少 settings，损坏或无法读取的旧文件阻止覆盖。只读列表保留原有容错。 |
| Core-C6 | JSON 写入同目录独占临时文件，完成后 rename。保留有效符号链接、目标文件 mode/uid/gid，失败时保留旧数据。 |
| Relay-C1 | refusal 历史只属于现有 one-shot 模式，长期连接继续限制真正未决的请求。 |
| Relay-C2 | conversation 按自己观察到的 request ID 接收 resolved 通知，不接收其他会话的无归属通知。 |
| Relay-C3 | conversation、history 与 binding 持久化使用现有 thread ID normalizer 的返回值。 |
| Relay-C4 | shell 路径使用安全字面量，plist 使用 XML 转义。环境覆盖与原有 fallback 行为保留。 |
| Relay-C5 | 卸载只处理可识别的生成文件及仍指向该 wrapper 的 GUI 设置。保留修改过的文件、符号链接、CODEX_HOME 和 WebSocket 设置。 |
| Desktop-D1 | hosts 从同一 snapshot 取得 provider 与 thread counts，删除独立 provider 扫描。按单个 RPC 页读取，已有结果不会被后续页失败丢弃。 |
| Desktop-D2 | 完整 metadata 参与合并与搜索，在分页输出时才压缩。 |
| Desktop-D3 | 用 app-server 的成功状态判断可达性，正常空列表不再报不可达。 |
| Desktop-D4 | 删除 DOM 表达式中的首次去重，由已有评分规则选择 selected/pinned 行。 |
| Desktop-D5 | MCP open/send 使用现有 660,000 ms render budget，覆盖允许的打开等待。 |
| Surface-S1 | 先预留所有 metadata，再分配正文预算。保留条目、原始 count/cursor 与正文截断标记。 |
| Surface-S2 | unknown 投递显示 Delivery unknown，并提示查看 thread 后再决定是否重发，保持既有 exit code。 |
| Surface-S3 | 默认小回执在正文构造前返回。 |
| Surface-S4 | history 测试仅在子进程 fixture 中隔离 CODEX_THREAD_ID，产品来源前缀行为不变。 |

## 精简结果与取舍

文件组成员操作共用一次 records 快照。创建、set、add、remove 的回归检查都只发生一次目录扫描。gateway 的 add/remove 也复用已有 roster，避免第二次 list RPC。同成员组复用、组大小和禁止嵌套等规则保持。

Desktop 的 50 条线程样本从 5 次分页 RPC、2 次 CDP inventory 变为 2 次 RPC、1 次 CDP inventory。snapshot 每次请求 25 条，最多 3,200 次，保留原来的 80,000 条名义上限。第二页失败时保留第一批 25 条并返回来源 warning，不新增重试层。这些是确定性调用计数，没有测量真实延迟或宣称提速百分比。

Codex transport 保留原模块，仅限制 one-shot 状态的生命周期。shim 删除未使用的 helper 和重复 stat，使用同一生成模板识别当前及上一个引用格式，不使用 checksum manifest。持久消息去重、账户身份和分页一致性已有的哈希仍有作用，本次未删除它们。

原子替换只保证单文件在完成写入前不覆盖旧内容，不是多文件事务或并发编辑锁。有效符号链接保留，悬空链接拒绝更新。未承诺 ACL、xattr、硬链接关系或断电后的持久性。

## 验证记录

在隔离工作树使用 `npm ci` 安装依赖，最终 `npm run check` 通过：源定义验证、构建、产物验证、TypeScript 检查、604 个 Node 测试和 110 个 route 测试全部通过。打包后的 npm tarball 安装到临时 prefix，`gbot`、`grok-bot`、`gbot-install` 的 `--help` 均正常运行，未修改本机正式安装。

首次组合检查出现一次 relay 并发启动超时；同一测试单独重跑通过，后续完整检查通过。没有放宽超时或修改启动逻辑来掩盖失败。

基线反例先验证失败，再运行修复后的行为检查。新增回归放在相应模块测试中。独立审阅发现了同名 cookie、POSIX 引号拼接，以及中间修复造成的 JSON 诊断字段丢失和未闭合引号回溯问题。最终用 JSON 值、shell 参数和普通 header 各自的边界处理，24 个定向 URL/approval 检查及独立反例复核通过。合成输入检查覆盖到 128k 字符；这不是生产负载的吞吐承诺。

独立正确性和可维护性审阅通过，删除三处重复说明代码行为的注释。决策记录审阅指出应明确保留已有发布文档的提交边界，已补记。本次提交包含修复、回归、审查结果和 patch Changeset；不包含此前未提交的发布指南、README、AGENTS 和发布文档 Changeset。

## 保留的后续事项

- Core-C7 的共享 refresh 取消归属尚未修改，内置路径没有稳定触发证据。
- Core-C8 的 408/499 供应商语义仍待确认，未改变投递分类，也未加入自动重发。
- relay 慢 history 对控制队列的实际影响尚未测量，未为了理论时限之和加入并发调度。
- 旧 relay records 与 binding 的保留期需要单独定义，未清除用于重复抑制的持久 ID。

本次没有访问真实 Desktop/CDP、生产网关或远端主机，没有发送真实消息、修改安装、推送或发布。验证使用临时文件、合成凭据、fake runner 与本机假服务器。
