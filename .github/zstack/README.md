# main 分支的 zstack 唤醒

`refs/heads/main` 每次推进时，`.github/workflows/zstack-main-push.yml` 向 Grok Bot webhook 发送一次 JSON。正文恰好是 `repository`、`ref`、`sha`。这个 workflow 不检出仓库，`permissions: {}`，也不调用 Changesets 或 `npm run release`。

接收 routine 将由 zstack 创建为 `grok-bot-cli-main-sync`。不要把本仓库指到其他仓库的 routine。

在本仓库 Settings → Secrets and variables → Actions 配置下面两个 repository secret。不要从其他仓库读取或复制 secret 值。secret 缺失时作业失败。

- `ZSTACK_WEBHOOK_URL`
- `ZSTACK_WEBHOOK_KEY`

URL 形状为 `https://api2.cursor.sh/automations/webhook/<id>`。URL 可以出现在聊天里。不要把 sender key 写进聊天、日志或仓库。

发送协议与已验证的实现相同：`Authorization: Bearer` 和 `X-Automation-Key` 两个头，POST 一次，超时 8 秒，不重试，不跟随重定向。只有 HTTP 200 算接受；这不表示同步已经完成。

离线测试不访问网络上的 webhook：

```bash
python3 .github/zstack/test_notify_zstack.py
```

本次改动没有读取 secret，也没有向真实 webhook 发请求。
