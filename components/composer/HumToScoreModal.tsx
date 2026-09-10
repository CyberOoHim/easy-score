'use client';

import React from 'react';
import { Measure, Song } from '@/types/song';
import { AudioEngine } from '@/lib/audioEngine';
import {
  ScoreTranscriptionDeck,
  InsertionMode,
  InstrumentPresetId,
  InstrumentPresetConfig,
  INSTRUMENT_PRESETS,
} from './ScoreTranscriptionDeck';

export type { InsertionMode, InstrumentPresetId, InstrumentPresetConfig };
export { INSTRUMENT_PRESETS };
export type HumModalStep = 'SETUP' | 'COUNTING_IN' | 'RECORDING' | 'REVIEW';

export interface HumToScoreModalProps {
  isOpen: boolean;
  onClose?: () => void;
  song: Song;
  selectedMeasureIndex?: number | null;
  audioEngine: AudioEngine;
  onCommitTranscription: (measures: Measure[], mode: InsertionMode) => void;
  isEmbedded?: boolean;
}

export const HumToScoreModal: React.FC<HumToScoreModalProps> = ({
  isOpen,
  onClose,
  song,
  selectedMeasureIndex,
  audioEngine,
  onCommitTranscription,
  isEmbedded = false,
}) => {
  return (
    <ScoreTranscriptionDeck
      isOpen={isOpen}
      onClose={onClose}
      song={song}
      selectedMeasureIndex={selectedMeasureIndex}
      audioEngine={audioEngine}
      onCommitTranscription={(measures, mode) => onCommitTranscription(measures, mode)}
      isEmbedded={isEmbedded}
      initialMode="hum"
      mode="hum"
    />
  );
};
