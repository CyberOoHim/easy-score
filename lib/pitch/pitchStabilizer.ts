/**
 * Multi-Stage Pitch Stabilizer & Jitter Suppressor
 *
 * Implements a hybrid audio stabilization pipeline designed for real-time monophonic
 * humming, vocal practice, and score transcription:
 *
 * 1. Adaptive Sliding Median Filter:
 *    Removes single-frame octave jumps, harmonic spikes, and transient acoustic glitches.
 * 2. Exponential Moving Average (EMA Low-Pass Filter):
 *    Smooths continuous pitch trajectories (eliminating 4–7 Hz micro-vibrato needle shaking)
 *    while detecting intentional melodic leaps (>100-120 cents) to prevent microtonal drag.
 * 3. Hysteresis Note-Locking (Schmitt Trigger):
 *    Locks the active semitone and prevents solfege display and quantization from flickering
 *    back and forth when singing near the ±50 cents boundary.
 * 4. Cents Deviation Dampening:
 *    Suppresses needle flutter for a silky, studio-grade visual tuner experience.
 */

import {
  type PitchResult,
  computeMedian,
  frequencyToMidi,
  midiToFrequency,
  frequencyToCents,
  getMidiNoteInfo,
} from './pitchDetector.ts';

export interface PitchStabilizerConfig {
  /**
   * Overall stabilization strength from 0.0 (fast/responsive) to 1.0 (ultra stable).
   * Default: 0.50 (balanced smoothing)
   */
  strength: number;
  sampleRate?: number;
}

export interface StabilizedPitchResult extends PitchResult {
  rawFrequency: number | null;
  rawMidi: number | null;
  rawCentsOff: number;
  isLocked: boolean;
}

export const DEFAULT_STABILIZER_CONFIG: Readonly<PitchStabilizerConfig> = {
  strength: 0.50,
  sampleRate: 44100,
};

export class PitchStabilizer {
  private config: PitchStabilizerConfig;
  private recentPitches: number[] = [];
  private emaFrequency: number | null = null;
  private dampenedCents = 0;
  private lockedMidi: number | null = null;
  private candidateMidi: number | null = null;
  private candidateFrameCount = 0;
  private consecutiveUnpitchedCount = 0;
  private lastVoicedResult: StabilizedPitchResult | null = null;
  private leapCandidateFreq: number | null = null;
  private leapCandidateCount = 0;

  constructor(options?: Partial<PitchStabilizerConfig>) {
    this.config = { ...DEFAULT_STABILIZER_CONFIG, ...options };
    this.clampStrength();
  }

  public setStrength(strength: number): void {
    this.config.strength = strength;
    this.clampStrength();
  }

  public getStrength(): number {
    return this.config.strength;
  }

  public updateConfig(options: Partial<PitchStabilizerConfig>): void {
    this.config = { ...this.config, ...options };
    this.clampStrength();
  }

  public getConfig(): Readonly<PitchStabilizerConfig> {
    return this.config;
  }

  /**
   * Reset all internal filters, history windows, and note locks.
   */
  public reset(): void {
    this.recentPitches = [];
    this.emaFrequency = null;
    this.dampenedCents = 0;
    this.lockedMidi = null;
    this.candidateMidi = null;
    this.candidateFrameCount = 0;
    this.consecutiveUnpitchedCount = 0;
    this.lastVoicedResult = null;
    this.leapCandidateFreq = null;
    this.leapCandidateCount = 0;
  }

  /**
   * Process an instantaneous raw pitch result through the stabilization pipeline.
   */
  public process(rawResult: PitchResult): StabilizedPitchResult {
    const strength = this.config.strength;

    // Handle silence / unpitched frame
    if (!rawResult.isPitched || rawResult.frequency === null) {
      this.consecutiveUnpitchedCount++;

      // 1-frame dropout bridging: if voiced RMS is still active and we have recent pitch, bridge 1 frame
      if (
        this.consecutiveUnpitchedCount === 1 &&
        this.lastVoicedResult !== null &&
        rawResult.rms >= 0.005
      ) {
        return {
          ...this.lastVoicedResult,
          rms: rawResult.rms,
          probability: Math.min(this.lastVoicedResult.probability, 0.5),
        };
      }

      // If unpitched for 3 or more consecutive frames, clear history and note locks
      if (this.consecutiveUnpitchedCount >= 3) {
        this.reset();
      }

      return {
        ...rawResult,
        rawFrequency: rawResult.frequency,
        rawMidi: rawResult.nearestMidi,
        rawCentsOff: rawResult.centsOffNearestMidi,
        isLocked: false,
      };
    }

    this.consecutiveUnpitchedCount = 0;
    let freq = rawResult.frequency;

    // -------------------------------------------------------------
    // Stage 1: Octave Continuity Guard & Adaptive Median Filter
    // -------------------------------------------------------------
    if (this.recentPitches.length >= 2) {
      const historyMedian = computeMedian(this.recentPitches);
      const ratio = freq / historyMedian;
      if (ratio >= 1.85 && ratio <= 2.15) {
        freq = freq / 2; // Correct harmonic octave jump
      } else if (ratio >= 0.45 && ratio <= 0.55 && freq * 2 <= 2200) {
        freq = freq * 2; // Correct subharmonic drop
      }

      // Intentional melodic leap detection:
      // If the incoming pitch deviates by >= 110 cents from recent history median
      const centsFromMedian = Math.abs(frequencyToCents(freq, historyMedian));
      if (centsFromMedian >= 110) {
        if (
          this.leapCandidateFreq !== null &&
          Math.abs(frequencyToCents(freq, this.leapCandidateFreq)) < 60
        ) {
          this.leapCandidateCount++;
        } else {
          this.leapCandidateFreq = freq;
          this.leapCandidateCount = 1;
        }

        // On 2 consecutive frames of an intentional leap, flush old note history
        if (this.leapCandidateCount >= 2) {
          this.recentPitches = [freq];
          this.emaFrequency = freq;
          this.lockedMidi = Math.round(frequencyToMidi(freq));
          this.candidateMidi = null;
          this.candidateFrameCount = 0;
          this.leapCandidateFreq = null;
          this.leapCandidateCount = 0;
        }
      } else {
        this.leapCandidateFreq = null;
        this.leapCandidateCount = 0;
      }
    }

    // Median window size: scales from 1 (at 0.0) up to 13 (at 1.0)
    const windowSize = Math.max(1, (1 + 2 * Math.floor(strength * 6)) | 1);
    this.recentPitches.push(freq);
    while (this.recentPitches.length > windowSize) {
      this.recentPitches.shift();
    }

    const medianFreq = computeMedian(this.recentPitches);

    // -------------------------------------------------------------
    // Stage 2: Exponential Moving Average (EMA) with Fast-Leap Snap
    // -------------------------------------------------------------
    let smoothedFreq = medianFreq;
    if (this.emaFrequency === null) {
      this.emaFrequency = medianFreq;
      smoothedFreq = medianFreq;
    } else {
      const centsDiff = Math.abs(frequencyToCents(medianFreq, this.emaFrequency));
      // Fast leap check: if there is a deliberate note transition (>110 cents),
      // snap immediately to avoid sluggish microtonal gliding between melodic notes
      if (centsDiff >= 110) {
        this.emaFrequency = medianFreq;
        smoothedFreq = medianFreq;
      } else {
        // Alpha scales from 0.95 (at 0.0 strength, instant) down to 0.15 (at 1.0 strength, ultra smooth)
        const alpha = Math.max(0.15, 0.95 - strength * 0.80);
        this.emaFrequency = alpha * medianFreq + (1 - alpha) * this.emaFrequency;
        smoothedFreq = this.emaFrequency;
      }
    }

    // -------------------------------------------------------------
    // Stage 3: Hysteresis Note-Locking (Schmitt Trigger)
    // -------------------------------------------------------------
    const fractionalMidi = frequencyToMidi(smoothedFreq);
    const rawNearestMidi = Math.round(fractionalMidi);

    if (this.lockedMidi === null) {
      this.lockedMidi = rawNearestMidi;
      this.candidateMidi = null;
      this.candidateFrameCount = 0;
    } else {
      const lockedCenterFreq = midiToFrequency(this.lockedMidi);
      const devFromLocked = frequencyToCents(smoothedFreq, lockedCenterFreq);

      // Expand boundary beyond ±50 cents by hysteresis margin:
      // strength 0.0 -> 50 cents (raw standard boundary)
      // strength 0.5 -> 62.5 cents
      // strength 1.0 -> 75 cents
      const hysteresisThreshold = 50 + strength * 25;

      if (Math.abs(devFromLocked) > hysteresisThreshold) {
        // Pitch has drifted convincingly past the hysteresis boundary
        const targetMidi = rawNearestMidi;
        if (targetMidi === this.candidateMidi) {
          this.candidateFrameCount++;
        } else {
          this.candidateMidi = targetMidi;
          this.candidateFrameCount = 1;
        }

        // Required confirmation frames before breaking lock
        const requiredFrames = strength <= 0.3 ? 1 : strength <= 0.7 ? 2 : 3;
        if (this.candidateFrameCount >= requiredFrames) {
          this.lockedMidi = this.candidateMidi;
          this.candidateMidi = null;
          this.candidateFrameCount = 0;
        }
      } else {
        // Voice is safely within the hysteresis boundary of the locked note
        this.candidateMidi = null;
        this.candidateFrameCount = 0;
      }
    }

    const activeMidi = this.lockedMidi ?? rawNearestMidi;
    const activeNoteFreq = midiToFrequency(activeMidi);
    const noteInfo = getMidiNoteInfo(activeNoteFreq);

    // -------------------------------------------------------------
    // Stage 4: Needle Cents Deviation Dampening
    // -------------------------------------------------------------
    const currentCentsOffLocked = frequencyToCents(smoothedFreq, activeNoteFreq);
    const clampedCents = Math.max(-50, Math.min(50, currentCentsOffLocked));

    // Beta smoothing for UI needle: 0.90 at 0.0 -> 0.25 at 1.0
    const beta = Math.max(0.25, 0.90 - strength * 0.65);
    this.dampenedCents = beta * clampedCents + (1 - beta) * this.dampenedCents;

    const result: StabilizedPitchResult = {
      frequency: Math.round(smoothedFreq * 100) / 100,
      probability: rawResult.probability,
      isPitched: true,
      tau: rawResult.tau,
      rms: rawResult.rms,
      nearestMidi: activeMidi,
      noteName: noteInfo?.noteName ?? rawResult.noteName,
      centsOffNearestMidi: Math.round(this.dampenedCents * 10) / 10,
      rawFrequency: rawResult.frequency,
      rawMidi: rawResult.nearestMidi,
      rawCentsOff: rawResult.centsOffNearestMidi,
      isLocked: this.lockedMidi !== null,
    };

    this.lastVoicedResult = result;
    return result;
  }

  private clampStrength(): void {
    if (!Number.isFinite(this.config.strength)) {
      this.config.strength = 0.50;
    } else {
      this.config.strength = Math.max(0, Math.min(1, this.config.strength));
    }
  }
}
