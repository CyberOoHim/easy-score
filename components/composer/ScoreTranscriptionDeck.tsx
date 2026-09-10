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
  ChevronUp,
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
  Upload,
  FileAudio,
  UploadCloud,
  AlertCircle,
  RefreshCw,
  Zap,
  Gauge,
  Compass,
} from 'lucide-react';
import {
  transcribeAudioFile,
  type AudioFileTranscriptionResult,
  type TempoEstimationResult,
  type TranscriptionEngine,
} from '@/lib/pitch/audioFileTranscriber';

export type StudioTranscriptionMode = 'hum' | 'upload' | 'keyboard';
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

  // Collapsible Advanced Settings in Setup mode
  const [showAdvancedSettings, setShowAdvancedSettings] = useState<boolean>(false);

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
  // AUDIO FILE UPLOAD & TRANSCRIPTION STATES
  // =========================================================================
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [uploadedFileSize, setUploadedFileSize] = useState<number | null>(null);
  const [uploadedAudioDuration, setUploadedAudioDuration] = useState<number | null>(null);
  const [uploadedWaveformPeaks, setUploadedWaveformPeaks] = useState<number[]>([]);
  const [isTranscribingFile, setIsTranscribingFile] = useState<boolean>(false);
  const [transcribeProgress, setTranscribeProgress] = useState<number>(0);
  const [transcribeStatusText, setTranscribeStatusText] = useState<string>('');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState<boolean>(false);
  const [previewAudioUrl, setPreviewAudioUrl] = useState<string | null>(null);
  const [isPreviewAudioPlaying, setIsPreviewAudioPlaying] = useState<boolean>(false);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // =========================================================================
  // REVIEW & OUTPUT STATES
  // =========================================================================
  const [transcriptionResult, setTranscriptionResult] = useState<TranscriptionResult | null>(null);
  const [transcribedMeasures, setTranscribedMeasures] = useState<Measure[]>([]);
  const [rawSegments, setRawSegments] = useState<RawNoteSegment[]>([]);
  const [isRawPlaying, setIsRawPlaying] = useState<boolean>(false);
  const [rawPlaybackProgress, setRawPlaybackProgress] = useState<number>(0);
  const [isSynthPlaying, setIsSynthPlaying] = useState<boolean>(false);
  const [detectedTempoResult, setDetectedTempoResult] = useState<TempoEstimationResult | null>(null);
  const [transcriptionEngineUsed, setTranscriptionEngineUsed] = useState<'basic-pitch' | 'dsp-yin'>('basic-pitch');
  const [autoDetectBpmEnabled, setAutoDetectBpmEnabled] = useState<boolean>(true);
  const [alignDownbeatEnabled, setAlignDownbeatEnabled] = useState<boolean>(true);
  const [selectedEngineMode, setSelectedEngineMode] = useState<TranscriptionEngine>('auto');

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

    if (previewAudioRef.current) {
      try {
        previewAudioRef.current.pause();
        previewAudioRef.current.currentTime = 0;
      } catch {}
    }
    setIsPreviewAudioPlaying(false);

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

  // Audio Engine playback state listener: automatically toggle synth play button back when playback finishes
  useEffect(() => {
    const unsubState = audioEngine.subscribeState(state => {
      if (!state.isPlaying) {
        setIsSynthPlaying(false);
      }
    });

    const unsubEnded = audioEngine.subscribeEnded(() => {
      setIsSynthPlaying(false);
    });

    return () => {
      unsubState();
      unsubEnded();
    };
  }, [audioEngine]);

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

  // Format bytes to human readable text
  const formatFileSize = useCallback((bytes: number | null): string => {
    if (bytes === null || bytes === undefined) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }, []);

  // Handle incoming selected or dropped audio file
  const handleFileSelected = useCallback((file: File) => {
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      setUploadError('音檔檔案過大（請上傳小於 50MB 的音訊檔）');
      return;
    }
    if (previewAudioRef.current) {
      try {
        previewAudioRef.current.pause();
      } catch {}
    }
    setIsPreviewAudioPlaying(false);

    setUploadedFile(file);
    setUploadedFileName(file.name);
    setUploadedFileSize(file.size);
    setUploadError(null);

    const objectUrl = URL.createObjectURL(file);
    setPreviewAudioUrl(objectUrl);

    // Read audio duration from metadata
    const tempAudio = new Audio(objectUrl);
    tempAudio.onloadedmetadata = () => {
      if (tempAudio.duration && isFinite(tempAudio.duration)) {
        setUploadedAudioDuration(Math.round(tempAudio.duration * 10) / 10);
      }
    };
  }, []);

  // Generate a pentatonic vocal scale WAV audio blob for instant zero-config testing
  const handleLoadSampleAudio = useCallback(() => {
    try {
      const sampleRate = 44100;
      // 5 notes: C4 (261.63), D4 (293.66), E4 (329.63), G4 (392.00), A4 (440.00)
      const noteFreqs = [261.63, 293.66, 329.63, 392.0, 440.0];
      const noteDurSec = 0.55;
      const restDurSec = 0.15;
      const totalDurSec = noteFreqs.length * (noteDurSec + restDurSec);
      const totalSamples = Math.floor(totalDurSec * sampleRate);
      const pcmData = new Float32Array(totalSamples);

      let offset = 0;
      for (const freq of noteFreqs) {
        const noteSamples = Math.floor(noteDurSec * sampleRate);
        for (let i = 0; i < noteSamples; i++) {
          const t = i / sampleRate;
          const attack = Math.min(1, i / (0.04 * sampleRate));
          const release = Math.min(1, (noteSamples - i) / (0.04 * sampleRate));
          const env = attack * release;
          const sample =
            (Math.sin(2 * Math.PI * freq * t) * 0.6 +
              Math.sin(2 * Math.PI * freq * 2 * t) * 0.25 +
              Math.sin(2 * Math.PI * freq * 3 * t) * 0.1) *
            env *
            0.5;
          pcmData[offset + i] = sample;
        }
        offset += noteSamples + Math.floor(restDurSec * sampleRate);
      }

      // Encode into WAV 16-bit PCM Blob
      const buffer = new ArrayBuffer(44 + totalSamples * 2);
      const view = new DataView(buffer);

      const writeString = (view: DataView, offset: number, string: string) => {
        for (let i = 0; i < string.length; i++) {
          view.setUint8(offset + i, string.charCodeAt(i));
        }
      };

      writeString(view, 0, 'RIFF');
      view.setUint32(4, 36 + totalSamples * 2, true);
      writeString(view, 8, 'WAVE');
      writeString(view, 12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeString(view, 36, 'data');
      view.setUint32(40, totalSamples * 2, true);

      let byteOffset = 44;
      for (let i = 0; i < totalSamples; i++) {
        const s = Math.max(-1, Math.min(1, pcmData[i]));
        view.setInt16(byteOffset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        byteOffset += 2;
      }

      const blob = new Blob([buffer], { type: 'audio/wav' });
      const sampleFile = new File([blob], 'vocal-scale-sample.wav', { type: 'audio/wav' });
      handleFileSelected(sampleFile);
    } catch (err) {
      console.error('Failed to generate sample audio:', err);
    }
  }, [handleFileSelected]);

  // Toggle previewing the selected audio file before transcription
  const togglePreviewAudio = useCallback(() => {
    if (!previewAudioUrl) return;
    if (!previewAudioRef.current) {
      previewAudioRef.current = new Audio(previewAudioUrl);
      previewAudioRef.current.onended = () => setIsPreviewAudioPlaying(false);
      previewAudioRef.current.onerror = () => setIsPreviewAudioPlaying(false);
    } else {
      if (previewAudioRef.current.src !== previewAudioUrl) {
        previewAudioRef.current.src = previewAudioUrl;
      }
    }

    if (isPreviewAudioPlaying) {
      previewAudioRef.current.pause();
      setIsPreviewAudioPlaying(false);
    } else {
      previewAudioRef.current
        .play()
        .then(() => setIsPreviewAudioPlaying(true))
        .catch(() => setIsPreviewAudioPlaying(false));
    }
  }, [previewAudioUrl, isPreviewAudioPlaying]);

  // Execute offline audio file transcription into Numbered Musical Notation
  const handleStartFileTranscription = useCallback(async () => {
    if (!uploadedFile) {
      setUploadError('請先選擇或拖曳人聲音訊檔案');
      return;
    }
    stopAllPipelines();
    if (previewAudioRef.current) {
      try {
        previewAudioRef.current.pause();
      } catch {}
    }
    setIsPreviewAudioPlaying(false);

    setIsTranscribingFile(true);
    setTranscribeProgress(0);
    setTranscribeStatusText('準備解析音檔...');
    setUploadError(null);

    try {
      const res = await transcribeAudioFile(uploadedFile, {
        key: activeKey,
        bpm: activeBpm,
        autoDetectBpm: autoDetectBpmEnabled,
        alignDownbeat: alignDownbeatEnabled,
        engine: selectedEngineMode,
        timeSignature: activeTimeSignature,
        grid: quantizeGrid,
        octaveShift: octaveShiftVal,
        accidentalPreference: accidentalPref,
        scaleMode,
        absorbArticulation,
        stabilizerStrength,
        pitchConfig: activePreset.pitchConfig,
        onsetConfig: activePreset.onsetConfig,
        onProgress: (pct, status) => {
          setTranscribeProgress(pct);
          setTranscribeStatusText(status);
        },
      });

      setUploadedWaveformPeaks(res.waveformPeaks);
      setUploadedAudioDuration(res.audioDurationSec);
      setRawSegments(res.rawSegments);
      setTranscriptionResult(res.transcriptionResult);
      setTranscribedMeasures(res.transcriptionResult.measures);
      setRecordedAudioUrl(res.audioUrl);
      if (res.tempoEstimation) {
        setDetectedTempoResult(res.tempoEstimation);
        if (autoDetectBpmEnabled && res.tempoEstimation.confidence >= 0.4) {
          setActiveBpm(res.tempoEstimation.bpm);
        }
      }
      setTranscriptionEngineUsed(res.engineUsed);
      setIsTranscribingFile(false);
      setStep('REVIEW');
    } catch (err: unknown) {
      console.error('Audio file transcription error:', err);
      setIsTranscribingFile(false);
      setUploadError(
        err instanceof Error
          ? `轉譜失敗: ${err.message}`
          : '無法解碼或辨識此音訊檔案，請確認是否為有效音訊格式 (MP3, WAV, M4A, AAC, OGG, FLAC)。'
      );
    }
  }, [
    uploadedFile,
    activeKey,
    activeBpm,
    autoDetectBpmEnabled,
    alignDownbeatEnabled,
    selectedEngineMode,
    activeTimeSignature,
    quantizeGrid,
    octaveShiftVal,
    accidentalPref,
    scaleMode,
    absorbArticulation,
    stabilizerStrength,
    activePreset,
    stopAllPipelines,
  ]);

  // Re-transcribe with adjusted parameters in Review Step
  const handleRetranscribe = useCallback(
    (overrides?: {
      grid?: QuantizeGrid;
      octaveShift?: number;
      accidentalPreference?: 'auto' | 'sharp' | 'flat';
      allowTriplets?: boolean;
      filterOneFingerGaps?: boolean;
      oneFingerMaxGapMs?: number;
      bpm?: number;
    }) => {
      const segs = rawSegments;
      if (segs.length === 0) return;

      if (isSynthPlaying) {
        audioEngine.stop();
        setIsSynthPlaying(false);
      }
      if (isRawPlaying) {
        setIsRawPlaying(false);
        rawPlaybackTimersRef.current.forEach(id => clearTimeout(id));
        rawPlaybackTimersRef.current = [];
        if (micAudioElementRef.current) {
          try {
            micAudioElementRef.current.pause();
            micAudioElementRef.current.currentTime = 0;
          } catch {}
        }
      }

      const newBpm = overrides?.bpm ?? activeBpm;
      if (overrides?.bpm && overrides.bpm !== activeBpm) {
        setActiveBpm(overrides.bpm);
      }

      const newGrid = overrides?.grid ?? quantizeGrid;
      const newOct = overrides?.octaveShift ?? octaveShiftVal;
      const newAcc = overrides?.accidentalPreference ?? accidentalPref;
      const newTriplets = overrides?.allowTriplets ?? allowTriplets;
      const newFilterOneFingerGaps = overrides?.filterOneFingerGaps ?? filterOneFingerGaps;
      const newOneFingerMaxGapMs = overrides?.oneFingerMaxGapMs ?? oneFingerGapThresholdMs;

      if (activeMode === 'keyboard') {
        const result = transcribeKeyboardSegmentsToMeasures(segs, {
          key: activeKey,
          bpm: newBpm,
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
          bpm: newBpm,
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
      isSynthPlaying,
      isRawPlaying,
      audioEngine,
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

    if ((activeMode === 'hum' || activeMode === 'upload') && recordedAudioUrl) {
      setIsRawPlaying(true);
      if (!micAudioElementRef.current) {
        micAudioElementRef.current = new Audio(recordedAudioUrl);
      } else {
        micAudioElementRef.current.src = recordedAudioUrl;
      }
      micAudioElementRef.current.currentTime = 0;
      micAudioElementRef.current.onended = () => {
        setIsRawPlaying(false);
        setRawPlaybackProgress(0);
      };
      micAudioElementRef.current.onerror = () => {
        setIsRawPlaying(false);
        setRawPlaybackProgress(0);
      };
      micAudioElementRef.current.play().catch(() => setIsRawPlaying(false));
    } else if (activeMode === 'keyboard') {
      const segs = rawSegments;
      if (segs.length === 0) return;

      setIsRawPlaying(true);
      setRawPlaybackProgress(0);
      let maxEndMs = 0;
      segs.forEach(s => {
        const segEnd = s.endTimeMs > 0 ? s.endTimeMs : s.startTimeMs + (s.durationMs || 300);
        if (segEnd > maxEndMs) maxEndMs = segEnd;
      });
      const totalDurationMs = Math.max(400, maxEndMs + 150);
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
          setRawPlaybackProgress(0);
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
    rawPlaybackTimersRef.current.forEach(id => clearTimeout(id));
    rawPlaybackTimersRef.current = [];
    if (micAudioElementRef.current) {
      try {
        micAudioElementRef.current.pause();
        micAudioElementRef.current.currentTime = 0;
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
            {activeMode === 'hum' ? (
              <Mic2 className="w-5 h-5" />
            ) : activeMode === 'upload' ? (
              <Upload className="w-5 h-5" />
            ) : (
              <Keyboard className="w-5 h-5" />
            )}
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
                : activeMode === 'upload'
                  ? '上傳人聲歌唱音檔 (MP3/WAV/M4A) · 離線基頻辨識轉寫簡譜'
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
            id="deck-mode-tab-upload"
            type="button"
            onClick={() => {
              stopAllPipelines();
              setActiveMode('upload');
              setStep('SETUP');
            }}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
              activeMode === 'upload'
                ? 'bg-amber-500 text-zinc-950 font-black shadow-md scale-[1.02]'
                : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-zinc-300/40 dark:hover:bg-zinc-800/60'
            }`}
          >
            <Upload className="w-3.5 h-3.5" />
            <span>音檔轉譜</span>
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
        {/* UNIFIED RECORDING DECK LAYOUT (SETUP / COUNTING_IN / RECORDING)         */}
        {/* Zero-shift architecture: fixed slots guarantee visual stability         */}
        {/* ======================================================================= */}
        {step !== 'REVIEW' && (
          activeMode === 'upload' ? (
            <div className="flex flex-col gap-4 animate-in fade-in duration-200">
              {/* ── SLOT 1: STATUS / SETUP STRIP (Fixed 64px) ────────────────────── */}
              <div className="min-h-[64px] flex items-center justify-between px-4 py-2.5 bg-zinc-50 dark:bg-zinc-900/70 border border-zinc-200 dark:border-zinc-800 rounded-2xl flex-wrap gap-2.5 box-border">
                {/* Left: Quick Params Badges */}
                <div className="flex items-center gap-2 flex-wrap text-xs">
                  {/* Key badge */}
                  <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 font-bold">
                    <span className="text-[10px] text-zinc-400 font-mono">調號</span>
                    <select
                      id="deck-upload-key-select"
                      value={activeKey}
                      onChange={e => setActiveKey(e.target.value as KeySignature)}
                      className="bg-transparent text-amber-600 dark:text-amber-400 font-black cursor-pointer outline-hidden"
                    >
                      {CHROMATIC_KEYS.map(k => (
                        <option key={k} value={k} className="bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100">
                          1 = {k}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Meter badge */}
                  <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 font-bold">
                    <span className="text-[10px] text-zinc-400 font-mono">拍號</span>
                    <select
                      id="deck-upload-time-sig-select"
                      value={activeTimeSignature}
                      onChange={e => setActiveTimeSignature(e.target.value as TimeSignature)}
                      className="bg-transparent text-amber-600 dark:text-amber-400 font-black cursor-pointer outline-hidden"
                    >
                      {STANDARD_TIME_SIGNATURES.map(ts => (
                        <option key={ts.value} value={ts.value} className="bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100">
                          {ts.label} 拍
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* BPM badge */}
                  <div className="flex items-center gap-2 px-2.5 py-1 rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 font-bold">
                    <span className="text-[10px] text-zinc-400 font-mono">速度</span>
                    <span className="font-mono text-amber-600 dark:text-amber-400 font-black w-8">
                      {activeBpm}
                    </span>
                    <input
                      id="deck-upload-bpm-slider"
                      type="range"
                      min="40"
                      max="200"
                      step="1"
                      value={activeBpm}
                      onChange={e => setActiveBpm(parseInt(e.target.value, 10))}
                      className="w-16 sm:w-24 accent-amber-500 h-1.5 bg-zinc-300 dark:bg-zinc-700 rounded-lg cursor-pointer"
                      title={`速度: ${activeBpm} BPM`}
                    />
                  </div>

                  {/* Grid badge */}
                  <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 font-bold">
                    <span className="text-[10px] text-zinc-400 font-mono">量化</span>
                    <select
                      id="deck-upload-grid-select"
                      value={quantizeGrid}
                      onChange={e => setQuantizeGrid(e.target.value as QuantizeGrid)}
                      className="bg-transparent text-zinc-700 dark:text-zinc-300 font-bold cursor-pointer outline-hidden text-xs"
                    >
                      <option value="quarter" className="bg-white dark:bg-zinc-900">¼ 拍 (四分)</option>
                      <option value="eighth" className="bg-white dark:bg-zinc-900">⅛ 拍 (八分)</option>
                      <option value="sixteenth" className="bg-white dark:bg-zinc-900">¹/₁₆ 拍 (十六分)</option>
                    </select>
                  </div>
                </div>

                {/* Right: Advanced Settings Toggle */}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    id="deck-upload-toggle-advanced-btn"
                    onClick={() => setShowAdvancedSettings(!showAdvancedSettings)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-bold transition-all cursor-pointer ${
                      showAdvancedSettings
                        ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40 shadow-xs'
                        : 'bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700 hover:text-zinc-900 dark:hover:text-zinc-200'
                    }`}
                  >
                    <SlidersHorizontal className="w-3.5 h-3.5" />
                    <span>{showAdvancedSettings ? '收起進階參數' : '進階設定'}</span>
                    {showAdvancedSettings ? (
                      <ChevronUp className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              </div>

              {/* ADVANCED SETTINGS ACCORDION */}
              {showAdvancedSettings && (
                <div className="animate-in fade-in duration-150 flex flex-col gap-4 p-4 rounded-2xl bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800">
                  <div className="flex flex-col gap-3.5">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <span className="text-xs font-black text-zinc-700 dark:text-zinc-300 flex items-center gap-1.5">
                        <FileAudio className="w-4 h-4 text-amber-500" />
                        <span>音訊解析模型與聲學防抖</span>
                      </span>
                      <span className="text-xs font-mono text-zinc-400">
                        可針對人聲歌唱或樂器演奏調整切分靈敏度
                      </span>
                    </div>

                    {/* Presets Grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {INSTRUMENT_PRESETS.map(p => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => setPresetId(p.id)}
                          className={`flex flex-col p-2.5 rounded-xl border text-left transition-all cursor-pointer ${
                            presetId === p.id
                              ? 'bg-amber-500/15 border-amber-500 text-amber-800 dark:text-amber-300 shadow-xs ring-1 ring-amber-400/40'
                              : 'bg-white dark:bg-zinc-900/60 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:border-zinc-300'
                          }`}
                        >
                          <div className="flex items-center gap-1.5 text-xs font-black">
                            <span>{p.icon}</span>
                            <span>{p.nameZh}</span>
                          </div>
                          <span className="text-[10px] text-zinc-500 mt-0.5 line-clamp-1">{p.tips}</span>
                        </button>
                      ))}
                    </div>

                    {/* Stabilizer and Articulation Settings */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                      <div className="flex items-center gap-2.5">
                        <span className="text-xs font-bold text-zinc-500 shrink-0">音準防抖平滑:</span>
                        <input
                          id="deck-upload-stabilizer-slider"
                          type="range"
                          min="0"
                          max="1"
                          step="0.05"
                          value={stabilizerStrength}
                          onChange={e => handleStabilizerChange(parseFloat(e.target.value))}
                          className="accent-amber-500 flex-1 h-2 bg-zinc-300 dark:bg-zinc-700 rounded-lg cursor-pointer"
                        />
                        <span className="text-xs font-mono font-bold text-amber-500 w-12 text-right">
                          {Math.round(stabilizerStrength * 100)}%
                        </span>
                      </div>

                      <div className="flex items-center justify-between gap-2 bg-white dark:bg-zinc-800 px-3 py-1.5 rounded-xl border border-zinc-200 dark:border-zinc-700">
                        <span className="text-xs font-bold text-zinc-600 dark:text-zinc-300">
                          吸收換氣/吐音空隙:
                        </span>
                        <button
                          type="button"
                          onClick={() => setAbsorbArticulation(!absorbArticulation)}
                          className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                            absorbArticulation
                              ? 'bg-amber-500 text-zinc-950 font-black'
                              : 'bg-zinc-200 dark:bg-zinc-700 text-zinc-500'
                          }`}
                        >
                          {absorbArticulation ? '開啟 (平滑相連)' : '關閉 (保留微小休止)'}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ── CENTER STAGE: AUDIO FILE DROPZONE & INSPECTION ────────────────── */}
              <div className="flex flex-col gap-3">
                {/* Hidden File Input */}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.webm,.flac"
                  className="hidden"
                  onChange={e => {
                    if (e.target.files && e.target.files[0]) {
                      handleFileSelected(e.target.files[0]);
                    }
                  }}
                />

                {!uploadedFile ? (
                  /* Empty Dropzone Card */
                  <div
                    onDragOver={e => {
                      e.preventDefault();
                      setIsDraggingFile(true);
                    }}
                    onDragLeave={e => {
                      e.preventDefault();
                      setIsDraggingFile(false);
                    }}
                    onDrop={e => {
                      e.preventDefault();
                      setIsDraggingFile(false);
                      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                        handleFileSelected(e.dataTransfer.files[0]);
                      }
                    }}
                    className={`border-2 border-dashed rounded-3xl p-6 sm:p-8 flex flex-col items-center justify-center text-center transition-all ${
                      isDraggingFile
                        ? 'border-amber-500 bg-amber-500/10 scale-[1.01]'
                        : 'border-zinc-300 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/30 hover:border-amber-400 hover:bg-zinc-50/80 dark:hover:bg-zinc-900/60'
                    }`}
                  >
                    <div className="w-14 h-14 rounded-2xl bg-amber-500/15 text-amber-500 flex items-center justify-center mb-3 shadow-inner">
                      <UploadCloud className="w-7 h-7 stroke-[2.2]" />
                    </div>
                    <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-100">
                      拖曳人聲歌唱音檔至此，或點擊選取檔案
                    </h3>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 max-w-md">
                      支援 MP3、WAV、M4A、AAC、OGG、WebM、FLAC 等常見音訊格式 (檔案上限 50MB)
                    </p>

                    <div className="flex items-center gap-3 mt-5 flex-wrap justify-center">
                      <button
                        type="button"
                        id="deck-browse-audio-file-btn"
                        onClick={() => fileInputRef.current?.click()}
                        className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 font-black text-xs shadow-md transition-all active:scale-95 cursor-pointer"
                      >
                        <Upload className="w-4 h-4" />
                        <span>選取音訊檔案</span>
                      </button>

                      <button
                        type="button"
                        id="deck-load-sample-audio-btn"
                        onClick={handleLoadSampleAudio}
                        className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 text-xs font-bold shadow-xs transition-all cursor-pointer"
                      >
                        <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                        <span>載入範例人聲音檔 (1-2-3-5-6 五聲音階)</span>
                      </button>
                    </div>

                    <div className="mt-4 px-4 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-700 dark:text-amber-300/90 max-w-lg leading-relaxed text-left flex items-start gap-2">
                      <Sparkles className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                      <span>
                        <strong className="font-bold">Spotify Basic Pitch 類神經轉譜已就緒：</strong>
                        結合深度學習音高與音頭偵測（抗人聲滑音、抖動與八度音誤判）及 Smart Tempo Tracker 智慧速度與強弱起拍對齊。支援 iPad 與本機離線運算。
                      </span>
                    </div>
                  </div>
                ) : (
                  /* File Selected Card */
                  <div className="flex flex-col gap-3.5 p-4 sm:p-5 rounded-2xl bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800">
                    <div className="flex items-center justify-between flex-wrap gap-3">
                      <div className="flex items-center gap-3">
                        <div className="w-12 h-12 rounded-2xl bg-amber-500/20 text-amber-500 flex items-center justify-center shrink-0">
                          <FileAudio className="w-6 h-6" />
                        </div>
                        <div>
                          <h4 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 break-all">
                            {uploadedFileName}
                          </h4>
                          <div className="flex items-center gap-3 text-xs font-mono text-zinc-500 dark:text-zinc-400 mt-0.5">
                            <span>{formatFileSize(uploadedFileSize)}</span>
                            <span>•</span>
                            <span>
                              {uploadedAudioDuration ? `${uploadedAudioDuration} 秒` : '長度讀取中...'}
                            </span>
                            <span>•</span>
                            <span className="text-emerald-500 font-bold">已解碼就緒</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          id="deck-preview-audio-btn"
                          onClick={togglePreviewAudio}
                          className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                            isPreviewAudioPlaying
                              ? 'bg-rose-500 text-white shadow-sm'
                              : 'bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700 hover:text-zinc-900 dark:hover:text-zinc-100'
                          }`}
                        >
                          {isPreviewAudioPlaying ? (
                            <>
                              <Pause className="w-3.5 h-3.5" />
                              <span>暫停試聽</span>
                            </>
                          ) : (
                            <>
                              <Play className="w-3.5 h-3.5" />
                              <span>試聽原音</span>
                            </>
                          )}
                        </button>

                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="px-3.5 py-2 rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 text-xs font-bold transition-colors cursor-pointer"
                        >
                          更換音檔
                        </button>
                      </div>
                    </div>

                    {/* AI Engine & Smart Tempo Settings Strip */}
                    <div className="pt-2 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-between flex-wrap gap-2 text-xs">
                      {/* Engine Selector */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-zinc-500 dark:text-zinc-400 font-bold">轉譜核心:</span>
                        <div className="inline-flex rounded-xl bg-zinc-200 dark:bg-zinc-800 p-0.5 border border-zinc-300 dark:border-zinc-700">
                          <button
                            type="button"
                            onClick={() => setSelectedEngineMode('auto')}
                            className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                              selectedEngineMode === 'auto' || selectedEngineMode === 'basic-pitch'
                                ? 'bg-amber-500 text-zinc-950 font-black shadow-xs'
                                : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                            }`}
                            title="Spotify Basic Pitch 深度學習類神經網路 (抗滑音、抗八度跳音)"
                          >
                            <span className="flex items-center gap-1">
                              <Zap className="w-3 h-3" />
                              <span>Basic Pitch 類神經 (推薦)</span>
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setSelectedEngineMode('dsp')}
                            className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                              selectedEngineMode === 'dsp'
                                ? 'bg-amber-500 text-zinc-950 font-black shadow-xs'
                                : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                            }`}
                            title="傳統 DSP YIN 基頻分析"
                          >
                            <span>DSP YIN 傳統</span>
                          </button>
                        </div>
                      </div>

                      {/* Smart Tempo & Downbeat Toggles */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          type="button"
                          onClick={() => setAutoDetectBpmEnabled(!autoDetectBpmEnabled)}
                          className={`flex items-center gap-1 px-2.5 py-1 rounded-lg border text-xs font-bold transition-all cursor-pointer ${
                            autoDetectBpmEnabled
                              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400'
                              : 'bg-zinc-200 dark:bg-zinc-800 border-transparent text-zinc-400'
                          }`}
                          title="自動偵測音檔速度 (BPM) 並套用至量化網格"
                        >
                          <Gauge className="w-3 h-3" />
                          <span>自動速度偵測 {autoDetectBpmEnabled ? '開' : '關'}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => setAlignDownbeatEnabled(!alignDownbeatEnabled)}
                          className={`flex items-center gap-1 px-2.5 py-1 rounded-lg border text-xs font-bold transition-all cursor-pointer ${
                            alignDownbeatEnabled
                              ? 'bg-amber-500/10 border-amber-500/30 text-amber-600 dark:text-amber-400'
                              : 'bg-zinc-200 dark:bg-zinc-800 border-transparent text-zinc-400'
                          }`}
                          title="自動對齊歌曲第 1 拍強拍或弱起小節 (Anacrusis)"
                        >
                          <Compass className="w-3 h-3" />
                          <span>強弱起拍對齊 {alignDownbeatEnabled ? '開' : '關'}</span>
                        </button>
                      </div>
                    </div>

                    {/* Transcription Progress State */}
                    {isTranscribingFile && (
                      <div className="mt-2 p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 flex flex-col gap-2 animate-in fade-in">
                        <div className="flex items-center justify-between text-xs font-bold text-amber-700 dark:text-amber-300">
                          <div className="flex items-center gap-2">
                            <RefreshCw className="w-4 h-4 animate-spin text-amber-500" />
                            <span>{transcribeStatusText || '音訊基頻分析與量化中...'}</span>
                          </div>
                          <span className="font-mono text-sm font-black">{transcribeProgress}%</span>
                        </div>
                        <div className="w-full bg-zinc-200 dark:bg-zinc-800 rounded-full h-2 overflow-hidden">
                          <div
                            className="bg-gradient-to-r from-amber-500 to-amber-400 h-full rounded-full transition-all duration-150"
                            style={{ width: `${Math.max(5, transcribeProgress)}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Upload Error Banner */}
                {uploadError && (
                  <div className="flex items-center justify-between p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-600 dark:text-rose-400 text-xs">
                    <div className="flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      <span className="font-bold">{uploadError}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setUploadError(null)}
                      className="px-2 py-1 rounded-md bg-rose-500/20 hover:bg-rose-500/30 font-bold transition-colors cursor-pointer"
                    >
                      清除
                    </button>
                  </div>
                )}
              </div>

              {/* ── SLOT 4: PERSISTENT PIANO BED ─────────────────────────────────── */}
              <div id="deck-upload-piano-bed-slot" className="flex flex-col gap-2">
                <PianoBed
                  activeKey={activeKey}
                  accidentalPreference={accidentalPref}
                  octaveBedView={octaveBedView}
                  onOctaveBedViewChange={setOctaveBedView}
                  activeMidiSet={activeMidiSet}
                  detectedPitchMidi={null}
                  onNoteDown={handlePianoNoteDown}
                  onNoteUp={handlePianoNoteUp}
                  mode="align"
                  octaveShiftVal={octaveShiftVal}
                />
              </div>

              {/* ── SLOT 5: BOTTOM ACTION ROW ────────────────────────────────────── */}
              <div className="flex items-center justify-between pt-1 min-h-[52px]">
                <button
                  type="button"
                  onClick={() => {
                    stopAllPipelines();
                    setActiveMode('hum');
                    setStep('SETUP');
                  }}
                  className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl border border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 text-xs font-bold hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  <Mic2 className="w-3.5 h-3.5 text-amber-500" />
                  <span>改用麥克風哼唱</span>
                </button>

                <button
                  id="deck-start-upload-transcription-btn"
                  type="button"
                  disabled={!uploadedFile || isTranscribingFile}
                  onClick={handleStartFileTranscription}
                  className={`flex items-center gap-2 px-7 py-3 rounded-2xl font-black text-sm shadow-md transition-all active:scale-95 cursor-pointer ${
                    !uploadedFile || isTranscribingFile
                      ? 'bg-zinc-200 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-600 cursor-not-allowed shadow-none'
                      : 'bg-gradient-to-r from-amber-500 to-amber-400 hover:from-amber-400 hover:to-amber-300 text-zinc-950 shadow-amber-500/20 ring-1 ring-amber-400/50'
                  }`}
                >
                  {isTranscribingFile ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin text-zinc-950" />
                      <span>轉譜中 ({transcribeProgress}%)...</span>
                    </>
                  ) : (
                    <>
                      <Upload className="w-4 h-4 stroke-[2.5]" />
                      <span>開始解析音檔並轉寫簡譜 (Transcribe Audio)</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          ) : (
          <div className="flex flex-col gap-4 animate-in fade-in duration-200">

            {/* ── SLOT 1: STATUS / SETUP STRIP (Fixed 64px) ────────────────────── */}
            <div className="min-h-[64px] flex items-center justify-between px-4 py-2.5 bg-zinc-50 dark:bg-zinc-900/70 border border-zinc-200 dark:border-zinc-800 rounded-2xl flex-wrap gap-2.5 box-border">
              {step === 'SETUP' ? (
                <>
                  {/* Left: Quick Params Badges */}
                  <div className="flex items-center gap-2 flex-wrap text-xs">
                    {/* Key badge */}
                    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 font-bold">
                      <span className="text-[10px] text-zinc-400 font-mono">調號</span>
                      <select
                        id="deck-setup-key-select"
                        value={activeKey}
                        onChange={e => setActiveKey(e.target.value as KeySignature)}
                        className="bg-transparent text-amber-600 dark:text-amber-400 font-black cursor-pointer outline-hidden"
                      >
                        {CHROMATIC_KEYS.map(k => (
                          <option key={k} value={k} className="bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100">
                            1 = {k}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Meter badge */}
                    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 font-bold">
                      <span className="text-[10px] text-zinc-400 font-mono">拍號</span>
                      <select
                        id="deck-setup-time-sig-select"
                        value={activeTimeSignature}
                        onChange={e => setActiveTimeSignature(e.target.value as TimeSignature)}
                        className="bg-transparent text-amber-600 dark:text-amber-400 font-black cursor-pointer outline-hidden"
                      >
                        {STANDARD_TIME_SIGNATURES.map(ts => (
                          <option key={ts.value} value={ts.value} className="bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100">
                            {ts.label} 拍
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* BPM badge */}
                    <div className="flex items-center gap-2 px-2.5 py-1 rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 font-bold">
                      <span className="text-[10px] text-zinc-400 font-mono">速度</span>
                      <span className="font-mono font-black text-amber-600 dark:text-amber-400 min-w-[36px]">
                        {activeBpm}
                      </span>
                      <input
                        id="deck-setup-bpm-slider"
                        type="range"
                        min="40"
                        max="200"
                        value={activeBpm}
                        onChange={e => setActiveBpm(parseInt(e.target.value, 10))}
                        className="accent-amber-500 w-16 sm:w-20 h-1.5 bg-zinc-200 dark:bg-zinc-700 rounded-lg cursor-pointer"
                        title={`速度: ${activeBpm} BPM`}
                      />
                    </div>

                    {/* Grid badge */}
                    <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 font-bold">
                      <span className="text-[10px] text-zinc-400 font-mono">量化</span>
                      <select
                        id="deck-setup-grid-select"
                        value={quantizeGrid}
                        onChange={e => setQuantizeGrid(e.target.value as QuantizeGrid)}
                        className="bg-transparent text-zinc-700 dark:text-zinc-300 font-bold cursor-pointer outline-hidden text-xs"
                      >
                        <option value="quarter" className="bg-white dark:bg-zinc-900">¼ 拍 (四分)</option>
                        <option value="eighth" className="bg-white dark:bg-zinc-900">⅛ 拍 (八分)</option>
                        <option value="sixteenth" className="bg-white dark:bg-zinc-900">¹/₁₆ 拍 (十六分)</option>
                      </select>
                    </div>
                  </div>

                  {/* Right: Advanced Settings Expander Toggle */}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      id="deck-toggle-advanced-settings-btn"
                      onClick={() => setShowAdvancedSettings(!showAdvancedSettings)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-bold transition-all cursor-pointer ${
                        showAdvancedSettings
                          ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40 shadow-xs'
                          : 'bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700 hover:text-zinc-900 dark:hover:text-zinc-200'
                      }`}
                    >
                      <SlidersHorizontal className="w-3.5 h-3.5" />
                      <span>{showAdvancedSettings ? '收起進階參數' : '進階設定'}</span>
                      {showAdvancedSettings ? (
                        <ChevronUp className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronDown className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </>
              ) : step === 'COUNTING_IN' ? (
                <>
                  <div className="flex items-center gap-2.5">
                    <div className="w-3 h-3 rounded-full bg-amber-500 animate-ping" />
                    <span className="text-xs font-black text-amber-700 dark:text-amber-300 uppercase tracking-wider">
                      {activeMode === 'hum'
                        ? `哼唱預備 · 倒數 ${countdownBeat} 拍`
                        : `琴鍵預備 · 倒數 ${countdownBeat} 拍`}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-mono text-amber-600 dark:text-amber-400 font-bold hidden sm:inline">
                      {countdownBeatsCount} 拍預備 · 速度 {activeBpm} BPM
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
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2.5">
                    <div className="w-3 h-3 rounded-full bg-rose-500 animate-ping" />
                    <span className="text-xs font-black text-rose-700 dark:text-rose-300 uppercase tracking-wider">
                      {activeMode === 'hum' ? `錄音辨識中 · ${activePreset.nameZh}` : '琴鍵彈奏收集中'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 font-mono font-bold text-sm text-rose-700 dark:text-rose-300">
                    <Clock className="w-4 h-4" />
                    <span>{recordingSeconds.toFixed(1)}s</span>
                  </div>
                </>
              )}
            </div>

            {/* ── COLLAPSIBLE ADVANCED SETTINGS ACCORDION (SETUP MODE ONLY) ──────── */}
            {step === 'SETUP' && showAdvancedSettings && (
              <div className="animate-in fade-in duration-150 flex flex-col gap-4 p-4 rounded-2xl bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800">
                {/* Mode Settings Content */}
                {activeMode === 'hum' ? (
                  <div className="flex flex-col gap-3.5">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <span className="text-xs font-black text-zinc-700 dark:text-zinc-300 flex items-center gap-1.5">
                        <Mic className="w-4 h-4 text-amber-500" />
                        <span>音源預設與增益</span>
                      </span>
                      <div className="flex items-center gap-2 text-xs font-mono text-zinc-400">
                        <Headphones className="w-3.5 h-3.5 text-amber-400" />
                        <span>建議佩戴耳機以避免聲音反饋</span>
                      </div>
                    </div>

                    {/* Presets Grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {INSTRUMENT_PRESETS.map(p => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => setPresetId(p.id)}
                          className={`flex flex-col p-2.5 rounded-xl border text-left transition-all cursor-pointer ${
                            presetId === p.id
                              ? 'bg-amber-500/15 border-amber-500 text-amber-800 dark:text-amber-300 shadow-xs ring-1 ring-amber-400/40'
                              : 'bg-white dark:bg-zinc-900/60 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:border-zinc-300'
                          }`}
                        >
                          <div className="flex items-center gap-1.5 text-xs font-black">
                            <span>{p.icon}</span>
                            <span>{p.nameZh}</span>
                          </div>
                          <span className="text-[10px] text-zinc-500 mt-0.5 line-clamp-1">{p.tips}</span>
                        </button>
                      ))}
                    </div>

                    {/* Gain & Stabilizer */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                      <div className="flex items-center gap-2.5">
                        <span className="text-xs font-bold text-zinc-500 shrink-0">麥克風放大:</span>
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
                        <span className="text-xs font-mono font-bold text-amber-500 w-12 text-right">
                          {micGain.toFixed(1)}x
                        </span>
                      </div>

                      <div className="flex items-center gap-2.5">
                        <span className="text-xs font-bold text-zinc-500 shrink-0">音準防抖:</span>
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
                        <span className="text-xs font-mono font-bold text-amber-500 w-12 text-right">
                          {Math.round(stabilizerStrength * 100)}%
                        </span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3.5">
                    <div className="flex items-center justify-between flex-wrap gap-2 text-xs">
                      <span className="font-black text-zinc-700 dark:text-zinc-300 flex items-center gap-1.5">
                        <Keyboard className="w-4 h-4 text-amber-500" />
                        <span>鍵盤按鍵映射與空隙過濾</span>
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded-full font-bold text-[10px] ${
                          isMidiConnected
                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                            : 'bg-zinc-200 dark:bg-zinc-800 text-zinc-500'
                        }`}
                      >
                        {isMidiConnected ? 'MIDI 已連線' : '無外部 MIDI (使用電腦打字)'}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-mono font-bold text-zinc-400 uppercase">
                          打字鍵位映射
                        </label>
                        <select
                          id="deck-qwerty-mode-select"
                          value={qwertyMappingMode}
                          onChange={e => setQwertyMappingMode(e.target.value as QwertyMappingMode)}
                          className="px-2.5 py-1.5 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-xl text-xs font-bold text-zinc-900 dark:text-zinc-100 cursor-pointer"
                        >
                          <option value="chromatic_piano">固定白黑鍵 (A~K 為 C4~C5)</option>
                          <option value="diatonic_degrees">首調唱名 (A~J 為 1~7 音)</option>
                        </select>
                      </div>

                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-mono font-bold text-zinc-400 uppercase">
                          單指換鍵空隙過濾
                        </label>
                        <button
                          id="deck-one-finger-gap-toggle"
                          type="button"
                          onClick={() => setFilterOneFingerGaps(!filterOneFingerGaps)}
                          className={`px-2.5 py-1.5 rounded-xl text-xs font-bold border transition-colors cursor-pointer text-center ${
                            filterOneFingerGaps
                              ? 'bg-amber-500/20 text-amber-600 dark:text-amber-300 border-amber-500/40'
                              : 'bg-zinc-200 dark:bg-zinc-800 text-zinc-500 border-zinc-300 dark:border-zinc-700'
                          }`}
                        >
                          {filterOneFingerGaps ? '開啟 (自動填補換音八分休止符)' : '關閉 (保留原始彈奏空隙)'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── SLOT 2: METRONOME & COUNT-IN BAR (Fixed 64px, h-16) ──────────── */}
            <div
              id="deck-visual-metronome-bar"
              className={`h-16 px-4 rounded-2xl border transition-colors duration-100 flex items-center justify-between gap-3 overflow-hidden select-none box-border ${
                step === 'SETUP'
                  ? 'bg-zinc-50 dark:bg-zinc-900/60 border-zinc-200 dark:border-zinc-800'
                  : isDownbeatFlash
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
                    step === 'SETUP'
                      ? 'bg-zinc-200 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-zinc-300 dark:border-zinc-700'
                      : isDownbeatFlash
                        ? 'bg-amber-400 text-zinc-950 scale-105 shadow-md shadow-amber-400/40 ring-1 ring-amber-300'
                        : isBeatPulse
                          ? 'bg-amber-500 text-zinc-950 scale-102 shadow-xs'
                          : 'bg-zinc-800 text-zinc-300 border border-zinc-700'
                  }`}
                >
                  {step === 'COUNTING_IN'
                    ? countdownBeat
                    : step === 'RECORDING'
                      ? currentBeatInBar
                      : '♩'}
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-bold text-zinc-800 dark:text-zinc-200 flex items-center gap-1.5 truncate">
                    <Activity className="w-3.5 h-3.5 text-amber-500" />
                    <span>
                      {step === 'COUNTING_IN'
                        ? '預備倒數'
                        : step === 'RECORDING'
                          ? '節拍器'
                          : '預備拍 / 節拍'}
                    </span>
                  </span>
                  <span className="text-[10px] font-mono text-zinc-500 dark:text-zinc-400">
                    {step === 'COUNTING_IN'
                      ? `${activeBpm} BPM · 倒數 ${countdownBeat} 拍`
                      : step === 'RECORDING'
                        ? `${activeBpm} BPM · ${activeTimeSignature} 拍`
                        : `${enableCountIn ? `${countdownBeatsCount} 拍預備` : '直接開始'} · ${activeBpm} BPM`}
                  </span>
                </div>
              </div>

              {/* Center: Beat Pods */}
              <div className="flex items-center justify-center gap-2 flex-1">
                {step === 'COUNTING_IN' ? (
                  Array.from({ length: countdownBeatsCount }).map((_, idx) => {
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
                ) : step === 'RECORDING' ? (
                  Array.from({ length: parseInt(activeTimeSignature.split('/')[0], 10) || 4 }).map(
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
                  )
                ) : (
                  /* SETUP MODE: Interactive Count-in Selector Pods */
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-bold text-zinc-500 hidden md:inline mr-1">
                      預備拍數:
                    </span>
                    {([2, 3, 4] as const).map(b => (
                      <button
                        key={b}
                        type="button"
                        id={`deck-count-in-${b}-beats`}
                        onClick={() => {
                          setEnableCountIn(true);
                          setCountdownBeatsCount(b);
                        }}
                        className={`px-3 py-1.5 text-xs font-bold font-mono rounded-xl transition-all cursor-pointer ${
                          enableCountIn && countdownBeatsCount === b
                            ? 'bg-amber-500 text-zinc-950 font-black shadow-xs ring-1 ring-amber-400'
                            : 'bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700 hover:text-zinc-900 dark:hover:text-zinc-200'
                        }`}
                      >
                        {b} 拍
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setEnableCountIn(!enableCountIn)}
                      className={`px-2.5 py-1.5 text-xs font-bold rounded-xl transition-all cursor-pointer ${
                        !enableCountIn
                          ? 'bg-zinc-300 dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 font-bold'
                          : 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300'
                      }`}
                    >
                      {!enableCountIn ? '不倒數' : '關閉倒數'}
                    </button>
                  </div>
                )}
              </div>

              {/* Right: Audible Click Toggle */}
              <button
                type="button"
                onClick={() => setAudibleClickDuringRecording(!audibleClickDuringRecording)}
                className={`flex items-center justify-center gap-1.5 h-9 px-3 text-xs font-bold rounded-xl border transition-all cursor-pointer select-none shrink-0 ${
                  audibleClickDuringRecording
                    ? 'bg-amber-500/20 text-amber-700 dark:text-amber-300 border-amber-500/40 hover:bg-amber-500/30'
                    : 'bg-white dark:bg-zinc-800 text-zinc-500 border-zinc-200 dark:border-zinc-700 hover:text-zinc-900 dark:hover:text-zinc-200'
                }`}
                title={audibleClickDuringRecording ? '點擊關閉聲音' : '點擊開啟節拍聲音'}
              >
                {audibleClickDuringRecording ? (
                  <>
                    <Volume2 className="w-3.5 h-3.5 text-amber-500 shrink-0" />
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

            {/* ── SLOT 3: MODE MONITOR & PRACTICE SLOT (Fixed 148px) ───────────── */}
            <div className="h-[148px] max-h-[148px] rounded-2xl overflow-hidden box-border">
              {activeMode === 'hum' ? (
                /* HUM MONITOR (Identical in SETUP, COUNTING_IN, RECORDING) */
                <div className="h-full p-3.5 bg-zinc-900 border border-zinc-800 rounded-2xl flex flex-col justify-between box-border">
                  <div className="flex items-center justify-between">
                    <div className="flex items-baseline gap-2.5">
                      <span className="text-3xl sm:text-4xl font-black text-amber-400 font-mono tracking-tight">
                        {isVoiced ? activeSolfegInfo.noteNum : '-'}
                      </span>
                      <span className="text-sm font-bold text-zinc-300">
                        {isVoiced ? activeSolfegInfo.solfege : '等待唱音輸入 (如 da / la)...'}
                      </span>
                      {isVoiced && activeSolfegInfo.octaveDots !== 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold">
                          {activeSolfegInfo.octaveDots > 0
                            ? `+${activeSolfegInfo.octaveDots} 八度`
                            : `${activeSolfegInfo.octaveDots} 八度`}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs font-mono">
                      <span className="text-zinc-400">
                        {currentPitchHz ? `${currentPitchHz.toFixed(1)} Hz` : '--.- Hz'}
                      </span>
                      <span
                        className={`font-bold px-2 py-0.5 rounded-md ${
                          Math.abs(currentCents) <= 15
                            ? 'bg-emerald-500/20 text-emerald-400'
                            : Math.abs(currentCents) <= 30
                              ? 'bg-amber-500/20 text-amber-400'
                              : 'bg-rose-500/20 text-rose-400'
                        }`}
                      >
                        {currentPitchHz ? `${currentCents > 0 ? '+' : ''}${currentCents} ¢` : '0 ¢'}
                      </span>
                      {step === 'SETUP' && (
                        <button
                          type="button"
                          id="deck-toggle-practice-btn"
                          onClick={() => {
                            if (isPracticingPitch) {
                              stopPitchPractice();
                            } else {
                              void startPitchPractice();
                            }
                          }}
                          className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                            isPracticingPitch
                              ? 'bg-rose-500 text-white'
                              : 'bg-emerald-600 hover:bg-emerald-500 text-white'
                          }`}
                        >
                          {isPracticingPitch ? '停止暖身' : '暖身試唱'}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Needle Bar */}
                  <div className="relative w-full h-3 bg-zinc-800 rounded-full overflow-hidden flex items-center">
                    <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-zinc-400 z-10" />
                    <div className="absolute left-[35%] right-[35%] top-0 bottom-0 bg-emerald-500/20" />
                    {isVoiced && (
                      <div
                        className="absolute top-0 bottom-0 w-2.5 rounded-full bg-amber-400 shadow-md transition-all duration-75"
                        style={{
                          left: `calc(${50 + (Math.max(-50, Math.min(50, currentCents)) / 50) * 45}% - 5px)`,
                        }}
                      />
                    )}
                  </div>

                  {/* Oscilloscope Canvas */}
                  <div className="w-full h-9 bg-zinc-950 rounded-xl overflow-hidden">
                    <canvas
                      ref={step === 'SETUP' ? practiceCanvasRef : canvasRef}
                      width={600}
                      height={36}
                      className="w-full h-full"
                    />
                  </div>
                </div>
              ) : (
                /* KEYBOARD MONITOR (Identical in SETUP, COUNTING_IN, RECORDING) */
                <div className="h-full p-3.5 bg-zinc-900 border border-zinc-800 rounded-2xl flex flex-col justify-between box-border">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-zinc-400">目前彈奏時值：</span>
                      {activeHeldBeats !== null ? (
                        <span className="px-2.5 py-0.5 rounded-lg bg-amber-500 text-zinc-950 font-black font-mono text-sm animate-pulse">
                          {activeHeldBeats.toFixed(2)} 拍
                        </span>
                      ) : (
                        <span className="text-xs text-zinc-400 font-mono">
                          {step === 'SETUP'
                            ? '點擊下方琴鍵或鍵盤試彈試聽'
                            : step === 'COUNTING_IN'
                              ? '倒數結束後開始彈奏...'
                              : '放開琴鍵即可結算音符'}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-zinc-400">
                        {qwertyMappingMode === 'chromatic_piano'
                          ? '鍵位：A~K (白鍵) / W,E,T,Y,U (黑鍵)'
                          : '鍵位：A~J (簡譜 1~7 音)'}
                      </span>
                      {liveRecordedNotes.length > 0 && (
                        <button
                          type="button"
                          disabled={step === 'COUNTING_IN'}
                          onClick={() => keyEngineRef.current?.undoLastNote()}
                          className="px-2.5 py-1 text-xs font-bold rounded-lg border bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border-zinc-700 cursor-pointer"
                          title="撤銷上一個音符 (Backspace)"
                        >
                          撤銷上音
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Notes Live Stream Strip or Guide */}
                  <div className="h-14 bg-zinc-950/80 rounded-xl border border-zinc-800 p-2 flex items-center overflow-x-auto gap-1.5">
                    {liveRecordedNotes.length > 0 ? (
                      <>
                        <span className="text-[10px] font-bold text-zinc-400 font-mono shrink-0">
                          已錄入：
                        </span>
                        <div className="flex items-center gap-1.5 flex-nowrap">
                          {liveRecordedNotes.map(n => (
                            <div
                              key={n.id}
                              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono font-bold shrink-0"
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
                      </>
                    ) : (
                      <div className="flex items-center justify-between w-full px-2 text-xs text-zinc-500">
                        <span>
                          {step === 'SETUP'
                            ? '💡 提示：在錄音前可試彈琴鍵，音符將自動對齊所選主音調號與量化精度。'
                            : step === 'COUNTING_IN'
                              ? '⏳ 倒數中，請依節拍器預備彈奏第一音...'
                              : '🎹 彈奏中，音符將隨彈奏即時顯示在此流水線中。'}
                        </span>
                        <span className="font-mono text-[10px] text-zinc-600 shrink-0">
                          1 = {activeKey} · {activeTimeSignature}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* ── SLOT 4: PERSISTENT PIANO BED (NEVER UNMOUNTS / ZERO SHIFT) ──── */}
            <div id="deck-persistent-piano-bed-slot" className="flex flex-col gap-2">
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

            {/* ── SLOT 5: BOTTOM ACTION ROW (Fixed 52px, min-h-[52px]) ─────────── */}
            <div className="flex items-center justify-between pt-1 min-h-[52px]">
              {step === 'SETUP' ? (
                <>
                  <div>
                    {onClose && (
                      <button
                        type="button"
                        onClick={onClose}
                        className="px-4 py-2.5 rounded-xl border border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 text-xs font-bold hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                      >
                        關閉
                      </button>
                    )}
                  </div>
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
                </>
              ) : (
                <>
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
                </>
              )}
            </div>

          </div>
          )
        )}


        {/* ======================================================================= */}
        {step === 'REVIEW' && (
          <div className="flex flex-col gap-6 animate-in fade-in duration-200">
            {/* Review Header Banner */}
            <div className="flex flex-col gap-3 p-4 rounded-2xl bg-zinc-900 border border-zinc-800">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center font-bold">
                    <Check className="w-4 h-4 stroke-[3]" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-sm font-extrabold text-zinc-100">
                        轉寫完成 · 簡譜成果檢視
                      </h3>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold flex items-center gap-1 bg-amber-500/15 text-amber-400 border border-amber-500/30">
                        <Zap className="w-3 h-3" />
                        <span>{transcriptionEngineUsed === 'basic-pitch' ? 'Spotify Basic Pitch 類神經轉譜' : 'DSP YIN 基頻轉譜'}</span>
                      </span>
                    </div>
                    <span className="text-xs font-mono text-zinc-400">
                      1={activeKey} · 速度 {activeBpm} BPM · {transcribedMeasures.length} 小節 · 共{' '}
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
                    <span>
                      {activeMode === 'hum'
                        ? '試聽原始人聲'
                        : activeMode === 'upload'
                          ? '試聽上傳原音'
                          : '試聽原始演奏'}
                    </span>
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

              {/* Smart Tempo Tracker Result Strip */}
              {detectedTempoResult && (
                <div className="pt-2.5 border-t border-zinc-800 flex items-center justify-between flex-wrap gap-2 text-xs">
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="flex items-center gap-1.5 text-zinc-300">
                      <Gauge className="w-3.5 h-3.5 text-amber-400" />
                      <span>AI 偵測速度:</span>
                      <span className="font-mono font-black text-amber-400 text-sm">
                        {detectedTempoResult.bpm} BPM
                      </span>
                      <span className="text-[11px] text-zinc-400">
                        (信心度 {Math.round(detectedTempoResult.confidence * 100)}%)
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 text-zinc-300">
                      <Compass className="w-3.5 h-3.5 text-emerald-400" />
                      <span>拍點對齊:</span>
                      <span className="font-bold text-zinc-200">
                        {detectedTempoResult.isPickup
                          ? `弱起小節 (前置 ${detectedTempoResult.pickupBeats} 拍)`
                          : '正拍對齊 (Beat 1)'}
                      </span>
                    </div>
                  </div>

                  {activeBpm !== detectedTempoResult.bpm && (
                    <button
                      type="button"
                      onClick={() => handleRetranscribe({ bpm: detectedTempoResult.bpm })}
                      className="flex items-center gap-1 px-3 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-xs font-bold transition-all cursor-pointer"
                    >
                      <Sparkles className="w-3 h-3" />
                      <span>採用 AI 偵測速度 ({detectedTempoResult.bpm} BPM)</span>
                    </button>
                  )}
                </div>
              )}
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

                <div className="flex items-center gap-2 sm:border-l sm:border-zinc-800 sm:pl-4">
                  <span className="font-bold text-zinc-400">速度量化 (BPM):</span>
                  <button
                    type="button"
                    onClick={() => {
                      const next = Math.max(40, activeBpm - 5);
                      setActiveBpm(next);
                      handleRetranscribe({ bpm: next });
                    }}
                    className="px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 cursor-pointer"
                    title="降低 5 BPM 並重新量化"
                  >
                    -5
                  </button>
                  <span className="font-mono font-bold text-amber-400 px-1">
                    {activeBpm}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const next = Math.min(240, activeBpm + 5);
                      setActiveBpm(next);
                      handleRetranscribe({ bpm: next });
                    }}
                    className="px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 cursor-pointer"
                    title="提高 5 BPM 並重新量化"
                  >
                    +5
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
                <span>{activeMode === 'upload' ? '重新選擇音檔' : '放棄重錄'}</span>
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
