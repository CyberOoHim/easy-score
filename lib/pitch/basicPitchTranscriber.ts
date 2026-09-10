/**
 * Basic Pitch Neural Audio Transcriber & Note Extractor
 *
 * Implements client-side automatic music transcription using Spotify's Basic Pitch
 * lightweight neural network (ICASSP 2022) combined with the Smart Tempo Tracker.
 *
 * Advantages over traditional YIN/ACF:
 * 1. Eliminates octave confusion errors (pitch doubling/halving).
 * 2. Robust against vocal vibrato and pitch wobble.
 * 3. Accurate onset detection even during soft attacks or articulation transitions.
 * 4. Runs client-side via TensorFlow.js with WebGL acceleration (works smoothly on iPad & mobile).
 */

import { midiToFrequency } from './pitchDetector';
import type { RawNoteSegment } from './onsetDetector';
import { estimateAudioTempo, type TempoEstimationResult } from './tempoEstimator';

export interface BasicPitchConfig {
  onsetThreshold?: number;     // Minimum amplitude of an onset activation (0.0 to 1.0, default: 0.38)
  frameThreshold?: number;     // Minimum amplitude of a frame activation (0.0 to 1.0, default: 0.25)
  minNoteLen?: number;         // Minimum note length in frames (default: 5 frames ~58ms)
  inferOnsets?: boolean;       // Infer additional onsets on large energy differences (default: true)
  melodiaTrick?: boolean;      // Suppress subharmonics / semitones near peak (default: true)
  vocalLeadOnly?: boolean;     // Extract monophonic lead line from polyphonic output (default: true)
}

export const DEFAULT_BASIC_PITCH_CONFIG: Readonly<BasicPitchConfig> = {
  onsetThreshold: 0.38,
  frameThreshold: 0.25,
  minNoteLen: 5,
  inferOnsets: true,
  melodiaTrick: true,
  vocalLeadOnly: true,
};

export interface NoteEventTime {
  startTimeSeconds: number;
  durationSeconds: number;
  pitchMidi: number;
  amplitude: number;
  pitchBends?: number[];
}

export interface BasicPitchTranscriptionOutput {
  notes: NoteEventTime[];
  rawSegments: RawNoteSegment[];
  tempoResult: TempoEstimationResult;
  resampledPcm: Float32Array;
  sampleRate: number;
}

// Singleton instances for neural model
let cachedBasicPitchInstance: any = null;
let basicPitchLoadPromise: Promise<any> | null = null;

/**
 * Initializes and caches the BasicPitch model instance.
 * Dynamically imports tfjs and basic-pitch to avoid SSR build conflicts.
 */
export async function getBasicPitchEngine(): Promise<{
  basicPitch: any;
  outputToNotesPoly: any;
  noteFramesToTime: any;
  addPitchBendsToNoteEvents: any;
}> {
  const [tf, bp] = await Promise.all([
    import('@tensorflow/tfjs'),
    import('@spotify/basic-pitch'),
  ]);

  if (cachedBasicPitchInstance) {
    return {
      basicPitch: cachedBasicPitchInstance,
      outputToNotesPoly: bp.outputToNotesPoly,
      noteFramesToTime: bp.noteFramesToTime,
      addPitchBendsToNoteEvents: bp.addPitchBendsToNoteEvents,
    };
  }

  if (!basicPitchLoadPromise) {
    basicPitchLoadPromise = (async () => {
      // Ensure tf is ready and prefer WebGL for hardware acceleration
      await tf.ready();
      try {
        if (tf.getBackend() !== 'webgl' && tf.findBackend('webgl')) {
          await tf.setBackend('webgl');
        }
      } catch (e) {
        console.warn('WebGL backend init failed, falling back to CPU:', e);
      }

      // Load static model files from public directory
      const modelUrl = '/models/basic-pitch/model.json';
      const instance = new bp.BasicPitch(modelUrl);
      await instance.model;
      cachedBasicPitchInstance = instance;
      return instance;
    })();
  }

  const basicPitch = await basicPitchLoadPromise;
  return {
    basicPitch,
    outputToNotesPoly: bp.outputToNotesPoly,
    noteFramesToTime: bp.noteFramesToTime,
    addPitchBendsToNoteEvents: bp.addPitchBendsToNoteEvents,
  };
}

/**
 * Resamples an AudioBuffer to 22,050 Hz mono Float32Array required by Basic Pitch.
 */
export async function resampleAudioBufferTo22kMono(
  audioBuffer: AudioBuffer
): Promise<Float32Array> {
  const targetSampleRate = 22050;
  const targetLength = Math.ceil(audioBuffer.duration * targetSampleRate);

  if (typeof window !== 'undefined') {
    const OfflineCtxClass =
      window.OfflineAudioContext ||
      (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;

    if (OfflineCtxClass) {
      try {
        const offlineCtx = new OfflineCtxClass(1, targetLength, targetSampleRate);
        const source = offlineCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(offlineCtx.destination);
        source.start(0);
        const rendered = await offlineCtx.startRendering();
        return rendered.getChannelData(0);
      } catch (e) {
        console.warn('OfflineAudioContext resampling failed, using linear interpolation fallback:', e);
      }
    }
  }

  // Fallback: High quality linear interpolation
  const numChannels = audioBuffer.numberOfChannels;
  const srcSampleRate = audioBuffer.sampleRate;
  const ratio = srcSampleRate / targetSampleRate;
  const out = new Float32Array(targetLength);

  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = numChannels > 1 ? audioBuffer.getChannelData(1) : null;

  for (let i = 0; i < targetLength; i++) {
    const srcPos = i * ratio;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;

    let sampleA = ch0[srcIndex] || 0;
    let sampleB = ch0[Math.min(ch0.length - 1, srcIndex + 1)] || 0;

    if (ch1) {
      sampleA = (sampleA + (ch1[srcIndex] || 0)) * 0.5;
      sampleB = (sampleB + (ch1[Math.min(ch1.length - 1, srcIndex + 1)] || 0)) * 0.5;
    }

    out[i] = sampleA + frac * (sampleB - sampleA);
  }

  return out;
}

/**
 * Converts detected NoteEventTime[] into continuous RawNoteSegment[]
 * with proper rests and monophonic lead-vocal resolution.
 */
export function convertBasicPitchNotesToRawSegments(
  notes: NoteEventTime[],
  audioDurationSec: number,
  options: {
    vocalLeadOnly?: boolean;
    absorbMicroGapsMs?: number;
  } = {}
): RawNoteSegment[] {
  const { vocalLeadOnly = true, absorbMicroGapsMs = 40 } = options;

  if (!notes || notes.length === 0) {
    return [
      {
        startTimeMs: 0,
        endTimeMs: Math.round(audioDurationSec * 1000),
        durationMs: Math.round(audioDurationSec * 1000),
        midi: null,
        frequencyHz: null,
        avgRms: 0,
        pitchSamples: [],
      },
    ];
  }

  // Filter valid musical notes
  const filtered = notes.filter(n => {
    return (
      n.pitchMidi >= 28 && // E1
      n.pitchMidi <= 96 && // C7
      n.durationSeconds >= 0.045 &&
      (n.amplitude ?? 0.5) > 0.08
    );
  });

  // Sort chronologically
  const sorted = [...filtered].sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);

  // If vocal lead mode is enabled, resolve overlapping notes by keeping higher amplitude / lead melody
  const monophonicNotes: NoteEventTime[] = [];

  if (vocalLeadOnly) {
    for (let i = 0; i < sorted.length; i++) {
      const current = sorted[i];

      if (monophonicNotes.length === 0) {
        monophonicNotes.push({ ...current });
        continue;
      }

      const prev = monophonicNotes[monophonicNotes.length - 1];
      const prevEnd = prev.startTimeSeconds + prev.durationSeconds;

      // Check for simultaneous or near-simultaneous onset (< 40ms)
      if (Math.abs(current.startTimeSeconds - prev.startTimeSeconds) < 0.04) {
        // Pick whichever has stronger amplitude (or higher pitch for vocal melody)
        if (current.amplitude > prev.amplitude * 1.1) {
          monophonicNotes[monophonicNotes.length - 1] = { ...current };
        }
        continue;
      }

      // Check for overlap: previous note sustains past current note start
      if (current.startTimeSeconds < prevEnd) {
        // Truncate previous note at current note attack
        prev.durationSeconds = Math.max(0.05, current.startTimeSeconds - prev.startTimeSeconds);
      }

      monophonicNotes.push({ ...current });
    }
  } else {
    monophonicNotes.push(...sorted);
  }

  // Build sequential timeline of notes and rests
  const rawSegments: RawNoteSegment[] = [];
  let currentTimeSec = 0;

  for (let i = 0; i < monophonicNotes.length; i++) {
    const note = monophonicNotes[i];
    const startSec = Math.max(currentTimeSec, note.startTimeSeconds);
    const endSec = startSec + note.durationSeconds;

    const gapSec = startSec - currentTimeSec;
    const gapMs = gapSec * 1000;

    // If there is a noticeable rest gap before this note, insert a rest
    if (gapMs >= absorbMicroGapsMs) {
      rawSegments.push({
        startTimeMs: Math.round(currentTimeSec * 1000),
        endTimeMs: Math.round(startSec * 1000),
        durationMs: Math.round(gapMs),
        midi: null,
        frequencyHz: null,
        avgRms: 0,
        pitchSamples: [],
      });
    } else if (rawSegments.length > 0 && gapMs > 0) {
      // Absorb micro-gap into previous voiced segment
      const last = rawSegments[rawSegments.length - 1];
      last.endTimeMs = Math.round(startSec * 1000);
      last.durationMs = last.endTimeMs - last.startTimeMs;
    }

    const freq = midiToFrequency(note.pitchMidi);
    rawSegments.push({
      startTimeMs: Math.round(startSec * 1000),
      endTimeMs: Math.round(endSec * 1000),
      durationMs: Math.round((endSec - startSec) * 1000),
      midi: note.pitchMidi,
      frequencyHz: freq,
      avgRms: Math.round((note.amplitude ?? 0.5) * 1000) / 1000,
      pitchSamples: [freq],
    });

    currentTimeSec = endSec;
  }

  // Trailing silence
  if (currentTimeSec < audioDurationSec - 0.05) {
    rawSegments.push({
      startTimeMs: Math.round(currentTimeSec * 1000),
      endTimeMs: Math.round(audioDurationSec * 1000),
      durationMs: Math.round((audioDurationSec - currentTimeSec) * 1000),
      midi: null,
      frequencyHz: null,
      avgRms: 0,
      pitchSamples: [],
    });
  }

  return rawSegments;
}

/**
 * Executes full Basic Pitch neural transcription on a 22k mono Float32Array audio buffer.
 */
export async function transcribeWithBasicPitch(
  mono22k: Float32Array,
  options: {
    config?: BasicPitchConfig;
    expectedMeter?: string;
    onProgress?: (percent: number, status: string) => void;
  } = {}
): Promise<BasicPitchTranscriptionOutput> {
  const {
    config = DEFAULT_BASIC_PITCH_CONFIG,
    expectedMeter = '4/4',
    onProgress,
  } = options;

  onProgress?.(15, '正在載入 Basic Pitch 類神經轉譜模型 (TF.js)...');

  const {
    basicPitch,
    outputToNotesPoly,
    noteFramesToTime,
    addPitchBendsToNoteEvents,
  } = await getBasicPitchEngine();

  onProgress?.(25, '正在進行類神經網路音符特徵推論...');

  const frames: number[][] = [];
  const onsets: number[][] = [];
  const contours: number[][] = [];

  // evaluateModel runs in 2-second overlapping sliding windows
  await basicPitch.evaluateModel(
    mono22k,
    (f: number[][], o: number[][], c: number[][]) => {
      frames.push(...f);
      onsets.push(...o);
      contours.push(...c);
    },
    (p: number) => {
      const pct = Math.min(80, Math.round(25 + p * 55));
      onProgress?.(pct, `類神經推論中 (${Math.round(p * 100)}%)...`);
    }
  );

  onProgress?.(82, '正在過濾音符邊界與提取旋律輪廓...');

  const onsetThresh = config.onsetThreshold ?? DEFAULT_BASIC_PITCH_CONFIG.onsetThreshold!;
  const frameThresh = config.frameThreshold ?? DEFAULT_BASIC_PITCH_CONFIG.frameThreshold!;
  const minNoteLen = config.minNoteLen ?? DEFAULT_BASIC_PITCH_CONFIG.minNoteLen!;
  const inferOnsets = config.inferOnsets ?? DEFAULT_BASIC_PITCH_CONFIG.inferOnsets!;
  const melodiaTrick = config.melodiaTrick ?? DEFAULT_BASIC_PITCH_CONFIG.melodiaTrick!;

  const noteEvents = outputToNotesPoly(
    frames,
    onsets,
    onsetThresh,
    frameThresh,
    minNoteLen,
    inferOnsets,
    null,
    null,
    melodiaTrick
  );

  const notesWithBends = addPitchBendsToNoteEvents(contours, noteEvents);
  const noteTimes: NoteEventTime[] = noteFramesToTime(notesWithBends);

  onProgress?.(88, '正在執行智慧速度追蹤與強弱拍對齊 (Beat Tracking)...');

  // Run Smart Tempo Tracker
  const tempoResult = estimateAudioTempo(
    mono22k,
    22050,
    noteTimes,
    { expectedMeter }
  );

  const audioDurationSec = mono22k.length / 22050;
  const rawSegments = convertBasicPitchNotesToRawSegments(
    noteTimes,
    audioDurationSec,
    { vocalLeadOnly: config.vocalLeadOnly ?? true }
  );

  return {
    notes: noteTimes,
    rawSegments,
    tempoResult,
    resampledPcm: mono22k,
    sampleRate: 22050,
  };
}
