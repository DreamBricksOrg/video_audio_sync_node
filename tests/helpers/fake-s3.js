// Minimal S3-compatible HTTP server for tests (path-style: /<bucket>/<key>).
// Supports PUT (upload or copy via x-amz-copy-source), HEAD, GET and DELETE.
const http = require("node:http");

function startFakeS3() {
  const objects = new Map(); // "bucket/key" → { body, headers }

  const xmlEscape = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const path = decodeURIComponent(url.pathname.slice(1)).replace(/\/$/, "");

    // ListObjectsV2: GET /<bucket>?list-type=2&prefix=...
    if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = `${path}/${url.searchParams.get("prefix") || ""}`;
      const contents = [...objects]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, o]) => `<Contents><Key>${xmlEscape(k.slice(path.length + 1))}</Key>` +
          `<Size>${o.body.length}</Size><LastModified>${new Date().toISOString()}</LastModified></Contents>`)
        .join("");
      res.writeHead(200, { "Content-Type": "application/xml" });
      return res.end(`<?xml version="1.0"?><ListBucketResult><Name>${xmlEscape(path)}</Name>` +
        `<IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
    }
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      if (req.method === "PUT" && req.headers["x-amz-copy-source"]) {
        const src = decodeURIComponent(String(req.headers["x-amz-copy-source"]).replace(/^\//, ""));
        const obj = objects.get(src);
        if (!obj) { res.writeHead(404); return res.end(); }
        objects.set(path, { ...obj });
        res.writeHead(200, { "Content-Type": "application/xml" });
        return res.end('<?xml version="1.0"?><CopyObjectResult><ETag>"copy"</ETag></CopyObjectResult>');
      }
      if (req.method === "PUT") {
        objects.set(path, {
          body: Buffer.concat(chunks),
          contentType: req.headers["content-type"],
          cacheControl: req.headers["cache-control"],
        });
        res.writeHead(200, { ETag: '"put"' });
        return res.end();
      }
      const obj = objects.get(path);
      if (req.method === "DELETE") {
        objects.delete(path);
        res.writeHead(204);
        return res.end();
      }
      if (!obj) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Length": obj.body.length, "Content-Type": obj.contentType || "" });
      res.end(req.method === "HEAD" ? undefined : obj.body);
    });
  });

  return new Promise(resolve => {
    server.listen(0, () => {
      resolve({
        endpoint: `http://127.0.0.1:${server.address().port}`,
        objects,
        stop: () => server.close(),
      });
    });
  });
}

module.exports = { startFakeS3 };
