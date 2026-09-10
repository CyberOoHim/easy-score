/**
 * Smart Tempo Tracker & Downbeat Alignment Engine
 *
 * Provides client-side automated beat-tracking, tempo estimation (BPM),
 * confidence scoring, and downbeat phase alignment for uploaded audio and
 * musical transcription.
 *
 * Key Capabilities:
 * 1. Dual-Evidence Tempo Estimation:
 *    - Spectral & RMS Onset Novelty autocorrelation with multi-harmonic comb filtering.
 *    - Inter-Onset Interval (IOI) histogram clustering from note onsets.
 *    - Human vocal/performance tempo prior (70-130 BPM) to eliminate half/double tempo errors.
 * 2. Downbeat & Phase Alignment (t₀):
 *    - Pinpoints the metric downbeat (Beat 1) relative to audio onset.
 *    - Distinguishes direct starts from pickup / anacrusis measures (弱起拍).
 *    - Quantizes grid offset so transcribed measures cleanly match the musical phrasing.
 */

export interface TempoEstimationResult {
  bpm: number;
  confidence: number;            // 0.0 to 1.0 (e.g. 0.88 = 88% confidence)
  beatIntervalSec: number;       // Seconds per quarter beat (e.g. 0.6s at 100 BPM)
  downbeatOffsetSec: number;     // Time in seconds where Beat 1 aligns
  isPickup: boolean;             // True if the song begins on an upbeat (anacrusis)
  pickupBeats: number;           // Number of pickup beats (e.g. 1.0 beat before bar 1)
  timeSignature: string;         // Meter used for alignment (e.g. '4/4', '3/4')
  suggestedBpm: number;          // Rounded integer BPM
}

export interface NoteOnsetCandidate {
  startTimeSeconds: number;
  durationSeconds?: number;
  amplitude?: number;
  pitchMidi?: number;
}

export interface TempoEstimatorOptions {
  minBpm?: number;               // Minimum tempo to consider (default: 50)
  maxBpm?: number;               // Maximum tempo to consider (default: 190)
  expectedMeter?: string;        // '4/4', '3/4', '2/4', '6/8' (default: '4/4')
  tempoPriorBpm?: number;        // Center of prior weighting (default: 96)
  tempoPriorSpread?: number;     // Spread of prior in octaves (default: 0.40)
}

/**
 * Computes a downsampled onset novelty energy curve from mono PCM audio.
 * Hop size is chosen to yield ~100 frames per second (10ms resolution).
 */
export function computeOnsetNoveltyCurve(
  monoPcm: Float32Array,
  sampleRate: number
): { novelty: Float32Array; fps: number } {
  const fps = 100; // 10ms per frame
  const hopSize = Math.max(64, Math.floor(sampleRate / fps));
  const frameSize = hopSize * 2;
  const numFrames = Math.floor((monoPcm.length - frameSize) / hopSize);

  if (numFrames <= 10) {
    return { novelty: new Float32Array(0), fps };
  }

  const novelty = new Float32Array(numFrames);
  let prevEnergy = 0;

  for (let f = 0; f < numFrames; f++) {
    const start = f * hopSize;
    let sumSquares = 0;
    for (let i = 0; i < frameSize; i += 2) {
      const val = monoPcm[start + i];
      sumSquares += val * val;
    }
    const currentEnergy = Math.sqrt(sumSquares / (frameSize / 2));

    // First-order difference half-wave rectified
    const diff = currentEnergy - prevEnergy;
    novelty[f] = diff > 0 ? diff : 0;
    prevEnergy = currentEnergy;
  }

  // Smooth novelty curve slightly with 3-point moving average to remove jitter
  const smoothed = new Float32Array(numFrames);
  for (let f = 1; f < numFrames - 1; f++) {
    smoothed[f] = (novelty[f - 1] + 2 * novelty[f] + novelty[f + 1]) * 0.25;
  }

  // Normalize peak to 1.0
  let maxVal = 0;
  for (let f = 0; f < numFrames; f++) {
    if (smoothed[f] > maxVal) maxVal = smoothed[f];
  }
  if (maxVal > 1e-5) {
    const invMax = 1.0 / maxVal;
    for (let f = 0; f < numFrames; f++) {
      smoothed[f] *= invMax;
    }
  }

  return { novelty: smoothed, fps };
}

/**
 * Calculates human tempo prior probability weight for candidate BPM.
 * Discourages octave errors (e.g. 50 BPM when actually 100, or 200 when actually 100).
 */
function getTempoPrior(bpm: number, centerBpm: number = 96, spread: number = 0.45): number {
  const logRatio = Math.log2(bpm / centerBpm);
  return Math.exp(-0.5 * Math.pow(logRatio / spread, 2));
}

/**
 * Analyzes Inter-Onset Intervals (IOIs) from detected note events.
 * Returns candidate beat periods with cluster weights.
 */
export function analyzeInterOnsetIntervals(
  notes: NoteOnsetCandidate[],
  minBpm: number = 50,
  maxBpm: number = 190
): Map<number, number> {
  const minInterval = 60 / maxBpm; // e.g. 0.315s
  const maxInterval = 60 / minBpm; // e.g. 1.20s

  const ioiScores = new Map<number, number>();
  if (!notes || notes.length < 3) return ioiScores;

  // Filter notes that have meaningful amplitude
  const sorted = [...notes].sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);

  for (let i = 0; i < sorted.length - 1; i++) {
    const tA = sorted[i].startTimeSeconds;
    const ampA = sorted[i].amplitude ?? 0.5;

    // Check next 6 subsequent notes
    for (let j = i + 1; j < Math.min(sorted.length, i + 7); j++) {
      const tB = sorted[j].startTimeSeconds;
      const ampB = sorted[j].amplitude ?? 0.5;
      const deltaT = tB - tA;

      if (deltaT < 0.15) continue; // ignore grace note or flame jitter
      if (deltaT > maxInterval * 2.5) break;

      // Candidate fundamental beat intervals from deltaT:
      // deltaT could be 1 beat, 0.5 beat (eighth), 2 beats (half), 1.5 beats (dotted)
      const testMultipliers = [1.0, 0.5, 2.0, 1.5, 0.75, 3.0];
      for (const mult of testMultipliers) {
        const candidateBeatSec = deltaT / mult;
        if (candidateBeatSec >= minInterval && candidateBeatSec <= maxInterval) {
          const candidateBpm = Math.round(60 / candidateBeatSec);
          const weight = (ampA + ampB) * 0.5 * (mult === 1.0 ? 1.0 : 0.6);
          ioiScores.set(candidateBpm, (ioiScores.get(candidateBpm) || 0) + weight);
        }
      }
    }
  }

  return ioiScores;
}

/**
 * Estimates Tempo (BPM), Confidence, and Downbeat alignment using
 * audio PCM data and/or Basic Pitch detected note onsets.
 */
export function estimateAudioTempo(
  monoPcm: Float32Array | null,
  sampleRate: number,
  notes: NoteOnsetCandidate[] = [],
  options: TempoEstimatorOptions = {}
): TempoEstimationResult {
  const {
    minBpm = 52,
    maxBpm = 185,
    expectedMeter = '4/4',
    tempoPriorBpm = 96,
    tempoPriorSpread = 0.45,
  } = options;

  let novelty: Float32Array = new Float32Array(0);
  let fps = 100;

  if (monoPcm && monoPcm.length > sampleRate * 1.5) {
    const res = computeOnsetNoveltyCurve(monoPcm, sampleRate);
    novelty = res.novelty;
    fps = res.fps;
  }

  // Also build an onset curve directly from Basic Pitch note starts if available
  if (notes.length >= 3) {
    const totalTimeSec = notes.reduce((max, n) => {
      const end = n.startTimeSeconds + (n.durationSeconds ?? 0.5);
      return end > max ? end : max;
    }, 0);

    const bpFrames = Math.ceil(totalTimeSec * fps) + 50;
    const bpNovelty = new Float32Array(bpFrames);

    for (const note of notes) {
      const idx = Math.round(note.startTimeSeconds * fps);
      if (idx >= 0 && idx < bpFrames) {
        const weight = Math.max(0.2, Math.min(1.0, note.amplitude ?? 0.7));
        bpNovelty[idx] += weight;
        if (idx + 1 < bpFrames) bpNovelty[idx + 1] += weight * 0.5;
        if (idx - 1 >= 0) bpNovelty[idx - 1] += weight * 0.5;
      }
    }

    // Blend with acoustic novelty if available, or use bpNovelty directly
    if (novelty.length >= bpFrames) {
      for (let i = 0; i < bpFrames; i++) {
        novelty[i] = novelty[i] * 0.5 + bpNovelty[i] * 0.5;
      }
    } else if (novelty.length === 0) {
      novelty = bpNovelty;
    }
  }

  // Autocorrelation over BPM search range
  const candidateScores: Array<{ bpm: number; score: number }> = [];
  const ioiMap = analyzeInterOnsetIntervals(notes, minBpm, maxBpm);

  let bestBpm = 80;
  let bestScore = -1;
  let medianScoreAcc = 0;
  let scoreCount = 0;

  if (novelty.length > fps * 2) {
    const maxLag = Math.floor((60 / minBpm) * fps);
    const minLag = Math.floor((60 / maxBpm) * fps);

    for (let bpm = minBpm; bpm <= maxBpm; bpm++) {
      const lag = (60 / bpm) * fps;
      const intLag = Math.round(lag);

      if (intLag < minLag || intLag > maxLag) continue;

      // Autocorrelation: R(lag)
      let autocorrSum = 0;
      let count = 0;
      const maxT = Math.min(novelty.length - intLag, fps * 30); // sample up to 30s
      const step = 2;

      for (let t = 0; t < maxT; t += step) {
        autocorrSum += novelty[t] * novelty[t + intLag];
        count++;
      }
      const r1 = count > 0 ? autocorrSum / count : 0;

      // Harmonic comb resonance (multi-tempo reinforcement)
      // Checks 2x period and 0.5x period to reward consistent pulses
      const lag2 = Math.round(lag * 2);
      let r2 = 0;
      if (lag2 < novelty.length / 2) {
        let sum2 = 0;
        let c2 = 0;
        for (let t = 0; t < Math.min(novelty.length - lag2, fps * 20); t += step) {
          sum2 += novelty[t] * novelty[t + lag2];
          c2++;
        }
        r2 = c2 > 0 ? sum2 / c2 : 0;
      }

      const lagHalf = Math.round(lag * 0.5);
      let rHalf = 0;
      if (lagHalf > 2) {
        let sumH = 0;
        let cH = 0;
        for (let t = 0; t < Math.min(novelty.length - lagHalf, fps * 20); t += step) {
          sumH += novelty[t] * novelty[t + lagHalf];
          cH++;
        }
        rHalf = cH > 0 ? sumH / cH : 0;
      }

      // Comb score
      const combScore = r1 + 0.5 * r2 + 0.35 * rHalf;

      // IOI bonus from discrete note onsets
      const ioiBonus = (ioiMap.get(bpm) || 0) * 0.08;

      // Human vocal singing tempo prior
      const prior = getTempoPrior(bpm, tempoPriorBpm, tempoPriorSpread);

      const totalScore = (combScore + ioiBonus) * prior;
      candidateScores.push({ bpm, score: totalScore });

      medianScoreAcc += totalScore;
      scoreCount++;

      if (totalScore > bestScore) {
        bestScore = totalScore;
        bestBpm = bpm;
      }
    }
  } else if (ioiMap.size > 0) {
    // Fallback purely on IOI if audio too short for continuous autocorrelation
    for (const [bpm, score] of ioiMap.entries()) {
      const prior = getTempoPrior(bpm, tempoPriorBpm, tempoPriorSpread);
      const totalScore = score * prior;
      candidateScores.push({ bpm, score: totalScore });
      if (totalScore > bestScore) {
        bestScore = totalScore;
        bestBpm = bpm;
      }
    }
  }

  // Calculate confidence: winning peak relative to mean candidate score
  const meanScore = scoreCount > 0 ? medianScoreAcc / scoreCount : 0.01;
  const rawConfidence = meanScore > 0 ? (bestScore - meanScore) / (bestScore + 1e-6) : 0.5;
  const confidence = Math.max(0.15, Math.min(0.98, Math.round(rawConfidence * 100) / 100));

  // Determine beats per measure from meter
  const meterParts = expectedMeter.split('/');
  const beatsPerMeasure = parseInt(meterParts[0], 10) || 4;
  const beatIntervalSec = 60 / bestBpm;
  const barIntervalSec = beatIntervalSec * beatsPerMeasure;

  // --------------------------------------------------------------------------
  // Downbeat & Phase Alignment (t0)
  // --------------------------------------------------------------------------
  let downbeatOffsetSec = 0;
  let isPickup = false;
  let pickupBeats = 0;

  if (notes.length > 0) {
    const firstVoiced = notes.find(n => (n.amplitude ?? 0.5) > 0.05) || notes[0];
    const firstOnset = firstVoiced.startTimeSeconds;

    // Search for optimal phase offset phi in [0, beatIntervalSec)
    // that aligns periodic downbeat trains with prominent onsets
    let bestPhase = 0;
    let bestPhaseScore = -1;
    const phaseSteps = 20;

    for (let s = 0; s < phaseSteps; s++) {
      const phi = (s / phaseSteps) * beatIntervalSec;
      let phaseScore = 0;

      for (const note of notes) {
        const t = note.startTimeSeconds;
        const phaseDiff = Math.abs(((t - phi) % beatIntervalSec + beatIntervalSec) % beatIntervalSec);
        const distToBeat = Math.min(phaseDiff, beatIntervalSec - phaseDiff);
        // Reward notes that land closely on the beat
        if (distToBeat < beatIntervalSec * 0.15) {
          phaseScore += (note.amplitude ?? 0.5) * (1 - distToBeat / (beatIntervalSec * 0.15));
        }
      }

      if (phaseScore > bestPhaseScore) {
        bestPhaseScore = phaseScore;
        bestPhase = phi;
      }
    }

    // Now align downbeat (Bar 1, Beat 1) relative to first note onset
    // We want Bar 1 to start near the first note
    // If the first note starts after a lead-in silence:
    const beatsBeforeFirst = (firstOnset - bestPhase) / beatIntervalSec;
    const wholeBarsBefore = Math.floor(beatsBeforeFirst / beatsPerMeasure);
    const remainderBeats = beatsBeforeFirst - (wholeBarsBefore * beatsPerMeasure);

    // If remainderBeats is close to 0 (< 0.35 beat), note starts on Beat 1 (downbeat)
    if (remainderBeats < 0.35) {
      downbeatOffsetSec = Math.max(0, bestPhase + wholeBarsBefore * barIntervalSec);
      isPickup = false;
      pickupBeats = 0;
    } else if (remainderBeats >= beatsPerMeasure - 0.75) {
      // Very close to next bar downbeat
      downbeatOffsetSec = Math.max(0, bestPhase + (wholeBarsBefore + 1) * barIntervalSec);
      isPickup = false;
      pickupBeats = 0;
    } else {
      // Starts on a pickup / upbeat!
      // Example in 4/4: remainder is 3 beats (starts on beat 4) -> 1 beat pickup
      const beatsUntilBar1 = beatsPerMeasure - remainderBeats;
      if (beatsUntilBar1 <= 2.2) {
        isPickup = true;
        pickupBeats = Math.round(beatsUntilBar1 * 2) / 2; // snap to nearest half beat
        downbeatOffsetSec = Math.max(0, bestPhase + (wholeBarsBefore + 1) * barIntervalSec);
      } else {
        downbeatOffsetSec = Math.max(0, bestPhase + wholeBarsBefore * barIntervalSec);
        isPickup = false;
        pickupBeats = 0;
      }
    }
  }

  return {
    bpm: bestBpm,
    suggestedBpm: bestBpm,
    confidence,
    beatIntervalSec: Math.round(beatIntervalSec * 1000) / 1000,
    downbeatOffsetSec: Math.round(downbeatOffsetSec * 1000) / 1000,
    isPickup,
    pickupBeats,
    timeSignature: expectedMeter,
  };
}
