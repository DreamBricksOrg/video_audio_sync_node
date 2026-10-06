// Public URL of a media file: the local /media route, or the CDN/bucket when
// MEDIA_BASE_URL is set (S3 bucket URL or a CloudFront distribution in front of it).
function createMediaUrl(baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return function mediaUrl(filename) {
    if (!filename) return null;
    const name = encodeURIComponent(filename);
    return base ? `${base}/${name}` : `/media/${name}`;
  };
}

// Public base URL of a bucket when MEDIA_BASE_URL isn't set (S3-only mode)
function defaultS3BaseUrl({ bucket, region, prefix, endpoint }) {
  const p = String(prefix || "").replace(/^\/+|\/+$/g, "");
  const root = endpoint
    ? `${String(endpoint).replace(/\/+$/, "")}/${bucket}`              // S3-compatible, path style
    : `https://${bucket}.s3.${region || "us-east-1"}.amazonaws.com`;   // AWS
  return p ? `${root}/${p}` : root;
}

module.exports = { createMediaUrl, defaultS3BaseUrl };
