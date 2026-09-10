'use client';

import React, { useMemo, useRef } from 'react';
import { KeySignature, PitchNumber } from '@/types/song';
import { midiToNumberedPitch } from '@/lib/pitch/scoreQuantizer';
import { Volume2, Sparkles, Mic2 } from 'lucide-react';

export type OctaveBedView = 'low_mid' | 'mid_high' | 'all';
export type PianoBedMode = 'record' | 'align';

export interface KeyDefinition {
  isBlack: boolean;
  midi: number;
  pitch: PitchNumber;
  accidental: '' | '#' | 'b';
  octave: number;
  numberedNotationLabel: string;
  solfege: string;
  noteName: string;
  qwertyKey?: string;
  leftPercent?: number;
}

export interface PianoBedProps {
  activeKey: KeySignature;
  accidentalPreference?: 'auto' | 'sharp' | 'flat';
  octaveBedView: OctaveBedView;
  onOctaveBedViewChange?: (view: OctaveBedView) => void;
  activeMidiSet: Set<number>;
  detectedPitchMidi?: number | null;
  onNoteDown?: (midi: number, sourceId?: string) => void;
  onNoteUp?: (midi: number, sourceId?: string) => void;
  mode?: PianoBedMode;
  showQwertyHints?: boolean;
  disabled?: boolean;
  className?: string;
  octaveShiftVal?: number;
}

const CHROMATIC_NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const PianoBed: React.FC<PianoBedProps> = ({
  activeKey,
  accidentalPreference = 'auto',
  octaveBedView,
  onOctaveBedViewChange,
  activeMidiSet,
  detectedPitchMidi = null,
  onNoteDown,
  onNoteUp,
  mode = 'record',
  showQwertyHints = true,
  disabled = false,
  className = '',
  octaveShiftVal = 0,
}) => {
  const isPointerDownRef = useRef<boolean>(false);

  // Octave range mapping
  const pianoOctaves = useMemo(() => {
    switch (octaveBedView) {
      case 'low_mid':
        return [-1, 0];
      case 'all':
        return [-1, 0, 1];
      case 'mid_high':
      default:
        return [0, 1];
    }
  }, [octaveBedView]);

  // Generate piano keys definitions
  const pianoKeys = useMemo(() => {
    const keys: { whiteKeys: KeyDefinition[]; blackKeys: KeyDefinition[] } = {
      whiteKeys: [],
      blackKeys: [],
    };

    pianoOctaves.forEach(oct => {
      // 7 White keys per octave
      const whiteDegreeOffsets = [0, 2, 4, 5, 7, 9, 11];
      const whitePitches: PitchNumber[] = [1, 2, 3, 4, 5, 6, 7];
      const solfegeNames = ['Do', 'Re', 'Mi', 'Fa', 'Sol', 'La', 'Ti'];

      whiteDegreeOffsets.forEach((semi, idx) => {
        const midi = 60 + oct * 12 + semi;
        const noteName = `${CHROMATIC_NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
        const pitch = whitePitches[idx];

        let qwertyLabel = '';
        if (oct === 0) {
          const qwertyChars = ['A', 'S', 'D', 'F', 'G', 'H', 'J'];
          qwertyLabel = qwertyChars[idx] || '';
        } else if (oct === 1) {
          const qwertyChars = ['K', 'L', ';', "'", '', '', ''];
          qwertyLabel = qwertyChars[idx] || '';
        }

        const numbered = midiToNumberedPitch(midi, activeKey, {
          accidentalPreference,
        });

        keys.whiteKeys.push({
          isBlack: false,
          midi,
          pitch,
          accidental: '',
          octave: oct,
          numberedNotationLabel: `${numbered.pitch}`,
          solfege: solfegeNames[idx],
          noteName,
          qwertyKey: qwertyLabel,
        });
      });

      // 5 Black keys per octave
      const blackDefs = [
        { semi: 1, leftPercent: 9.7, pitch: 1 as PitchNumber, qwerty0: 'W', qwerty1: 'O' },
        { semi: 3, leftPercent: 24.0, pitch: 2 as PitchNumber, qwerty0: 'E', qwerty1: 'P' },
        { semi: 6, leftPercent: 52.5, pitch: 4 as PitchNumber, qwerty0: 'T', qwerty1: '' },
        { semi: 8, leftPercent: 66.8, pitch: 5 as PitchNumber, qwerty0: 'Y', qwerty1: '' },
        { semi: 10, leftPercent: 81.1, pitch: 6 as PitchNumber, qwerty0: 'U', qwerty1: '' },
      ];

      blackDefs.forEach(bk => {
        const midi = 60 + oct * 12 + bk.semi;
        const noteName = `${CHROMATIC_NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
        const qwertyLabel = oct === 0 ? bk.qwerty0 : oct === 1 ? bk.qwerty1 : '';

        const numbered = midiToNumberedPitch(midi, activeKey, {
          accidentalPreference,
        });

        keys.blackKeys.push({
          isBlack: true,
          midi,
          pitch: bk.pitch,
          accidental: '#',
          octave: oct,
          numberedNotationLabel: `${numbered.accidental === '#' ? '♯' : '♭'}${numbered.pitch}`,
          solfege:
            bk.pitch === 1
              ? 'Di'
              : bk.pitch === 2
                ? 'Ri'
                : bk.pitch === 4
                  ? 'Fi'
                  : bk.pitch === 5
                    ? 'Si'
                    : 'Li',
          noteName,
          qwertyKey: qwertyLabel,
          leftPercent: bk.leftPercent,
        });
      });
    });

    return keys;
  }, [pianoOctaves, activeKey, accidentalPreference]);

  // Touch / Pointer Event Handlers
  const handleKeyPointerDown = (e: React.PointerEvent, midi: number) => {
    if (disabled) return;
    isPointerDownRef.current = true;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {}
    onNoteDown?.(midi, `touch-${midi}`);
  };

  const handleKeyPointerUp = (e: React.PointerEvent, midi: number) => {
    if (disabled) return;
    isPointerDownRef.current = false;
    try {
      if ((e.currentTarget as HTMLElement).hasPointerCapture?.(e.pointerId)) {
        (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
      }
    } catch {}
    onNoteUp?.(midi, `touch-${midi}`);
  };

  const handleKeyPointerCancel = (e: React.PointerEvent, midi: number) => {
    if (disabled) return;
    isPointerDownRef.current = false;
    try {
      if ((e.currentTarget as HTMLElement).hasPointerCapture?.(e.pointerId)) {
        (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
      }
    } catch {}
    onNoteUp?.(midi, `touch-${midi}`);
  };

  const handleKeyPointerEnter = (e: React.PointerEvent, midi: number) => {
    if (disabled) return;
    if (isPointerDownRef.current && e.buttons > 0) {
      onNoteDown?.(midi, `touch-${midi}`);
    }
  };

  const handleKeyPointerLeave = (e: React.PointerEvent, midi: number) => {
    if (disabled) return;
    try {
      if ((e.currentTarget as HTMLElement).hasPointerCapture?.(e.pointerId)) {
        return;
      }
    } catch {}
    onNoteUp?.(midi, `touch-${midi}`);
  };

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      {/* Mode Status & Octave Controls Bar */}
      <div className="flex items-center justify-between px-1 flex-wrap gap-2 text-xs">
        {mode === 'align' ? (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-300">
            <Volume2 className="w-3.5 h-3.5 text-cyan-400" />
            <span className="font-extrabold text-[11px]">音高對齊模式：</span>
            <span className="text-[11px] text-zinc-300">點擊琴鍵試聽標準音以校正音準 (不計入樂譜)</span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300">
            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
            <span className="font-extrabold text-[11px]">鍵盤彈奏模式：</span>
            <span className="text-[11px] text-zinc-300">點擊琴鍵、敲擊電腦鍵盤或使用 MIDI 進行彈奏錄入</span>
          </div>
        )}

        {/* Octave Range Switcher & Metadata */}
        <div className="flex items-center gap-3">
          {onOctaveBedViewChange && (
            <div className="flex items-center gap-1">
              <span className="text-zinc-500 text-[11px] font-bold">顯示：</span>
              {(['low_mid', 'mid_high', 'all'] as const).map(viewOption => (
                <button
                  key={viewOption}
                  type="button"
                  onClick={() => onOctaveBedViewChange(viewOption)}
                  className={`px-2 py-0.5 rounded-lg text-[10px] font-bold border transition-colors cursor-pointer ${
                    octaveBedView === viewOption
                      ? 'bg-amber-500 text-zinc-950 border-amber-400 font-extrabold shadow-xs'
                      : 'bg-zinc-900 hover:bg-zinc-800 text-zinc-400 border-zinc-800'
                  }`}
                >
                  {viewOption === 'low_mid'
                    ? '低+中八度'
                    : viewOption === 'mid_high'
                      ? '中+高八度'
                      : '全 3 八度'}
                </button>
              ))}
            </div>
          )}

          <div className="text-[11px] text-zinc-500 font-mono hidden sm:flex items-center gap-1">
            <span>1 = {activeKey}</span>
            {octaveShiftVal !== 0 && <span>· 移調 {octaveShiftVal > 0 ? `+${octaveShiftVal}` : octaveShiftVal}</span>}
          </div>
        </div>
      </div>

      {/* On-screen Piano Bed */}
      <div
        id="piano-bed-surface"
        className="relative select-none touch-none w-full bg-zinc-900/90 p-2.5 rounded-2xl border border-zinc-800 shadow-inner overflow-x-auto"
        style={{ minHeight: '170px' }}
      >
        {/* White Keys Row */}
        <div className="flex w-full h-40 sm:h-44 relative">
          {pianoKeys.whiteKeys.map(wk => {
            const isActive = activeMidiSet.has(wk.midi);
            const isDetectedSung = detectedPitchMidi !== null && detectedPitchMidi === wk.midi;

            return (
              <div
                key={`wk-${wk.midi}`}
                onPointerDown={e => {
                  e.preventDefault();
                  handleKeyPointerDown(e, wk.midi);
                }}
                onPointerUp={e => {
                  e.preventDefault();
                  handleKeyPointerUp(e, wk.midi);
                }}
                onPointerCancel={e => {
                  e.preventDefault();
                  handleKeyPointerCancel(e, wk.midi);
                }}
                onPointerEnter={e => {
                  e.preventDefault();
                  handleKeyPointerEnter(e, wk.midi);
                }}
                onPointerLeave={e => {
                  e.preventDefault();
                  handleKeyPointerLeave(e, wk.midi);
                }}
                onContextMenu={e => e.preventDefault()}
                className={`flex-1 flex flex-col justify-end items-center pb-2 border-r border-zinc-300 dark:border-zinc-800 rounded-b-lg cursor-pointer select-none touch-none transition-all duration-75 relative ${
                  isActive
                    ? mode === 'align'
                      ? 'bg-cyan-300 dark:bg-cyan-400 text-zinc-950 shadow-md ring-2 ring-cyan-300 transform translate-y-0.5'
                      : 'bg-amber-300 dark:bg-amber-400 text-zinc-950 shadow-md transform translate-y-0.5'
                    : isDetectedSung
                      ? 'bg-emerald-200 dark:bg-emerald-950/80 text-emerald-900 dark:text-emerald-200 ring-2 ring-emerald-400 animate-pulse'
                      : 'bg-white hover:bg-zinc-100 text-zinc-800'
                }`}
              >
                {/* Real-time detected pitch badge (Hum Mode) */}
                {isDetectedSung && (
                  <div className="absolute top-1.5 px-1 py-0.2 rounded-full bg-emerald-500 text-zinc-950 font-black text-[8px] flex items-center gap-0.5 shadow-sm">
                    <Mic2 className="w-2.5 h-2.5" />
                    <span>唱音</span>
                  </div>
                )}

                {/* Numbered Notation Degree */}
                <div className="flex flex-col items-center">
                  {wk.octave > 0 && <span className="text-[8px] leading-none -mb-1">●</span>}
                  <span className="text-sm font-black font-mono">
                    {wk.numberedNotationLabel}
                  </span>
                  {wk.octave < 0 && <span className="text-[8px] leading-none -mt-1">●</span>}
                </div>

                {/* Solfege Name */}
                <span className="text-[9px] font-sans text-zinc-500 font-medium">
                  {wk.solfege}
                </span>

                {/* QWERTY Key Label */}
                {showQwertyHints && wk.qwertyKey && (
                  <span className="text-[8px] font-mono font-extrabold px-1 rounded bg-zinc-200 text-zinc-700 mt-0.5">
                    {wk.qwertyKey}
                  </span>
                )}
              </div>
            );
          })}

          {/* Black Keys Layer */}
          {pianoOctaves.map((oct, oIdx) => {
            const octWidthPercent = 100 / pianoOctaves.length;
            const bKeysInOct = pianoKeys.blackKeys.filter(bk => bk.octave === oct);

            return bKeysInOct.map(bk => {
              const isActive = activeMidiSet.has(bk.midi);
              const isDetectedSung = detectedPitchMidi !== null && detectedPitchMidi === bk.midi;
              const leftPos = oIdx * octWidthPercent + ((bk.leftPercent || 0) * octWidthPercent) / 100;

              return (
                <div
                  key={`bk-${bk.midi}`}
                  onPointerDown={e => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleKeyPointerDown(e, bk.midi);
                  }}
                  onPointerUp={e => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleKeyPointerUp(e, bk.midi);
                  }}
                  onPointerCancel={e => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleKeyPointerCancel(e, bk.midi);
                  }}
                  onPointerEnter={e => {
                    e.preventDefault();
                    handleKeyPointerEnter(e, bk.midi);
                  }}
                  onPointerLeave={e => {
                    e.preventDefault();
                    handleKeyPointerLeave(e, bk.midi);
                  }}
                  onContextMenu={e => e.preventDefault()}
                  style={{
                    left: `${leftPos}%`,
                    width: `${octWidthPercent * 0.09}%`,
                    height: '62%',
                  }}
                  className={`absolute top-0 z-10 flex flex-col justify-end items-center pb-1.5 rounded-b-md cursor-pointer select-none touch-none transition-all duration-75 ${
                    isActive
                      ? mode === 'align'
                        ? 'bg-cyan-400 text-zinc-950 shadow-lg ring-2 ring-cyan-300 transform translate-y-0.5'
                        : 'bg-amber-400 text-zinc-950 shadow-lg transform translate-y-0.5'
                      : isDetectedSung
                        ? 'bg-emerald-600 text-white ring-2 ring-emerald-400 shadow-md animate-pulse'
                        : 'bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border-x border-b border-black shadow-md'
                  }`}
                >
                  {isDetectedSung && (
                    <div className="absolute top-1 px-0.5 py-0.2 rounded bg-emerald-400 text-zinc-950 text-[7px] font-black">
                      ●
                    </div>
                  )}

                  <span className="text-[10px] font-black font-mono">
                    {bk.numberedNotationLabel}
                  </span>

                  {showQwertyHints && bk.qwertyKey && (
                    <span className="text-[7px] font-mono font-bold px-0.5 rounded bg-zinc-800 text-amber-400 mt-0.5">
                      {bk.qwertyKey}
                    </span>
                  )}
                </div>
              );
            });
          })}
        </div>
      </div>
    </div>
  );
};
