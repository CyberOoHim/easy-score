'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  KeySignature,
  Measure,
  NumberedNotationNote,
  PitchNumber,
  Song,
  TimeSignature,
  InstrumentType,
} from '@/types/song';
import { AudioEngine } from '@/lib/audioEngine';
import {
  KeyEventEngine,
  QwertyMappingMode,
  ActiveNoteState,
} from '@/lib/keyboard/keyEventEngine';
import { useWebMidi } from '@/lib/keyboard/webMidi';
import {
  PitchDetector,
  PitchDetectorConfig,
  getMidiNoteInfo,
  calculateRms,
  NOTE_NAMES,
  frequencyToCents,
  midiToFrequency,
} from '@/lib/pitch/pitchDetector';
import {
  NoteSegmenter,
  OnsetDetectorConfig,
  RawNoteSegment,
} from '@/lib/pitch/onsetDetector';
import {
  transcribeAudioSegmentsToMeasures,
  transcribeKeyboardSegmentsToMeasures,
  QuantizeGrid,
  ScaleMode,
  shiftOctaves,
  cleanRawSegments,
  midiToNumberedPitch,
  frequencyToNumberedPitch,
  TranscriptionResult,
} from '@/lib/pitch/scoreQuantizer';
import { wakeLockManager } from '@/lib/wakeLock';
import { CHROMATIC_KEYS, STANDARD_TIME_SIGNATURES } from '@/lib/taigiUtils';
import { NumberedNotationNoteComponent } from '@/components/NumberedNotationNoteComponent';
import { PianoBed, OctaveBedView } from './PianoBed';
import {
  Mic,
  Mic2,
  Keyboard,
  Square,
  Play,
  Pause,
  RotateCcw,
  Check,
  X,
  Volume2,
  VolumeX,
  SlidersHorizontal,
  Sparkles,
  ChevronDown,
  ArrowUp,
  ArrowDown,
  Music2,
  Activity,
  Radio,
  Clock,
  Layers,
  HelpCircle,
  Delete,
  Headphones,
  Target,
} from 'lucide-react';

export type StudioTranscriptionMode = 'hum' | 'keyboard';
export type DeckStep = 'SETUP' | 'COUNTING_IN' | 'RECORDING' | 'REVIEW';
export type InsertionMode = 'cursor' | 'append' | 'replace';

export type InstrumentPresetId = 'vocal' | 'flute' | 'cello' | 'guitar' | 'erhu';

export interface InstrumentPresetConfig {
  id: InstrumentPresetId;
  name: string;
  nameZh: string;
  icon: string;
  description: string;
  tips: string;
  pitchConfig: Partial<PitchDetectorConfig>;
  onsetConfig: Partial<OnsetDetectorConfig>;
  filterType: 'highpass' | 'bandpass';
  filterFreq: number;
  filterQ?: number;
}

export const INSTRUMENT_PRESETS: InstrumentPresetConfig[] = [
  {
    id: 'vocal',
    name: 'Vocal Humming',
    nameZh: '人聲哼唱',
    icon: '🎙️',
    description: 'Vocal humming or singing with micro-vibrato smoothing',
    tips: '建議以清脆的「噠 (da)」或「啦 (la)」起音，保持音量穩定',
    pitchConfig: {
      threshold: 0.15,
      minFrequency: 75,
      maxFrequency: 1200,
      silenceThreshold: 0.008,
      medianFilterSize: 5,
    },
    onsetConfig: {
      silenceThresholdRms: 0.008,
      attackRmsDeltaThreshold: 0.02,
      attackRelativeRiseThreshold: 1.8,
      refractoryPeriodMs: 70,
    },
    filterType: 'highpass',
    filterFreq: 80,
  },
  {
    id: 'flute',
    name: 'Bamboo Flute',
    nameZh: '竹笛 / 笛子',
    icon: '🎋',
    description: 'Acoustic flute with breath turbulence filtering & tonguing attack',
    tips: '帶音頭吐音可獲得最佳音符切分，竹笛高音純淨易辨識',
    pitchConfig: {
      threshold: 0.12,
      minFrequency: 280,
      maxFrequency: 2800,
      silenceThreshold: 0.007,
      medianFilterSize: 3,
    },
    onsetConfig: {
      silenceThresholdRms: 0.007,
      attackRmsDeltaThreshold: 0.015,
      attackRelativeRiseThreshold: 1.6,
      refractoryPeriodMs: 60,
    },
    filterType: 'bandpass',
    filterFreq: 1200,
    filterQ: 0.8,
  },
  {
    id: 'cello',
    name: 'Cello',
    nameZh: '大提琴 / 擦弦',
    icon: '🎻',
    description: 'Bowed strings with harmonic suppression & glissando protection',
    tips: '換弓與清晰換把運指有助精確分音，已抗二次泛音八度跳音',
    pitchConfig: {
      threshold: 0.12,
      minFrequency: 65,
      maxFrequency: 1800,
      silenceThreshold: 0.009,
      medianFilterSize: 5,
    },
    onsetConfig: {
      silenceThresholdRms: 0.009,
      attackRmsDeltaThreshold: 0.022,
      attackRelativeRiseThreshold: 1.7,
      refractoryPeriodMs: 90,
    },
    filterType: 'highpass',
    filterFreq: 60,
  },
  {
    id: 'guitar',
    name: 'Acoustic Guitar',
    nameZh: '木吉他單音',
    icon: '🎸',
    description: 'Plucked single-note acoustic solos with transient attack detection',
    tips: '手指或撥片彈奏清晰單音，每次撥弦皆自動觸發起音偵測',
    pitchConfig: {
      threshold: 0.15,
      minFrequency: 80,
      maxFrequency: 1200,
      silenceThreshold: 0.008,
      medianFilterSize: 3,
    },
    onsetConfig: {
      silenceThresholdRms: 0.008,
      attackRmsDeltaThreshold: 0.025,
      attackRelativeRiseThreshold: 2.0,
      spectralFluxThreshold: 0.06,
      refractoryPeriodMs: 70,
    },
    filterType: 'highpass',
    filterFreq: 75,
  },
];

const SOLFEGE_MAP: Record<string, string> = {
  '0': 'Rest',
  '1': 'Do',
  '2': 'Re',
  '3': 'Mi',
  '4': 'Fa',
  '5': 'Sol',
  '6': 'La',
  '7': 'Ti',
  'empty': '',
};

export interface ScoreTranscriptionDeckProps {
  isOpen?: boolean;
  onClose?: () => void;
  song: Song;
  selectedMeasureIndex?: number | null;
  audioEngine: AudioEngine;
  onCommitTranscription: (
    measures: Measure[],
    mode: InsertionMode,
    sourceMode: StudioTranscriptionMode
  ) => void;
  isEmbedded?: boolean;
  initialMode?: StudioTranscriptionMode;
  mode?: StudioTranscriptionMode;
  onModeChange?: (mode: StudioTranscriptionMode) => void;
}

export const ScoreTranscriptionDeck: React.FC<ScoreTranscriptionDeckProps> = ({
  isOpen = true,
  onClose,
  song,
  selectedMeasureIndex = 0,
  audioEngine,
  onCommitTranscription,
  isEmbedded = true,
  initialMode = 'hum',
  mode: controlledMode,
  onModeChange,
}) => {
  // Mode state: internal if not controlled
  const [internalMode, setInternalMode] = useState<StudioTranscriptionMode>(initialMode);
  const activeMode = controlledMode ?? internalMode;

  const setActiveMode = useCallback(
    (newMode: StudioTranscriptionMode) => {
      if (controlledMode === undefined) {
        setInternalMode(newMode);
      }
      onModeChange?.(newMode);
    },
    [controlledMode, onModeChange]
  );

  // Workflow step
  const [step, setStep] = useState<DeckStep>('SETUP');

  // Shared Musical Configuration
  const [activeKey, setActiveKey] = useState<KeySignature>(song.key || 'C');
  const [activeBpm, setActiveBpm] = useState<number>(song.bpm || 80);
  const [activeTimeSignature, setActiveTimeSignature] = useState<TimeSignature>(
    song.timeSignature || '4/4'
  );
  const [quantizeGrid, setQuantizeGrid] = useState<QuantizeGrid>('eighth');
  const [enableCountIn, setEnableCountIn] = useState<boolean>(true);
  const [countdownBeatsCount, setCountdownBeatsCount] = useState<2 | 3 | 4>(2);
  const [audibleClickDuringRecording, setAudibleClickDuringRecording] = useState<boolean>(
    activeMode === 'keyboard'
  );
  const [octaveShiftVal, setOctaveShiftVal] = useState<number>(0);
  const [accidentalPref, setAccidentalPref] = useState<'auto' | 'sharp' | 'flat'>('auto');
  const [insertionMode, setInsertionMode] = useState<InsertionMode>('cursor');
  const [synthInstrument, setSynthInstrument] = useState<InstrumentType>('piano');

  // Octave display view for piano bed
  const [octaveBedView, setOctaveBedView] = useState<OctaveBedView>('mid_high');

  // Count-in state
  const [countdownBeat, setCountdownBeat] = useState<number>(2);

  // Metronome Pulse Bar State (Common to both modes)
  const [currentBeatInBar, setCurrentBeatInBar] = useState<number>(1);
  const [isBeatPulse, setIsBeatPulse] = useState<boolean>(false);
  const [isDownbeatFlash, setIsDownbeatFlash] = useState<boolean>(false);
  const [recordingSeconds, setRecordingSeconds] = useState<number>(0);

  // Active played notes state on piano bed
  const [activeMidiSet, setActiveMidiSet] = useState<Set<number>>(new Set());

  // =========================================================================
  // HUM MODE STATES
  // =========================================================================
  const [presetId, setPresetId] = useState<InstrumentPresetId>('vocal');
  const [scaleMode, setScaleMode] = useState<ScaleMode>('diatonic');
  const [absorbArticulation, setAbsorbArticulation] = useState<boolean>(true);
  const [currentPitchHz, setCurrentPitchHz] = useState<number | null>(null);
  const [currentMidi, setCurrentMidi] = useState<number | null>(null);
  const [currentCents, setCurrentCents] = useState<number>(0);
  const [currentRms, setCurrentRms] = useState<number>(0);
  const [isVoiced, setIsVoiced] = useState<boolean>(false);
  const [isPracticingPitch, setIsPracticingPitch] = useState<boolean>(false);
  const [recordedAudioUrl, setRecordedAudioUrl] = useState<string | null>(null);
  const [micGain, setMicGain] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('hum_to_score_mic_gain');
        if (saved) {
          const parsed = parseFloat(saved);
          if (!isNaN(parsed) && parsed >= 1 && parsed <= 30) return parsed;
        }
      } catch {}
    }
    return 6.0;
  });

  const [stabilizerStrength, setStabilizerStrength] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('hum_to_score_pitch_stabilizer');
        if (saved) {
          const parsed = parseFloat(saved);
          if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) return parsed;
        }
      } catch {}
    }
    return 0.50;
  });

  // =========================================================================
  // KEYBOARD MODE STATES
  // =========================================================================
  const [qwertyMappingMode, setQwertyMappingMode] =
    useState<QwertyMappingMode>('chromatic_piano');
  const [allowTriplets, setAllowTriplets] = useState<boolean>(false);
  const [filterOneFingerGaps, setFilterOneFingerGaps] = useState<boolean>(true);
  const [oneFingerGapThresholdMs, setOneFingerGapThresholdMs] = useState<number>(450);
  const [activeHeldBeats, setActiveHeldBeats] = useState<number | null>(null);
  const [liveRecordedNotes, setLiveRecordedNotes] = useState<
    Array<{
      id: string;
      pitch: PitchNumber;
      octave: number;
      accidental: '' | '#' | 'b';
      duration: number;
      solfege: string;
    }>
  >([]);

  // =========================================================================
  // REVIEW & OUTPUT STATES
  // =========================================================================
  const [transcriptionResult, setTranscriptionResult] = useState<TranscriptionResult | null>(null);
  const [transcribedMeasures, setTranscribedMeasures] = useState<Measure[]>([]);
  const [rawSegments, setRawSegments] = useState<RawNoteSegment[]>([]);
  const [isRawPlaying, setIsRawPlaying] = useState<boolean>(false);
  const [rawPlaybackProgress, setRawPlaybackProgress] = useState<number>(0);
  const [isSynthPlaying, setIsSynthPlaying] = useState<boolean>(false);

  // =========================================================================
  // REFS & ENGINES
  // =========================================================================
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const filterNodeRef = useRef<BiquadFilterNode | null>(null);
  const micGainNodeRef = useRef<GainNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);
  const pitchDetectorRef = useRef<PitchDetector | null>(null);
  const noteSegmenterRef = useRef<NoteSegmenter | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const practiceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameIdRef = useRef<number | null>(null);
  const micAudioElementRef = useRef<HTMLAudioElement | null>(null);

  const keyEngineRef = useRef<KeyEventEngine | null>(null);

  // Acoustic Gating / Audition Blanking ref for Hum Mode
  const isAuditioningPitchRef = useRef<boolean>(false);
  const auditionBlankingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // General timers refs
  const recordingStartTimeRef = useRef<number>(0);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countInIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const metronomeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const metronomePulseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audibleClickRef = useRef<boolean>(audibleClickDuringRecording);
  const rawPlaybackTimersRef = useRef<number[]>([]);

  // Closure-safe parameter refs
  const activeKeyRef = useRef(activeKey);
  const activeBpmRef = useRef(activeBpm);
  const octaveShiftRef = useRef(octaveShiftVal);
  const accidentalPrefRef = useRef(accidentalPref);
  const quantizeGridRef = useRef(quantizeGrid);
  const allowTripletsRef = useRef(allowTriplets);
  const filterOneFingerGapsRef = useRef(filterOneFingerGaps);
  const oneFingerGapThresholdMsRef = useRef(oneFingerGapThresholdMs);

  useEffect(() => {
    audibleClickRef.current = audibleClickDuringRecording;
  }, [audibleClickDuringRecording]);

  useEffect(() => {
    activeKeyRef.current = activeKey;
    activeBpmRef.current = activeBpm;
    octaveShiftRef.current = octaveShiftVal;
    accidentalPrefRef.current = accidentalPref;
    quantizeGridRef.current = quantizeGrid;
    allowTripletsRef.current = allowTriplets;
    filterOneFingerGapsRef.current = filterOneFingerGaps;
    oneFingerGapThresholdMsRef.current = oneFingerGapThresholdMs;
  }, [activeKey, activeBpm, octaveShiftVal, accidentalPref, quantizeGrid, allowTriplets, filterOneFingerGaps, oneFingerGapThresholdMs]);

  // Selected preset configuration (for Hum)
  const activePreset = useMemo(() => {
    return (
      INSTRUMENT_PRESETS.find(p => p.id === presetId || (presetId === 'erhu' && p.id === 'cello')) ||
      INSTRUMENT_PRESETS[0]
    );
  }, [presetId]);

  // Dynamic mic gain adjustment
  const handleMicGainChange = useCallback((newGain: number) => {
    const clamped = Math.max(1, Math.min(30, Math.round(newGain * 10) / 10));
    setMicGain(clamped);
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('hum_to_score_mic_gain', String(clamped));
      } catch {}
    }
    if (micGainNodeRef.current && audioContextRef.current) {
      try {
        micGainNodeRef.current.gain.setTargetAtTime(clamped, audioContextRef.current.currentTime, 0.02);
      } catch {
        micGainNodeRef.current.gain.value = clamped;
      }
    }
    const effectiveSilenceThreshold = 0.005;
    if (pitchDetectorRef.current) {
      pitchDetectorRef.current.updateConfig({ silenceThreshold: effectiveSilenceThreshold });
    }
    if (noteSegmenterRef.current) {
      noteSegmenterRef.current.updateConfig({ silenceThresholdRms: effectiveSilenceThreshold });
    }
  }, []);

  // Dynamic pitch stabilizer strength adjustment
  const handleStabilizerChange = useCallback((newStrength: number) => {
    const clamped = Math.max(0, Math.min(1, Math.round(newStrength * 100) / 100));
    setStabilizerStrength(clamped);
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('hum_to_score_pitch_stabilizer', String(clamped));
      } catch {}
    }
    if (pitchDetectorRef.current) {
      pitchDetectorRef.current.setStabilizerStrength(clamped);
    }
    if (noteSegmenterRef.current) {
      noteSegmenterRef.current.setStabilizerStrength(clamped);
    }
  }, []);

  // Web MIDI Handler
  const handleIncomingMidiMessage = useCallback(
    (event: { data: Uint8Array | number[] }) => {
      const data = event.data;
      if (!data) return;

      if (activeMode === 'keyboard') {
        if ((step === 'RECORDING' || step === 'COUNTING_IN') && keyEngineRef.current) {
          keyEngineRef.current.handleMidiMessage(event);
        } else if (step === 'SETUP' || step === 'REVIEW') {
          if ((data[0] & 0xf0) === 0x90 && (data.length <= 2 || data[2] > 0)) {
            const midi = data[1];
            const pitchInfo = midiToNumberedPitch(midi, activeKeyRef.current, {
              accidentalPreference: accidentalPrefRef.current,
              octaveShift: octaveShiftRef.current,
            });
            audioEngine.previewNote(activeKeyRef.current, {
              id: `midi-audition-${midi}`,
              pitch: pitchInfo.pitch,
              octave: pitchInfo.octave,
              accidental: pitchInfo.accidental,
              duration: 1,
              lyric: {},
            });
          }
        }
      } else if (activeMode === 'hum') {
        if ((data[0] & 0xf0) === 0x90 && (data.length <= 2 || data[2] > 0)) {
          const midi = data[1];
          isAuditioningPitchRef.current = true;
          if (auditionBlankingTimeoutRef.current) clearTimeout(auditionBlankingTimeoutRef.current);

          const pitchInfo = midiToNumberedPitch(midi, activeKeyRef.current, {
            accidentalPreference: accidentalPrefRef.current,
            octaveShift: octaveShiftRef.current,
          });
          audioEngine.previewNote(activeKeyRef.current, {
            id: `midi-align-${midi}`,
            pitch: pitchInfo.pitch,
            octave: pitchInfo.octave,
            accidental: pitchInfo.accidental,
            duration: 1,
            lyric: {},
          });
          setActiveMidiSet(prev => new Set(prev).add(midi));
        } else if ((data[0] & 0xf0) === 0x80 || ((data[0] & 0xf0) === 0x90 && data[2] === 0)) {
          const midi = data[1];
          setActiveMidiSet(prev => {
            const next = new Set(prev);
            next.delete(midi);
            return next;
          });
          if (auditionBlankingTimeoutRef.current) clearTimeout(auditionBlankingTimeoutRef.current);
          auditionBlankingTimeoutRef.current = setTimeout(() => {
            isAuditioningPitchRef.current = false;
          }, 120);
        }
      }
    },
    [activeMode, step, audioEngine]
  );

  const {
    isSupported: isMidiSupported,
    devices: midiDevices,
    activeDevice: activeMidiDevice,
    isConnected: isMidiConnected,
  } = useWebMidi(handleIncomingMidiMessage, isOpen);

  // Initialize KeyEventEngine for Keyboard mode
  useEffect(() => {
    const engine = new KeyEventEngine(
      {
        keySignature: activeKeyRef.current,
        timeSignature: activeTimeSignature,
        bpm: activeBpmRef.current,
        octaveShift: octaveShiftRef.current,
        quantizeGrid: quantizeGridRef.current,
        allowTriplets: allowTripletsRef.current,
        accidentalPreference: accidentalPrefRef.current,
        qwertyMappingMode,
        extendLegatoGaps: true,
        filterOneFingerGaps: filterOneFingerGapsRef.current,
        oneFingerMaxGapMs: oneFingerGapThresholdMsRef.current,
      },
      {
        onNoteOn: (note: ActiveNoteState) => {
          setActiveMidiSet(prev => new Set(prev).add(note.midi));
          audioEngine.previewNote(activeKeyRef.current, {
            id: `kb-preview-${note.midi}`,
            pitch: note.pitch,
            octave: note.octave,
            accidental: note.accidental,
            duration: 1,
            lyric: {},
          });
        },
        onNoteOff: (midi: number) => {
          setActiveMidiSet(prev => {
            const next = new Set(prev);
            next.delete(midi);
            return next;
          });
        },
        onSegmentCommitted: seg => {
          if (seg.midi !== null) {
            const pitchInfo = midiToNumberedPitch(seg.midi, activeKeyRef.current, {
              accidentalPreference: accidentalPrefRef.current,
              octaveShift: octaveShiftRef.current,
            });
            const q = { duration: Math.max(0.25, Math.round((seg.durationMs / 1000) * (activeBpmRef.current / 60) * 4) / 4) };
            const solfege = SOLFEGE_MAP[String(pitchInfo.pitch)] || '';
            setLiveRecordedNotes(prev => [
              ...prev.slice(-9),
              {
                id: `live-rec-${seg.startTimeMs}-${Date.now()}`,
                pitch: pitchInfo.pitch,
                octave: pitchInfo.octave,
                accidental: pitchInfo.accidental,
                duration: q.duration,
                solfege,
              },
            ]);
          }
        },
        onOctaveShiftChange: shift => {
          setOctaveShiftVal(shift);
        },
      }
    );

    keyEngineRef.current = engine;

    return () => {
      engine.destroy();
      if (engine.isRecordingActive()) {
        engine.stopRecording();
      }
    };
  }, [audioEngine, activeTimeSignature, qwertyMappingMode]);

  // Sync config into KeyEventEngine
  useEffect(() => {
    keyEngineRef.current?.updateConfig({
      keySignature: activeKey,
      timeSignature: activeTimeSignature,
      bpm: activeBpm,
      octaveShift: octaveShiftVal,
      quantizeGrid,
      allowTriplets,
      accidentalPreference: accidentalPref,
      qwertyMappingMode,
      filterOneFingerGaps,
      oneFingerMaxGapMs: oneFingerGapThresholdMs,
    });
  }, [
    activeKey,
    activeTimeSignature,
    activeBpm,
    octaveShiftVal,
    quantizeGrid,
    allowTriplets,
    accidentalPref,
    qwertyMappingMode,
    filterOneFingerGaps,
    oneFingerGapThresholdMs,
  ]);

  // Throttled live held duration ticker during Keyboard recording
  useEffect(() => {
    if (step !== 'RECORDING' || activeMode !== 'keyboard') return;

    const ticker = setInterval(() => {
      const active = keyEngineRef.current?.getActiveNoteHeldDuration();
      if (active) {
        setActiveHeldBeats(active.estimatedBeats);
      } else {
        setActiveHeldBeats(null);
      }
    }, 80);

    return () => {
      clearInterval(ticker);
      setActiveHeldBeats(null);
    };
  }, [step, activeMode]);

  // Stop all pipelines and audio
  const stopAllPipelines = useCallback(() => {
    void wakeLockManager.release();
    setIsPracticingPitch(false);

    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    if (countInIntervalRef.current) {
      clearInterval(countInIntervalRef.current);
      countInIntervalRef.current = null;
    }
    if (metronomeIntervalRef.current) {
      clearInterval(metronomeIntervalRef.current);
      metronomeIntervalRef.current = null;
    }
    if (metronomePulseTimeoutRef.current) {
      clearTimeout(metronomePulseTimeoutRef.current);
      metronomePulseTimeoutRef.current = null;
    }
    setIsBeatPulse(false);
    setIsDownbeatFlash(false);

    setIsRawPlaying(false);
    setIsSynthPlaying(false);
    rawPlaybackTimersRef.current.forEach(id => clearTimeout(id));
    rawPlaybackTimersRef.current = [];

    if (micAudioElementRef.current) {
      try {
        micAudioElementRef.current.pause();
        micAudioElementRef.current.currentTime = 0;
      } catch {}
    }

    audioEngine.stop();

    if (keyEngineRef.current && keyEngineRef.current.isRecordingActive()) {
      keyEngineRef.current.stopRecording();
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch {}
    }
    mediaRecorderRef.current = null;

    if (scriptProcessorRef.current) {
      try {
        scriptProcessorRef.current.disconnect();
      } catch {}
      scriptProcessorRef.current = null;
    }
    if (filterNodeRef.current) {
      try {
        filterNodeRef.current.disconnect();
      } catch {}
      filterNodeRef.current = null;
    }
    if (micGainNodeRef.current) {
      try {
        micGainNodeRef.current.disconnect();
      } catch {}
      micGainNodeRef.current = null;
    }
    if (silentGainRef.current) {
      try {
        silentGainRef.current.disconnect();
      } catch {}
      silentGainRef.current = null;
    }
    if (analyserRef.current) {
      try {
        analyserRef.current.disconnect();
      } catch {}
      analyserRef.current = null;
    }
    if (animFrameIdRef.current) {
      cancelAnimationFrame(animFrameIdRef.current);
      animFrameIdRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop());
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      try {
        audioContextRef.current.close();
      } catch {}
      audioContextRef.current = null;
    }

    pitchDetectorRef.current = null;
    noteSegmenterRef.current = null;
    setActiveMidiSet(new Set());
    setActiveHeldBeats(null);
    setIsVoiced(false);
    setCurrentPitchHz(null);
    setCurrentMidi(null);
    setCurrentCents(0);
    setCurrentRms(0);
  }, [audioEngine]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      stopAllPipelines();
    };
  }, [stopAllPipelines]);

  // Oscilloscope drawing animation for Live Practice Mode (Hum Mode)
  const drawPracticeOscilloscope = useCallback(() => {
    if (animFrameIdRef.current) {
      cancelAnimationFrame(animFrameIdRef.current);
    }

    const renderFrame = () => {
      if (!analyserRef.current) return;
      const canvas = practiceCanvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const bufferLength = analyserRef.current.fftSize;
          const dataArray = new Uint8Array(bufferLength);
          analyserRef.current.getByteTimeDomainData(dataArray);

          ctx.fillStyle = '#09090b';
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          // Center baseline guide
          ctx.lineWidth = 1;
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
          ctx.beginPath();
          ctx.moveTo(0, canvas.height / 2);
          ctx.lineTo(canvas.width, canvas.height / 2);
          ctx.stroke();

          ctx.lineWidth = 2;
          ctx.strokeStyle = '#10b981';
          ctx.beginPath();

          const sliceWidth = (canvas.width * 1.0) / bufferLength;
          let x = 0;

          for (let i = 0; i < bufferLength; i++) {
            const v = dataArray[i] / 128.0;
            const y = (v * canvas.height) / 2;

            if (i === 0) {
              ctx.moveTo(x, y);
            } else {
              ctx.lineTo(x, y);
            }
            x += sliceWidth;
          }

          ctx.lineTo(canvas.width, canvas.height / 2);
          ctx.stroke();
        }
      }

      animFrameIdRef.current = requestAnimationFrame(renderFrame);
    };

    animFrameIdRef.current = requestAnimationFrame(renderFrame);
  }, []);

  // Oscilloscope drawing animation for Active Recording (Hum Mode)
  const drawOscilloscope = useCallback(() => {
    if (animFrameIdRef.current) {
      cancelAnimationFrame(animFrameIdRef.current);
    }

    const renderFrame = () => {
      if (!analyserRef.current) return;
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const bufferLength = analyserRef.current.fftSize;
          const dataArray = new Uint8Array(bufferLength);
          analyserRef.current.getByteTimeDomainData(dataArray);

          ctx.fillStyle = '#09090b';
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          ctx.lineWidth = 2;
          ctx.strokeStyle = '#f59e0b';
          ctx.beginPath();

          const sliceWidth = (canvas.width * 1.0) / bufferLength;
          let x = 0;

          for (let i = 0; i < bufferLength; i++) {
            const v = dataArray[i] / 128.0;
            const y = (v * canvas.height) / 2;

            if (i === 0) {
              ctx.moveTo(x, y);
            } else {
              ctx.lineTo(x, y);
            }
            x += sliceWidth;
          }

          ctx.lineTo(canvas.width, canvas.height / 2);
          ctx.stroke();
        }
      }

      animFrameIdRef.current = requestAnimationFrame(renderFrame);
    };

    animFrameIdRef.current = requestAnimationFrame(renderFrame);
  }, []);

  // START / STOP PRE-RECORDING PITCH PRACTICE
  const startPitchPractice = useCallback(async () => {
    stopAllPipelines();
    setIsPracticingPitch(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: false,
          channelCount: 1,
        },
      });
      mediaStreamRef.current = stream;

      const AudioContextClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioContextClass();
      audioContextRef.current = ctx;

      if (ctx.state === 'suspended') {
        await ctx.resume();
      }

      const source = ctx.createMediaStreamSource(stream);

      const filter = ctx.createBiquadFilter();
      filter.type = activePreset.filterType;
      filter.frequency.value = activePreset.filterFreq;
      if (activePreset.filterQ) filter.Q.value = activePreset.filterQ;
      filterNodeRef.current = filter;

      const gainNode = ctx.createGain();
      gainNode.gain.value = micGain;
      micGainNodeRef.current = gainNode;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyserRef.current = analyser;

      const processor = ctx.createScriptProcessor(2048, 1, 1);
      scriptProcessorRef.current = processor;

      const silentGain = ctx.createGain();
      silentGain.gain.value = 0;
      silentGainRef.current = silentGain;

      source.connect(filter);
      filter.connect(gainNode);
      gainNode.connect(analyser);
      analyser.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(ctx.destination);

      const effectiveSilenceThreshold = 0.005;

      const pitchDetector = new PitchDetector({
        sampleRate: ctx.sampleRate,
        ...activePreset.pitchConfig,
        silenceThreshold: effectiveSilenceThreshold,
        stabilizerStrength,
      });
      pitchDetectorRef.current = pitchDetector;

      let silenceFrames = 0;
      processor.onaudioprocess = e => {
        const channelData = e.inputBuffer.getChannelData(0);
        const rms = calculateRms(channelData);
        setCurrentRms(rms);

        const pitchRes = pitchDetector.detectSmoothed(channelData);

        if (pitchRes.isPitched && pitchRes.frequency !== null) {
          silenceFrames = 0;
          setIsVoiced(true);
          setCurrentPitchHz(pitchRes.frequency);
          setCurrentMidi(pitchRes.nearestMidi);
          setCurrentCents(pitchRes.centsOffNearestMidi);
        } else {
          silenceFrames++;
          if (silenceFrames > 4) {
            setIsVoiced(false);
            setCurrentPitchHz(null);
            setCurrentMidi(null);
            setCurrentCents(0);
          }
        }
      };

      drawPracticeOscilloscope();
    } catch (err) {
      console.error('Failed to start microphone practice:', err);
      setIsPracticingPitch(false);
      alert('無法啟動麥克風，請檢查瀏覽器麥克風權限。');
    }
  }, [activePreset, micGain, stabilizerStrength, stopAllPipelines, drawPracticeOscilloscope]);

  const stopPitchPractice = useCallback(() => {
    stopAllPipelines();
  }, [stopAllPipelines]);

  // Keep practice animation running when practice mode is enabled and canvas mounts
  useEffect(() => {
    if (isPracticingPitch && analyserRef.current) {
      drawPracticeOscilloscope();
    }
  }, [isPracticingPitch, drawPracticeOscilloscope]);

  // START RECORDING FLOW
  const beginActiveRecording = useCallback(async () => {
    setStep('RECORDING');
    setRecordingSeconds(0);
    setActiveMidiSet(new Set());
    setActiveHeldBeats(null);
    setLiveRecordedNotes([]);
    void wakeLockManager.request();

    recordingStartTimeRef.current = performance.now();

    recordingTimerRef.current = setInterval(() => {
      const elapsed = (performance.now() - recordingStartTimeRef.current) / 1000;
      setRecordingSeconds(Math.round(elapsed * 10) / 10);
    }, 100);

    const beatsPerBar = parseInt(activeTimeSignature.split('/')[0], 10) || 4;
    const intervalMs = (60 / activeBpm) * 1000;
    let b = 1;

    setCurrentBeatInBar(1);
    setIsBeatPulse(true);
    setIsDownbeatFlash(true);
    if (audibleClickRef.current) {
      audioEngine.playMetronomeTick(true);
    }
    if (metronomePulseTimeoutRef.current) clearTimeout(metronomePulseTimeoutRef.current);
    metronomePulseTimeoutRef.current = setTimeout(() => {
      setIsBeatPulse(false);
      setIsDownbeatFlash(false);
      metronomePulseTimeoutRef.current = null;
    }, 140);

    metronomeIntervalRef.current = setInterval(() => {
      b = (b % beatsPerBar) + 1;
      setCurrentBeatInBar(b);
      setIsBeatPulse(true);
      const isDown = b === 1;
      setIsDownbeatFlash(isDown);

      if (audibleClickRef.current) {
        audioEngine.playMetronomeTick(isDown);
      }

      if (metronomePulseTimeoutRef.current) clearTimeout(metronomePulseTimeoutRef.current);
      metronomePulseTimeoutRef.current = setTimeout(() => {
        setIsBeatPulse(false);
        setIsDownbeatFlash(false);
        metronomePulseTimeoutRef.current = null;
      }, 140);
    }, intervalMs);

    if (activeMode === 'keyboard') {
      const engine = keyEngineRef.current;
      if (engine) {
        engine.startRecording();
      }
    } else {
      // HUM RECORDING PIPELINE
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            autoGainControl: false,
            noiseSuppression: false,
            channelCount: 1,
          },
        });
        mediaStreamRef.current = stream;

        const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AudioContextClass();
        audioContextRef.current = ctx;

        if (ctx.state === 'suspended') {
          await ctx.resume();
        }

        const source = ctx.createMediaStreamSource(stream);

        const filter = ctx.createBiquadFilter();
        filter.type = activePreset.filterType;
        filter.frequency.value = activePreset.filterFreq;
        if (activePreset.filterQ) filter.Q.value = activePreset.filterQ;
        filterNodeRef.current = filter;

        const gainNode = ctx.createGain();
        gainNode.gain.value = micGain;
        micGainNodeRef.current = gainNode;

        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyserRef.current = analyser;

        const processor = ctx.createScriptProcessor(2048, 1, 1);
        scriptProcessorRef.current = processor;

        const silentGain = ctx.createGain();
        silentGain.gain.value = 0;
        silentGainRef.current = silentGain;

        source.connect(filter);
        filter.connect(gainNode);
        gainNode.connect(analyser);
        analyser.connect(processor);
        processor.connect(silentGain);
        silentGain.connect(ctx.destination);

        const effectiveSilenceThreshold = 0.005;

        const pitchDetector = new PitchDetector({
          sampleRate: ctx.sampleRate,
          ...activePreset.pitchConfig,
          silenceThreshold: effectiveSilenceThreshold,
          stabilizerStrength,
        });
        pitchDetectorRef.current = pitchDetector;

        const segmenter = new NoteSegmenter({
          sampleRate: ctx.sampleRate,
          ...activePreset.onsetConfig,
          silenceThresholdRms: effectiveSilenceThreshold,
          stabilizerStrength,
        });
        noteSegmenterRef.current = segmenter;

        const recorder = new MediaRecorder(stream);
        recordedChunksRef.current = [];
        recorder.ondataavailable = e => {
          if (e.data.size > 0) recordedChunksRef.current.push(e.data);
        };
        recorder.onstop = () => {
          const blob = new Blob(recordedChunksRef.current, { type: 'audio/webm' });
          const url = URL.createObjectURL(blob);
          setRecordedAudioUrl(url);
        };
        recorder.start();
        mediaRecorderRef.current = recorder;

        let silenceFrames = 0;
        processor.onaudioprocess = e => {
          const channelData = e.inputBuffer.getChannelData(0);
          const rms = calculateRms(channelData);
          setCurrentRms(rms);
          const timestampMs = performance.now() - recordingStartTimeRef.current;

          const pitchRes = pitchDetector.detectSmoothed(channelData);
          const isAuditioning = isAuditioningPitchRef.current;

          if (pitchRes.isPitched && pitchRes.frequency !== null) {
            silenceFrames = 0;
            setIsVoiced(true);
            setCurrentPitchHz(pitchRes.frequency);
            setCurrentMidi(pitchRes.nearestMidi);
            setCurrentCents(pitchRes.centsOffNearestMidi);
          } else {
            silenceFrames++;
            if (silenceFrames > 4) {
              setIsVoiced(false);
              setCurrentPitchHz(null);
              setCurrentMidi(null);
              setCurrentCents(0);
            }
          }

          // Ingest frame only if not actively auditioning pitch on keyboard
          if (!isAuditioning) {
            segmenter.ingestFrame(
              channelData,
              timestampMs,
              pitchRes.isPitched ? pitchRes.frequency : null,
              pitchRes.probability
            );
          }
        };

        drawOscilloscope();
      } catch (err) {
        console.error('Failed to start microphone recording:', err);
        alert('無法啟動麥克風，請檢查瀏覽器麥克風權限。');
        stopAllPipelines();
        setStep('SETUP');
      }
    }
  }, [
    activeMode,
    activeTimeSignature,
    activeBpm,
    audioEngine,
    activePreset,
    micGain,
    stabilizerStrength,
    drawOscilloscope,
    stopAllPipelines,
  ]);

  // Handle Count-in and Start Recording
  const startRecordingFlow = useCallback(() => {
    stopAllPipelines();

    const secPerBeat = 60 / activeBpm;

    if (!enableCountIn) {
      void beginActiveRecording();
      return;
    }

    const COUNT_IN_BEATS = countdownBeatsCount;
    setStep('COUNTING_IN');
    setCountdownBeat(COUNT_IN_BEATS);

    // Fire first beat pulse immediately (downbeat of count-in)
    setIsBeatPulse(true);
    setIsDownbeatFlash(true);
    if (audibleClickRef.current) {
      audioEngine.playMetronomeTick(true);
    }
    if (metronomePulseTimeoutRef.current) clearTimeout(metronomePulseTimeoutRef.current);
    metronomePulseTimeoutRef.current = setTimeout(() => {
      setIsBeatPulse(false);
      setIsDownbeatFlash(false);
      metronomePulseTimeoutRef.current = null;
    }, 140);

    let count = COUNT_IN_BEATS;

    if (countInIntervalRef.current) {
      clearInterval(countInIntervalRef.current);
      countInIntervalRef.current = null;
    }

    countInIntervalRef.current = setInterval(() => {
      count -= 1;
      if (count > 0) {
        setCountdownBeat(count);
        // Pulse metronome bar on each countdown beat
        setIsBeatPulse(true);
        setIsDownbeatFlash(false);
        if (audibleClickRef.current) {
          audioEngine.playMetronomeTick(false);
        }
        if (metronomePulseTimeoutRef.current) clearTimeout(metronomePulseTimeoutRef.current);
        metronomePulseTimeoutRef.current = setTimeout(() => {
          setIsBeatPulse(false);
          setIsDownbeatFlash(false);
          metronomePulseTimeoutRef.current = null;
        }, 140);
      } else {
        if (countInIntervalRef.current) {
          clearInterval(countInIntervalRef.current);
          countInIntervalRef.current = null;
        }
        void beginActiveRecording();
      }
    }, secPerBeat * 1000);
  }, [activeBpm, enableCountIn, countdownBeatsCount, stopAllPipelines, audioEngine, beginActiveRecording]);

  // Finish Recording & Transcribe
  const handleFinishRecording = useCallback(() => {
    const finalTimestampMs = performance.now() - recordingStartTimeRef.current;

    if (activeMode === 'keyboard') {
      const engine = keyEngineRef.current;
      if (!engine) return;

      const segments = engine.finalize();
      setRawSegments(segments);

      const result = transcribeKeyboardSegmentsToMeasures(segments, {
        key: activeKey,
        bpm: activeBpm,
        timeSignature: activeTimeSignature,
        grid: quantizeGrid,
        allowTriplets,
        octaveShift: octaveShiftVal,
        accidentalPreference: accidentalPref,
        autoFillTrailingRests: false,
        filterOneFingerGaps,
        oneFingerMaxGapMs: oneFingerGapThresholdMs,
      });

      setTranscriptionResult(result);
      setTranscribedMeasures(result.measures);
    } else {
      const segmenter = noteSegmenterRef.current;
      if (!segmenter) return;

      const raw = segmenter.finalize(finalTimestampMs);
      const cleaned = cleanRawSegments(raw, 50, true, absorbArticulation, activeBpm);
      setRawSegments(cleaned);

      const result = transcribeAudioSegmentsToMeasures(cleaned, {
        key: activeKey,
        bpm: activeBpm,
        timeSignature: activeTimeSignature,
        grid: quantizeGrid,
        octaveShift: octaveShiftVal,
        accidentalPreference: accidentalPref,
        scaleMode,
        autoFillTrailingRests: false,
      });

      setTranscriptionResult(result);
      setTranscribedMeasures(result.measures);
    }

    stopAllPipelines();
    setStep('REVIEW');
  }, [
    activeMode,
    activeKey,
    activeBpm,
    activeTimeSignature,
    quantizeGrid,
    allowTriplets,
    octaveShiftVal,
    accidentalPref,
    absorbArticulation,
    scaleMode,
    filterOneFingerGaps,
    oneFingerGapThresholdMs,
    stopAllPipelines,
  ]);

  // Handle Piano Key Pointer Events
  const handlePianoNoteDown = useCallback(
    (midi: number, sourceId?: string) => {
      if (activeMode === 'keyboard') {
        if (keyEngineRef.current) {
          keyEngineRef.current.noteOn(midi, 0.9, undefined, sourceId);
        }
      } else {
        // HUM MODE: PITCH ALIGNMENT ONLY
        isAuditioningPitchRef.current = true;
        if (auditionBlankingTimeoutRef.current) clearTimeout(auditionBlankingTimeoutRef.current);

        const pitchInfo = midiToNumberedPitch(midi, activeKeyRef.current, {
          accidentalPreference: accidentalPrefRef.current,
          octaveShift: octaveShiftRef.current,
        });
        audioEngine.previewNote(activeKeyRef.current, {
          id: `align-tone-${midi}`,
          pitch: pitchInfo.pitch,
          octave: pitchInfo.octave,
          accidental: pitchInfo.accidental,
          duration: 1,
          lyric: {},
        });

        setActiveMidiSet(prev => new Set(prev).add(midi));
      }
    },
    [activeMode, audioEngine]
  );

  const handlePianoNoteUp = useCallback(
    (midi: number, sourceId?: string) => {
      if (activeMode === 'keyboard') {
        if (keyEngineRef.current) {
          keyEngineRef.current.noteOff(midi, undefined, sourceId);
        }
      } else {
        // HUM MODE RELEASE
        setActiveMidiSet(prev => {
          const next = new Set(prev);
          next.delete(midi);
          return next;
        });
        if (auditionBlankingTimeoutRef.current) clearTimeout(auditionBlankingTimeoutRef.current);
        auditionBlankingTimeoutRef.current = setTimeout(() => {
          isAuditioningPitchRef.current = false;
        }, 120);
      }
    },
    [activeMode]
  );

  // Re-transcribe with adjusted parameters in Review Step
  const handleRetranscribe = useCallback(
    (overrides?: {
      grid?: QuantizeGrid;
      octaveShift?: number;
      accidentalPreference?: 'auto' | 'sharp' | 'flat';
      allowTriplets?: boolean;
      filterOneFingerGaps?: boolean;
      oneFingerMaxGapMs?: number;
    }) => {
      const segs = rawSegments;
      if (segs.length === 0) return;

      const newGrid = overrides?.grid ?? quantizeGrid;
      const newOct = overrides?.octaveShift ?? octaveShiftVal;
      const newAcc = overrides?.accidentalPreference ?? accidentalPref;
      const newTriplets = overrides?.allowTriplets ?? allowTriplets;
      const newFilterOneFingerGaps = overrides?.filterOneFingerGaps ?? filterOneFingerGaps;
      const newOneFingerMaxGapMs = overrides?.oneFingerMaxGapMs ?? oneFingerGapThresholdMs;

      if (activeMode === 'keyboard') {
        const result = transcribeKeyboardSegmentsToMeasures(segs, {
          key: activeKey,
          bpm: activeBpm,
          timeSignature: activeTimeSignature,
          grid: newGrid,
          allowTriplets: newTriplets,
          octaveShift: newOct,
          accidentalPreference: newAcc,
          autoFillTrailingRests: false,
          filterOneFingerGaps: newFilterOneFingerGaps,
          oneFingerMaxGapMs: newOneFingerMaxGapMs,
        });
        setTranscriptionResult(result);
        setTranscribedMeasures(result.measures);
      } else {
        const result = transcribeAudioSegmentsToMeasures(segs, {
          key: activeKey,
          bpm: activeBpm,
          timeSignature: activeTimeSignature,
          grid: newGrid,
          octaveShift: newOct,
          accidentalPreference: newAcc,
          scaleMode,
          autoFillTrailingRests: false,
        });
        setTranscriptionResult(result);
        setTranscribedMeasures(result.measures);
      }
    },
    [
      rawSegments,
      activeMode,
      activeKey,
      activeBpm,
      activeTimeSignature,
      quantizeGrid,
      allowTriplets,
      octaveShiftVal,
      accidentalPref,
      scaleMode,
      filterOneFingerGaps,
      oneFingerGapThresholdMs,
    ]
  );

  // Dual-Track Audition Player (Track A: Raw audio/timing)
  const handleToggleRawPlay = useCallback(() => {
    if (isRawPlaying) {
      audioEngine.stop();
      setIsRawPlaying(false);
      rawPlaybackTimersRef.current.forEach(id => clearTimeout(id));
      rawPlaybackTimersRef.current = [];
      if (micAudioElementRef.current) {
        micAudioElementRef.current.pause();
        micAudioElementRef.current.currentTime = 0;
      }
      return;
    }

    setIsSynthPlaying(false);
    audioEngine.stop();

    if (activeMode === 'hum' && recordedAudioUrl) {
      setIsRawPlaying(true);
      if (!micAudioElementRef.current) {
        micAudioElementRef.current = new Audio(recordedAudioUrl);
      } else {
        micAudioElementRef.current.src = recordedAudioUrl;
      }
      micAudioElementRef.current.onended = () => {
        setIsRawPlaying(false);
        setRawPlaybackProgress(0);
      };
      micAudioElementRef.current.play().catch(() => setIsRawPlaying(false));
    } else if (activeMode === 'keyboard') {
      const segs = rawSegments;
      if (segs.length === 0) return;

      setIsRawPlaying(true);
      setRawPlaybackProgress(0);
      const totalDurationMs = segs[segs.length - 1].endTimeMs;
      const startTime = performance.now();

      segs.forEach((seg, idx) => {
        if (seg.midi !== null) {
          const timer = setTimeout(() => {
            const pitchInfo = midiToNumberedPitch(seg.midi!, activeKey, {
              octaveShift: octaveShiftVal,
              accidentalPreference: accidentalPref,
            });
            audioEngine.previewNote(activeKey, {
              id: `raw-play-${idx}`,
              pitch: pitchInfo.pitch,
              octave: pitchInfo.octave,
              accidental: pitchInfo.accidental,
              duration: Math.max(0.25, (seg.durationMs / 1000) * (activeBpm / 60)),
              lyric: {},
            });
          }, seg.startTimeMs);
          rawPlaybackTimersRef.current.push(timer as unknown as number);
        }
      });

      const ticker = setInterval(() => {
        const elapsed = performance.now() - startTime;
        if (elapsed >= totalDurationMs) {
          clearInterval(ticker);
          setIsRawPlaying(false);
          setRawPlaybackProgress(100);
        } else {
          setRawPlaybackProgress((elapsed / totalDurationMs) * 100);
        }
      }, 50);
      rawPlaybackTimersRef.current.push(ticker as unknown as number);
    }
  }, [
    isRawPlaying,
    activeMode,
    recordedAudioUrl,
    rawSegments,
    activeKey,
    octaveShiftVal,
    accidentalPref,
    activeBpm,
    audioEngine,
  ]);

  // Dual-Track Audition Player (Track B: Quantized Synth Preview)
  const handleToggleSynthPlay = useCallback(() => {
    if (isSynthPlaying) {
      audioEngine.stop();
      setIsSynthPlaying(false);
      return;
    }

    if (transcribedMeasures.length === 0) return;

    setIsRawPlaying(false);
    if (micAudioElementRef.current) {
      try {
        micAudioElementRef.current.pause();
      } catch {}
    }

    const previewSong: Song = {
      id: `deck-preview-${Date.now()}`,
      title: 'Transcription Preview',
      composer: '',
      lyricist: '',
      key: activeKey,
      timeSignature: activeTimeSignature,
      bpm: activeBpm,
      measures: transcribedMeasures,
    };

    audioEngine.setOptions({ instrument: synthInstrument });
    audioEngine.play(previewSong);
    setIsSynthPlaying(true);
  }, [
    isSynthPlaying,
    transcribedMeasures,
    activeKey,
    activeTimeSignature,
    activeBpm,
    synthInstrument,
    audioEngine,
  ]);

  // Commit Transcribed Measures to Composer
  const handleCommit = useCallback(() => {
    if (transcribedMeasures.length === 0) {
      if (onClose) onClose();
      else setStep('SETUP');
      return;
    }

    stopAllPipelines();
    onCommitTranscription(transcribedMeasures, insertionMode, activeMode);
    if (onClose) onClose();
    else setStep('SETUP');
  }, [
    transcribedMeasures,
    stopAllPipelines,
    onCommitTranscription,
    insertionMode,
    activeMode,
    onClose,
  ]);

  // QWERTY global keydown listener
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        stopAllPipelines();
        if (onClose) onClose();
        else setStep('SETUP');
        return;
      }

      if (step === 'SETUP' && e.code === 'Space') {
        e.preventDefault();
        startRecordingFlow();
        return;
      }

      if (step === 'RECORDING' || step === 'COUNTING_IN') {
        if (step === 'RECORDING' && e.code === 'Enter') {
          e.preventDefault();
          handleFinishRecording();
          return;
        }

        if (activeMode === 'keyboard' && keyEngineRef.current) {
          keyEngineRef.current.handleKeyDown(e);
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if ((step === 'RECORDING' || step === 'COUNTING_IN') && activeMode === 'keyboard' && keyEngineRef.current) {
        keyEngineRef.current.handleKeyUp(e);
      }
    };

    const handleBlur = () => {
      if ((step === 'RECORDING' || step === 'COUNTING_IN') && activeMode === 'keyboard' && keyEngineRef.current) {
        keyEngineRef.current.releaseAllActiveKeys();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [
    isOpen,
    step,
    activeMode,
    startRecordingFlow,
    handleFinishRecording,
    stopAllPipelines,
    onClose,
  ]);

  // Solfege display info for hum pitch gauge
  const activeSolfegInfo = useMemo(() => {
    if (!isVoiced || currentMidi === null) {
      return { noteNum: '0', solfege: 'Rest', octaveDots: 0, accidental: '' };
    }
    const numbered = currentPitchHz
      ? frequencyToNumberedPitch(currentPitchHz, activeKey, {
          accidentalPreference: accidentalPref,
          octaveShift: octaveShiftVal,
          scaleMode,
        })
      : midiToNumberedPitch(currentMidi, activeKey, {
          accidentalPreference: accidentalPref,
          octaveShift: octaveShiftVal,
          scaleMode,
        });
    return {
      noteNum: String(numbered.pitch),
      solfege: SOLFEGE_MAP[String(numbered.pitch)] || '',
      octaveDots: numbered.octave,
      accidental: numbered.accidental,
    };
  }, [isVoiced, currentMidi, currentPitchHz, activeKey, accidentalPref, octaveShiftVal, scaleMode]);

  if (!isOpen) return null;

  return (
    <div
      id={isEmbedded ? 'score-transcription-deck-container' : 'score-transcription-deck-modal'}
      className="relative w-full bg-white dark:bg-[#12151c] border border-zinc-200 dark:border-zinc-800 rounded-3xl shadow-2xl overflow-hidden flex flex-col transition-all"
    >
      {/* ========================================================================= */}
      {/* 1. DECK HEADER & MODE SWITCHER                                            */}
      {/* ========================================================================= */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-200/80 dark:border-zinc-800/80 bg-zinc-50/80 dark:bg-zinc-900/60 backdrop-blur-md flex-wrap gap-3 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-amber-500/20 border border-amber-500/30 text-amber-500 flex items-center justify-center font-black shadow-sm">
            {activeMode === 'hum' ? <Mic2 className="w-5 h-5" /> : <Keyboard className="w-5 h-5" />}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-extrabold text-base sm:text-lg text-zinc-900 dark:text-zinc-100 tracking-tight">
                即時轉譜工作台
              </h2>
              <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-amber-500/20 text-amber-700 dark:text-amber-300 uppercase font-mono">
                Transcription Deck
              </span>
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 hidden sm:block">
              {activeMode === 'hum'
                ? '人聲哼唱收音 · 琴鍵即時對齊音準與參考音'
                : '琴鍵彈奏 · 螢幕觸控 / 電腦打字 / MIDI 輸入'}
            </p>
          </div>
        </div>

        {/* Input Mode Selector Tabs */}
        <div className="flex items-center bg-zinc-200/70 dark:bg-zinc-950 p-1 rounded-2xl border border-zinc-300 dark:border-zinc-800 shadow-inner">
          <button
            id="deck-mode-tab-hum"
            type="button"
            onClick={() => {
              stopAllPipelines();
              setActiveMode('hum');
              setStep('SETUP');
            }}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
              activeMode === 'hum'
                ? 'bg-amber-500 text-zinc-950 font-black shadow-md scale-[1.02]'
                : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-zinc-300/40 dark:hover:bg-zinc-800/60'
            }`}
          >
            <Mic2 className="w-3.5 h-3.5" />
            <span>哼唱收音</span>
          </button>

          <button
            id="deck-mode-tab-keyboard"
            type="button"
            onClick={() => {
              stopAllPipelines();
              setActiveMode('keyboard');
              setStep('SETUP');
            }}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
              activeMode === 'keyboard'
                ? 'bg-amber-500 text-zinc-950 font-black shadow-md scale-[1.02]'
                : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-zinc-300/40 dark:hover:bg-zinc-800/60'
            }`}
          >
            <Keyboard className="w-3.5 h-3.5" />
            <span>鍵盤彈奏</span>
          </button>
        </div>

        {/* Step Indicator Badges */}
        <div className="flex items-center gap-1 text-[11px] font-mono text-zinc-500">
          <span className={step === 'SETUP' ? 'text-amber-400 font-bold' : ''}>設定</span>
          <span>→</span>
          <span className={step === 'RECORDING' || step === 'COUNTING_IN' ? 'text-amber-400 font-bold' : ''}>
            {step === 'COUNTING_IN' ? '預備倒數' : '錄製'}
          </span>
          <span>→</span>
          <span className={step === 'REVIEW' ? 'text-amber-400 font-bold' : ''}>檢視微調</span>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 2. BODY CONTENT (BY STEP)                                                 */}
      {/* ========================================================================= */}
      <div className="p-4 sm:p-6 flex flex-col gap-6">
        {/* ======================================================================= */}
        {/* STEP 1: SETUP                                                           */}
        {/* ======================================================================= */}
        {step === 'SETUP' && (
          <div className="flex flex-col gap-6 animate-in fade-in duration-200">
            {/* Unified Score Parameters Bar */}
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 p-4 bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800/80 rounded-2xl">
              {/* Key Signature */}
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-mono font-bold text-zinc-400 uppercase">
                  主音調號 (Key)
                </label>
                <select
                  id="deck-setup-key-select"
                  value={activeKey}
                  onChange={e => setActiveKey(e.target.value as KeySignature)}
                  className="px-2.5 py-1.5 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-xl text-xs font-bold text-zinc-900 dark:text-zinc-100 cursor-pointer"
                >
                  {CHROMATIC_KEYS.map(k => (
                    <option key={k} value={k}>
                      1 = {k}
                    </option>
                  ))}
                </select>
              </div>

              {/* Time Signature */}
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-mono font-bold text-zinc-400 uppercase">
                  拍號 (Meter)
                </label>
                <select
                  id="deck-setup-time-sig-select"
                  value={activeTimeSignature}
                  onChange={e => setActiveTimeSignature(e.target.value as TimeSignature)}
                  className="px-2.5 py-1.5 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-xl text-xs font-bold text-zinc-900 dark:text-zinc-100 cursor-pointer"
                >
                  {STANDARD_TIME_SIGNATURES.map(ts => (
                    <option key={ts.value} value={ts.value}>
                      {ts.label} 拍
                    </option>
                  ))}
                </select>
              </div>

              {/* Tempo (BPM) */}
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-mono font-bold text-zinc-400 uppercase">
                  速度 ({activeBpm} BPM)
                </label>
                <input
                  id="deck-setup-bpm-slider"
                  type="range"
                  min="40"
                  max="200"
                  value={activeBpm}
                  onChange={e => setActiveBpm(parseInt(e.target.value, 10))}
                  className="accent-amber-500 w-full h-2 bg-zinc-300 dark:bg-zinc-700 rounded-lg cursor-pointer my-auto"
                />
              </div>

              {/* Quantize Grid */}
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-mono font-bold text-zinc-400 uppercase">
                  量化精度 (Grid)
                </label>
                <select
                  id="deck-setup-grid-select"
                  value={quantizeGrid}
                  onChange={e => setQuantizeGrid(e.target.value as QuantizeGrid)}
                  className="px-2.5 py-1.5 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-xl text-xs font-bold text-zinc-900 dark:text-zinc-100 cursor-pointer"
                >
                  <option value="quarter">四分音符 (¼ 拍)</option>
                  <option value="eighth">八分音符 (⅛ 拍)</option>
                  <option value="sixteenth">十六分音符 (¹/₁₆ 拍)</option>
                </select>
              </div>

              {/* Count-in Toggle & Beats Selector */}
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-mono font-bold text-zinc-400 uppercase">
                    預備倒數 (Count-in)
                  </label>
                  <button
                    type="button"
                    onClick={() => setEnableCountIn(!enableCountIn)}
                    className="text-[9px] font-bold text-zinc-500 hover:text-amber-500 transition-colors cursor-pointer"
                  >
                    {enableCountIn ? '關閉' : '開啟'}
                  </button>
                </div>
                {enableCountIn ? (
                  <div className="grid grid-cols-3 gap-1 bg-zinc-200/80 dark:bg-zinc-800/80 p-0.5 rounded-xl border border-zinc-300 dark:border-zinc-700">
                    {([2, 3, 4] as const).map(b => (
                      <button
                        key={b}
                        type="button"
                        id={`deck-count-in-${b}-beats`}
                        onClick={() => setCountdownBeatsCount(b)}
                        className={`py-1 text-xs font-bold rounded-lg transition-all text-center cursor-pointer ${
                          countdownBeatsCount === b
                            ? 'bg-amber-500 text-zinc-950 font-black shadow-xs'
                            : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-300/50 dark:hover:bg-zinc-700/50'
                        }`}
                        title={`錄音前預備 ${b} 拍倒數`}
                      >
                        {b} 拍
                      </button>
                    ))}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setEnableCountIn(true)}
                    className="px-2.5 py-1.5 rounded-xl text-xs font-bold border border-zinc-300 dark:border-zinc-700 bg-zinc-200 dark:bg-zinc-800 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors cursor-pointer text-center"
                  >
                    關閉 (直接錄音)
                  </button>
                )}
              </div>

              {/* Audible Metronome Click */}
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-mono font-bold text-zinc-400 uppercase">
                  節拍提示聲
                </label>
                <button
                  type="button"
                  onClick={() => setAudibleClickDuringRecording(!audibleClickDuringRecording)}
                  className={`px-2.5 py-1.5 rounded-xl text-xs font-bold border transition-colors cursor-pointer text-center ${
                    audibleClickDuringRecording
                      ? 'bg-amber-500/20 text-amber-600 dark:text-amber-300 border-amber-500/40'
                      : 'bg-zinc-200 dark:bg-zinc-800 text-zinc-500 border-zinc-300 dark:border-zinc-700'
                  }`}
                >
                  {audibleClickDuringRecording ? '🔊 滴答聲' : '🔇 靜音 (僅閃燈)'}
                </button>
              </div>
            </div>

            {/* Mode-Specific Settings Panels */}
            {activeMode === 'hum' ? (
              <div className="flex flex-col gap-4 p-4 rounded-2xl bg-zinc-50 dark:bg-zinc-900/40 border border-zinc-200 dark:border-zinc-800/60">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <span className="text-xs font-black text-zinc-700 dark:text-zinc-300 flex items-center gap-1.5">
                    <Mic className="w-4 h-4 text-amber-500" />
                    <span>收音音源與靈敏度增益</span>
                  </span>
                  <div className="flex items-center gap-2 text-xs font-mono text-zinc-400">
                    <Headphones className="w-3.5 h-3.5 text-amber-400" />
                    <span>建議佩戴耳機以避免聲音反饋</span>
                  </div>
                </div>

                {/* Preset Chips */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {INSTRUMENT_PRESETS.map(p => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setPresetId(p.id)}
                      className={`flex flex-col p-3 rounded-xl border text-left transition-all cursor-pointer ${
                        presetId === p.id
                          ? 'bg-amber-500/15 border-amber-500 text-amber-800 dark:text-amber-300 shadow-sm ring-1 ring-amber-400/40'
                          : 'bg-white dark:bg-zinc-900/60 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:border-zinc-300'
                      }`}
                    >
                      <div className="flex items-center gap-1.5 text-xs font-black">
                        <span>{p.icon}</span>
                        <span>{p.nameZh}</span>
                      </div>
                      <span className="text-[10px] text-zinc-500 mt-1 line-clamp-1">{p.tips}</span>
                    </button>
                  ))}
                </div>

                {/* Mic Gain Slider */}
                <div className="flex items-center gap-3 pt-1">
                  <span className="text-xs font-bold text-zinc-500 shrink-0">麥克風放大增益:</span>
                  <input
                    id="deck-hum-gain-slider"
                    type="range"
                    min="1"
                    max="20"
                    step="0.5"
                    value={micGain}
                    onChange={e => handleMicGainChange(parseFloat(e.target.value))}
                    className="accent-amber-500 flex-1 h-2 bg-zinc-300 dark:bg-zinc-700 rounded-lg cursor-pointer"
                  />
                  <span className="text-xs font-mono font-bold text-amber-500 w-14 text-right">
                    {micGain.toFixed(1)}x
                  </span>
                </div>

                {/* Pitch Stabilizer Slider & Quick Presets */}
                <div className="flex flex-col gap-2 pt-2 border-t border-zinc-200/60 dark:border-zinc-800/60">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <SlidersHorizontal className="w-3.5 h-3.5 text-amber-500" />
                      <span className="text-xs font-bold text-zinc-700 dark:text-zinc-300">
                        音準穩定度 (Pitch Stabilizer):
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-[11px] font-bold px-2 py-0.5 rounded-md ${
                          stabilizerStrength <= 0.3
                            ? 'bg-blue-500/15 text-blue-500 dark:text-blue-400 border border-blue-500/30'
                            : stabilizerStrength <= 0.65
                              ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30'
                              : 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30'
                        }`}
                      >
                        {stabilizerStrength <= 0.3
                          ? '⚡ 即時靈敏 (Fast)'
                          : stabilizerStrength <= 0.65
                            ? '🎯 標準平穩 (Smooth)'
                            : '🛡️ 極致防抖 (Ultra)'}
                      </span>
                      <span className="text-xs font-mono font-black text-amber-500 w-12 text-right">
                        {Math.round(stabilizerStrength * 100)}%
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <span className="text-[10px] text-zinc-400 shrink-0">即時靈敏 (0%)</span>
                    <input
                      id="deck-hum-stabilizer-slider"
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={stabilizerStrength}
                      onChange={e => handleStabilizerChange(parseFloat(e.target.value))}
                      className="accent-amber-500 flex-1 h-2 bg-zinc-300 dark:bg-zinc-700 rounded-lg cursor-pointer"
                    />
                    <span className="text-[10px] text-zinc-400 shrink-0">極致防抖 (100%)</span>
                  </div>

                  {/* Quick Preset Chips */}
                  <div className="flex items-center gap-2 pt-0.5 flex-wrap">
                    <span className="text-[10px] text-zinc-500 shrink-0 font-medium">快捷預設:</span>
                    <button
                      type="button"
                      onClick={() => handleStabilizerChange(0.25)}
                      className={`px-2 py-0.5 rounded-md text-[11px] font-bold transition-all cursor-pointer ${
                        Math.abs(stabilizerStrength - 0.25) < 0.04
                          ? 'bg-amber-500 text-zinc-950 font-black shadow-xs'
                          : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                      }`}
                    >
                      輕度 25% (裝飾音 / 快歌)
                    </button>
                    <button
                      type="button"
                      onClick={() => handleStabilizerChange(0.50)}
                      className={`px-2 py-0.5 rounded-md text-[11px] font-bold transition-all cursor-pointer ${
                        Math.abs(stabilizerStrength - 0.50) < 0.04
                          ? 'bg-amber-500 text-zinc-950 font-black shadow-xs'
                          : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                      }`}
                    >
                      標準 50% (平衡防抖 · 預設)
                    </button>
                    <button
                      type="button"
                      onClick={() => handleStabilizerChange(0.80)}
                      className={`px-2 py-0.5 rounded-md text-[11px] font-bold transition-all cursor-pointer ${
                        Math.abs(stabilizerStrength - 0.80) < 0.04
                          ? 'bg-amber-500 text-zinc-950 font-black shadow-xs'
                          : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                      }`}
                    >
                      高強度 80% (鎖定防抖 · 長音)
                    </button>
                  </div>
                </div>

                {/* PRE-RECORDING LIVE PITCH VISUAL DETECTOR & PRACTICE PANEL */}
                <div className="flex flex-col gap-3 pt-3 mt-1 border-t border-zinc-200/80 dark:border-zinc-800/80">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2">
                      <div
                        className={`w-2.5 h-2.5 rounded-full ${
                          isPracticingPitch ? 'bg-emerald-500 animate-ping' : 'bg-zinc-400'
                        }`}
                      />
                      <span className="text-xs font-black text-zinc-800 dark:text-zinc-200 flex items-center gap-1.5">
                        <Target className="w-4 h-4 text-emerald-500" />
                        <span>音準即時視覺偵測與暖身練習</span>
                      </span>
                    </div>

                    {/* Toggle Practice Mode Button */}
                    <button
                      id="deck-toggle-practice-btn"
                      type="button"
                      onClick={() => {
                        if (isPracticingPitch) {
                          stopPitchPractice();
                        } else {
                          void startPitchPractice();
                        }
                      }}
                      className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer shadow-xs ${
                        isPracticingPitch
                          ? 'bg-rose-500 hover:bg-rose-600 text-white font-extrabold shadow-rose-500/20'
                          : 'bg-emerald-600 hover:bg-emerald-500 text-white font-black shadow-emerald-600/20'
                      }`}
                    >
                      {isPracticingPitch ? (
                        <>
                          <Square className="w-3.5 h-3.5 fill-current" />
                          <span>停止音準練習 (Stop)</span>
                        </>
                      ) : (
                        <>
                          <Mic2 className="w-3.5 h-3.5" />
                          <span>啟動即時音準檢測 (Practice Pitch)</span>
                        </>
                      )}
                    </button>
                  </div>

                  {!isPracticingPitch ? (
                    <div className="p-3 bg-white dark:bg-zinc-950/60 rounded-xl border border-dashed border-zinc-300 dark:border-zinc-800 text-xs text-zinc-600 dark:text-zinc-400 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="flex items-start gap-2.5">
                        <Sparkles className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                        <div>
                          <p className="font-bold text-zinc-700 dark:text-zinc-300">
                            在正式錄製前先練習音準與發聲穩定度
                          </p>
                          <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                            點擊上方啟動後對著麥克風哼唱，可即時查看唱名音高、音分指針偏離度與下方琴鍵即時對齊，確保轉譜精準度。
                          </p>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3.5 p-4 bg-zinc-950 rounded-2xl border border-emerald-500/40 text-zinc-100 shadow-inner">
                      {/* Upper row: Pitch degree, Note name, Accuracy evaluation */}
                      <div className="flex items-center justify-between flex-wrap gap-3">
                        <div className="flex items-baseline gap-3">
                          <span className="text-4xl sm:text-5xl font-black text-emerald-400 font-mono tracking-tight">
                            {isVoiced ? activeSolfegInfo.noteNum : '-'}
                          </span>
                          <div className="flex flex-col">
                            <span className="text-base font-extrabold text-zinc-200">
                              {isVoiced
                                ? activeSolfegInfo.solfege
                                : '靜音中 · 請對麥克風發聲'}
                            </span>
                            <span className="text-xs font-mono text-zinc-400">
                              {isVoiced && currentMidi !== null
                                ? `${getMidiNoteInfo(currentPitchHz || 0)?.noteName || ''}`
                                : '對麥克風哼唱 (如 da / la)'}
                            </span>
                          </div>
                          {isVoiced && activeSolfegInfo.octaveDots !== 0 && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-bold self-center">
                              {activeSolfegInfo.octaveDots > 0
                                ? `+${activeSolfegInfo.octaveDots} 八度`
                                : `${activeSolfegInfo.octaveDots} 八度`}
                            </span>
                          )}
                        </div>

                        {/* Accuracy badge & Frequency readout */}
                        <div className="flex flex-col items-end gap-1">
                          <div className="flex items-center gap-2">
                            {isVoiced ? (
                              <span
                                className={`px-2.5 py-0.5 rounded-full text-xs font-extrabold border font-mono ${
                                  Math.abs(currentCents) <= 10
                                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 shadow-xs'
                                    : Math.abs(currentCents) <= 25
                                      ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                                      : 'bg-rose-500/20 text-rose-300 border-rose-500/40'
                                }`}
                              >
                                {Math.abs(currentCents) <= 10
                                  ? '🎯 精準 In-Tune (±10¢)'
                                  : Math.abs(currentCents) <= 25
                                    ? `⚠️ 微偏 Slight Drift (${currentCents > 0 ? '+' : ''}${currentCents}¢)`
                                    : currentCents > 0
                                      ? `❌ 偏高 Sharp (+${currentCents}¢)`
                                      : `❌ 偏低 Flat (${currentCents}¢)`}
                              </span>
                            ) : (
                              <span className="text-xs font-mono text-zinc-500">等待唱音輸入...</span>
                            )}
                          </div>
                          <span className="text-xs font-mono text-zinc-400">
                            {currentPitchHz ? `${currentPitchHz.toFixed(1)} Hz` : '--.- Hz'}
                          </span>
                        </div>
                      </div>

                      {/* Cents Deviation Gauge & Needle */}
                      <div className="flex flex-col gap-1">
                        <div className="flex justify-between text-[10px] font-mono font-bold text-zinc-400 px-1">
                          <span>-50¢ 偏低</span>
                          <span className="text-emerald-400 font-black">0¢ (標準音)</span>
                          <span>+50¢ 偏高</span>
                        </div>
                        <div className="relative w-full h-3.5 bg-zinc-900 rounded-full overflow-hidden flex items-center border border-zinc-800">
                          {/* Target in-tune zone (±10 cents) */}
                          <div className="absolute left-[40%] right-[40%] top-0 bottom-0 bg-emerald-500/25 border-x border-emerald-500/50" />
                          <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-emerald-400 z-10" />
                          {isVoiced && (
                            <div
                              className={`absolute top-0 bottom-0 w-2.5 rounded-full shadow-lg transition-all duration-75 ${
                                Math.abs(currentCents) <= 10
                                  ? 'bg-emerald-400 shadow-emerald-400/50 ring-1 ring-white'
                                  : Math.abs(currentCents) <= 25
                                    ? 'bg-amber-400 shadow-amber-400/50'
                                    : 'bg-rose-400 shadow-rose-400/50'
                              }`}
                              style={{
                                left: `calc(${50 + (Math.max(-50, Math.min(50, currentCents)) / 50) * 45}% - 5px)`,
                              }}
                            />
                          )}
                        </div>
                      </div>

                      {/* Waveform Canvas & Volume Level Meter */}
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 items-center pt-1">
                        <div className="sm:col-span-2 h-11 bg-zinc-900/90 rounded-xl overflow-hidden border border-zinc-800/80">
                          <canvas
                            ref={practiceCanvasRef}
                            width={500}
                            height={44}
                            className="w-full h-full"
                          />
                        </div>

                        {/* Input RMS Volume Gauge */}
                        <div className="flex flex-col gap-1 p-2 bg-zinc-900/80 rounded-xl border border-zinc-800">
                          <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400">
                            <span>輸入音量 (RMS)</span>
                            <span className="font-bold text-zinc-300">
                              {(currentRms * 100).toFixed(1)}%
                            </span>
                          </div>
                          <div className="w-full h-2 bg-zinc-800 rounded-full overflow-hidden">
                            <div
                              className={`h-full transition-all duration-75 rounded-full ${
                                currentRms > 0.3
                                  ? 'bg-rose-500'
                                  : currentRms > 0.15
                                    ? 'bg-amber-400'
                                    : 'bg-emerald-500'
                              }`}
                              style={{ width: `${Math.min(100, (currentRms / 0.25) * 100)}%` }}
                            />
                          </div>
                          <span className="text-[9px] text-zinc-500 truncate">
                            {currentRms < 0.008
                              ? '環境靜音'
                              : currentRms > 0.3
                                ? '⚠️ 音量過大 (請調降增益)'
                                : '✅ 收音良好'}
                          </span>
                        </div>
                      </div>

                      {/* Real-time Pitch Stabilizer Slider in Practice Card */}
                      <div className="flex flex-col gap-2 p-2.5 bg-zinc-900/90 rounded-xl border border-zinc-800/90">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5 text-xs text-zinc-300 font-bold">
                            <SlidersHorizontal className="w-3.5 h-3.5 text-amber-400" />
                            <span>即時防抖強度 (Pitch Stabilizer)</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span
                              className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                                stabilizerStrength <= 0.3
                                  ? 'bg-blue-500/20 text-blue-300'
                                  : stabilizerStrength <= 0.65
                                    ? 'bg-emerald-500/20 text-emerald-300'
                                    : 'bg-amber-500/20 text-amber-300'
                              }`}
                            >
                              {stabilizerStrength <= 0.3
                                ? '⚡ 靈敏'
                                : stabilizerStrength <= 0.65
                                  ? '🎯 平穩'
                                  : '🛡️ 極致防抖'}
                            </span>
                            <span className="text-xs font-mono font-black text-amber-400">
                              {Math.round(stabilizerStrength * 100)}%
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2.5">
                          <span className="text-[9px] text-zinc-500">0%</span>
                          <input
                            id="deck-practice-stabilizer-slider"
                            type="range"
                            min="0"
                            max="1"
                            step="0.05"
                            value={stabilizerStrength}
                            onChange={e => handleStabilizerChange(parseFloat(e.target.value))}
                            className="accent-amber-500 flex-1 h-1.5 bg-zinc-800 rounded-lg cursor-pointer"
                          />
                          <span className="text-[9px] text-zinc-500">100%</span>
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => handleStabilizerChange(0.25)}
                              className={`px-1.5 py-0.5 rounded text-[10px] font-bold transition-all cursor-pointer ${
                                Math.abs(stabilizerStrength - 0.25) < 0.04
                                  ? 'bg-amber-400 text-zinc-950 font-black'
                                  : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                              }`}
                            >
                              25%
                            </button>
                            <button
                              type="button"
                              onClick={() => handleStabilizerChange(0.50)}
                              className={`px-1.5 py-0.5 rounded text-[10px] font-bold transition-all cursor-pointer ${
                                Math.abs(stabilizerStrength - 0.50) < 0.04
                                  ? 'bg-amber-400 text-zinc-950 font-black'
                                  : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                              }`}
                            >
                              50%
                            </button>
                            <button
                              type="button"
                              onClick={() => handleStabilizerChange(0.80)}
                              className={`px-1.5 py-0.5 rounded text-[10px] font-bold transition-all cursor-pointer ${
                                Math.abs(stabilizerStrength - 0.80) < 0.04
                                  ? 'bg-amber-400 text-zinc-950 font-black'
                                  : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                              }`}
                            >
                              80%
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* Practice Instruction Hint */}
                      <div className="flex items-center gap-1.5 text-[11px] text-emerald-300/90 bg-emerald-950/40 p-2 rounded-lg border border-emerald-800/40">
                        <Sparkles className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        <span>
                          <strong>音準對齊練習：</strong>點擊下方鋼琴琴鍵試聽標準音，對著麥克風唱出相同音高，讓指針居中、琴鍵亮起綠色「唱音」！
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-4 p-4 rounded-2xl bg-zinc-50 dark:bg-zinc-900/40 border border-zinc-200 dark:border-zinc-800/60">
                <div className="flex items-center justify-between flex-wrap gap-2 text-xs">
                  <span className="font-black text-zinc-700 dark:text-zinc-300 flex items-center gap-1.5">
                    <Keyboard className="w-4 h-4 text-amber-500" />
                    <span>電腦打字鍵位與 Web MIDI 設備</span>
                  </span>
                  <div className="flex items-center gap-2 font-mono">
                    <span className="text-zinc-400">MIDI 狀態:</span>
                    <span
                      className={`px-2 py-0.5 rounded-full font-bold text-[10px] ${
                        isMidiConnected
                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                          : 'bg-zinc-800 text-zinc-400'
                      }`}
                    >
                      {isMidiConnected
                        ? `已連線 (${midiDevices.find(d => d.id === activeMidiDevice)?.name || '外部鍵盤'})`
                        : isMidiSupported
                          ? '未偵測到 MIDI 設備 (可用打字/觸控)'
                          : '瀏覽器不支援 MIDI'}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {/* QWERTY Mapping Selector */}
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-mono font-bold text-zinc-400 uppercase">
                      電腦鍵盤打字映射
                    </label>
                    <select
                      id="deck-qwerty-mode-select"
                      value={qwertyMappingMode}
                      onChange={e => setQwertyMappingMode(e.target.value as QwertyMappingMode)}
                      className="px-2.5 py-1.5 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-xl text-xs font-bold text-zinc-900 dark:text-zinc-100 cursor-pointer"
                    >
                      <option value="chromatic_piano">
                        固定鋼琴白黑鍵 (A~K 為 C4~C5，W/E/T/Y/U 為升音)
                      </option>
                      <option value="diatonic_degrees">
                        首調唱名 (A~J 固定為 1~7 音，自動隨調號移調)
                      </option>
                    </select>
                  </div>

                  {/* Triplets Toggle */}
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-mono font-bold text-zinc-400 uppercase">
                      三連音辨識 (Triplets)
                    </label>
                    <button
                      type="button"
                      onClick={() => setAllowTriplets(!allowTriplets)}
                      className={`px-2.5 py-1.5 rounded-xl text-xs font-bold border transition-colors cursor-pointer text-center ${
                        allowTriplets
                          ? 'bg-amber-500/20 text-amber-600 dark:text-amber-300 border-amber-500/40'
                          : 'bg-zinc-200 dark:bg-zinc-800 text-zinc-500 border-zinc-300 dark:border-zinc-700'
                      }`}
                    >
                      {allowTriplets ? '開 (允許三連音 3 連音量化)' : '關 (純二進位節奏)'}
                    </button>
                  </div>
                </div>

                {/* One-Finger Gap Filtering & Threshold Slider */}
                <div className="flex flex-col gap-2.5 p-3 rounded-xl bg-zinc-100 dark:bg-zinc-800/70 border border-zinc-200 dark:border-zinc-700/80">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex flex-col">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-black text-zinc-800 dark:text-zinc-200">
                          單指彈奏空隙過濾 (One-Finger Gap Filter)
                        </span>
                        <span
                          className={`text-[10px] font-bold px-1.5 py-0.2 rounded font-mono ${
                            filterOneFingerGaps
                              ? 'bg-amber-500/20 text-amber-600 dark:text-amber-300'
                              : 'bg-zinc-200 dark:bg-zinc-700 text-zinc-500'
                          }`}
                        >
                          {filterOneFingerGaps ? '已開啟 (預設自動填補換音空隙)' : '已關閉 (保留原始彈奏空隙)'}
                        </span>
                      </div>
                      <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                        自動吸收單指換鍵時的抬指空白，延伸前音避免產生零碎的八分休止符 (0)
                      </span>
                    </div>

                    <button
                      id="deck-one-finger-gap-toggle"
                      type="button"
                      onClick={() => setFilterOneFingerGaps(!filterOneFingerGaps)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-colors cursor-pointer ${
                        filterOneFingerGaps
                          ? 'bg-amber-500 hover:bg-amber-400 text-zinc-950 border-amber-500 shadow-xs'
                          : 'bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 text-zinc-700 dark:text-zinc-300 border-zinc-300 dark:border-zinc-600'
                      }`}
                    >
                      {filterOneFingerGaps ? '開啟 (過濾空隙)' : '關閉 (不作過濾)'}
                    </button>
                  </div>

                  {filterOneFingerGaps && (
                    <div className="flex flex-col gap-1.5 pt-1.5 border-t border-zinc-200 dark:border-zinc-700/60 animate-in fade-in duration-150">
                      <div className="flex items-center justify-between text-xs font-mono">
                        <span className="font-bold text-zinc-600 dark:text-zinc-400">
                          過濾門檻 (Gap Threshold):
                        </span>
                        <span className="font-black text-amber-600 dark:text-amber-400">
                          {oneFingerGapThresholdMs} ms
                          <span className="text-[11px] font-normal text-zinc-500 ml-1">
                            (約 {(oneFingerGapThresholdMs / (60000 / activeBpm)).toFixed(2)} 拍)
                          </span>
                        </span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-[10px] font-mono text-zinc-400">150ms (快)</span>
                        <input
                          id="deck-one-finger-gap-slider"
                          type="range"
                          min={150}
                          max={900}
                          step={25}
                          value={oneFingerGapThresholdMs}
                          onChange={e => setOneFingerGapThresholdMs(Number(e.target.value))}
                          className="flex-1 accent-amber-500 h-1.5 bg-zinc-300 dark:bg-zinc-700 rounded-lg cursor-pointer"
                        />
                        <span className="text-[10px] font-mono text-zinc-400">900ms (慢)</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* PERSISTENT PIANO BED IN SETUP */}
            <div className="flex flex-col gap-2">
              <PianoBed
                activeKey={activeKey}
                accidentalPreference={accidentalPref}
                octaveBedView={octaveBedView}
                onOctaveBedViewChange={setOctaveBedView}
                activeMidiSet={activeMidiSet}
                detectedPitchMidi={activeMode === 'hum' && isVoiced ? currentMidi : null}
                onNoteDown={handlePianoNoteDown}
                onNoteUp={handlePianoNoteUp}
                mode={activeMode === 'hum' ? 'align' : 'record'}
                octaveShiftVal={octaveShiftVal}
              />
            </div>

            {/* START RECORDING BUTTON */}
            <div className="flex items-center justify-end gap-3 pt-2">
              {onClose && (
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2.5 rounded-xl border border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 text-xs font-bold hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  關閉
                </button>
              )}
              <button
                id="deck-start-recording-btn"
                type="button"
                onClick={startRecordingFlow}
                className="flex items-center gap-2 px-6 py-3 rounded-2xl bg-gradient-to-r from-amber-500 to-amber-400 hover:from-amber-400 hover:to-amber-300 text-zinc-950 font-black text-sm shadow-md transition-all active:scale-95 cursor-pointer"
              >
                {activeMode === 'hum' ? (
                  <>
                    <Mic2 className="w-4 h-4" />
                    <span>開始哼唱收音 (Start Hum Recording)</span>
                  </>
                ) : (
                  <>
                    <Keyboard className="w-4 h-4" />
                    <span>開始鍵盤彈奏 (Start Keyboard Recording)</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* ======================================================================= */}
        {/* STEP 2 & 3: COUNTING_IN + RECORDING (unified — zero keyboard jump)      */}
        {/* ======================================================================= */}
        {(step === 'COUNTING_IN' || step === 'RECORDING') && (
          <div className="flex flex-col gap-5 animate-in fade-in duration-200">

            {/* ── Status Header ─────────────────────────────────────────────── */}
            {step === 'COUNTING_IN' ? (
              <div className="flex items-center justify-between px-4 py-2.5 bg-amber-500/15 border border-amber-500/30 rounded-2xl flex-wrap gap-2 min-h-[42px]">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-amber-500 animate-ping" />
                  <span className="text-xs font-black text-amber-700 dark:text-amber-300 uppercase tracking-wider">
                    {activeMode === 'hum'
                      ? `哼唱預備 · 倒數 ${countdownBeat} 拍`
                      : `琴鍵預備 · 倒數 ${countdownBeat} 拍`}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono text-amber-600 dark:text-amber-400 font-bold hidden sm:inline">
                    {countdownBeatsCount} 拍預備拍 · 速度 {activeBpm} BPM
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      stopAllPipelines();
                      setStep('SETUP');
                    }}
                    className="px-3 py-1 rounded-xl border border-zinc-300 dark:border-zinc-700 text-xs font-bold text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                  >
                    取消預備
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between px-4 py-2.5 bg-rose-500/15 border border-rose-500/30 rounded-2xl flex-wrap gap-2 min-h-[42px]">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-rose-500 animate-ping" />
                  <span className="text-xs font-black text-rose-700 dark:text-rose-300 uppercase tracking-wider">
                    {activeMode === 'hum' ? `錄音辨識中 · ${activePreset.nameZh}` : '琴鍵彈奏收集中'}
                  </span>
                </div>
                <div className="flex items-center gap-2 font-mono font-bold text-sm text-rose-700 dark:text-rose-300">
                  <Clock className="w-4 h-4" />
                  <span>{recordingSeconds.toFixed(1)}s</span>
                </div>
              </div>
            )}

            {/* ── VISUAL METRONOME CLICK BAR (Red Frame — identical in both steps) ── */}
            <div
              id="deck-visual-metronome-bar"
              className={`h-16 px-4 rounded-2xl border transition-colors duration-100 flex items-center justify-between gap-3 overflow-hidden select-none box-border ${
                isDownbeatFlash
                  ? 'bg-amber-500/20 border-amber-400 shadow-md'
                  : isBeatPulse
                    ? 'bg-zinc-800/95 border-amber-500/40 shadow-xs'
                    : 'bg-zinc-900/90 border-zinc-800'
              }`}
            >
              {/* Left: Beat Badge + Label */}
              <div className="flex items-center gap-3 shrink-0 w-44 sm:w-48">
                <div
                  className={`w-10 h-10 rounded-xl flex items-center justify-center font-black text-lg transition-all duration-100 shrink-0 ${
                    isDownbeatFlash
                      ? 'bg-amber-400 text-zinc-950 scale-105 shadow-md shadow-amber-400/40 ring-1 ring-amber-300'
                      : isBeatPulse
                        ? 'bg-amber-500 text-zinc-950 scale-102 shadow-xs'
                        : 'bg-zinc-800 text-zinc-300 border border-zinc-700'
                  }`}
                >
                  {step === 'COUNTING_IN' ? countdownBeat : currentBeatInBar}
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-bold text-zinc-200 flex items-center gap-1.5 truncate">
                    <Activity className="w-3.5 h-3.5 text-amber-400" />
                    <span>{step === 'COUNTING_IN' ? '預備倒數' : '節拍器'}</span>
                  </span>
                  <span className="text-[10px] font-mono text-zinc-400">
                    {step === 'COUNTING_IN'
                      ? `${activeBpm} BPM · 倒數 ${countdownBeat} 拍`
                      : `${activeBpm} BPM · ${activeTimeSignature} 拍`}
                  </span>
                </div>
              </div>

              {/* Center: Beat Pods */}
              <div className="flex items-center justify-center gap-2 flex-1">
                {step === 'COUNTING_IN'
                  ? Array.from({ length: countdownBeatsCount }).map((_, idx) => {
                      const beatNum = idx + 1;
                      const isCurrent = countdownBeat === beatNum;
                      const isDown = beatNum === 1;
                      return (
                        <div
                          key={beatNum}
                          className={`flex items-center justify-center w-10 sm:w-12 h-9 rounded-xl text-xs font-mono font-bold transition-all duration-100 select-none ${
                            isCurrent
                              ? isDown
                                ? 'bg-amber-400 text-zinc-950 font-black ring-1 ring-amber-300 shadow-sm scale-105'
                                : 'bg-amber-500 text-zinc-950 font-black scale-105'
                              : isDown
                                ? 'bg-zinc-800/90 border border-amber-500/40 text-amber-400'
                                : 'bg-zinc-800/60 text-zinc-400 border border-zinc-700/60'
                          }`}
                        >
                          <span className="text-[9px] mr-0.5">{isDown ? '★' : '•'}</span>
                          <span>{beatNum}</span>
                        </div>
                      );
                    })
                  : Array.from({ length: parseInt(activeTimeSignature.split('/')[0], 10) || 4 }).map(
                      (_, idx) => {
                        const beatNum = idx + 1;
                        const isCurrent = currentBeatInBar === beatNum;
                        const isDown = beatNum === 1;
                        return (
                          <div
                            key={beatNum}
                            className={`flex items-center justify-center w-10 sm:w-12 h-9 rounded-xl text-xs font-mono font-bold transition-all duration-100 select-none ${
                              isCurrent
                                ? isDown
                                  ? 'bg-amber-400 text-zinc-950 font-black ring-1 ring-amber-300 shadow-sm scale-105'
                                  : 'bg-amber-500 text-zinc-950 font-black scale-105'
                                : isDown
                                  ? 'bg-zinc-800/90 border border-amber-500/40 text-amber-400'
                                  : 'bg-zinc-800/60 text-zinc-400 border border-zinc-700/60'
                            }`}
                          >
                            <span className="text-[9px] mr-0.5">{isDown ? '★' : '•'}</span>
                            <span>{beatNum}</span>
                          </div>
                        );
                      }
                    )}
              </div>

              {/* Right: Audible Click Toggle */}
              <button
                type="button"
                onClick={() => setAudibleClickDuringRecording(!audibleClickDuringRecording)}
                className={`flex items-center justify-center gap-1.5 h-9 px-3 text-xs font-bold rounded-xl border transition-all cursor-pointer select-none shrink-0 ${
                  audibleClickDuringRecording
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 hover:bg-amber-500/30'
                    : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:text-zinc-200'
                }`}
              >
                {audibleClickDuringRecording ? (
                  <>
                    <Volume2 className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    <span className="hidden sm:inline">提示音：開</span>
                  </>
                ) : (
                  <>
                    <VolumeX className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                    <span className="hidden sm:inline">提示音：靜音</span>
                  </>
                )}
              </button>
            </div>

            {/* ── HUM-SPECIFIC: PITCH TUNER GAUGE (shown in both steps for hum) ─ */}
            {activeMode === 'hum' && (
              <div className="p-4 bg-zinc-900 border border-zinc-800 rounded-2xl flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-baseline gap-2">
                    <span className="text-4xl font-black text-amber-400 font-mono">
                      {activeSolfegInfo.noteNum}
                    </span>
                    <span className="text-base font-bold text-zinc-400">
                      {activeSolfegInfo.solfege}
                    </span>
                    {activeSolfegInfo.octaveDots !== 0 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold">
                        {activeSolfegInfo.octaveDots > 0
                          ? `+${activeSolfegInfo.octaveDots} 八度`
                          : `${activeSolfegInfo.octaveDots} 八度`}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col items-end text-xs font-mono">
                    <span className="text-zinc-400">
                      {currentPitchHz ? `${currentPitchHz.toFixed(1)} Hz` : '等待唱音...'}
                    </span>
                    <span
                      className={`font-bold ${
                        Math.abs(currentCents) <= 15
                          ? 'text-emerald-400'
                          : Math.abs(currentCents) <= 30
                            ? 'text-amber-400'
                            : 'text-rose-400'
                      }`}
                    >
                      {currentPitchHz ? `${currentCents > 0 ? '+' : ''}${currentCents} ¢` : ''}
                    </span>
                  </div>
                </div>

                {/* Needle Bar */}
                <div className="relative w-full h-3 bg-zinc-800 rounded-full overflow-hidden flex items-center">
                  <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-zinc-400 z-10" />
                  <div className="absolute left-[35%] right-[35%] top-0 bottom-0 bg-emerald-500/20" />
                  {isVoiced && (
                    <div
                      className="absolute top-0 bottom-0 w-2 rounded-full bg-amber-400 shadow-md transition-all duration-75"
                      style={{
                        left: `calc(${50 + (Math.max(-50, Math.min(50, currentCents)) / 50) * 45}% - 4px)`,
                      }}
                    />
                  )}
                </div>

                {/* Oscilloscope Canvas */}
                <div className="w-full h-10 bg-zinc-950 rounded-xl overflow-hidden">
                  <canvas ref={canvasRef} width={600} height={40} className="w-full h-full" />
                </div>
              </div>
            )}

            {/* ── KEYBOARD-SPECIFIC: DURATION BADGE & LIVE NOTES STREAM ─────── */}
            {activeMode === 'keyboard' && (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between px-4 py-2.5 bg-zinc-900 rounded-2xl border border-zinc-800 min-h-[44px]">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-zinc-400">目前按壓時值：</span>
                    {step === 'COUNTING_IN' ? (
                      <span className="text-xs text-zinc-500 font-mono">
                        倒數結束後開始彈奏...
                      </span>
                    ) : activeHeldBeats !== null ? (
                      <span className="px-2 py-0.5 rounded-lg bg-amber-500 text-zinc-950 font-black font-mono text-xs animate-pulse">
                        {activeHeldBeats.toFixed(2)} 拍
                      </span>
                    ) : (
                      <span className="text-xs text-zinc-500 font-mono">放開琴鍵即可結算音符</span>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={step === 'COUNTING_IN'}
                    onClick={() => keyEngineRef.current?.undoLastNote()}
                    className={`px-2.5 py-1 text-xs font-bold rounded-lg border transition-colors ${
                      step === 'COUNTING_IN'
                        ? 'bg-zinc-800/50 text-zinc-600 border-zinc-700/50 cursor-not-allowed'
                        : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border-zinc-700 cursor-pointer'
                    }`}
                    title="撤銷上一個音符 (Backspace)"
                  >
                    撤銷上音 (Undo)
                  </button>
                </div>

                {/* Live stream — only shows during recording */}
                {step === 'RECORDING' && liveRecordedNotes.length > 0 && (
                  <div className="flex items-center gap-2 p-2 bg-zinc-950/70 rounded-xl border border-zinc-800/80 overflow-x-auto">
                    <span className="text-[10px] font-bold text-zinc-400 font-mono shrink-0">
                      已錄入：
                    </span>
                    <div className="flex items-center gap-1.5 flex-nowrap">
                      {liveRecordedNotes.map(n => (
                        <div
                          key={n.id}
                          className="flex items-center gap-1 px-2 py-0.5 rounded-lg bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono font-bold shrink-0"
                        >
                          <span className="text-amber-400 font-black">
                            {n.accidental}{n.pitch}{n.octave > 0 ? '̇' : n.octave < 0 ? '̣' : ''}
                          </span>
                          <span className="text-[10px] px-1 rounded bg-zinc-800 text-zinc-400">
                            {n.duration}拍
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── PERSISTENT PIANO BED (never unmounted — zero jump) ──────────── */}
            <div className="flex flex-col gap-2">
              <PianoBed
                activeKey={activeKey}
                accidentalPreference={accidentalPref}
                octaveBedView={octaveBedView}
                onOctaveBedViewChange={setOctaveBedView}
                activeMidiSet={activeMidiSet}
                detectedPitchMidi={activeMode === 'hum' && isVoiced ? currentMidi : null}
                onNoteDown={handlePianoNoteDown}
                onNoteUp={handlePianoNoteUp}
                mode={activeMode === 'hum' ? 'align' : 'record'}
                octaveShiftVal={octaveShiftVal}
              />
            </div>

            {/* ── Bottom Action Row (identical height in both steps) ────────── */}
            <div className="flex items-center justify-between pt-2 min-h-[52px]">
              <button
                type="button"
                onClick={() => {
                  stopAllPipelines();
                  setStep('SETUP');
                }}
                className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-xl transition-colors cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>{step === 'COUNTING_IN' ? '取消預備' : '重新錄製'}</span>
              </button>

              {step === 'COUNTING_IN' ? (
                <div className="flex items-center gap-2 px-6 py-3 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-400 text-sm font-bold select-none">
                  <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                  <span>倒數結束自動開始錄製...</span>
                </div>
              ) : (
                <button
                  id="deck-finish-recording-btn"
                  type="button"
                  onClick={handleFinishRecording}
                  className="flex items-center gap-2 px-6 py-3 rounded-2xl bg-amber-500 hover:bg-amber-400 text-zinc-950 font-black text-sm shadow-md transition-all active:scale-95 cursor-pointer"
                >
                  <Check className="w-4 h-4 stroke-[3]" />
                  <span>完成轉寫並檢視 (Finish &amp; Review)</span>
                </button>
              )}
            </div>
          </div>
        )}


        {/* ======================================================================= */}
        {step === 'REVIEW' && (
          <div className="flex flex-col gap-6 animate-in fade-in duration-200">
            {/* Review Header Banner */}
            <div className="flex items-center justify-between p-4 rounded-2xl bg-zinc-900 border border-zinc-800 flex-wrap gap-3">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center font-bold">
                  <Check className="w-4 h-4 stroke-[3]" />
                </div>
                <div>
                  <h3 className="text-sm font-extrabold text-zinc-100">
                    轉寫完成 · 簡譜成果檢視
                  </h3>
                  <span className="text-xs font-mono text-zinc-400">
                    1={activeKey} · {transcribedMeasures.length} 小節 · 共{' '}
                    {transcribedMeasures.reduce((sum, m) => sum + (m.notes?.length || 0), 0)} 個音符
                  </span>
                </div>
              </div>

              {/* Dual-Track Audio Players */}
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={handleToggleRawPlay}
                  className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                    isRawPlaying
                      ? 'bg-rose-500 text-white'
                      : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700'
                  }`}
                >
                  {isRawPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                  <span>{activeMode === 'hum' ? '試聽原始人聲' : '試聽原始演奏'}</span>
                </button>

                <button
                  type="button"
                  onClick={handleToggleSynthPlay}
                  className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-black transition-all cursor-pointer ${
                    isSynthPlaying
                      ? 'bg-rose-500 text-white'
                      : 'bg-amber-500 hover:bg-amber-400 text-zinc-950'
                  }`}
                >
                  {isSynthPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 fill-current" />}
                  <span>試聽轉譜樂音 (Synth)</span>
                </button>
              </div>
            </div>

            {/* Visual Numbered Notation Score Preview */}
            <div className="p-4 rounded-2xl bg-zinc-950 border border-zinc-800 overflow-x-auto">
              <div className="flex flex-wrap items-stretch gap-y-4 gap-x-2">
                {transcribedMeasures.map((m, mIdx) => (
                  <div
                    key={m.id || `preview-m-${mIdx}`}
                    className="relative flex items-center p-2 rounded-xl bg-zinc-900/80 border border-zinc-800"
                  >
                    <span className="absolute -top-2.5 left-2 px-1 rounded font-mono text-[9px] font-bold bg-zinc-800 text-zinc-400 border border-zinc-700">
                      {mIdx + 1}
                    </span>
                    <div className="flex items-center gap-1 px-1 py-0.5">
                      {(m.notes || []).map((note, nIdx) => (
                        <NumberedNotationNoteComponent
                          key={note.id || `preview-n-${mIdx}-${nIdx}`}
                          note={note}
                          prevNote={nIdx > 0 ? m.notes[nIdx - 1] : null}
                        />
                      ))}
                    </div>
                    <div className="w-[1px] h-8 bg-zinc-700 mx-1 rounded-full shrink-0" />
                  </div>
                ))}
              </div>
            </div>

            {/* Quick Re-quantize & Fine-Tuning Bar */}
            <div className="flex items-center justify-between p-3.5 rounded-2xl bg-zinc-900 border border-zinc-800 flex-wrap gap-3 text-xs">
              <div className="flex items-center gap-4 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-zinc-400">八度位移:</span>
                  <button
                    type="button"
                    onClick={() => {
                      const next = octaveShiftVal - 1;
                      setOctaveShiftVal(next);
                      handleRetranscribe({ octaveShift: next });
                    }}
                    className="px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 cursor-pointer"
                  >
                    -1 八度
                  </button>
                  <span className="font-mono font-bold text-amber-400 px-1">
                    {octaveShiftVal > 0 ? `+${octaveShiftVal}` : octaveShiftVal}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const next = octaveShiftVal + 1;
                      setOctaveShiftVal(next);
                      handleRetranscribe({ octaveShift: next });
                    }}
                    className="px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 cursor-pointer"
                  >
                    +1 八度
                  </button>
                </div>

                {activeMode === 'keyboard' && (
                  <div className="flex items-center gap-2 sm:border-l sm:border-zinc-800 sm:pl-4 flex-wrap">
                    <span className="font-bold text-zinc-400">單指空隙過濾:</span>
                    <button
                      type="button"
                      onClick={() => {
                        const next = !filterOneFingerGaps;
                        setFilterOneFingerGaps(next);
                        handleRetranscribe({ filterOneFingerGaps: next });
                      }}
                      className={`px-2.5 py-1 rounded-lg text-xs font-bold border transition-colors cursor-pointer ${
                        filterOneFingerGaps
                          ? 'bg-amber-500 text-zinc-950 border-amber-500 font-black'
                          : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:text-zinc-200'
                      }`}
                    >
                      {filterOneFingerGaps ? '已開啟' : '已關閉'}
                    </button>

                    {filterOneFingerGaps && (
                      <div className="flex items-center gap-1.5 ml-1">
                        <span className="text-zinc-400 font-mono text-[11px]">門檻:</span>
                        <input
                          type="range"
                          min={150}
                          max={900}
                          step={25}
                          value={oneFingerGapThresholdMs}
                          onChange={e => {
                            const val = Number(e.target.value);
                            setOneFingerGapThresholdMs(val);
                            handleRetranscribe({ filterOneFingerGaps: true, oneFingerMaxGapMs: val });
                          }}
                          className="w-20 accent-amber-500 h-1 bg-zinc-700 rounded-lg cursor-pointer"
                          title={`過濾門檻: ${oneFingerGapThresholdMs}ms`}
                        />
                        <span className="font-mono text-amber-400 text-[11px] font-bold">
                          {oneFingerGapThresholdMs}ms
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                <span className="font-bold text-zinc-400">寫入方式:</span>
                <select
                  value={insertionMode}
                  onChange={e => setInsertionMode(e.target.value as InsertionMode)}
                  className="px-2.5 py-1 bg-zinc-800 border border-zinc-700 rounded-xl text-zinc-200 font-bold cursor-pointer"
                >
                  <option value="replace">取代現有樂譜</option>
                  <option value="append">追加至樂譜末尾</option>
                  <option value="cursor">插入目前選取小節</option>
                </select>
              </div>
            </div>

            {/* COMMIT OR DISCARD */}
            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={() => {
                  stopAllPipelines();
                  setStep('SETUP');
                }}
                className="flex items-center gap-1.5 px-4 py-2.5 text-xs font-bold text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-xl transition-colors cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>放棄重錄</span>
              </button>

              <button
                id="deck-commit-to-score-btn"
                type="button"
                onClick={handleCommit}
                className="flex items-center gap-2 px-7 py-3 rounded-2xl bg-gradient-to-r from-amber-500 to-amber-400 hover:from-amber-400 hover:to-amber-300 text-zinc-950 font-black text-sm shadow-md transition-all active:scale-95 cursor-pointer"
              >
                <Check className="w-4 h-4 stroke-[3]" />
                <span>確認寫入樂譜 (Commit to Score)</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
