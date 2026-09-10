/**
 * Autocorrelation Vocal & Monophonic Pitch Detection Algorithm
 *
 * Implements time-domain pitch tracking using the Difference Function,
 * Cumulative Mean Normalized Difference Function (CMNDF), multi-trough
 * thresholding, and parabolic peak interpolation.
 *
 * Optimized for real-time monophonic vocal humming and acoustic traditional
 * instruments (Bamboo Flute, Erhu, Acoustic Guitar).
 */

export interface PitchDetectorConfig {
  sampleRate: number;         // Audio sample rate in Hz (default: 44100)
  threshold: number;          // Dip threshold for CMNDF (default: 0.15)
  minFrequency: number;       // Lowest expected fundamental f0 in Hz (default: 65 Hz ~ C2)
  maxFrequency: number;       // Highest expected fundamental f0 in Hz (default: 2000 Hz ~ B6)
  silenceThreshold: number;   // Linear RMS energy below which frame is silence (default: 0.008 ~ -42dB)
  fallbackThreshold: number;  // Max CMNDF value allowed when taking global minimum (default: 0.40)
  medianFilterSize: number;   // Sliding window size for micro-vibrato smoothing (default: 5)
  stabilizerStrength?: number;// Pitch stabilizer strength 0.0 to 1.0 (default: 0.50)
}

export interface PitchResult {
  frequency: number | null;   // Detected fundamental frequency f0 in Hz, or null if unvoiced
  probability: number;        // Confidence score between 0.0 and 1.0
  isPitched: boolean;         // True if voiced note above probability & energy threshold
  tau: number | null;         // Fundamental period in sample units
  rms: number;                // Root-mean-square amplitude of analysis window
  centsOffNearestMidi: number;// Tuning deviation in cents (-50 to +50)
  nearestMidi: number | null; // Nearest integer MIDI note number (e.g. 69 for A4)
  noteName: string | null;    // Scientific pitch notation (e.g. "A4", "C#5")
}

export interface MidiNoteInfo {
  midi: number;
  frequency: number;
  noteName: string;
  octave: number;
  pitchClass: string;
  centsOff: number;
}

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export const DEFAULT_PITCH_CONFIG: Readonly<PitchDetectorConfig> = {
  sampleRate: 44100,
  threshold: 0.15,
  minFrequency: 65,
  maxFrequency: 2000,
  silenceThreshold: 0.008,
  fallbackThreshold: 0.40,
  medianFilterSize: 5,
  stabilizerStrength: 0.50,
};

export {
  PitchStabilizer,
  type PitchStabilizerConfig,
  type StabilizedPitchResult,
  DEFAULT_STABILIZER_CONFIG,
} from './pitchStabilizer';

/**
 * Calculate RMS amplitude of an audio buffer.
 */
export function calculateRms(buffer: Float32Array | number[]): number {
  if (buffer.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < buffer.length; i++) {
    sumSq += buffer[i] * buffer[i];
  }
  return Math.sqrt(sumSq / buffer.length);
}

/**
 * Convert frequency in Hz to fractional MIDI note number (A4 = 440Hz -> MIDI 69).
 */
export function frequencyToMidi(frequency: number): number {
  if (frequency <= 0) return 0;
  return 69 + 12 * Math.log2(frequency / 440);
}

/**
 * Convert MIDI note number to frequency in Hz.
 */
export function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Calculate deviation in cents between two frequencies.
 */
export function frequencyToCents(frequency: number, referenceFrequency: number): number {
  if (frequency <= 0 || referenceFrequency <= 0) return 0;
  return 1200 * Math.log2(frequency / referenceFrequency);
}

/**
 * Resolve detailed pitch information for a frequency in Hz.
 */
export function getMidiNoteInfo(frequency: number): MidiNoteInfo | null {
  if (frequency <= 0 || !Number.isFinite(frequency)) return null;

  const fractionalMidi = frequencyToMidi(frequency);
  const roundedMidi = Math.round(fractionalMidi);
  const exactNoteFreq = midiToFrequency(roundedMidi);
  const centsOff = Math.round(frequencyToCents(frequency, exactNoteFreq) * 10) / 10;

  const pitchClassIndex = ((roundedMidi % 12) + 12) % 12;
  const octave = Math.floor(roundedMidi / 12) - 1;
  const pitchClass = NOTE_NAMES[pitchClassIndex];
  const noteName = `${pitchClass}${octave}`;

  return {
    midi: roundedMidi,
    frequency: exactNoteFreq,
    noteName,
    octave,
    pitchClass,
    centsOff,
  };
}

/**
 * Compute the running median of an array of numbers.
 */
export function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * Pure function: Detect pitch on an audio buffer using autocorrelation difference algorithm.
 */
export function detectPitch(
  buffer: Float32Array | number[],
  options?: Partial<PitchDetectorConfig>
): PitchResult {
  const config: PitchDetectorConfig = { ...DEFAULT_PITCH_CONFIG, ...options };
  const {
    sampleRate,
    threshold,
    minFrequency,
    maxFrequency,
    silenceThreshold,
    fallbackThreshold,
  } = config;

  const emptyResult = (rms: number): PitchResult => ({
    frequency: null,
    probability: 0,
    isPitched: false,
    tau: null,
    rms,
    centsOffNearestMidi: 0,
    nearestMidi: null,
    noteName: null,
  });

  const bufferLength = buffer.length;
  if (bufferLength < 64) {
    return emptyResult(0);
  }

  // Pre-check: RMS energy gating
  const rms = calculateRms(buffer);
  if (rms < silenceThreshold) {
    return emptyResult(rms);
  }

  // Half-buffer integration window size W
  const halfBufferSize = Math.floor(bufferLength / 2);

  // Period tau boundaries in sample units
  // f = sampleRate / tau -> tau = sampleRate / f
  const tauMin = Math.max(2, Math.floor(sampleRate / maxFrequency));
  const tauMax = Math.min(halfBufferSize - 1, Math.floor(sampleRate / minFrequency));

  if (tauMax <= tauMin) {
    return emptyResult(rms);
  }

  // Step 1: Difference function d(tau) = sum_{j=0}^{W-1} (x[j] - x[j + tau])^2
  const diff = new Float32Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let j = 0; j < halfBufferSize; j++) {
      const delta = buffer[j] - buffer[j + tau];
      sum += delta * delta;
    }
    diff[tau] = sum;
  }

  // Step 2: Cumulative Mean Normalized Difference Function (CMNDF)
  const cmndf = new Float32Array(tauMax + 1);
  cmndf[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    runningSum += diff[tau];
    if (runningSum <= 1e-12) {
      cmndf[tau] = 1;
    } else {
      cmndf[tau] = (diff[tau] * tau) / runningSum;
    }
  }

  // Step 3: Multi-Trough Peak Search & Thresholding
  // Search for the first local minimum below threshold (prevents subharmonic octave drops)
  let tauCandidate = -1;
  let minCmndfVal = 1.0;

  interface LocalTrough {
    tau: number;
    val: number;
  }
  const troughs: LocalTrough[] = [];

  for (let tau = tauMin + 1; tau < tauMax; tau++) {
    if (cmndf[tau] < cmndf[tau - 1] && cmndf[tau] <= cmndf[tau + 1]) {
      troughs.push({ tau, val: cmndf[tau] });
    }
  }

  // 3a. First local minimum below absolute threshold
  for (const trough of troughs) {
    if (trough.val < threshold) {
      tauCandidate = trough.tau;
      minCmndfVal = trough.val;
      break;
    }
  }

  // 3b. If no trough below threshold, look for first trough below fallbackThreshold
  if (tauCandidate === -1) {
    for (const trough of troughs) {
      if (trough.val <= fallbackThreshold) {
        tauCandidate = trough.tau;
        minCmndfVal = trough.val;
        break;
      }
    }
  }

  // 3c. If still not found, check global minimum across all troughs or range
  if (tauCandidate === -1) {
    let globalMinTau = tauMin;
    let globalMinVal = cmndf[tauMin];
    for (let tau = tauMin + 1; tau <= tauMax; tau++) {
      if (cmndf[tau] < globalMinVal) {
        globalMinVal = cmndf[tau];
        globalMinTau = tau;
      }
    }

    const effectiveMaxFallback = Math.max(0.55, fallbackThreshold);
    if (globalMinVal <= effectiveMaxFallback) {
      tauCandidate = globalMinTau;
      minCmndfVal = globalMinVal;
    }
  }

  // 3d. Subharmonic / Octave Halving Correction:
  if (tauCandidate > 2 * tauMin) {
    const halfTau = Math.round(tauCandidate / 2);
    for (let t = Math.max(tauMin, halfTau - 2); t <= Math.min(tauMax, halfTau + 2); t++) {
      if (cmndf[t] < threshold + 0.08 || cmndf[t] <= minCmndfVal * 1.35 + 0.04) {
        if (t > tauMin && t < tauMax && cmndf[t] <= cmndf[t - 1] && cmndf[t] <= cmndf[t + 1]) {
          tauCandidate = t;
          minCmndfVal = cmndf[t];
          break;
        }
      }
    }
  }

  // If no candidate met reliability criteria, return unpitched
  if (tauCandidate === -1 || tauCandidate <= 0) {
    return emptyResult(rms);
  }

  // Step 4: Parabolic Interpolation for Sub-Bin Pitch Resolution
  let refinedTau: number = tauCandidate;
  if (tauCandidate > 1 && tauCandidate < tauMax) {
    const alpha = cmndf[tauCandidate - 1];
    const beta = cmndf[tauCandidate];
    const gamma = cmndf[tauCandidate + 1];
    const denominator = 2 * (alpha - 2 * beta + gamma);

    if (Math.abs(denominator) > 1e-9) {
      const delta = (alpha - gamma) / denominator;
      if (Math.abs(delta) <= 1.0) {
        refinedTau = tauCandidate + delta;
      }
    }
  }

  if (refinedTau <= 0) {
    return emptyResult(rms);
  }

  const frequency = sampleRate / refinedTau;

  // Validate bounds
  if (frequency < minFrequency || frequency > maxFrequency) {
    return emptyResult(rms);
  }

  // Periodicity / confidence score
  const probability = Math.max(0, Math.min(1, 1 - minCmndfVal));
  const isPitched = probability >= (1 - fallbackThreshold);

  const noteInfo = getMidiNoteInfo(frequency);

  return {
    frequency: Math.round(frequency * 100) / 100,
    probability: Math.round(probability * 1000) / 1000,
    isPitched,
    tau: Math.round(refinedTau * 100) / 100,
    rms: Math.round(rms * 10000) / 10000,
    centsOffNearestMidi: noteInfo?.centsOff ?? 0,
    nearestMidi: noteInfo?.midi ?? null,
    noteName: noteInfo?.noteName ?? null,
  };
}

import { PitchStabilizer, type StabilizedPitchResult } from './pitchStabilizer';

/**
 * Stateful Pitch Detector with multi-stage pitch stabilization
 * (adaptive median filtering, EMA low-pass, Schmitt trigger hysteresis, and needle dampening).
 */
export class PitchDetector {
  private config: PitchDetectorConfig;
  private stabilizer: PitchStabilizer;

  constructor(options?: Partial<PitchDetectorConfig>) {
    this.config = { ...DEFAULT_PITCH_CONFIG, ...options };
    this.stabilizer = new PitchStabilizer({
      strength: this.config.stabilizerStrength ?? 0.50,
      sampleRate: this.config.sampleRate,
    });
  }

  public updateConfig(options: Partial<PitchDetectorConfig>): void {
    this.config = { ...this.config, ...options };
    if (options.stabilizerStrength !== undefined) {
      this.stabilizer.setStrength(options.stabilizerStrength);
    }
    if (options.sampleRate !== undefined) {
      this.stabilizer.updateConfig({ sampleRate: options.sampleRate });
    }
  }

  public setStabilizerStrength(strength: number): void {
    this.config.stabilizerStrength = strength;
    this.stabilizer.setStrength(strength);
  }

  public getStabilizerStrength(): number {
    return this.stabilizer.getStrength();
  }

  public getStabilizer(): PitchStabilizer {
    return this.stabilizer;
  }

  public getConfig(): Readonly<PitchDetectorConfig> {
    return this.config;
  }

  /**
   * Reset internal pitch tracking history and stabilizer state.
   */
  public reset(): void {
    this.stabilizer.reset();
  }

  /**
   * Detect raw instantaneous pitch on an audio buffer.
   */
  public detect(buffer: Float32Array | number[]): PitchResult {
    return detectPitch(buffer, this.config);
  }

  /**
   * Detect pitch with multi-stage stabilization (adaptive median, EMA low-pass,
   * Schmitt trigger hysteresis note-locking, and needle dampening).
   */
  public detectSmoothed(buffer: Float32Array | number[]): StabilizedPitchResult {
    const rawResult = this.detect(buffer);
    return this.stabilizer.process(rawResult);
  }
}
