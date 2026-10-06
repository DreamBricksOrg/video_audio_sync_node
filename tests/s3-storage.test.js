const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createS3Storage } = require("../lib/s3-storage");

// Records every command sent; HeadObject answers from `objects`
function fakeClient(objects = {}) {
  const sent = [];
  return {
    sent,
    async send(cmd) {
      const name = cmd.constructor.name;
      const input = { ...cmd.input };
      if (input.Body && typeof input.Body.pipe === "function") {
        const chunks = [];
        for await (const c of input.Body) chunks.push(c);
        input.Body = Buffer.concat(chunks).toString();
      }
      sent.push({ name, input });
      if (name === "HeadObjectCommand") {
        if (!(input.Key in objects)) {
          const err = new Error("NotFound");
          err.name = "NotFound";
          err.$metadata = { httpStatusCode: 404 };
          throw err;
        }
        return { ContentLength: objects[input.Key] };
      }
      return {};
    },
  };
}

function withFile(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s3s-"));
  const file = path.join(dir, "promo.mp3");
  fs.writeFileSync(file, content);
  return Promise.resolve(fn(file)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test("disabled without a bucket", () => {
  assert.equal(createS3Storage({}).enabled, false);
  assert.equal(createS3Storage({ bucket: "b", client: fakeClient() }).enabled, true);
});

test("upload streams the file with type, length and cache headers under the prefix", async () => {
  const client = fakeClient();
  const storage = createS3Storage({ bucket: "midia", prefix: "audiosync/", client, contentTypeFor: () => "audio/mpeg" });
  await withFile("hello", file => storage.upload(file, "promo.mp3"));
  const [put] = client.sent;
  assert.equal(put.name, "PutObjectCommand");
  assert.equal(put.input.Bucket, "midia");
  assert.equal(put.input.Key, "audiosync/promo.mp3");
  assert.equal(put.input.Body, "hello");
  assert.equal(put.input.ContentLength, 5);
  assert.equal(put.input.ContentType, "audio/mpeg");
  assert.equal(put.input.CacheControl, "public, max-age=60");
});

test("rename copies then deletes the old key", async () => {
  const client = fakeClient();
  const storage = createS3Storage({ bucket: "midia", prefix: "a/b", client });
  await storage.rename("old name.mp4", "new.mp4");
  assert.deepEqual(client.sent.map(c => c.name), ["CopyObjectCommand", "DeleteObjectCommand"]);
  assert.equal(client.sent[0].input.CopySource, "midia/a/b/old%20name.mp4");
  assert.equal(client.sent[0].input.Key, "a/b/new.mp4");
  assert.equal(client.sent[1].input.Key, "a/b/old name.mp4");
});

test("remove deletes the key", async () => {
  const client = fakeClient();
  await createS3Storage({ bucket: "midia", client }).remove("x.mp3");
  assert.deepEqual(client.sent, [{ name: "DeleteObjectCommand", input: { Bucket: "midia", Key: "x.mp3" } }]);
});

test("needsUpload compares the remote size and treats 404 as missing", async () => {
  const storage = createS3Storage({ bucket: "midia", client: fakeClient({ "same.mp3": 10, "diff.mp3": 3 }) });
  assert.equal(await storage.needsUpload("same.mp3", 10), false);
  assert.equal(await storage.needsUpload("diff.mp3", 10), true);
  assert.equal(await storage.needsUpload("missing.mp3", 10), true);
});

test("list pages through the prefix and returns direct children only", async () => {
  const pages = [
    { Contents: [{ Key: "audiosync/a.mp4", Size: 10, LastModified: new Date(1) }, { Key: "audiosync/sub/x.mp3", Size: 1 }], IsTruncated: true, NextContinuationToken: "t2" },
    { Contents: [{ Key: "audiosync/b.mp3", Size: 3, LastModified: new Date(2) }], IsTruncated: false },
  ];
  const sent = [];
  const client = { async send(cmd) { sent.push(cmd.input); return pages[sent.length - 1]; } };
  const items = await createS3Storage({ bucket: "midia", prefix: "audiosync", client }).list();
  assert.deepEqual(items.map(i => [i.filename, i.size]), [["a.mp4", 10], ["b.mp3", 3]]);
  assert.equal(sent[0].Prefix, "audiosync/");
  assert.equal(sent[1].ContinuationToken, "t2");
});

test("describe shows where files go", () => {
  const storage = createS3Storage({ bucket: "midia", prefix: "audiosync", client: fakeClient() });
  assert.equal(storage.describe(), "s3://midia/audiosync/");
});
