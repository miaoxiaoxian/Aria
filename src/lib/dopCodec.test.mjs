// Bit-level checks for the DoP packer. A mistake here is audible as noise on a
// DSD DAC, so the container layouts and the marker/payload bytes are asserted
// against known patterns rather than "it produced a file".
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import codec from "../../electron/dopCodec.cjs";

const FRAMES = 32;
const BLOCK_SIZE = 4096;
const MARKERS = [0x05, 0xfa];

const left = Buffer.alloc(BLOCK_SIZE);
const right = Buffer.alloc(BLOCK_SIZE);
for (let index = 0; index < FRAMES * 2; index += 1) {
  left[index] = index;
  right[index] = 0xff - index;
}

const reverseBits = (value) => {
  let reversed = 0;
  for (let bit = 0; bit < 8; bit += 1) reversed = (reversed << 1) | ((value >> bit) & 1);
  return reversed;
};

function u64be(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

function writeDsf(file) {
  const data = Buffer.concat([left, right]);
  const total = 28 + 52 + 12 + data.length;
  const buffer = Buffer.alloc(total);
  buffer.write("DSD ", 0, "latin1");
  buffer.writeBigUInt64LE(BigInt(28), 4);
  buffer.writeBigUInt64LE(BigInt(total), 12);
  buffer.write("fmt ", 28, "latin1");
  buffer.writeBigUInt64LE(BigInt(52), 32);
  buffer.writeUInt32LE(1, 40);
  buffer.writeUInt32LE(0, 44);
  buffer.writeUInt32LE(2, 48);
  buffer.writeUInt32LE(2, 52);
  buffer.writeUInt32LE(2_822_400, 56);
  buffer.writeUInt32LE(1, 60);
  buffer.writeBigUInt64LE(BigInt(FRAMES * 16), 64);
  buffer.writeUInt32LE(BLOCK_SIZE, 72);
  buffer.writeUInt32LE(0, 76);
  buffer.write("data", 80, "latin1");
  buffer.writeBigUInt64LE(BigInt(12 + data.length), 84);
  data.copy(buffer, 92);
  writeFileSync(file, buffer);
}

function writeDff(file) {
  const data = Buffer.alloc(FRAMES * 4);
  for (let frame = 0; frame < FRAMES; frame += 1) {
    data[frame * 4] = left[frame * 2];
    data[frame * 4 + 1] = right[frame * 2];
    data[frame * 4 + 2] = left[frame * 2 + 1];
    data[frame * 4 + 3] = right[frame * 2 + 1];
  }
  const rate = Buffer.alloc(4);
  rate.writeUInt32BE(2_822_400);
  const fsChunk = Buffer.concat([Buffer.from("FS  ", "latin1"), u64be(4), rate]);
  const channelCount = Buffer.alloc(2);
  channelCount.writeUInt16BE(2);
  const chnlPayload = Buffer.concat([channelCount, Buffer.from("SLFTSRGT", "latin1")]);
  const chnlChunk = Buffer.concat([Buffer.from("CHNL", "latin1"), u64be(chnlPayload.length), chnlPayload]);
  const propPayload = Buffer.concat([Buffer.from("SND ", "latin1"), fsChunk, chnlChunk]);
  const propChunk = Buffer.concat([Buffer.from("PROP", "latin1"), u64be(propPayload.length), propPayload]);
  const version = Buffer.alloc(4);
  version.writeUInt32BE(0x0105_0000);
  const fver = Buffer.concat([Buffer.from("FVER", "latin1"), u64be(4), version]);
  const dsdChunk = Buffer.concat([Buffer.from("DSD ", "latin1"), u64be(data.length), data]);
  const body = Buffer.concat([Buffer.from("DSD ", "latin1"), fver, propChunk, dsdChunk]);
  writeFileSync(file, Buffer.concat([Buffer.from("FRM8", "latin1"), u64be(body.length), body]));
}

describe("DoP codec", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aria-dop-test-"));

  it("packs a DSF payload (block interleaved, LSB first) with correct channels", async () => {
    const source = path.join(dir, "probe.dsf");
    const target = path.join(dir, "probe-dsf.wav");
    writeDsf(source);

    const layout = await codec.readDsdLayout(source);
    expect(layout).toMatchObject({ container: "dsf", channels: 2, sampleRate: 2_822_400, lsbFirst: true });
    const dop = codec.describeDop(layout);
    expect(dop).toMatchObject({ tier: "DSD64", dopRate: 176_400 });

    const frames = await codec.encodeDopWav(source, layout, target);
    expect(frames).toBe(Math.floor((BLOCK_SIZE * 2) / 4));

    const wav = readFileSync(target);
    expect(wav.readUInt32LE(24)).toBe(176_400);
    expect(wav.readUInt16LE(34)).toBe(24);
    for (let frame = 0; frame < FRAMES; frame += 1) {
      for (let channel = 0; channel < 2; channel += 1) {
        const at = 44 + (frame * 2 + channel) * 3;
        const sourceBytes = channel === 0 ? left : right;
        const expected = (reverseBits(sourceBytes[frame * 2]) << 8) | reverseBits(sourceBytes[frame * 2 + 1]);
        expect(wav[at] | (wav[at + 1] << 8)).toBe(expected);
        expect(wav[at + 2]).toBe(MARKERS[(frame * 2 + channel) & 1]);
      }
    }
  });

  it("packs a DSDIFF payload (byte interleaved, MSB first) with correct channels", async () => {
    const source = path.join(dir, "probe.dff");
    const target = path.join(dir, "probe-dff.wav");
    writeDff(source);

    const layout = await codec.readDsdLayout(source);
    expect(layout).toMatchObject({ container: "dff", channels: 2, sampleRate: 2_822_400, lsbFirst: false });
    await codec.encodeDopWav(source, layout, target);

    const wav = readFileSync(target);
    for (let frame = 0; frame < FRAMES; frame += 1) {
      for (let channel = 0; channel < 2; channel += 1) {
        const at = 44 + (frame * 2 + channel) * 3;
        const sourceBytes = channel === 0 ? left : right;
        const expected = (sourceBytes[frame * 2] << 8) | sourceBytes[frame * 2 + 1];
        expect(wav[at] | (wav[at + 1] << 8)).toBe(expected);
        expect(wav[at + 2]).toBe(MARKERS[(frame * 2 + channel) & 1]);
      }
    }
  });

  it("refuses layouts DoP cannot carry", async () => {
    const source = path.join(dir, "mono.dsf");
    writeDsf(source);
    const layout = await codec.readDsdLayout(source);
    expect(codec.describeDop({ ...layout, channels: 1 })).toBeNull();
    expect(codec.describeDop({ ...layout, sampleRate: 44_100 })).toBeNull();
    expect(codec.isDsdPath("track.DSF")).toBe(true);
    expect(codec.isDsdPath("track.flac")).toBe(false);
  });
});
