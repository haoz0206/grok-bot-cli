import { grokApprovalNotice } from "../src/core/grok-approvals.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  assertAllowedCredentialUrl,
  redactSecrets,
  resetPolicyWarnings,
} from "../src/core/url-policy.js";

// Unit tests run with GROK_BOT_TEST=1; production-policy
// cases opt out explicitly so the assertions below describe the real CLI.
function withEnv(values, fn) {
  values = { GROK_BOT_TEST: null, NODE_ENV: null, ...values };
  const prev = {};
  for (const key of Object.keys(values)) {
    prev[key] = process.env[key];
    const v = values[key];
    if (v == null) delete process.env[key];
    else process.env[key] = v;
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(values)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

test("allows https cursor.sh gateway hosts", () => {
  withEnv({ GROK_BOT_ALLOW_LOCAL_GATEWAY: null, GROK_BOT_ALLOW_ANY_GATEWAY: null }, () => {
    assert.equal(
      assertAllowedCredentialUrl("https://api2.cursor.sh"),
      "https://api2.cursor.sh",
    );
    assert.equal(
      assertAllowedCredentialUrl("https://box-abc.cursor.sh/"),
      "https://box-abc.cursor.sh",
    );
    assert.equal(
      assertAllowedCredentialUrl("https://agent.cursor.com"),
      "https://agent.cursor.com",
    );
    // The box gateway EnsureSandBox hands out lives on this family.
    assert.equal(
      assertAllowedCredentialUrl("https://145d7c6d03c7434e75f0-pod-abc-1340.us12.cursorvm.com/"),
      "https://145d7c6d03c7434e75f0-pod-abc-1340.us12.cursorvm.com",
    );
    assert.throws(() => assertAllowedCredentialUrl("https://cursorvm.com.evil.example"), /Rejected gateway URL host/i);
  });
});

test("backend URLs reject cursorvm and loopback", () => {
  withEnv({ GROK_BOT_ALLOW_LOCAL_GATEWAY: "1", GROK_BOT_ALLOW_ANY_GATEWAY: null }, () => {
    assert.equal(
      assertAllowedCredentialUrl("https://api2.cursor.sh", { kind: "backend" }),
      "https://api2.cursor.sh",
    );
    assert.throws(
      () =>
        assertAllowedCredentialUrl("https://145d7c6d03c7434e75f0-pod-abc-1340.us12.cursorvm.com", {
          kind: "backend",
        }),
      /Rejected backend URL host/i,
    );
    assert.throws(
      () => assertAllowedCredentialUrl("http://127.0.0.1:1340", { kind: "backend" }),
      /EnsureSandBox backends must be https/i,
    );
  });
});

test("rejects http and non-cursor hosts by default", () => {
  withEnv({ GROK_BOT_ALLOW_LOCAL_GATEWAY: null, GROK_BOT_ALLOW_ANY_GATEWAY: null }, () => {
    assert.throws(() => assertAllowedCredentialUrl("http://api2.cursor.sh"), /only https/i);
    assert.throws(() => assertAllowedCredentialUrl("https://evil.example"), /Rejected gateway URL host/i);
    assert.throws(() => assertAllowedCredentialUrl("https://127.0.0.1:1340"), /GROK_BOT_ALLOW_LOCAL_GATEWAY/i);
    assert.throws(() => assertAllowedCredentialUrl("https://0.0.0.0:1340"), /Rejected gateway URL host/i);
  });
});

test("allows local gateways when opted in", () => {
  resetPolicyWarnings();
  withEnv({ GROK_BOT_ALLOW_LOCAL_GATEWAY: "1", GROK_BOT_ALLOW_ANY_GATEWAY: null }, () => {
    assert.equal(
      assertAllowedCredentialUrl("http://127.0.0.1:1340"),
      "http://127.0.0.1:1340",
    );
    assert.equal(
      assertAllowedCredentialUrl("http://localhost:1340/"),
      "http://localhost:1340",
    );
  });
});

test("ALLOW_ANY_GATEWAY bypasses host checks", () => {
  resetPolicyWarnings();
  withEnv({ GROK_BOT_ALLOW_ANY_GATEWAY: "true", GROK_BOT_ALLOW_LOCAL_GATEWAY: null }, () => {
    assert.equal(
      assertAllowedCredentialUrl("https://evil.example/path"),
      "https://evil.example/path",
    );
  });
});

test("test mode allows only loopback, for gateway and backend, and ignores escape hatches", () => {
  for (const env of [{ GROK_BOT_TEST: "1" }, { NODE_ENV: "test" }]) {
    withEnv({ GROK_BOT_ALLOW_ANY_GATEWAY: "1", GROK_BOT_ALLOW_LOCAL_GATEWAY: null, ...env }, () => {
      assert.equal(assertAllowedCredentialUrl("http://127.0.0.1:1340/"), "http://127.0.0.1:1340");
      assert.equal(assertAllowedCredentialUrl("http://localhost:1340", { kind: "backend" }), "http://localhost:1340");
      assert.throws(() => assertAllowedCredentialUrl("https://box.cursor.sh"), {
        message: 'Rejected gateway URL host "box.cursor.sh": test mode (GROK_BOT_TEST / NODE_ENV=test) only allows http(s) loopback gateways.',
      });
      assert.throws(() => assertAllowedCredentialUrl("https://api2.cursor.sh", { kind: "backend" }), {
        message: 'Rejected backend URL host "api2.cursor.sh": test mode (GROK_BOT_TEST / NODE_ENV=test) only allows http(s) loopback gateways.',
      });
      assert.throws(() => assertAllowedCredentialUrl("https://evil.example"), /^Error: Rejected gateway URL host "evil.example": test mode/);
      assert.throws(() => assertAllowedCredentialUrl("ws://127.0.0.1:1340"), /^Error: Rejected gateway URL host "127.0.0.1": test mode/);
    });
  }
});

test("redacts bearer, basic, cookie, and token-like fields", () => {
  const out = redactSecrets(
    'EnsureSandBox failed: 401 {"gatewayToken":"supersecret","x-anyrun-network-token":"route"} ' +
      "Bearer abc.def-ghi+= authorization: Basic YWJjMTIz Cookie: sid=keepsecret Set-Cookie: a=b",
  );
  assert.match(out, /Bearer <redacted>/);
  assert.match(out, /gatewayToken":"<redacted>/);
  assert.match(out, /authorization: <redacted>/i);
  assert.match(out, /Cookie: <redacted>/i);
  assert.match(out, /Set-Cookie: <redacted>/i);
  assert.doesNotMatch(out, /supersecret/);
  assert.doesNotMatch(out, /abc\.def-ghi/);
  assert.doesNotMatch(out, /YWJjMTIz/);
  assert.doesNotMatch(out, /keepsecret/);
});

test("redacts quoted authorization fields with scheme credentials", () => {
  const jsonRedacted = redactSecrets('{"authorization":"Basic SECRET_TOKEN"}');
  assert.doesNotThrow(() => JSON.parse(jsonRedacted));
  assert.doesNotMatch(jsonRedacted, /SECRET_TOKEN/);
  assert.equal(redactSecrets(jsonRedacted), jsonRedacted);

  const shellRedacted = redactSecrets("{'proxy-authorization': 'Basic SECRET_TOKEN'}");
  assert.doesNotMatch(shellRedacted, /SECRET_TOKEN/);
  assert.equal(redactSecrets(shellRedacted), shellRedacted);
});

test("redacts quoted shell authorization headers and multiline values", () => {
  const inputs = [
    "'Authorization: Basic SECRET_TOKEN'",
    `curl -H 'Proxy-Authorization: Basic SECRET_TOKEN' --verbose`,
    `'authorization': 'Basic SECRET
TOKEN'`,
  ];
  for (const input of inputs) {
    const redacted = redactSecrets(input);
    assert.doesNotMatch(redacted, /SECRET_TOKEN|SECRET|TOKEN/);
    assert.equal(redactSecrets(redacted), redacted);
  }
});

test("does not swallow diagnostics after an incomplete quoted authorization value", () => {
  const inputs = [
    [`'authorization': 'Basic SECRET
Status: 'failed'`, /Status: 'failed'/],
    [`'authorization': 'Basic SECRET
Status: failed
Next: 'keep'`, /Status: failed\nNext: 'keep'/],
  ];
  for (const [input, preserved] of inputs) {
    const redacted = redactSecrets(input);
    assert.doesNotMatch(redacted, /SECRET/);
    assert.match(redacted, preserved);
    assert.equal(redactSecrets(redacted), redacted);
  }
});

test("redacts field-shaped continuation inside a quoted authorization value", () => {
  const input = `'authorization': 'Basic FIRST
X-Thing: SECOND_SECRET'`;
  const redacted = redactSecrets(input);
  assert.doesNotMatch(redacted, /FIRST|SECOND_SECRET/);
  assert.equal(redactSecrets(redacted), redacted);
});

test("redaction removes every cookie value and preserves following diagnostics", () => {
  const inputs = [
    "Cookie: sid=FIRST_FAKE; refresh=SECOND_FAKE; login=THIRD_FAKE",
    'Cookie: sid="FIRST_FAKE"; refresh=SECOND_FAKE',
    "Cookie: sid=FIRST_FAKE; refresh=SECOND_FAKE\nStatus: failed",
    "Cookie: sid=FIRST_FAKE; refresh=SECOND_FAKE Authorization: Basic THIRD_FAKE\nStatus: failed",
    JSON.stringify({ cookie: "sid=FIRST_FAKE; refresh=SECOND_FAKE", status: "failed" }),
    "curl -H 'Cookie: sid=FIRST_FAKE; refresh=SECOND_FAKE' --verbose",
    'Set-Cookie: sid=FIRST_FAKE; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/\nStatus: failed',
  ];
  for (const input of inputs) {
    const redacted = redactSecrets(input);
    assert.doesNotMatch(redacted, /FIRST_FAKE|SECOND_FAKE|THIRD_FAKE/);
    assert.equal(redactSecrets(redacted), redacted);
    if (input.includes("Status: failed")) assert.match(redacted, /Status: failed/);
    if (input.includes("--verbose")) assert.match(redacted, /--verbose/);
    if (input.includes('"status"')) assert.match(redacted, /"status":"failed"/);
  }
});

for (const name of ["authorization", "proxy-authorization", "cookie", "set-cookie"]) {
  test(`cookie named ${name} does not end header redaction`, () => {
    const input = `Cookie: sid=FIRST_FAKE; ${name}=SECOND_FAKE; third=THIRD_FAKE; fourth=FOURTH_FAKE`;
    const redacted = redactSecrets(input);
    assert.doesNotMatch(redacted, /FIRST_FAKE|SECOND_FAKE|THIRD_FAKE|FOURTH_FAKE/);
    assert.equal(redactSecrets(redacted), redacted);
  });
}


for (const command of [
  String.raw`curl -H 'Cookie: sid=FIRST_FAKE'\''TAIL; refresh=SECOND_FAKE' --verbose`,
  String.raw`curl -H 'Cookie: sid=FIRST_FAKE'"'"'TAIL; refresh=SECOND_FAKE' --verbose`,
  String.raw`curl -H 'Cookie: sid=FIRST_FAKE''TAIL; refresh=SECOND_FAKE' --verbose`,
  String.raw`curl -H "Cookie: sid=FIRST_FAKE"'TAIL; refresh=SECOND_FAKE' --verbose`,
]) {
  test(`redacts the complete concatenated cookie argument in ${command}`, () => {
    const redacted = redactSecrets(command);
    assert.doesNotMatch(redacted, /FIRST_FAKE|TAIL|SECOND_FAKE/);
    assert.match(redacted, /^curl -H /);
    assert.match(redacted, / --verbose$/);
    assert.equal(redactSecrets(redacted), redacted);
    const notice = grokApprovalNotice({
      id: "card", kind: "send-message", message: {
        type: "auto-review-approval", approval: { requestId: "approval", status: "pending", command },
      },
    }, "fixture-bot");
    assert.doesNotMatch(notice, /FIRST_FAKE|TAIL|SECOND_FAKE/);
    assert.match(notice, /--verbose/);
  });
}

for (const diagnostic of [
  { message: "Cookie: sid=FIRST_FAKE; refresh=SECOND_FAKE", status: "failed" },
  { message: "Failure Cookie: sid=FIRST_FAKE; refresh=SECOND_FAKE", status: "failed" },
  ["Cookie: sid=FIRST_FAKE; refresh=SECOND_FAKE", "Status: failed"],
  { rows: [["Cookie: sid=FIRST_FAKE; refresh=SECOND_FAKE", "Status: failed"]], status: "failed" },
  { message: "Cookie: sid=FIRST_FAKE", other: "Set-Cookie: refresh=SECOND_FAKE", status: "failed" },
]) {
  test(`quoted diagnostic boundaries preserve ${JSON.stringify(diagnostic)}`, () => {
    const input = JSON.stringify(diagnostic);
    const output = redactSecrets(input);
    assert.doesNotMatch(output, /FIRST_FAKE|SECOND_FAKE/);
    assert.equal(redactSecrets(output), output);
    assert.match(output, /failed/);
    assert.doesNotThrow(() => JSON.parse(output));
    const notice = grokApprovalNotice({ id: "card", kind: "send-message", message: {
      type: "auto-review-approval", approval: { requestId: "approval", status: "pending", summary: input },
    } }, "fixture-bot");
    assert.doesNotMatch(notice, /FIRST_FAKE|SECOND_FAKE/);
    assert.match(notice, /failed/);
  });
}

for (const quote of ["'", '"']) {
  test(`unterminated ${quote} cookie header redacts the rest of its line`, () => {
    const input = `${quote}Cookie:${" ".repeat(8000)}FIRST_FAKE; refresh=SECOND_FAKE\nStatus: failed`;
    const output = redactSecrets(input);
    assert.doesNotMatch(output, /FIRST_FAKE|SECOND_FAKE/);
    assert.match(output, /Status: failed/);
    assert.equal(redactSecrets(output), output);
    const notice = grokApprovalNotice({ id: "card", kind: "send-message", message: {
      type: "auto-review-approval", approval: { requestId: "approval", status: "pending", command: input },
    } }, "fixture-bot");
    assert.doesNotMatch(notice, /FIRST_FAKE|SECOND_FAKE/);
    assert.match(notice, /Status: failed/);
  });
}
