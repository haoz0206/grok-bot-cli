import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);

test("built CLI preserves manual/no-history sends and truthful server Bot receipts", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "gbot-backend-cli-"));
  let scenario, sends, nonce;
  const received = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    received.push(req.url);
    res.setHeader("content-type", "application/json");
    switch (req.url) {
      case "/aiserver.v1.GrokBotService/EnsureSandBox":
        res.end(JSON.stringify({ gatewayUrl: `http://127.0.0.1:${server.address().port}`, gatewayToken: "fixture-gateway" }));
        break;
      case "/api/listAgents":
        res.end(JSON.stringify({ agents: [{ id: "fixture-bot", name: "Momo" }] }));
        break;
      case "/aiserver.v1.GrokBotService/SendGrokBotUserMessage":
        sends++;
        nonce = body.messageId;
        assert.equal(body.text, "hello");
        assert.equal(body.agentId, "fixture-bot");
        assert.equal(req.headers.authorization, "Bearer fixture-access");
        if (scenario === "disconnect") { req.socket.destroy(); break; }
        res.end(JSON.stringify(scenario === "refused"
          ? { delivery: 4, refusal: { message: "fixture rejection" } }
          : { delivery: "GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL" }));
        break;
      case "/api/getAgentTranscriptTail":
        res.end(JSON.stringify({ entries: scenario === "unknown" ? [] : [{ id: "echo-fixture", clientNonce: nonce }] }));
        break;
      default:
        res.statusCode = 409;
        res.end(JSON.stringify({ message: "This Bot runs on the server" }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, APPDATA: home,
    GROK_BOT_TEST: "1", CODEX_THREAD_ID: "", CURSOR_ACCESS_TOKEN: "fixture-access",
    CURSOR_API_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    GROK_BOT_GATEWAY_URL: "", GROK_BOT_GATEWAY_TOKEN: "", GROK_BOT_GATEWAY_HEADERS: "",
    GROK_BOT_HISTORY: "on", GROK_BOT_HISTORY_DIR: join(home, "history"), SAND_CLIENT_VERSION: "1.1.0",
  };
  for (const [mode, delivery, code] of [["accepted", "accepted", 0], ["unknown", "unknown", 0], ["refused", "rejected", 1], ["disconnect", "unknown", 1]]) {
    await t.test(mode, async () => {
      scenario = mode;
      sends = 0;
      received.length = 0;
      const args = ["dist/bin/gbot.mjs", "send", "--gateway", "--reply-mode", "manual", "--no-history", "--json", "--", "fixture-bot", "hello"];
      let result;
      try { result = { ...await exec(process.execPath, args, { env, timeout: 15000 }), code: 0 }; }
      catch (error) { result = error; }
      assert.equal(result.code, code, result.stderr);
      const out = JSON.parse(result.stdout);
      assert.equal(out.delivery, delivery);
      assert.equal(out.messageId, mode === "accepted" ? "echo-fixture" : undefined);
      assert.equal(sends, 1);
      assert.equal(received.includes("/api/sendPrompt"), false);
      assert.equal(existsSync(join(home, "history/history.jsonl")), false);
      assert.equal(existsSync(join(home, ".grok-bot-cli/relay")), false);
    });
  }
});
