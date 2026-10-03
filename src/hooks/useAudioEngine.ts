import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { Track } from "@/data/music";
import type { NativeAudioState } from "@/lib/audioTypes";
import { api } from "@/lib/api";
import { commitPlaybackTime, getPlaybackTime } from "@/lib/playbackClock";
import { configureSpectrumAnalyser } from "@/lib/spectrumEngine";
import { equalizerBandsForMode, equalizerModeQ, isEqualizerActive, type EqualizerSettings } from "@/lib/equalizer";
import { readCachedAudioSettings, writeCachedAudioSettings, type AudioOutputMode, type QualityLevel } from "@/lib/playerPresentation";

// Owns the media pipeline: the HTML audio element, the mpv native bridge
// (loading/progress/pause/volume/device + exclusive mode), output device
// enumeration and the Web Audio graph that feeds the spectrum visualizer.
export function useAudioEngine(options: {
  activeTrack: Track;
  activeTrackId: string;
  idleTrackId: string;
  effectiveQualityLevel: QualityLevel;
  playing: boolean;
  volume: number;
  hifiEnabled: boolean;
  gaplessEnabled: boolean;
  audioOutputMode: AudioOutputMode;
  equalizer: EqualizerSettings;
  pageVisible: boolean;
  analyserEnabled: boolean;
  pendingSeekRef: { current: number };
  setPlaying: (updater: (playing: boolean) => boolean) => void;
  setDurationSeconds: (seconds: number) => void;
  exclusiveMode: boolean;
  durationSeconds: number;
  handleTrackEnded: () => void;
  // Called when mpv advances to an entry that was appended for gapless
  // playback. The native engine owns the transition, but React still needs
  // to adopt the new track id so the analyser and progress UI follow it.
  handleNativeTrackAdvanced: (trackId: string) => void;
  pickRelativeTrack: (direction: 1 | -1) => void;
  hasMultipleQueueTracks: boolean;
  // Resolves the next queue entry (already URL-resolved) for gapless mpv
  // preloading; null when the next track cannot be preloaded.
  getNextPreload: () => { trackId: string; url: string } | null;
}) {
  const activeTrack = options.activeTrack;
  const [audioOutputDevices, setAudioOutputDevices] = useState<Array<{ id: string; label: string }>>([]);
  const [nativeAudioSupported, setNativeAudioSupported] = useState(() => Boolean(window.ariaDesktop?.nativeAudio?.supported));
  const [nativeAudioState, setNativeAudioState] = useState<NativeAudioState | null>(null);
  const [selectedSinkId, setSelectedSinkId] = useState(() => readCachedAudioSettings().sinkId ?? "default");
  const [nativePlaybackFailed, setNativePlaybackFailed] = useState(false);
  const [nativeAnalyserWakeToken, setNativeAnalyserWakeToken] = useState(0);

  // mpv (native WASAPI) owns the audible stream for the Shared/Exclusive
  // output modes. In the "system" mode Chromium plays the stream itself so
  // the OS media session is a real, audible session (full artwork + prev/next
  // in the Windows media card); only tracks that require native decoding
  // (CD, exotic containers) still fall back to mpv.
  const nativePlaybackRequested = Boolean(
    nativeAudioSupported &&
      options.audioOutputMode !== "system" &&
      (activeTrack.streamUrl || activeTrack.requiresNativePlayback),
  );
  const nativePlaybackEnabled = Boolean(nativePlaybackRequested && !nativePlaybackFailed);

  const activeStreamUrl = useMemo(() => {
    if (!activeTrack.streamUrl) return null;
    const resolvedUrl = api.resolveUrl(activeTrack.streamUrl);
    if (activeTrack.source !== "netease") return resolvedUrl;

    const url = new URL(resolvedUrl, window.location.href);
    url.searchParams.set("level", options.effectiveQualityLevel);
    return url.href;
  }, [activeTrack, options.effectiveQualityLevel]);

  const audioElementStreamUrl = useMemo(() => {
    if (!activeTrack.streamUrl || activeTrack.requiresNativePlayback) return null;
    const resolvedUrl = api.resolveUrl(activeTrack.streamUrl);
    if (activeTrack.source !== "netease") return resolvedUrl;

    const url = new URL(resolvedUrl, window.location.href);
    if (activeTrack.source === "netease") {
      // Native mpv owns the audible lossless stream. The renderer copy is
      // analyser-only, so use the smallest available stream to avoid doubling
      // high-resolution downloads and decoder memory.
      url.searchParams.set("level", nativePlaybackEnabled ? "standard" : options.effectiveQualityLevel);
    }
    return url.href;
  }, [activeTrack, options.effectiveQualityLevel, nativePlaybackEnabled]);

  const audioRef = useRef<HTMLAudioElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const equalizerNodesRef = useRef<BiquadFilterNode[]>([]);
  const nativeSilenceGainRef = useRef<GainNode | null>(null);
  const analyserOutputModeRef = useRef<"audible" | "silent" | null>(null);
  const nativeLoadedUrlRef = useRef<string | null>(null);
  const nativeAnalyserDelayUntilRef = useRef(0);
  const nativeLoadSequenceRef = useRef(0);
  const lastNativeRenderRef = useRef({ at: 0, position: 0 });
  const audioErrorRef = useRef({ count: 0, lastAt: 0 });
  const preloadKeyRef = useRef<string | null>(null);
  const handledGaplessGenerationRef = useRef(0);

  const syncNativeAudioState = useEffectEvent((state: NativeAudioState) => {
    const now = performance.now();
    const previousNativeRender = lastNativeRenderRef.current;
    const shouldRenderNativeState =
      state.kind !== "progress" ||
      now - previousNativeRender.at > 500 ||
      Math.abs((state.position ?? 0) - previousNativeRender.position) > 0.8;
    if (shouldRenderNativeState) {
      lastNativeRenderRef.current = { at: now, position: state.position ?? previousNativeRender.position };
      setNativeAudioState(state);
    }
    const currentTrackMatches = Boolean(state.trackId && state.trackId === options.activeTrackId);
    const shouldSyncPlayback =
      currentTrackMatches &&
      (state.active ||
        state.kind === "loading" ||
        state.kind === "loaded" ||
        state.kind === "pause" ||
        state.kind === "seek" ||
        state.kind === "progress" ||
        state.kind === "ended");

    if (shouldSyncPlayback) {
      if (typeof state.duration === "number" && state.duration > 0) {
        options.setDurationSeconds(state.duration);
      }
      if (typeof state.position === "number") {
        commitPlaybackTime(state.position, state.kind === "loaded" || state.kind === "seek" || state.kind === "ended");
      }
      if (state.kind === "pause" && typeof state.paused === "boolean") {
        options.setPlaying(() => !state.paused);
      }
    }
    if (state.kind === "ended" && currentTrackMatches && nativePlaybackEnabled) {
      options.handleTrackEnded();
    }

    // With an appended mpv playlist entry, the native engine emits a
    // `file-loaded` event for the next track without an intervening renderer
    // load call. Its track id therefore differs from React's current id. Do
    // not wait for an `ended` event (which is intentionally suppressed by the
    // native engine); hand the identity to App immediately.
    const gaplessGeneration = Number(state.gaplessGeneration ?? 0);
    // A native engine restart resets its generation counter. Drop the old
    // renderer-side watermark so the first seamless transition after resume
    // is still adopted.
    if (gaplessGeneration < handledGaplessGenerationRef.current) {
      handledGaplessGenerationRef.current = 0;
    }
    if (
      nativePlaybackEnabled &&
      state.kind === "loaded" &&
      state.trackId &&
      state.trackId !== options.activeTrackId &&
      gaplessGeneration > handledGaplessGenerationRef.current
    ) {
      handledGaplessGenerationRef.current = gaplessGeneration;
      options.handleNativeTrackAdvanced(state.trackId);
    }
  });

  useEffect(() => {
    const nativeAudio = window.ariaDesktop?.nativeAudio;
    if (!nativeAudio?.supported) return;

    let cancelled = false;
    nativeAudio
      .getState?.()
      .then((state) => {
        if (!cancelled && state) syncNativeAudioState(state as NativeAudioState);
      })
      .catch(() => undefined);

    const dispose = nativeAudio.onEvent?.((payload) => {
      if (!cancelled) syncNativeAudioState(payload as NativeAudioState);
    });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [syncNativeAudioState]);

  useEffect(() => {
    const nativeAudio = window.ariaDesktop?.nativeAudio;
    if (!nativePlaybackEnabled) return;
    const audio = audioRef.current as (HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> }) | null;
    if (!audio?.setSinkId) return;
    audio.setSinkId(selectedSinkId === "default" ? "" : selectedSinkId).catch(() => {
      // Device switching is optional; keep current output if the platform rejects it.
    });
  }, [nativePlaybackEnabled, selectedSinkId]);

  useEffect(() => {
    const nativeAudio = window.ariaDesktop?.nativeAudio;
    if (nativeAudio?.supported) {
      nativeAudio
        .isSupported?.()
        .then((supported) => {
          setNativeAudioSupported(Boolean(supported));
          if (!supported) return [];
          return nativeAudio.listDevices?.() ?? [];
        })
        .then((devices) => {
          if (Array.isArray(devices) && devices.length) {
            setAudioOutputDevices(devices);
          }
        })
        .catch(() => {
          setNativeAudioSupported(false);
        });
      return;
    }

    if (!navigator.mediaDevices?.enumerateDevices) return;

    let cancelled = false;
    const refreshDevices = () => {
      navigator.mediaDevices
        .enumerateDevices()
        .then((devices) => {
          if (cancelled) return;
          const outputs = devices
            .filter((device) => device.kind === "audiooutput")
            .map((device, index) => ({
              id: device.deviceId || `output-${index}`,
              label: device.label || `播放设备 ${index + 1}`,
            }));
          setAudioOutputDevices([{ id: "default", label: "系统默认" }, ...outputs.filter((device) => device.id !== "default")]);
        })
        .catch(() => {
          if (!cancelled) setAudioOutputDevices([{ id: "default", label: "系统默认" }]);
        });
    };

    refreshDevices();
    navigator.mediaDevices.addEventListener?.("devicechange", refreshDevices);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener?.("devicechange", refreshDevices);
    };
  }, []);

  useEffect(() => {
    writeCachedAudioSettings({
      sinkId: selectedSinkId,
      hifiEnabled: options.hifiEnabled,
      gaplessEnabled: options.gaplessEnabled,
      exclusiveMode: options.exclusiveMode,
      outputMode: options.audioOutputMode,
    });
  }, [options.audioOutputMode, options.exclusiveMode, options.gaplessEnabled, options.hifiEnabled, selectedSinkId]);

  useEffect(() => {
    setNativePlaybackFailed(false);
    nativeLoadedUrlRef.current = null;
    if (!nativePlaybackRequested) {
      nativeAnalyserDelayUntilRef.current = 0;
      setNativeAnalyserWakeToken((value) => value + 1);
      return;
    }

    nativeAnalyserDelayUntilRef.current = performance.now() + 220;
    const timer = window.setTimeout(() => {
      setNativeAnalyserWakeToken((value) => value + 1);
    }, 260);
    return () => window.clearTimeout(timer);
  }, [options.activeTrack.id, activeStreamUrl, options.audioOutputMode, nativePlaybackRequested, selectedSinkId]);

  useEffect(() => {
    if (!audioOutputDevices.length) return;
    if (audioOutputDevices.some((device) => device.id === selectedSinkId)) return;
    setSelectedSinkId("default");
  }, [audioOutputDevices, selectedSinkId]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const nativeAnalyserBridgeReady = Boolean(nativePlaybackEnabled && audioSourceRef.current && nativeSilenceGainRef.current);
    const nativeAnalyserReady =
      !nativePlaybackEnabled ||
      Boolean(
        nativeAudioState?.trackId === options.activeTrack.id &&
          nativeAudioState.active &&
          performance.now() >= nativeAnalyserDelayUntilRef.current,
      );
    audio.muted = nativePlaybackEnabled && !nativeAnalyserBridgeReady;
    audio.volume = nativePlaybackEnabled ? (nativeAnalyserBridgeReady ? 1 : 0) : Math.max(0, Math.min(1, options.volume / 100));
    // The mpv path owns audible lossless playback. Chromium only needs a
    // lightweight analyser source, so avoid pre-buffering the whole stream.
    audio.preload = nativePlaybackEnabled ? (nativeAnalyserReady ? "metadata" : "none") : "metadata";

    if (!audioElementStreamUrl || !nativeAnalyserReady || (nativePlaybackEnabled && !options.analyserEnabled)) {
      audio.pause();
      if (nativePlaybackEnabled && audio.src) {
        audio.removeAttribute("src");
        audio.load();
      }
      return;
    }

    const nextSrc = new URL(audioElementStreamUrl, window.location.href).href;
    if (audio.src !== nextSrc) {
      audio.pause();
      if (audio.src) {
        audio.removeAttribute("src");
        audio.load();
      }
      audio.src = nextSrc;
      audio.load();
      options.setDurationSeconds(0);
    }

    if (options.playing) {
      audio.play().catch(() => {
        if (!nativePlaybackEnabled) options.setPlaying(() => false);
      });
    } else {
      audio.pause();
    }
  }, [
    audioElementStreamUrl,
    options.activeTrack.id,
    options.hifiEnabled,
    nativeAudioState?.active,
    nativeAudioState?.trackId,
    nativeAnalyserWakeToken,
    nativePlaybackEnabled,
    options.analyserEnabled,
    options.volume,
    options.playing,
  ]);

  useEffect(() => {
    if (!nativePlaybackEnabled) return;
    const audio = audioRef.current;
    if (!audio) return;
    const desiredTime = nativeAudioState?.position;
    if (!Number.isFinite(desiredTime)) return;
    if (Math.abs((audio.currentTime || 0) - (desiredTime ?? 0)) < 0.45) return;
    audio.currentTime = Math.max(0, desiredTime ?? 0);
  }, [nativeAudioState?.position, nativePlaybackEnabled]);

  useEffect(() => {
    const nativeAudio = window.ariaDesktop?.nativeAudio;
    if (!nativeAudio?.supported) return;
    if (nativePlaybackEnabled) return;
    nativeLoadedUrlRef.current = null;
    nativeAudio.stop?.().catch(() => undefined);
  }, [nativePlaybackEnabled]);

  // Gapless preload runs on a 1-second clock tick reading the committed
  // playback clock, decoupled from state-update timing so the append always
  // lands inside the final seconds of the current track.
  const preloadInputsRef = useRef({
    enabled: false,
    playing: false,
    durationSeconds: 0,
    activeTrackId: "",
    generation: 0,
    getNextPreload: () => null as { trackId: string; url: string } | null,
  });
  preloadInputsRef.current = {
    enabled: nativePlaybackEnabled && options.gaplessEnabled,
    playing: options.playing,
    durationSeconds: options.durationSeconds,
    activeTrackId: options.activeTrack.id,
    generation: nativeAudioState?.gaplessGeneration ?? 0,
    getNextPreload: options.getNextPreload,
  };

  useEffect(() => {
    if (!nativePlaybackEnabled) return;
    const nativeAudio = window.ariaDesktop?.nativeAudio;
    const loadNext = nativeAudio?.loadNext;
    if (!loadNext) return;

    const timer = window.setInterval(() => {
      const inputs = preloadInputsRef.current;
      if (!inputs.enabled || !inputs.playing) return;
      const remaining = inputs.durationSeconds - getPlaybackTime();
      if (!Number.isFinite(remaining) || remaining > 6 || remaining <= 0.2) return;

      const next = inputs.getNextPreload();
      if (!next) return;
      const key = `${inputs.activeTrackId}\u0000${next.trackId}\u0000${next.url}\u0000${inputs.generation}`;
      if (preloadKeyRef.current === key) return;
      preloadKeyRef.current = key;
      loadNext(next).catch(() => {
        preloadKeyRef.current = null;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [nativePlaybackEnabled, options.gaplessEnabled]);

  useEffect(() => {
    if (options.gaplessEnabled) return;
    preloadKeyRef.current = null;
    const nativeAudio = window.ariaDesktop?.nativeAudio;
    if (!nativePlaybackEnabled || !nativeAudio?.supported) return;
    // A disabled toggle must also drop an already appended mpv entry. Reload
    // the current URL through the normal effect on the next render.
    nativeLoadedUrlRef.current = null;
  }, [nativePlaybackEnabled, options.gaplessEnabled]);

  useEffect(() => {
    const nativeAudio = window.ariaDesktop?.nativeAudio;
    if (!nativePlaybackEnabled || !nativeAudio?.supported) return;
    options.pendingSeekRef.current = getPlaybackTime();
    nativeLoadedUrlRef.current = null;
  }, [options.exclusiveMode, nativePlaybackEnabled, selectedSinkId]);

  useEffect(() => {
    const nativeAudio = window.ariaDesktop?.nativeAudio;
    if (!nativePlaybackEnabled || !nativeAudio?.supported) return;

    if (!activeStreamUrl || options.activeTrack.id === options.idleTrackId) {
      nativeLoadedUrlRef.current = null;
      nativeAudio.stop?.().catch(() => undefined);
      return;
    }

    const nextUrl = activeStreamUrl;
    const nextLoadKey = [
      nextUrl,
      options.activeTrack.nativeDevice ?? "",
      options.activeTrack.nativeStart ?? "",
      options.activeTrack.nativeEnd ?? "",
      options.activeTrack.cdReadQuality ?? "high",
    ].join("\u0000");
    // A gapless advance is already loaded by mpv before React adopts the new
    // track id. Replacing that URL here would restart the song at zero and
    // can briefly disconnect the analyser from the active decoder.
    const nativeStateOwnsTrack = Boolean(
      nativeAudioState?.active &&
        nativeAudioState.trackId === options.activeTrack.id &&
        nativeAudioState.url === nextUrl,
    );
    if (nativeStateOwnsTrack) {
      nativeLoadedUrlRef.current = nextLoadKey;
      return;
    }
    if (nativeLoadedUrlRef.current === nextLoadKey) return;

    let cancelled = false;
    const loadSequence = nativeLoadSequenceRef.current + 1;
    nativeLoadSequenceRef.current = loadSequence;
    nativeLoadedUrlRef.current = nextLoadKey;
    nativeAudio
      .load?.({
        trackId: options.activeTrack.id,
        url: nextUrl,
        position: options.pendingSeekRef.current || 0,
        paused: !options.playing,
        volume: options.volume,
        exclusive: options.exclusiveMode,
        deviceId: selectedSinkId,
        nativeDevice: options.activeTrack.nativeDevice ?? null,
        startChapter: options.activeTrack.nativeStart ?? null,
        endChapter: options.activeTrack.nativeEnd ?? null,
        cdReadQuality: options.activeTrack.cdReadQuality ?? "high",
      })
      .then((state) => {
        if (cancelled || nativeLoadSequenceRef.current !== loadSequence) return;
        if (state) syncNativeAudioState(state as NativeAudioState);
      })
      .catch(() => {
        if (cancelled || nativeLoadSequenceRef.current !== loadSequence) return;
        nativeLoadedUrlRef.current = null;
        setNativePlaybackFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeStreamUrl,
    options.activeTrack.id,
    options.activeTrack.cdReadQuality,
    options.activeTrack.nativeEnd,
    options.activeTrack.nativeDevice,
    options.activeTrack.nativeStart,
    nativePlaybackEnabled,
    options.gaplessEnabled,
    nativeAudioState?.trackId,
    options.exclusiveMode,
    options.volume,
    options.playing,
    selectedSinkId,
    syncNativeAudioState,
  ]);

  useEffect(() => {
    const nativeAudio = window.ariaDesktop?.nativeAudio;
    if (!nativePlaybackEnabled || !nativeAudio?.supported) return;
    nativeAudio.setPaused?.(!options.playing).catch(() => undefined);
  }, [nativePlaybackEnabled, options.playing]);
  useEffect(() => {
    const nativeAudio = window.ariaDesktop?.nativeAudio;
    if (!nativePlaybackEnabled || !nativeAudio?.supported) return;
    nativeAudio.setVolume?.(options.volume).catch(() => undefined);
  }, [nativePlaybackEnabled, options.volume]);

  useEffect(() => {
    if (
      !options.playing ||
      !audioElementStreamUrl ||
      !options.pageVisible ||
      (nativePlaybackEnabled && !options.analyserEnabled)
    ) {
      return;
    }

    const audio = audioRef.current;
    if (!audio) return;

    const AudioContextClass =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;

    const context = audioContextRef.current ?? new AudioContextClass();
    audioContextRef.current = context;
    if (!audioSourceRef.current) {
      try {
        audioSourceRef.current = context.createMediaElementSource(audio);
      } catch {
        return;
      }
      analyserRef.current = context.createAnalyser();
      configureSpectrumAnalyser(analyserRef.current);
      // DSP equalizer: one peaking biquad per active band, inserted between the
      // media element and the analyser so every output mode that plays through
      // Chromium (System) is filtered in real time.
      connectEqualizerChain(context);
    }

    void context.resume();
    const analyser = analyserRef.current;
    if (!analyser) return;
    configureSpectrumAnalyser(analyser);

    const desiredOutputMode = nativePlaybackEnabled ? "silent" : "audible";
    if (analyserOutputModeRef.current !== desiredOutputMode) {
      try {
        analyser.disconnect();
      } catch {
        // Ignore graph cleanup errors; reconnect below.
      }
      try {
        nativeSilenceGainRef.current?.disconnect();
      } catch {
        // The silent sink may already be disconnected.
      }

      if (nativePlaybackEnabled) {
        const silentGain = nativeSilenceGainRef.current ?? context.createGain();
        silentGain.gain.value = 0;
        nativeSilenceGainRef.current = silentGain;
        analyser.connect(silentGain);
        silentGain.connect(context.destination);
      } else {
        analyser.connect(context.destination);
      }
      analyserOutputModeRef.current = desiredOutputMode;
    }
    if (nativePlaybackEnabled) {
      audio.muted = false;
      audio.volume = 1;
    }
  }, [
    audioElementStreamUrl,
    options.activeTrack.id,
    nativePlaybackEnabled,
    options.analyserEnabled,
    options.pageVisible,
    options.playing,
  ]);

  // (Re)builds the biquad chain for the active band layout: media element →
  // peaking filters → analyser. Switching between the 18-band and 31-band
  // layouts changes the node count, so the chain is rewired as a whole.
  function connectEqualizerChain(context: AudioContext) {
    const source = audioSourceRef.current;
    const analyser = analyserRef.current;
    if (!source || !analyser) return;

    if (equalizerNodesRef.current.length) {
      try {
        source.disconnect();
      } catch {
        // The source may already be detached.
      }
      for (const node of equalizerNodesRef.current) {
        try {
          node.disconnect();
        } catch {
          // Ignore stale node teardown errors.
        }
      }
      equalizerNodesRef.current = [];
    }

    const settings = options.equalizer;
    const active = isEqualizerActive(settings);
    const bands = equalizerBandsForMode(settings.mode);
    const gains = settings.gains[settings.mode];
    const nodes = bands.map((band, index) => {
      const node = context.createBiquadFilter();
      node.type = "peaking";
      node.frequency.value = band.frequency;
      node.Q.value = equalizerModeQ[settings.mode];
      node.gain.value = active ? gains[index] ?? 0 : 0;
      return node;
    });

    let chainTail: AudioNode = source;
    for (const node of nodes) {
      chainTail.connect(node);
      chainTail = node;
    }
    chainTail.connect(analyser);
    equalizerNodesRef.current = nodes;
  }

  // Push the DSP curve onto the Web Audio biquads (System output mode) and the
  // mpv audio filters (WASAPI Shared/Exclusive) whenever the settings change.
  useEffect(() => {
    const settings = options.equalizer;
    const active = isEqualizerActive(settings);
    const gains = settings.gains[settings.mode];
    for (const [index, node] of equalizerNodesRef.current.entries()) {
      const rawGain = active ? gains[index] ?? 0 : 0;
      const nextGain = Number.isFinite(rawGain) ? rawGain : 0;
      if (Math.abs(node.gain.value - nextGain) < 0.001) continue;
      node.gain.value = nextGain;
    }
  }, [options.equalizer]);

  // Band-layout switch: rewire the chain for the new node count.
  useEffect(() => {
    const context = audioContextRef.current;
    if (!context) return;
    connectEqualizerChain(context);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.equalizer.mode]);

  useEffect(() => {
    const setEqualizer = window.ariaDesktop?.nativeAudio?.setEqualizer;
    if (!setEqualizer) return;
    if (!nativePlaybackEnabled) return;
    setEqualizer({
      enabled: options.equalizer.enabled,
      gains: options.equalizer.gains[options.equalizer.mode],
      frequencies: equalizerBandsForMode(options.equalizer.mode).map((band) => band.frequency),
      q: equalizerModeQ[options.equalizer.mode],
    }).catch(() => undefined);
  }, [nativePlaybackEnabled, options.equalizer]);

  useEffect(() => {
    return () => {
      try {
        audioSourceRef.current?.disconnect();
      } catch {
        // Ignore audio graph shutdown errors.
      }
      try {
        analyserRef.current?.disconnect();
      } catch {
        // Ignore audio graph shutdown errors.
      }
      try {
        nativeSilenceGainRef.current?.disconnect();
      } catch {
        // Ignore audio graph shutdown errors.
      }
      for (const node of equalizerNodesRef.current) {
        try {
          node.disconnect();
        } catch {
          // Ignore audio graph shutdown errors.
        }
      }
      equalizerNodesRef.current = [];
      audioSourceRef.current = null;
      analyserRef.current = null;
      nativeSilenceGainRef.current = null;
      analyserOutputModeRef.current = null;
      audioContextRef.current?.close().catch(() => undefined);
      audioContextRef.current = null;
    };
  }, []);

  function handleAudioError() {
    if (nativePlaybackEnabled) return;
    if (!activeStreamUrl || !options.playing) return;

    const now = Date.now();
    const previous = audioErrorRef.current;
    const nextCount = now - previous.lastAt > 6000 ? 1 : previous.count + 1;
    audioErrorRef.current = { count: nextCount, lastAt: now };

    if (nextCount >= 3 || !options.hasMultipleQueueTracks) {
      options.setPlaying(() => false);
      return;
    }

    window.setTimeout(() => options.pickRelativeTrack(1), 650);
  }

  function resetAudioError() {
    audioErrorRef.current = { count: 0, lastAt: 0 };
  }

  // Replays the current track from the start through the native engine.
  // mpv unloads the file at EOF and sits idle, so a plain seek(0) cannot
  // restart it — the file has to be loaded again from the beginning.
  const restartNativeTrack = useEffectEvent(async () => {
    const nativeAudio = window.ariaDesktop?.nativeAudio;
    if (!nativePlaybackEnabled || !nativeAudio?.supported) return false;
    const url = activeStreamUrl;
    if (!url || options.activeTrack.id === options.idleTrackId) return false;
    const nextLoadKey = [
      url,
      options.activeTrack.nativeDevice ?? "",
      options.activeTrack.nativeStart ?? "",
      options.activeTrack.nativeEnd ?? "",
      options.activeTrack.cdReadQuality ?? "high",
    ].join("\u0000");
    nativeLoadedUrlRef.current = nextLoadKey;
    options.pendingSeekRef.current = 0;
    commitPlaybackTime(0, true);
    try {
      await nativeAudio.load({
        trackId: options.activeTrack.id,
        url,
        position: 0,
        paused: false,
        volume: options.volume,
        exclusive: options.exclusiveMode,
        deviceId: selectedSinkId,
        nativeDevice: options.activeTrack.nativeDevice ?? null,
        startChapter: options.activeTrack.nativeStart ?? null,
        endChapter: options.activeTrack.nativeEnd ?? null,
        cdReadQuality: options.activeTrack.cdReadQuality ?? "high",
      });
      return true;
    } catch {
      nativeLoadedUrlRef.current = null;
      return false;
    }
  });

  return {
    audioRef,
    analyserRef,
    audioOutputDevices,
    nativeAudioSupported,
    nativeAudioState,
    selectedSinkId,
    setSelectedSinkId,
    nativePlaybackFailed,
    nativePlaybackRequested,
    nativePlaybackEnabled,
    activeStreamUrl,
    audioElementStreamUrl,
    handleAudioError,
    resetAudioError,
    restartNativeTrack,
  };
}
