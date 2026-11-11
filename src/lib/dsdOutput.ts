import type { Track } from "@/data/music";
import type { DsdPcmRate } from "./playerPresentation";
export function isLocalDsd(track: Pick<Track, "source" | "format" | "filePath">) {
  return track.source === "local" && (/^(DSD|DSF|DFF)$/i.test(track.format ?? "") || /\.(dsf|dff)$/i.test(track.filePath ?? ""));
}
export function dsdOutputSettings(track: Pick<Track, "source" | "format" | "filePath">, rate: DsdPcmRate, forceExclusive: boolean, exclusive: boolean) {
  const isDsd = isLocalDsd(track);
  return { isDsd, samplerate: isDsd && ["44100", "88200", "176400"].includes(rate) ? Number(rate) : 0, exclusive: exclusive || (isDsd && forceExclusive) };
}
