import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readDsdHeader, scanMusicFolder } from "./musicScanner";

it("indexes DSF even when tags are unreadable and keeps the DSD rate and native requirement", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "aria-dsd-"));
  try {
    const header = Buffer.alloc(92);
    header.write("DSD "); header.writeBigUInt64LE(28n, 4);
    header.writeBigUInt64LE(92n, 12); header.write("fmt ", 28);
    header.writeBigUInt64LE(52n, 32); header.writeUInt32LE(2, 52);
    header.writeUInt32LE(2822400, 56); header.writeBigUInt64LE(5644800n, 64);
    const file = path.join(folder, "test.dsf");
    await writeFile(file, header);
    expect(await readDsdHeader(file)).toEqual({ sampleRate: 2822400, channels: 2, durationSeconds: 2 });
    const tracks = await scanMusicFolder(folder);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ format: "DSD", sampleRate: 2822400, requiresNativePlayback: true });
    await writeFile(file, Buffer.from("bad"));
    expect(await readDsdHeader(file)).toBeNull();
  } finally { await rm(folder, { recursive: true, force: true }); }
});
