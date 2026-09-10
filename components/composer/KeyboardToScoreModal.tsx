'use client';

import React from 'react';
import { Measure, Song } from '@/types/song';
import { AudioEngine } from '@/lib/audioEngine';
import {
  ScoreTranscriptionDeck,
  InsertionMode,
} from './ScoreTranscriptionDeck';

export type { InsertionMode };
export type KeyboardModalStep = 'SETUP' | 'COUNTING_IN' | 'RECORDING' | 'REVIEW';

export interface KeyboardToScoreModalProps {
  isOpen: boolean;
  onClose?: () => void;
  song: Song;
  selectedMeasureIndex?: number | null;
  audioEngine: AudioEngine;
  onCommitTranscription: (measures: Measure[], mode: InsertionMode) => void;
  isEmbedded?: boolean;
}

export const KeyboardToScoreModal: React.FC<KeyboardToScoreModalProps> = ({
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
      initialMode="keyboard"
      mode="keyboard"
    />
  );
};
