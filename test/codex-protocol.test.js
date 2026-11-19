import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeFrame,
  encodeFrame,
  websocketAccept,
} from "../src/core/codex-bridge.js";

test("encodeFrame masks a client text frame per RFC 6455", () => {
  const frame = encodeFrame(
    0x1,
    Buffer.from("Hello"),
    Buffer.from([0x37, 0xfa, 0x21, 0x3d]),
  );
  assert.equal(frame.toString("hex"), "818537fa213d7f9f4d5158");
  const back = decodeFrame(frame);
  assert.equal(back.payload.toString(), "Hello");
  assert.equal(back.rest.length, 0);
});

test("websocketAccept and frame headers match the RFC 6455 vectors", () => {
  assert.equal(
    websocketAccept("dGhlIHNhbXBsZSBub25jZQ=="),
    "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
  );
  assert.equal(
    encodeFrame(0x1, Buffer.alloc(125)).subarray(0, 2).toString("hex"),
    "817d",
  );
  assert.equal(
    encodeFrame(0x1, Buffer.alloc(126)).subarray(0, 4).toString("hex"),
    "817e007e",
  );
  assert.equal(
    encodeFrame(0x1, Buffer.alloc(65536)).subarray(0, 10).toString("hex"),
    "817f0000000000010000",
  );
  assert.equal(decodeFrame(encodeFrame(0x1, Buffer.alloc(65536))).payload.length, 65536);
});

test("decodeFrame waits for a complete frame and returns the remainder", () => {
  const two = Buffer.concat([
    encodeFrame(0x1, Buffer.from("a")),
    encodeFrame(0x1, Buffer.from("bc")),
  ]);
  assert.equal(decodeFrame(two.subarray(0, 2)), null);
  const first = decodeFrame(two);
  assert.equal(first.payload.toString(), "a");
  assert.equal(decodeFrame(first.rest).payload.toString(), "bc");
});
