const { test } = require("node:test");
const assert = require("node:assert/strict");
const { hashPassword, verifyPassword } = require("../lib/passwords");

test("hash and verify", async () => {
  const stored = await hashPassword("correct horse battery");
  assert.match(stored, /^scrypt\$\d+\$\d+\$\d+\$[\w-]+\$[\w-]+$/);
  assert.equal(await verifyPassword("correct horse battery", stored), true);
  assert.equal(await verifyPassword("wrong", stored), false);
});

test("the same password hashes differently each time (salt)", async () => {
  assert.notEqual(await hashPassword("abc12345"), await hashPassword("abc12345"));
});

test("garbage stored values never verify", async () => {
  assert.equal(await verifyPassword("x", ""), false);
  assert.equal(await verifyPassword("x", "plain-text"), false);
  assert.equal(await verifyPassword("x", "scrypt$1$1$1$$"), false);
});
