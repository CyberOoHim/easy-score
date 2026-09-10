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

export interface AudioFileTranscriptionOptions {
  key?: KeySignature;
  bpm?: number;
  timeSignature?: TimeSignature;
  grid?: QuantizeGrid;
  octaveShift?: number;
  accidentalPreference?: 'auto' | 'sharp' | 'flat';
  scaleMode?: ScaleMode;
  absorbArticulation?: boolean;
  stabilizerStrength?: number;
  pitchConfig?: Partial<PitchDetectorConfig>;
  onsetConfig?: Partial<OnsetDetectorConfig>;
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
 * Decodes compressed or uncompressed audio files (MP3, WAV, M4A, AAC, OGG, WebM, FLAC)
 * into PCM audio buffers and performs frame-by-frame pitch tracking, onset boundary
 * detection, and musical score quantization.
 */
export async function transcribeAudioFile(
  fileOrBlob: File | Blob,
  options: AudioFileTranscriptionOptions = {}
): Promise<AudioFileTranscriptionResult> {
  const {
    key = 'C',
    bpm = 80,
    timeSignature = '4/4',
    grid = 'eighth',
    octaveShift = 0,
    accidentalPreference = 'auto',
    scaleMode = 'diatonic',
    absorbArticulation = true,
    stabilizerStrength = 0.5,
    pitchConfig = {},
    onsetConfig = {},
    onProgress,
  } = options;

  onProgress?.(5, '正在讀取音訊檔案...');

  const arrayBuffer = await fileOrBlob.arrayBuffer();

  onProgress?.(20, '正在解碼音訊 PCM 數據...');

  // AudioContext for decoding
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

  const sampleRate = audioBuffer.sampleRate;
  const durationSec = audioBuffer.duration;
  const numChannels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;

  onProgress?.(35, '準備單聲道音訊與聲學過濾...');

  // Convert to mono Float32Array
  const monoData = new Float32Array(length);
  if (numChannels === 1) {
    monoData.set(audioBuffer.getChannelData(0));
  } else {
    const ch0 = audioBuffer.getChannelData(0);
    const ch1 = audioBuffer.getChannelData(1);
    for (let i = 0; i < length; i++) {
      monoData[i] = (ch0[i] + ch1[i]) * 0.5;
    }
  }

  // Calculate peak amplitude and normalize if audio is too quiet
  let maxPeak = 0;
  for (let i = 0; i < length; i += 16) {
    const absVal = Math.abs(monoData[i]);
    if (absVal > maxPeak) maxPeak = absVal;
  }

  // Normalization boost for low-gain mic recordings
  if (maxPeak > 0.001 && maxPeak < 0.25) {
    const targetPeak = 0.65;
    const gainFactor = Math.min(8.0, targetPeak / maxPeak);
    for (let i = 0; i < length; i++) {
      monoData[i] *= gainFactor;
    }
  }

  const waveformPeaks = extractWaveformPeaks(monoData, 80);

  onProgress?.(45, '初始化基頻音高與音頭切分引擎...');

  const effectiveSilenceThreshold = 0.006;

  const pitchDetector = new PitchDetector({
    ...DEFAULT_PITCH_CONFIG,
    sampleRate,
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
    sampleRate,
    silenceThresholdRms: effectiveSilenceThreshold,
    attackRmsDeltaThreshold: 0.018,
    attackRelativeRiseThreshold: 1.8,
    refractoryPeriodMs: 70,
    stabilizerStrength,
    ...onsetConfig,
  });

  onProgress?.(55, '正在逐訊框分析音高與音符切分...');

  // Frame windowing setup
  const frameSize = 2048;
  const hopSize = 512; // ~11.6ms resolution at 44.1kHz
  const frameBuffer = new Float32Array(frameSize);

  let overallPeakRms = 0;
  const totalSteps = Math.ceil((length - frameSize) / hopSize) + 1;
  let currentStep = 0;

  for (let offset = 0; offset < length; offset += hopSize) {
    currentStep++;

    // Fill analysis frame (with zero-padding if near the end of audio)
    for (let i = 0; i < frameSize; i++) {
      const idx = offset + i;
      frameBuffer[i] = idx < length ? monoData[idx] : 0;
    }

    const timestampMs = (offset / sampleRate) * 1000;
    const frameRms = calculateRms(frameBuffer);
    if (frameRms > overallPeakRms) overallPeakRms = frameRms;

    // Detect pitch
    const pitchRes = pitchDetector.detectSmoothed(frameBuffer);

    // Ingest into segmenter
    noteSegmenter.ingestFrame(
      frameBuffer,
      timestampMs,
      pitchRes.isPitched ? pitchRes.frequency : null,
      pitchRes.probability
    );

    // Yield control periodically so UI progress remains responsive
    if (currentStep % 400 === 0) {
      const pct = Math.min(88, Math.round(55 + (currentStep / totalSteps) * 33));
      onProgress?.(pct, `音訊基頻分析中 (${Math.round((offset / length) * 100)}%)...`);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  onProgress?.(90, '正在收束音符與去除短促雜音...');

  const totalDurationMs = durationSec * 1000;
  const raw = noteSegmenter.finalize(totalDurationMs);
  const cleaned = cleanRawSegments(raw, 60, true, absorbArticulation, bpm);

  onProgress?.(96, '量化音符並編排簡譜小節...');

  const transcriptionResult = transcribeAudioSegmentsToMeasures(cleaned, {
    key,
    bpm,
    timeSignature,
    grid,
    octaveShift,
    accidentalPreference,
    scaleMode,
    autoFillTrailingRests: false,
  });

  const audioUrl = URL.createObjectURL(fileOrBlob);

  onProgress?.(100, '轉譜完成！');

  return {
    transcriptionResult,
    rawSegments: cleaned,
    audioDurationSec: Math.round(durationSec * 10) / 10,
    sampleRate,
    peakRms: Math.round(overallPeakRms * 1000) / 1000,
    waveformPeaks,
    audioUrl,
  };
}
