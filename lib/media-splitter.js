/**
 * Media splitter — turns one video-with-audio file into:
 *   <name>_video.<ext>  video only (stream copied, no quality loss, fast)
 *   <name>_audio.mp3    audio only (MP3, aligned to the video's timeline)
 *
 * Uses the system ffmpeg/ffprobe (override with FFMPEG_PATH / FFPROBE_PATH).
 * Built to be called from the upload route later:
 *
 *   const { splitMedia } = require("./lib/media-splitter");
 *   const { video, audio } = await splitMedia("assets/promo.mp4", { outDir: "assets" });
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

// Output container per input extension
const VIDEO_CONTAINERS = { ".mp4": ".mp4", ".m4v": ".mp4", ".mov": ".mp4", ".webm": ".webm", ".mkv": ".mp4" };
const INPUT_EXTS = Object.keys(VIDEO_CONTAINERS);

// Codecs browsers play in each container; anything else is re-encoded to H.264/MP4
const PLAYABLE_CODECS = { ".mp4": ["h264", "av1"], ".webm": ["vp8", "vp9", "av1"] };

// "web" option: smaller H.264 for sites — CRF 28, ~2.5 Mbps cap, longer side ≤ 1920px
const WEB_VIDEO_ARGS = [
  "-c:v", "libx264", "-preset", "medium", "-crf", "28",
  "-maxrate", "2500k", "-bufsize", "5000k", "-pix_fmt", "yuv420p",
  "-vf", "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))'",
];

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", d => (stdout += d));
    proc.stderr.on("data", d => (stderr += d));
    proc.on("error", err => {
      reject(err.code === "ENOENT"
        ? new Error(`${cmd} não encontrado. Instale o ffmpeg ou defina FFMPEG_PATH/FFPROBE_PATH.`)
        : err);
    });
    proc.on("close", code => {
      if (code === 0) return resolve({ stdout, stderr });
      // ffmpeg's real error is at the end of stderr
      const tail = stderr.trim().split("\n").slice(-4).join("\n");
      reject(new Error(`${path.basename(cmd)} falhou (código ${code}):\n${tail}`));
    });
  });
}

/** Stream info for a media file: { duration, video: {codec, width, height} | null, audio: {codec} | null } */
async function probe(inputPath) {
  const { stdout } = await run(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,codec_name,width,height",
    "-of", "json",
    inputPath,
  ]);
  const info = JSON.parse(stdout);
  const streams = info.streams || [];
  const v = streams.find(s => s.codec_type === "video");
  const a = streams.find(s => s.codec_type === "audio");
  return {
    duration: parseFloat(info.format && info.format.duration) || null,
    video: v ? { codec: v.codec_name, width: v.width, height: v.height } : null,
    audio: a ? { codec: a.codec_name } : null,
  };
}

/**
 * Splits `inputPath` into a video-only file and an MP3.
 *
 * Options:
 *   outDir        where to write (default: same folder as the input)
 *   baseName      output name prefix (default: input name without extension)
 *   overwrite     replace existing outputs (default: false → throws if they exist)
 *   audioQuality  LAME VBR quality 0 (best) – 9 (smallest), default 2 (~190 kbps)
 *   web           re-encode the video small for websites (default: false)
 *
 * Returns { video, audio, duration, input } with absolute paths.
 */
async function splitMedia(inputPath, options = {}) {
  const input = path.resolve(inputPath);
  if (!fs.existsSync(input)) throw new Error(`Arquivo não encontrado: ${inputPath}`);

  const ext = path.extname(input).toLowerCase();
  if (!VIDEO_CONTAINERS[ext]) {
    throw new Error(`Formato não suportado (${ext || "sem extensão"}). Use: ${INPUT_EXTS.join(", ")}`);
  }

  const info = await probe(input);
  if (!info.video) throw new Error("O arquivo não tem faixa de vídeo.");
  if (!info.audio) throw new Error("O arquivo não tem faixa de áudio para separar.");

  // Copy the video when the browser can play it as-is, otherwise re-encode
  let outExt = VIDEO_CONTAINERS[ext];
  const web = !!options.web;
  const transcode = web || !PLAYABLE_CODECS[outExt].includes(info.video.codec);
  if (transcode) outExt = ".mp4";

  const outDir = path.resolve(options.outDir || path.dirname(input));
  const baseName = options.baseName || path.basename(input, path.extname(input));
  const videoOut = path.join(outDir, `${baseName}_video${outExt}`);
  const audioOut = path.join(outDir, `${baseName}_audio.mp3`);
  const quality = Number.isInteger(options.audioQuality) ? options.audioQuality : 2;

  for (const out of [videoOut, audioOut]) {
    if (out === input) throw new Error(`A saída teria o mesmo nome da entrada: ${out}`);
    if (fs.existsSync(out) && !options.overwrite) {
      throw new Error(`Já existe: ${out} (use overwrite para substituir)`);
    }
  }
  fs.mkdirSync(outDir, { recursive: true });

  // Write to temp names and rename at the end, so a failure never leaves half files
  const tmpVideo = path.join(outDir, `.split-${Date.now()}-${path.basename(videoOut)}`);
  const tmpAudio = path.join(outDir, `.split-${Date.now()}-${path.basename(audioOut)}`);

  try {
    // Video: drop audio; copy the stream, or re-encode to H.264 if the codec
    // isn't browser-playable. faststart lets the totem start playing before
    // the whole file is downloaded.
    await run(FFMPEG, [
      "-hide_banner", "-y", "-i", input,
      "-map", "0:v:0", "-an",
      ...(web
        ? WEB_VIDEO_ARGS
        : transcode
          ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]
          : ["-c:v", "copy"]),
      ...(outExt === ".mp4" ? ["-movflags", "+faststart"] : []),
      tmpVideo,
    ]);

    // Audio: first audio track → MP3. aresample pads/trims so audio time 0 ==
    // video time 0 (needed: phones sync to the totem's video position).
    await run(FFMPEG, [
      "-hide_banner", "-y", "-i", input,
      "-map", "0:a:0", "-vn",
      "-af", "aresample=async=1:first_pts=0",
      "-c:a", "libmp3lame", "-q:a", String(quality),
      "-f", "mp3",
      tmpAudio,
    ]);

    fs.renameSync(tmpVideo, videoOut);
    fs.renameSync(tmpAudio, audioOut);
  } catch (err) {
    fs.rmSync(tmpVideo, { force: true });
    fs.rmSync(tmpAudio, { force: true });
    throw err;
  }

  return { input, video: videoOut, audio: audioOut, duration: info.duration, transcoded: transcode, web };
}

module.exports = { splitMedia, probe, INPUT_EXTS };
