import { KeySignature, TimeSignature } from '@/types/song';
import {
  PitchDetector,
  PitchDetectorConfig,
  DEFAULT_PITCH_CONFIG,
  calculateRms,
} from './pitchDetector';
import {
  NoteSegmenter,
  OnsetDetectorConfig,
  DEFAULT_ONSET_CONFIG,
  RawNoteSegment,
} from './onsetDetector';
import {
  cleanRawSegments,
  transcribeAudioSegmentsToMeasures,
  QuantizeGrid,
  ScaleMode,
  TranscriptionResult,
} from './scoreQuantizer';
import {
  transcribeWithBasicPitch,
  resampleAudioBufferTo22kMono,
  BasicPitchConfig,
  DEFAULT_BASIC_PITCH_CONFIG,
} from './basicPitchTranscriber';
import {
  estimateAudioTempo,
  type TempoEstimationResult,
} from './tempoEstimator';

export type TranscriptionEngine = 'basic-pitch' | 'dsp' | 'auto';

export interface AudioFileTranscriptionOptions {
  key?: KeySignature;
  bpm?: number;
  autoDetectBpm?: boolean;                  // If true, automatically sets BPM from Smart Tempo Tracker (default: true)
  alignDownbeat?: boolean;                  // If true, detects and aligns metric downbeat / pickup measures (default: true)
  engine?: TranscriptionEngine;             // Transcription core engine: 'auto' | 'basic-pitch' | 'dsp' (default: 'auto')
  timeSignature?: TimeSignature;
  grid?: QuantizeGrid;
  octaveShift?: number;
  accidentalPreference?: 'auto' | 'sharp' | 'flat';
  scaleMode?: ScaleMode;
  absorbArticulation?: boolean;
  stabilizerStrength?: number;
  pitchConfig?: Partial<PitchDetectorConfig>;
  onsetConfig?: Partial<OnsetDetectorConfig>;
  basicPitchConfig?: Partial<BasicPitchConfig>;
  onProgress?: (percent: number, status: string) => void;
}

export interface AudioFileTranscriptionResult {
  transcriptionResult: TranscriptionResult;
  rawSegments: RawNoteSegment[];
  audioDurationSec: number;
  sampleRate: number;
  peakRms: number;
  waveformPeaks: number[];
  audioUrl: string;
  tempoEstimation?: TempoEstimationResult;
  engineUsed: 'basic-pitch' | 'dsp-yin';
}

/**
 * Extracts a downsampled waveform peaks array for lightweight visual rendering in UI.
 */
export function extractWaveformPeaks(channelData: Float32Array, targetPoints: number = 100): number[] {
  const step = Math.floor(channelData.length / targetPoints);
  const peaks: number[] = [];
  if (step <= 0) return [0.5];

  for (let i = 0; i < targetPoints; i++) {
    const start = i * step;
    const end = Math.min(channelData.length, start + step);
    let max = 0;
    for (let j = start; j < end; j += 4) {
      const absVal = Math.abs(channelData[j]);
      if (absVal > max) max = absVal;
    }
    peaks.push(Math.round(max * 1000) / 1000);
  }
  return peaks;
}

/**
 * High-speed client-side audio file transcription into Numbered Musical Notation (Jianpu).
 *
 * Primary Core Engine:
 * Spotify Basic Pitch neural network (eliminates octave jumps, pitch wobble, and vocal vibrato
 * artifacts) with Smart Tempo & Downbeat Tracking.
 *
 * Fallback Engine:
 * Lightweight DSP YIN / Autocorrelation pitch tracking if WebGL or neural model is unavailable.
 */
export async function transcribeAudioFile(
  fileOrBlob: File | Blob,
  options: AudioFileTranscriptionOptions = {}
): Promise<AudioFileTranscriptionResult> {
  const {
    key = 'C',
    bpm = 80,
    autoDetectBpm = true,
    alignDownbeat = true,
    engine = 'auto',
    timeSignature = '4/4',
    grid = 'eighth',
    octaveShift = 0,
    accidentalPreference = 'auto',
    scaleMode = 'diatonic',
    absorbArticulation = true,
    stabilizerStrength = 0.5,
    pitchConfig = {},
    onsetConfig = {},
    basicPitchConfig = {},
    onProgress,
  } = options;

  onProgress?.(5, '正在讀取音訊檔案...');

  const arrayBuffer = await fileOrBlob.arrayBuffer();

  onProgress?.(15, '正在解碼音訊 PCM 數據...');

  const AudioContextClass =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const decodeCtx = new AudioContextClass();

  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    if (decodeCtx.state !== 'closed') {
      try {
        await decodeCtx.close();
      } catch {}
    }
  }

  const durationSec = audioBuffer.duration;
  const numChannels = audioBuffer.numberOfChannels;
  const originalLength = audioBuffer.length;
  const originalSampleRate = audioBuffer.sampleRate;

  // Extract mono PCM for waveform rendering and fallback
  const monoData = new Float32Array(originalLength);
  if (numChannels === 1) {
    monoData.set(audioBuffer.getChannelData(0));
  } else {
    const ch0 = audioBuffer.getChannelData(0);
    const ch1 = audioBuffer.getChannelData(1);
    for (let i = 0; i < originalLength; i++) {
      monoData[i] = (ch0[i] + ch1[i]) * 0.5;
    }
  }

  // Calculate peak amplitude and normalize if audio is too quiet
  let maxPeak = 0;
  for (let i = 0; i < originalLength; i += 16) {
    const absVal = Math.abs(monoData[i]);
    if (absVal > maxPeak) maxPeak = absVal;
  }

  if (maxPeak > 0.001 && maxPeak < 0.25) {
    const targetPeak = 0.65;
    const gainFactor = Math.min(8.0, targetPeak / maxPeak);
    for (let i = 0; i < originalLength; i++) {
      monoData[i] *= gainFactor;
    }
  }

  const waveformPeaks = extractWaveformPeaks(monoData, 80);
  const audioUrl = URL.createObjectURL(fileOrBlob);

  // --------------------------------------------------------------------------
  // 1. PRIMARY CORE: Basic Pitch Neural AMT + Smart Tempo Tracker
  // --------------------------------------------------------------------------
  const shouldUseBasicPitch = engine === 'auto' || engine === 'basic-pitch';

  if (shouldUseBasicPitch) {
    try {
      onProgress?.(22, '重採樣至 22,050 Hz 並初始化 Basic Pitch 模型...');
      const mono22k = await resampleAudioBufferTo22kMono(audioBuffer);

      const bpResult = await transcribeWithBasicPitch(mono22k, {
        config: {
          ...DEFAULT_BASIC_PITCH_CONFIG,
          ...basicPitchConfig,
        },
        expectedMeter: timeSignature,
        onProgress: (pct, msg) => {
          onProgress?.(pct, msg);
        },
      });

      const detectedTempo = bpResult.tempoResult;
      // Determine final quantization BPM
      const effectiveBpm = autoDetectBpm && detectedTempo.confidence >= 0.4
        ? detectedTempo.bpm
        : bpm;

      let segmentsToQuantize = bpResult.rawSegments;

      // Downbeat alignment & pickup note handling
      if (alignDownbeat && detectedTempo.isPickup && detectedTempo.pickupBeats > 0) {
        const meterParts = timeSignature.split('/');
        const beatsPerBar = parseInt(meterParts[0], 10) || 4;
        const leadingRestBeats = Math.max(0, beatsPerBar - detectedTempo.pickupBeats);

        if (leadingRestBeats > 0) {
          const msPerBeat = (60 / effectiveBpm) * 1000;
          const leadingRestMs = Math.round(leadingRestBeats * msPerBeat);

          // Find first voiced note
          const firstVoicedIdx = segmentsToQuantize.findIndex(s => s.midi !== null);
          if (firstVoicedIdx >= 0) {
            const firstVoiced = segmentsToQuantize[firstVoicedIdx];
            const pickupRestSegment: RawNoteSegment = {
              startTimeMs: 0,
              endTimeMs: leadingRestMs,
              durationMs: leadingRestMs,
              midi: null,
              frequencyHz: null,
              avgRms: 0,
              pitchSamples: [],
            };

            // Replace any leading unaligned silence with clean pickup measure rest
            segmentsToQuantize = [
              pickupRestSegment,
              ...segmentsToQuantize.slice(firstVoicedIdx),
            ];
          }
        }
      }

      onProgress?.(93, '量化音符並編排簡譜小節...');

      const cleaned = cleanRawSegments(segmentsToQuantize, 50, false, absorbArticulation, effectiveBpm);
      const transcriptionResult = transcribeAudioSegmentsToMeasures(cleaned, {
        key,
        bpm: effectiveBpm,
        timeSignature,
        grid,
        octaveShift,
        accidentalPreference,
        scaleMode,
        autoFillTrailingRests: false,
      });

      onProgress?.(100, '類神經轉譜完成！');

      return {
        transcriptionResult,
        rawSegments: cleaned,
        audioDurationSec: Math.round(durationSec * 10) / 10,
        sampleRate: 22050,
        peakRms: Math.round(maxPeak * 1000) / 1000,
        waveformPeaks,
        audioUrl,
        tempoEstimation: detectedTempo,
        engineUsed: 'basic-pitch',
      };
    } catch (err) {
      console.warn('Basic Pitch neural transcription encountered an error, falling back to DSP YIN engine:', err);
      if (engine === 'basic-pitch') {
        throw err; // If user specifically forced basic-pitch, don't hide the error
      }
      // Otherwise proceed to DSP fallback
    }
  }

  // --------------------------------------------------------------------------
  // 2. FALLBACK: Traditional DSP YIN / Autocorrelation Engine
  // --------------------------------------------------------------------------
  onProgress?.(30, '初始化傳統聲學基頻偵測引擎 (DSP YIN)...');

  const effectiveSilenceThreshold = 0.006;
  const pitchDetector = new PitchDetector({
    ...DEFAULT_PITCH_CONFIG,
    sampleRate: originalSampleRate,
    threshold: 0.15,
    minFrequency: 75,
    maxFrequency: 1400,
    silenceThreshold: effectiveSilenceThreshold,
    medianFilterSize: 5,
    stabilizerStrength,
    ...pitchConfig,
  });

  const noteSegmenter = new NoteSegmenter({
    ...DEFAULT_ONSET_CONFIG,
    sampleRate: originalSampleRate,
    silenceThresholdRms: effectiveSilenceThreshold,
    attackRmsDeltaThreshold: 0.018,
    attackRelativeRiseThreshold: 1.8,
    refractoryPeriodMs: 70,
    stabilizerStrength,
    ...onsetConfig,
  });

  onProgress?.(45, '逐訊框分析音高與音頭邊界...');

  const frameSize = 2048;
  const hopSize = 512;
  const frameBuffer = new Float32Array(frameSize);

  let overallPeakRms = 0;
  const totalSteps = Math.ceil((originalLength - frameSize) / hopSize) + 1;
  let currentStep = 0;

  for (let offset = 0; offset < originalLength; offset += hopSize) {
    currentStep++;

    for (let i = 0; i < frameSize; i++) {
      const idx = offset + i;
      frameBuffer[i] = idx < originalLength ? monoData[idx] : 0;
    }

    const timestampMs = (offset / originalSampleRate) * 1000;
    const frameRms = calculateRms(frameBuffer);
    if (frameRms > overallPeakRms) overallPeakRms = frameRms;

    const pitchRes = pitchDetector.detectSmoothed(frameBuffer);
    noteSegmenter.ingestFrame(
      frameBuffer,
      timestampMs,
      pitchRes.isPitched ? pitchRes.frequency : null,
      pitchRes.probability
    );

    if (currentStep % 400 === 0) {
      const pct = Math.min(85, Math.round(45 + (currentStep / totalSteps) * 40));
      onProgress?.(pct, `音訊基頻分析中 (${Math.round((offset / originalLength) * 100)}%)...`);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  onProgress?.(88, '正在執行智慧速度追蹤...');

  const totalDurationMs = durationSec * 1000;
  const raw = noteSegmenter.finalize(totalDurationMs);

  // Convert raw segments to note candidates for tempo estimation
  const noteCandidates = raw
    .filter(s => s.midi !== null)
    .map(s => ({
      startTimeSeconds: s.startTimeMs / 1000,
      durationSeconds: s.durationMs / 1000,
      amplitude: s.avgRms,
      pitchMidi: s.midi ?? undefined,
    }));

  const tempoEst = estimateAudioTempo(
    monoData,
    originalSampleRate,
    noteCandidates,
    { expectedMeter: timeSignature }
  );

  const effectiveBpm = autoDetectBpm && tempoEst.confidence >= 0.4
    ? tempoEst.bpm
    : bpm;

  const cleaned = cleanRawSegments(raw, 60, true, absorbArticulation, effectiveBpm);

  onProgress?.(95, '量化音符並編排簡譜小節...');

  const transcriptionResult = transcribeAudioSegmentsToMeasures(cleaned, {
    key,
    bpm: effectiveBpm,
    timeSignature,
    grid,
    octaveShift,
    accidentalPreference,
    scaleMode,
    autoFillTrailingRests: false,
  });

  onProgress?.(100, '轉譜完成！');

  return {
    transcriptionResult,
    rawSegments: cleaned,
    audioDurationSec: Math.round(durationSec * 10) / 10,
    sampleRate: originalSampleRate,
    peakRms: Math.round(overallPeakRms * 1000) / 1000,
    waveformPeaks,
    audioUrl,
    tempoEstimation: tempoEst,
    engineUsed: 'dsp-yin',
  };
}
