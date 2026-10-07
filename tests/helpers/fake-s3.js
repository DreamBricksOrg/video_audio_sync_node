// Minimal S3-compatible HTTP server for tests (path-style: /<bucket>/<key>).
// Supports PUT (upload, or copy via x-amz-copy-source), HEAD, GET, DELETE,
// ListObjectsV2, ETags and conditional requests (If-Match / If-None-Match).
const http = require("node:http");
const crypto = require("node:crypto");

const etagOf = body => `"${crypto.createHash("md5").update(body).digest("hex")}"`;

// `cors: false` = bucket without CORS rules (browsers can't upload directly)
function startFakeS3({ cors = true } = {}) {
  const objects = new Map(); // "bucket/key" → { body, contentType, cacheControl }

  const xmlEscape = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const xmlError = (res, status, code) => {
    res.writeHead(status, { "Content-Type": "application/xml" });
    res.end(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const path = decodeURIComponent(url.pathname.slice(1)).replace(/\/$/, "");

    // Browser uploads with presigned URLs (bucket CORS allows the admin page)
    if (cors) res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") {
      if (!cors) { res.writeHead(403); return res.end(); }
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "PUT",
        "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "",
      });
      return res.end();
    }
    // Presigned URL past its X-Amz-Expires → refused, like S3
    const signedAt = url.searchParams.get("X-Amz-Date");
    if (signedAt) {
      const t = Date.parse(signedAt.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"));
      if (Date.now() > t + Number(url.searchParams.get("X-Amz-Expires")) * 1000) return xmlError(res, 403, "AccessDenied");
    }

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
      const existing = objects.get(path);
      const ifMatch = req.headers["if-match"];
      const ifNoneMatch = req.headers["if-none-match"];

      if (req.method === "PUT" && req.headers["x-amz-copy-source"]) {
        const src = decodeURIComponent(String(req.headers["x-amz-copy-source"]).replace(/^\//, ""));
        const obj = objects.get(src);
        if (!obj) return xmlError(res, 404, "NoSuchKey");
        objects.set(path, { ...obj });
        res.writeHead(200, { "Content-Type": "application/xml" });
        return res.end(`<?xml version="1.0"?><CopyObjectResult><ETag>${etagOf(obj.body)}</ETag></CopyObjectResult>`);
      }
      if (req.method === "PUT") {
        // Conditional writes, like S3: If-None-Match "*" = only if absent; If-Match = only if unchanged
        if (ifNoneMatch === "*" && existing) return xmlError(res, 412, "PreconditionFailed");
        if (ifMatch && (!existing || etagOf(existing.body) !== ifMatch)) return xmlError(res, 412, "PreconditionFailed");
        const body = Buffer.concat(chunks);
        objects.set(path, {
          body,
          contentType: req.headers["content-type"],
          cacheControl: req.headers["cache-control"],
        });
        res.writeHead(200, { ETag: etagOf(body) });
        return res.end();
      }
      if (req.method === "DELETE") {
        objects.delete(path);
        res.writeHead(204);
        return res.end();
      }
      if (!existing) return xmlError(res, 404, "NoSuchKey");
      const etag = etagOf(existing.body);
      if (ifNoneMatch && ifNoneMatch === etag) {
        res.writeHead(304, { ETag: etag });
        return res.end();
      }
      res.writeHead(200, { "Content-Length": existing.body.length, "Content-Type": existing.contentType || "", ETag: etag });
      res.end(req.method === "HEAD" ? undefined : existing.body);
    });
  });

  return new Promise(resolve => {
    server.listen(0, () => {
      resolve({
        endpoint: `http://127.0.0.1:${server.address().port}`,
        objects,
        // Drops keep-alive connections too, so clients see S3 as down right away
        stop: () => {
          server.close();
          server.closeAllConnections();
        },
      });
    });
  });
}

module.exports = { startFakeS3 };
