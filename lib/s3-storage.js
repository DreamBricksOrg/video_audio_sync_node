/**
 * Mirrors the media library (assets/) to an S3 bucket, so videos and audios can
 * be served from S3 or a CloudFront distribution (MEDIA_BASE_URL) instead of
 * this server. Keys are `<prefix>/<filename>`, same names as in assets/.
 *
 * Credentials come from the standard AWS sources (AWS_ACCESS_KEY_ID /
 * AWS_SECRET_ACCESS_KEY env vars, ~/.aws, or an IAM role). `endpoint` allows
 * S3-compatible storage (MinIO, Cloudflare R2) and local tests.
 */
const fs = require("fs");
const {
  S3Client, PutObjectCommand, DeleteObjectCommand, CopyObjectCommand, HeadObjectCommand, ListObjectsV2Command,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");

const httpStatus = err => (err && err.$metadata && err.$metadata.httpStatusCode) || 0;

// Short cache: a replaced file (same name) shows up within a minute, also via CloudFront
const DEFAULT_CACHE_CONTROL = "public, max-age=60";

function createS3Storage({
  bucket, region, prefix = "", endpoint, client,
  contentTypeFor = () => "application/octet-stream",
  cacheControl = DEFAULT_CACHE_CONTROL,
} = {}) {
  if (!bucket) return { enabled: false };

  const s3 = client || new S3Client({
    region: region || "us-east-1",
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    // Plain bodies (no streaming checksums) — works with S3 and S3-compatible stores
    requestChecksumCalculation: "WHEN_REQUIRED",
    maxAttempts: 3,
  });
  const base = String(prefix).replace(/^\/+|\/+$/g, "");
  const key = filename => (base ? `${base}/${filename}` : filename);
  const encodeKey = k => k.split("/").map(encodeURIComponent).join("/");

  async function upload(localPath, filename) {
    const { size } = fs.statSync(localPath);
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key(filename),
      Body: fs.createReadStream(localPath),
      ContentLength: size,
      ContentType: contentTypeFor(filename),
      CacheControl: cacheControl,
    }));
  }

  async function remove(filename) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key(filename) }));
  }

  // S3 has no rename: copy (keeps type/cache metadata) then delete the old key
  async function rename(oldName, newName) {
    await s3.send(new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${encodeKey(key(oldName))}`,
      Key: key(newName),
    }));
    await remove(oldName);
  }

  // True when the object is missing or has a different size
  async function needsUpload(filename, localSize) {
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key(filename) }));
      return Number(head.ContentLength) !== localSize;
    } catch (err) {
      if (err.name === "NotFound" || (err.$metadata && err.$metadata.httpStatusCode === 404)) return true;
      throw err;
    }
  }

  // Files directly under the prefix (needs s3:ListBucket on the bucket)
  async function list() {
    const items = [];
    const listPrefix = base ? `${base}/` : "";
    let token;
    do {
      const page = await s3.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: listPrefix, ContinuationToken: token,
      }));
      for (const obj of page.Contents || []) {
        const filename = obj.Key.slice(listPrefix.length);
        if (!filename || filename.includes("/")) continue; // skip "folders" and nested keys
        items.push({ filename, size: Number(obj.Size) || 0, modified: obj.LastModified || null });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return items;
  }

  // Small text objects (the campaigns config). Returns { body, etag }, null when
  // missing, or { notModified: true } when ifNoneMatch matches the current ETag.
  async function getText(filename, { ifNoneMatch } = {}) {
    try {
      const res = await s3.send(new GetObjectCommand({
        Bucket: bucket, Key: key(filename), ...(ifNoneMatch ? { IfNoneMatch: ifNoneMatch } : {}),
      }));
      return { body: await res.Body.transformToString(), etag: res.ETag };
    } catch (err) {
      if (httpStatus(err) === 304) return { notModified: true };
      if (err.name === "NoSuchKey" || httpStatus(err) === 404) return null;
      throw err;
    }
  }

  // Conditional write: ifMatch = only if unchanged since that ETag; ifNoneMatch "*"
  // = only if absent. A failed condition throws an error with code "PreconditionFailed".
  async function putText(filename, body, { ifMatch, ifNoneMatch, contentType = "application/json" } = {}) {
    try {
      const res = await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: key(filename), Body: body, ContentType: contentType, CacheControl: "no-cache",
        ...(ifMatch ? { IfMatch: ifMatch } : {}),
        ...(ifNoneMatch ? { IfNoneMatch: ifNoneMatch } : {}),
      }));
      return res.ETag;
    } catch (err) {
      if (httpStatus(err) === 412 || err.name === "PreconditionFailed") err.code = "PreconditionFailed";
      throw err;
    }
  }

  const describe = () => `s3://${bucket}/${base ? `${base}/` : ""}`;

  return { enabled: true, upload, remove, rename, needsUpload, list, getText, putText, describe };
}

module.exports = { createS3Storage };
