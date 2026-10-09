// DoP (DSD over PCM) codec.
//
// A DSD bit stream cannot be handed to WASAPI directly, so it is packed the way
// the DoP v1.0 spec describes: every 24-bit PCM frame carries 16 DSD bits in
// its two low bytes plus an alternating marker (0x05 / 0xFA) in the top byte.
// A DSD-aware DAC recognises the marker pattern and plays the payload as native
// DSD instead of passing it through its PCM path.
//
// The packed stream is written as a plain 24-bit WAV so mpv keeps normal
// progress, seeking and gapless handling. The file is deleted as soon as
// playback moves on.
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const DOP_MARKERS = [0x05, 0xfa];
const DSD_SAMPLE_RATES = new Map([
  [2_822_400, { tier: "DSD64", dopRate: 176_400 }],
  [5_644_800, { tier: "DSD128", dopRate: 352_800 }],
  [11_289_600, { tier: "DSD256", dopRate: 705_600 }],
  [22_579_200, { tier: "DSD512", dopRate: 1_411_200 }],
]);

const BIT_REVERSE = (() => {
  const table = new Uint8Array(256);
  for (let value = 0; value < 256; value += 1) {
    let reversed = 0;
    for (let bit = 0; bit < 8; bit += 1) reversed = (reversed << 1) | ((value >> bit) & 1);
    table[value] = reversed;
  }
  return table;
})();

function isDsdPath(filePath) {
  const extension = path.extname(String(filePath || "")).toLowerCase();
  return extension === ".dsf" || extension === ".dff";
}

/** DSD tier + the PCM rate DoP needs for it (DSD rate / 16). */
function describeDop(layout) {
  if (!layout || layout.channels !== 2) return null;
  const info = DSD_SAMPLE_RATES.get(layout.sampleRate);
  if (!info) return null;
  return { ...info, channels: layout.channels, sampleRate: layout.sampleRate };
}

/**
 * Container header of a DSF or DSDIFF file: rate, channels and where the raw
 * 1-bit payload begins. This is the "is it really DSD, and can DoP carry it"
 * check performed before a track starts.
 */
async function readDsdLayout(filePath) {
  let handle;
  try {
    handle = await fsp.open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const head = Buffer.alloc(65_536);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    if (bytesRead < 16) return null;
    const magic = head.subarray(0, 4).toString("latin1");

    if (magic === "DSD ") {
      if (bytesRead < 80 || head.subarray(28, 32).toString("latin1") !== "fmt ") return null;
      const channels = head.readUInt32LE(52) || 2;
      const sampleRate = head.readUInt32LE(56);
      const sampleCount = Number(head.readBigUInt64LE(64));
      const blockSize = head.readUInt32LE(72) || 4096;
      const dataIdOffset = head.indexOf("data", 80, "latin1");
      if (dataIdOffset < 0 || dataIdOffset + 12 > bytesRead) return null;
      const dataBytes = Number(head.readBigUInt64LE(dataIdOffset + 4));
      if (!sampleRate || !dataBytes) return null;
      return {
        container: "dsf",
        channels,
        sampleRate,
        blockSize,
        dataOffset: dataIdOffset + 12,
        dataBytes,
        // DSF packs bits least-significant-first and interleaves whole blocks
        // of blockSize bytes per channel.
        lsbFirst: true,
        blockInterleaved: true,
        sampleCount: Number.isFinite(sampleCount) ? sampleCount : null,
      };
    }

    if (magic === "FRM8") {
      let offset = 16;
      let sampleRate = 0;
      let channels = 0;
      let dataOffset = 0;
      let dataBytes = 0;
      while (offset + 12 <= bytesRead) {
        const id = head.subarray(offset, offset + 4).toString("latin1");
        const size = Number(head.readBigUInt64BE(offset + 4));
        if (!Number.isFinite(size) || size < 0) break;
        if (id === "PROP") {
          let cursor = offset + 16; // skip the "SND " form type
          const end = Math.min(offset + 12 + size, bytesRead);
          while (cursor + 12 <= end) {
            const subId = head.subarray(cursor, cursor + 4).toString("latin1");
            const subSize = Number(head.readBigUInt64BE(cursor + 4));
            if (subId === "FS  " && cursor + 16 <= bytesRead) sampleRate = head.readUInt32BE(cursor + 12);
            if (subId === "CHNL" && cursor + 14 <= bytesRead) channels = head.readUInt16BE(cursor + 12);
            if (!Number.isFinite(subSize) || subSize < 0) break;
            cursor += 12 + subSize + (subSize % 2);
          }
        } else if (id === "DSD ") {
          dataOffset = offset + 12;
          dataBytes = size;
        }
        offset += 12 + size + (size % 2);
      }
      if (!sampleRate || !channels || !dataOffset || !dataBytes) return null;
      return {
        container: "dff",
        channels,
        sampleRate,
        blockSize: 0,
        dataOffset,
        dataBytes,
        // DSDIFF packs bits most-significant-first, one byte per channel,
        // channel-interleaved.
        lsbFirst: false,
        blockInterleaved: false,
        sampleCount: null,
      };
    }

    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function buildWavHeader(dataBytes, { channels = 2, sampleRate, bitsPerSample = 24 } = {}) {
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/** One 24-bit DoP frame: 16 DSD bits in the low bytes, marker on top. */
function writeDopFrame(target, at, first, second, lsbFirst, marker) {
  const high = lsbFirst ? BIT_REVERSE[first] : first;
  const low = lsbFirst ? BIT_REVERSE[second] : second;
  const payload = (high << 8) | low;
  target[at] = payload & 0xff;
  target[at + 1] = (payload >> 8) & 0xff;
  target[at + 2] = marker;
}

/**
 * Packs the raw DSD payload of `layout` into a 24-bit DoP WAV at `targetPath`.
 * Resolves with the number of PCM frames written.
 */
async function encodeDopWav(sourcePath, layout, targetPath, onProgress) {
  const dop = describeDop(layout);
  if (!dop) throw new Error("unsupported DSD layout for DoP");
  const channels = layout.channels;
  const framesPerSourceFrame = channels * 2;
  const totalFrames = Math.floor(layout.dataBytes / framesPerSourceFrame);
  const dataBytes = totalFrames * channels * 3;
  if (dataBytes + 44 > 0xffff_ffff) throw new Error("DoP stream exceeds the WAV 4 GiB limit");

  const source = await fsp.open(sourcePath, "r");
  const target = await fsp.open(targetPath, "w");
  let frameIndex = 0;
  let writtenFrames = 0;
  try {
    await target.write(buildWavHeader(dataBytes, { channels, sampleRate: dop.dopRate }));

    if (layout.blockInterleaved) {
      // DSF: walk whole blocks; each block holds blockSize bytes per channel.
      const blockBytes = layout.blockSize || 4096;
      const regionBytes = blockBytes * channels;
      const totalBlocks = Math.ceil(layout.dataBytes / regionBytes);
      const region = Buffer.alloc(regionBytes);
      const pack = Buffer.alloc(Math.floor(blockBytes / 2) * channels * 3);
      for (let block = 0; block < totalBlocks; block += 1) {
        const { bytesRead } = await source.read(region, 0, regionBytes, layout.dataOffset + block * regionBytes);
        if (bytesRead < framesPerSourceFrame) break;
        const frames = Math.min(Math.floor(bytesRead / channels / 2), Math.floor(blockBytes / 2), totalFrames - writtenFrames);
        if (frames <= 0) break;
        let cursor = 0;
        for (let frame = 0; frame < frames; frame += 1) {
          for (let channel = 0; channel < channels; channel += 1) {
            const base = channel * blockBytes + frame * 2;
            writeDopFrame(pack, cursor, region[base], region[base + 1], layout.lsbFirst, DOP_MARKERS[frameIndex++ & 1]);
            cursor += 3;
          }
        }
        await target.write(pack.subarray(0, cursor));
        writtenFrames += frames;
        if (onProgress && block % 64 === 0) onProgress(writtenFrames / totalFrames);
        if (writtenFrames >= totalFrames) break;
      }
    } else {
      // DSDIFF: bytes are channel-interleaved, so a frame needs two bytes per
      // channel with a stride of `channels`.
      const chunkBytes = 1 << 20;
      const aligned = chunkBytes - (chunkBytes % framesPerSourceFrame);
      const buffer = Buffer.alloc(aligned);
      const pack = Buffer.alloc((aligned / framesPerSourceFrame) * channels * 3);
      let position = layout.dataOffset;
      const end = layout.dataOffset + layout.dataBytes;
      while (position < end && writtenFrames < totalFrames) {
        const want = Math.min(aligned, end - position);
        const { bytesRead } = await source.read(buffer, 0, want, position);
        if (bytesRead < framesPerSourceFrame) break;
        const frames = Math.min(Math.floor(bytesRead / framesPerSourceFrame), totalFrames - writtenFrames);
        let cursor = 0;
        for (let frame = 0; frame < frames; frame += 1) {
          for (let channel = 0; channel < channels; channel += 1) {
            // Bytes are interleaved one sample per channel: the two DSD bytes
            // of a frame sit `channels` bytes apart.
            const first = frame * 2 * channels + channel;
            const second = first + channels;
            writeDopFrame(pack, cursor, buffer[first], buffer[second], layout.lsbFirst, DOP_MARKERS[frameIndex++ & 1]);
            cursor += 3;
          }
        }
        await target.write(pack.subarray(0, cursor));
        writtenFrames += frames;
        position += bytesRead;
        if (onProgress) onProgress(writtenFrames / totalFrames);
      }
    }
  } finally {
    await source.close().catch(() => undefined);
    await target.close().catch(() => undefined);
  }
  return writtenFrames;
}

/** Where prepared DoP streams live; wiped between sessions. */
function dopCacheDir() {
  return path.join(os.tmpdir(), "aria-dop");
}

async function ensureDopCacheDir() {
  await fsp.mkdir(dopCacheDir(), { recursive: true });
  return dopCacheDir();
}

module.exports = {
  DSD_SAMPLE_RATES,
  buildWavHeader,
  describeDop,
  dopCacheDir,
  encodeDopWav,
  ensureDopCacheDir,
  isDsdPath,
  readDsdLayout,
};
