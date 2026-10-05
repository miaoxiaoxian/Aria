import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parseFile } from "music-metadata";
import { quantizeBitrate } from "./utils/bitrate";
import type { ScannedTrack } from "./types";

const execFileAsync = promisify(execFile);

const audioExtensions = new Set([
  ".mp3",
  ".flac",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
  ".opus",
  ".ape",
  // DSD sources. Chromium cannot decode DSD, so these are always played
  // through the native engine, which decodes them to PCM (DSD64 -> 352.8 kHz).
  ".dsf",
  ".dff",
]);

const dsdExtensions = new Set([".dsf", ".dff"]);

/** DSD64/128/256/512 share the 44.1 kHz family base rate of 2.8224 MHz. */
const dsdSampleRateLabels = new Map<number, string>([
  [2_822_400, "DSD64"],
  [5_644_800, "DSD128"],
  [11_289_600, "DSD256"],
  [22_579_200, "DSD512"],
]);

const cdExtensions = new Set([".cda"]);

export type CdDrive = {
  drive: string;
  label: string;
};

export type CdReadQuality = "high" | "low";

export type ScanProgress = {
  phase: "discovering" | "metadata" | "complete";
  processed: number;
  total: number;
};

export async function scanMusicFolder(root: string, onProgress?: (progress: ScanProgress) => void): Promise<ScannedTrack[]> {
  const resolvedRoot = path.resolve(root);
  onProgress?.({ phase: "discovering", processed: 0, total: 0 });
  const files = await collectAudioFiles(resolvedRoot);
  onProgress?.({ phase: "metadata", processed: 0, total: files.length });
  let processed = 0;
  const tracks = await mapWithConcurrency(files, 6, async (file) => {
    const track = await readTrackMetadata(file, resolvedRoot);
    processed += 1;
    onProgress?.({ phase: "metadata", processed, total: files.length });
    return track;
  });

  const result = tracks.filter((track): track is ScannedTrack => Boolean(track)).sort(compareTracksForAlbum);
  onProgress?.({ phase: "complete", processed: files.length, total: files.length });
  return result;
}

export async function listCdDrives(): Promise<CdDrive[]> {
  if (process.platform !== "win32") return [];

  try {
    const command =
      "Get-CimInstance Win32_CDROMDrive | Select-Object Drive,Name,MediaLoaded | ConvertTo-Json -Compress";
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], {
      windowsHide: true,
      timeout: 5000,
    });
    const parsed = JSON.parse(stdout.trim() || "[]") as
      | Array<{ Drive?: string; Name?: string; MediaLoaded?: boolean }>
      | { Drive?: string; Name?: string; MediaLoaded?: boolean };
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items
      .filter((item) => typeof item.Drive === "string" && item.Drive)
      .map((item) => ({
        drive: `${String(item.Drive).replace(/\\$/, "")}\\`,
        label: String(item.Name || item.Drive || "Audio CD"),
      }));
  } catch {
    return [];
  }
}

export async function scanCdDrives(qualityMode: CdReadQuality = "high"): Promise<{ drives: CdDrive[]; tracks: ScannedTrack[] }> {
  const drives = await listCdDrives();
  const nested = await Promise.all(drives.map((drive) => scanCdDrive(drive, qualityMode)));
  const tracks = nested.flat().sort(compareTracksForAlbum);
  return { drives, tracks };
}

async function scanCdDrive(drive: CdDrive, qualityMode: CdReadQuality): Promise<ScannedTrack[]> {
  try {
    const entries = await readdir(drive.drive, { withFileTypes: true });
    const cdaFiles = entries
      .filter((entry) => entry.isFile() && cdExtensions.has(path.extname(entry.name).toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));

    return cdaFiles.map((entry, index) => {
      const absolute = path.join(drive.drive, entry.name);
      const trackNumber = parseTrackNumber(entry.name) ?? index + 1;
      const highQuality = qualityMode === "high";
      return {
        id: createHash("sha1").update(`cd:${drive.drive}:${entry.name}`).digest("hex"),
        path: absolute,
        title: `Track ${String(trackNumber).padStart(2, "0")}`,
        artist: "Audio CD",
        album: drive.label || "Audio CD",
        albumArtist: "Audio CD",
        duration: null,
        quality: highQuality ? "Lossless" : "320K",
        format: highQuality ? "CDDA" : "CDDA Low",
        size: 0,
        bitrate: highQuality ? 1_411_200 : 705_600,
        sampleRate: highQuality ? 44_100 : 22_050,
        bpm: null,
        hasCover: false,
        trackNumber,
        discNumber: 1,
        libraryRoot: `cd:${drive.drive}`,
        mediaKind: "audio-cd",
        streamUrl: absolute,
        nativeDevice: drive.drive,
        nativeStart: `#${trackNumber}`,
        nativeEnd: trackNumber < cdaFiles.length ? `#${trackNumber + 1}` : null,
        cdReadQuality: qualityMode,
        requiresNativePlayback: true,
      };
    });
  } catch {
    return [];
  }
}

async function collectAudioFiles(dir: string): Promise<string[]> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) return collectAudioFiles(absolute);
      if (entry.isFile() && audioExtensions.has(path.extname(entry.name).toLowerCase())) {
        return [absolute];
      }
      return [];
    }),
  );

  return nested.flat();
}

type DsdHeader = { sampleRate: number; channels: number; durationSeconds: number | null };

/**
 * Minimal DSF / DSDIFF (DFF) header reader. DSD files stay indexable and
 * playable even when the tag parser cannot read them, so the essential numbers
 * (rate, channels, length) come straight from the container header.
 */
export async function readDsdHeader(filePath: string): Promise<DsdHeader | null> {
  const handle = await open(filePath, "r");
  try {
    const head = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    if (bytesRead < 16) return null;
    const magic = head.subarray(0, 4).toString("latin1");

    if (magic === "DSD ") {
      // DSF: the fmt chunk holds channels, sample rate and the bit count.
      if (bytesRead < 80 || head.subarray(28, 32).toString("latin1") !== "fmt ") return null;
      const channels = head.readUInt32LE(52) || 2;
      const sampleRate = head.readUInt32LE(56);
      const sampleCount = Number(head.readBigUInt64LE(64));
      if (!sampleRate) return null;
      return {
        channels,
        sampleRate,
        durationSeconds: Number.isFinite(sampleCount) && sampleCount > 0 ? sampleCount / sampleRate : null,
      };
    }

    if (magic === "FRM8") {
      // DSDIFF: FRM8 <size> "DSD " then the chunks, so the walk starts at 16.
      let offset = 16;
      let sampleRate = 0;
      let channels = 0;
      let dataBytes = 0;
      while (offset + 12 <= bytesRead) {
        const id = head.subarray(offset, offset + 4).toString("latin1");
        const size = Number(head.readBigUInt64BE(offset + 4));
        if (!Number.isFinite(size) || size < 0) break;
        if (id === "PROP") {
          let propOffset = offset + 16; // skip the "SND " form type, not a chunk
          const propEnd = Math.min(offset + 12 + size, bytesRead);
          while (propOffset + 12 <= propEnd) {
            const subId = head.subarray(propOffset, propOffset + 4).toString("latin1");
            const subSize = Number(head.readBigUInt64BE(propOffset + 4));
            if (subId === "FS  " && propOffset + 16 <= bytesRead) sampleRate = head.readUInt32BE(propOffset + 12);
            if (subId === "CHNL" && propOffset + 14 <= bytesRead) channels = head.readUInt16BE(propOffset + 12);
            if (!Number.isFinite(subSize) || subSize < 0) break;
            propOffset += 12 + subSize + (subSize % 2); // chunks are even-padded
          }
        } else if (id === "DSD ") {
          dataBytes = size;
        }
        offset += 12 + size + (size % 2);
      }
      if (!sampleRate || !channels) return null;
      return {
        channels,
        sampleRate,
        durationSeconds: dataBytes > 0 ? (dataBytes * 8) / (channels * sampleRate) : null,
      };
    }

    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readTrackMetadata(filePath: string, libraryRoot: string): Promise<ScannedTrack | null> {
  const extension = path.extname(filePath).toLowerCase();
  const dsdByExtension = dsdExtensions.has(extension);
  let parsed: Awaited<ReturnType<typeof parseFile>> | null = null;
  let fileSize = 0;

  try {
    const [metadata, fileStat] = await Promise.all([parseFile(filePath), stat(filePath)]);
    parsed = metadata;
    fileSize = fileStat.size;
  } catch {
    if (!dsdByExtension) return null;
    try {
      fileSize = (await stat(filePath)).size;
    } catch {
      return null;
    }
  }

  const dsdHeader = dsdByExtension ? await readDsdHeader(filePath).catch(() => null) : null;
  const common = parsed?.common;
  const format = parsed?.format;
  const filename = path.basename(filePath, extension);
  const sampleRate = typeof format?.sampleRate === "number" ? format.sampleRate : dsdHeader?.sampleRate ?? null;
  const isDsd = dsdByExtension || (sampleRate != null && dsdSampleRateLabels.has(sampleRate));
  const parsedDuration = typeof format?.duration === "number" && format.duration > 0 ? format.duration : null;

  return {
    id: createHash("sha1").update(filePath).digest("hex"),
    path: filePath,
    title: common?.title || filename,
    artist: common?.artist || common?.albumartist || "Unknown Artist",
    album: common?.album || "Unknown Album",
    albumArtist: common?.albumartist || common?.artist || null,
    duration: parsedDuration ?? dsdHeader?.durationSeconds ?? null,
    quality: detectQuality(filePath, {
      bitsPerSample: format?.bitsPerSample,
      bitrate: format?.bitrate,
      lossless: format?.lossless,
      sampleRate: format?.sampleRate,
    }),
    format: isDsd ? "DSD" : format?.container || extension.slice(1).toUpperCase(),
    size: fileSize,
    // A DSD "bitrate" (11 Mbps for DSD128) is meaningless next to PCM numbers;
    // the UI shows the DSD64/128/256 label instead.
    bitrate: isDsd ? null : typeof format?.bitrate === "number" ? quantizeBitrate(format.bitrate) : null,
    sampleRate,
    bpm: null,
    hasCover: Boolean(common?.picture?.length),
    trackNumber: typeof common?.track?.no === "number" ? common.track.no : null,
    discNumber: typeof common?.disk?.no === "number" ? common.disk.no : null,
    libraryRoot,
    mediaKind: "file",
    streamUrl: null,
    nativeDevice: null,
    nativeStart: null,
    nativeEnd: null,
    // DSD must be decoded by mpv; the renderer's <audio> element cannot.
    requiresNativePlayback: isDsd,
  };
}

function parseTrackNumber(name: string) {
  const match = name.match(/(\d+)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function compareTracksForAlbum(a: ScannedTrack, b: ScannedTrack) {
  const albumCompare = `${a.albumArtist || a.artist} ${a.album}`.localeCompare(
    `${b.albumArtist || b.artist} ${b.album}`,
    "zh-CN",
  );
  if (albumCompare !== 0) return albumCompare;
  const discCompare = (a.discNumber ?? 0) - (b.discNumber ?? 0);
  if (discCompare !== 0) return discCompare;
  const trackCompare = (a.trackNumber ?? 9999) - (b.trackNumber ?? 9999);
  if (trackCompare !== 0) return trackCompare;
  return a.title.localeCompare(b.title, "zh-CN");
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

function detectQuality(
  filePath: string,
  format: { bitsPerSample?: number; bitrate?: number; lossless?: boolean; sampleRate?: number },
) {
  const extension = path.extname(filePath).toLowerCase();
  if ((format.bitsPerSample && format.bitsPerSample >= 24) || (format.sampleRate && format.sampleRate >= 88_200)) {
    return "Hi-Res";
  }
  if (format.lossless || extension === ".flac" || extension === ".wav" || extension === ".ape") return "Lossless";
  if (format.bitrate && format.bitrate >= 900_000) return "Lossless";
  if (format.bitrate && format.bitrate >= 256_000) return "320K";
  return "320K";
}
