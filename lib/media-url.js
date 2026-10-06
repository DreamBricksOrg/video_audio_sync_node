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

module.exports = { createMediaUrl };
