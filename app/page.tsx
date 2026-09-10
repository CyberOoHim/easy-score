'use client';

import React, { useState, useEffect, useCallback, useMemo, startTransition } from 'react';
import {
  KeySignature,
  Measure,
  NumberedNotationNote,
  Song,
  TimeSignature,
  InstrumentType,
} from '@/types/song';
import { audioEngine } from '@/lib/audioEngine';
import { ScoreTranscriptionDeck, InsertionMode } from '@/components/composer/ScoreTranscriptionDeck';
import { NumberedNotationNoteComponent } from '@/components/NumberedNotationNoteComponent';
import { downloadMidiFile } from '@/lib/midiExport';
import {
  Mic2,
  Keyboard,
  Music2,
  Play,
  Pause,
  RotateCcw,
  Copy,
  Check,
  Download,
  Trash2,
  SlidersHorizontal,
  Clock,
  Sparkles,
  Layers,
  FileMusic,
  Share2,
  ListMusic,
  Volume2,
  Plus,
  Upload,
} from 'lucide-react';

export type StudioFeatureMode = 'hum' | 'keyboard' | 'upload';

interface SavedTranscriptionTake {
  id: string;
  timestamp: number;
  source: 'hum' | 'keyboard' | 'upload';
  title: string;
  song: Song;
  notesCount: number;
  measuresCount: number;
}

const STORAGE_KEY_SAVED_TAKES = 'score_transcriber_saved_takes_v1';
const STORAGE_KEY_CURRENT_SONG = 'score_transcriber_current_song_v1';

function createInitialEmptySong(): Song {
  return {
    id: 'transcription-' + Date.now(),
    title: 'Transcribed Melody',
    composer: 'Audio / Keyboard Transcriber',
    key: 'C',
    bpm: 80,
    timeSignature: '4/4',
    measures: [
      {
        id: 'm-1',
        measureNumber: 1,
        timeSignature: '4/4',
        notes: [
          {
            id: 'n-1-1',
            pitch: 1,
            octave: 0,
            duration: 1,
            lyric: { hanlo: '', poj: '' },
          },
          {
            id: 'n-1-2',
            pitch: 2,
            octave: 0,
            duration: 1,
            lyric: { hanlo: '', poj: '' },
          },
          {
            id: 'n-1-3',
            pitch: 3,
            octave: 0,
            duration: 1,
            lyric: { hanlo: '', poj: '' },
          },
          {
            id: 'n-1-4',
            pitch: 5,
            octave: 0,
            duration: 1,
            lyric: { hanlo: '', poj: '' },
          },
        ],
      },
      {
        id: 'm-2',
        measureNumber: 2,
        timeSignature: '4/4',
        notes: [
          {
            id: 'n-2-1',
            pitch: 6,
            octave: 0,
            duration: 2,
            lyric: { hanlo: '', poj: '' },
          },
          {
            id: 'n-2-2',
            pitch: 5,
            octave: 0,
            duration: 2,
            lyric: { hanlo: '', poj: '' },
          },
        ],
      },
    ],
  };
}

export default function Home() {
  const [activeFeature, setActiveFeature] = useState<StudioFeatureMode>('hum');
  // Initialize with safe SSR-compatible defaults, then hydrate from localStorage client-side.
  // Using lazy initializers that read localStorage directly causes React hydration mismatches
  // because the server renders the empty default while the client immediately renders stored data.
  const [song, setSong] = useState<Song>(createInitialEmptySong);
  const [savedTakes, setSavedTakes] = useState<SavedTranscriptionTake[]>([]);

  // Hydrate persisted state from localStorage after first client render.
  // Wrapped in startTransition so these are treated as low-priority deferred updates,
  // avoiding synchronous cascading renders (satisfies react-hooks/set-state-in-effect).
  useEffect(() => {
    startTransition(() => {
      try {
        const storedSong = localStorage.getItem(STORAGE_KEY_CURRENT_SONG);
        if (storedSong) {
          setSong(JSON.parse(storedSong));
        }
      } catch {}
      try {
        const storedTakes = localStorage.getItem(STORAGE_KEY_SAVED_TAKES);
        if (storedTakes) {
          setSavedTakes(JSON.parse(storedTakes));
        }
      } catch {}
    });
  }, []);

  const [isTakesDrawerOpen, setIsTakesDrawerOpen] = useState<boolean>(false);
  const [copySuccessToast, setCopySuccessToast] = useState<string | null>(null);

  // Playback state
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackProgress, setPlaybackProgress] = useState<{
    measureIndex: number;
    noteIndex: number;
    activeNoteId?: string;
  }>({
    measureIndex: 0,
    noteIndex: 0,
  });
  const [playbackInstrument, setPlaybackInstrument] = useState<InstrumentType>('piano');
  const [playbackBpm, setPlaybackBpm] = useState<number>(song.bpm || 80);

  // Sync song changes to storage
  useEffect(() => {
    if (typeof window !== 'undefined' && song) {
      try {
        localStorage.setItem(STORAGE_KEY_CURRENT_SONG, JSON.stringify(song));
      } catch {}
    }
  }, [song]);

  // Sync saved takes to storage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY_SAVED_TAKES, JSON.stringify(savedTakes));
      } catch {}
    }
  }, [savedTakes]);

  // Count total notes & measures
  const { totalNotes, totalMeasures } = useMemo(() => {
    let notesCount = 0;
    const measuresCount = song.measures?.length || 0;
    (song.measures || []).forEach(m => {
      notesCount += (m.notes || []).length;
    });
    return { totalNotes: notesCount, totalMeasures: measuresCount };
  }, [song]);

  // Audio Engine playback callbacks
  useEffect(() => {
    const unsubState = audioEngine.subscribeState(state => {
      setIsPlaying(state.isPlaying);
      setPlaybackProgress({
        measureIndex: state.currentMeasureIndex,
        noteIndex: state.currentNoteIndex,
        activeNoteId: state.currentNoteId || undefined,
      });
    });

    const unsubEnded = audioEngine.subscribeEnded(() => {
      setIsPlaying(false);
      setPlaybackProgress({ measureIndex: 0, noteIndex: 0 });
    });

    return () => {
      unsubState();
      unsubEnded();
    };
  }, []);

  // Playback trigger
  const handleTogglePlayback = useCallback(() => {
    if (isPlaying) {
      audioEngine.stop();
      setIsPlaying(false);
      setPlaybackProgress({ measureIndex: 0, noteIndex: 0 });
    } else {
      const songToPlay: Song = {
        ...song,
        bpm: playbackBpm,
        measures: song.measures.map(m => ({
          ...m,
          notes: m.notes.map(n => ({
            ...n,
            instrument: playbackInstrument,
          })),
        })),
      };
      audioEngine.play(songToPlay);
      setIsPlaying(true);
    }
  }, [isPlaying, song, playbackBpm, playbackInstrument]);

  // Handle Commit from Hum-to-Score or Keyboard-to-Score
  const handleCommitTranscription = useCallback(
    (newMeasures: Measure[], mode: InsertionMode) => {
      audioEngine.stop();
      setIsPlaying(false);

      setSong(prevSong => {
        let updatedMeasures: Measure[] = [];
        if (mode === 'replace' || !prevSong.measures || prevSong.measures.length === 0) {
          updatedMeasures = [...newMeasures];
        } else if (mode === 'append') {
          updatedMeasures = [...prevSong.measures, ...newMeasures];
        } else {
          // cursor or default insert
          updatedMeasures = [...newMeasures];
        }

        const finalMeasures = updatedMeasures.map((m, idx) => ({
          ...m,
          measureNumber: m.measureNumber || idx + 1,
        }));

        const newSong: Song = {
          ...prevSong,
          measures: finalMeasures,
        };

        // Save take into history
        const newTake: SavedTranscriptionTake = {
          id: 'take-' + Date.now(),
          timestamp: Date.now(),
          source: activeFeature,
          title: `${activeFeature === 'hum' ? '哼唱收音' : activeFeature === 'upload' ? '音檔轉譜' : '鍵盤彈奏'} - ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`,
          song: newSong,
          notesCount: finalMeasures.reduce((sum, m) => sum + (m.notes?.length || 0), 0),
          measuresCount: finalMeasures.length,
        };

        setSavedTakes(takes => [newTake, ...takes.slice(0, 19)]);
        setPlaybackBpm(newSong.bpm || 80);
        return newSong;
      });

      // Scroll to score preview
      setTimeout(() => {
        const scoreSection = document.getElementById('transcribed-score-view');
        if (scoreSection) {
          scoreSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }, 100);
    },
    [activeFeature]
  );

  // Copy plain text numbered notation format
  const handleCopyNumberedNotation = useCallback(() => {
    if (!song.measures || song.measures.length === 0) return;

    const lines: string[] = [];
    lines.push(`【${song.title || '轉譜簡譜'}】 1=${song.key || 'C'}  ${song.timeSignature || '4/4'}  ${song.bpm || 80} BPM`);
    lines.push('');

    let currentLine = '| ';
    song.measures.forEach((m, mIdx) => {
      const noteStrings = (m.notes || []).map(n => {
        if (n.pitch === 0) return '0';
        if (n.pitch === 'empty') return ' ';
        let str = '';
        if (n.accidental) str += n.accidental === '#' ? '♯' : '♭';
        str += n.pitch;
        if (n.octave > 0) str += '̇'.repeat(n.octave);
        if (n.octave < 0) str += '̣'.repeat(Math.abs(n.octave));
        if (n.duration === 2) str += ' -';
        if (n.duration === 3) str += ' - -';
        if (n.duration === 4) str += ' - - -';
        if (n.duration <= 0.5 && n.duration > 0.25) str += '_';
        if (n.duration <= 0.25) str += '=';
        if (n.isDotted) str += '·';
        return str;
      });

      currentLine += noteStrings.join(' ') + ' | ';

      if ((mIdx + 1) % 4 === 0 || mIdx === song.measures.length - 1) {
        lines.push(currentLine);
        currentLine = '| ';
      }
    });

    const fullText = lines.join('\n');
    navigator.clipboard.writeText(fullText).then(() => {
      setCopySuccessToast('簡譜純文字已成功複製到剪貼簿！');
      setTimeout(() => setCopySuccessToast(null), 3000);
    });
  }, [song]);

  // Export JSON
  const handleExportJson = useCallback(() => {
    const jsonStr = JSON.stringify(song, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(song.title || 'transcription').replace(/\s+/g, '_')}.taigi.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [song]);

  // Export MIDI
  const handleExportMidi = useCallback(() => {
    downloadMidiFile(song, {
      instrument: playbackInstrument,
      tempoBpm: playbackBpm,
      includeAccompaniment: false,
    });
  }, [song, playbackInstrument, playbackBpm]);

  // Clear score / New session
  const handleClearScore = useCallback(() => {
    audioEngine.stop();
    setIsPlaying(false);
    const emptySong: Song = {
      ...createInitialEmptySong(),
      key: song.key || 'C',
      bpm: song.bpm || 80,
      timeSignature: song.timeSignature || '4/4',
      measures: [
        {
          id: 'm-1',
          measureNumber: 1,
          timeSignature: song.timeSignature || '4/4',
          notes: [
            {
              id: 'n-1-1',
              pitch: 0,
              octave: 0,
              duration: 4,
              lyric: { hanlo: '', poj: '' },
            },
          ],
        },
      ],
    };
    setSong(emptySong);
  }, [song.key, song.bpm, song.timeSignature]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col selection:bg-amber-500 selection:text-zinc-950">
      {/* ========================================================================= */}
      {/* 1. STUDIO HEADER BAR                                                      */}
      {/* ========================================================================= */}
      <header className="sticky top-0 z-40 border-b border-zinc-800/80 bg-zinc-900/90 backdrop-blur-md px-4 sm:px-6 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4 flex-wrap">
          {/* Brand & Tagline */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-amber-400 to-amber-600 text-zinc-950 flex items-center justify-center font-black shadow-lg shadow-amber-500/20 shrink-0">
              <FileMusic className="w-5 h-5 stroke-[2.5]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base sm:text-lg font-black tracking-tight text-zinc-100">
                  轉譜工作站
                </h1>
                <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-amber-500/15 text-amber-300 border border-amber-500/20 uppercase tracking-wide">
                  Score Studio
                </span>
              </div>
              <p className="text-xs text-zinc-400 hidden sm:block">
                人聲哼唱與琴鍵彈奏 · 即時轉寫簡譜與 MIDI
              </p>
            </div>
          </div>

          {/* Core Feature Mode Switcher */}
          <div className="flex items-center bg-zinc-950 p-1 rounded-2xl border border-zinc-800 shadow-inner">
            <button
              id="feature-tab-hum"
              type="button"
              onClick={() => {
                audioEngine.stop();
                setIsPlaying(false);
                setActiveFeature('hum');
              }}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer ${
                activeFeature === 'hum'
                  ? 'bg-amber-500 text-zinc-950 font-black shadow-md scale-[1.02]'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60'
              }`}
            >
              <Mic2 className="w-4 h-4" />
              <span>哼唱收音 (Hum-to-Score)</span>
            </button>

            <button
              id="feature-tab-keyboard"
              type="button"
              onClick={() => {
                audioEngine.stop();
                setIsPlaying(false);
                setActiveFeature('keyboard');
              }}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer ${
                activeFeature === 'keyboard'
                  ? 'bg-amber-500 text-zinc-950 font-black shadow-md scale-[1.02]'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60'
              }`}
            >
              <Keyboard className="w-4 h-4" />
              <span>鍵盤彈奏 (Keyboard-to-Score)</span>
            </button>
          </div>

          {/* Quick Info & Saved Takes Trigger */}
          <div className="flex items-center gap-2">
            <div className="hidden lg:flex items-center gap-2 px-3 py-1.5 rounded-xl bg-zinc-800/60 border border-zinc-700/60 text-xs font-mono text-zinc-300">
              <span className="text-amber-400 font-bold">1={song.key}</span>
              <span className="text-zinc-600">•</span>
              <span>{song.timeSignature}</span>
              <span className="text-zinc-600">•</span>
              <span>{song.bpm} BPM</span>
            </div>

            <button
              id="open-saved-takes-btn"
              type="button"
              onClick={() => setIsTakesDrawerOpen(prev => !prev)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-bold text-zinc-200 transition-colors cursor-pointer"
              title="檢視歷史轉譜記錄"
            >
              <ListMusic className="w-4 h-4 text-amber-400" />
              <span className="hidden sm:inline">歷史記錄</span>
              {savedTakes.length > 0 && (
                <span className="px-1.5 py-0.2 text-[10px] font-black rounded-full bg-amber-500 text-zinc-950">
                  {savedTakes.length}
                </span>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* ========================================================================= */}
      {/* 2. MAIN ACTIVE WORKSPACE                                                 */}
      {/* ========================================================================= */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8 flex flex-col gap-8">
        {/* Feature Mode Notification Banner */}
        <div className="flex items-center justify-between p-4 rounded-2xl bg-zinc-900/60 border border-zinc-800/80 backdrop-blur-xs flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
              {activeFeature === 'hum' ? (
                <Mic2 className="w-5 h-5" />
              ) : activeFeature === 'upload' ? (
                <Upload className="w-5 h-5" />
              ) : (
                <Keyboard className="w-5 h-5" />
              )}
            </div>
            <div>
              <h2 className="text-sm sm:text-base font-extrabold text-zinc-100 flex items-center gap-2">
                <span>
                  {activeFeature === 'hum'
                    ? '人聲哼唱與實體樂器收音轉譜'
                    : activeFeature === 'upload'
                      ? '上傳人聲歌唱音檔解析轉寫簡譜'
                      : '螢幕觸控 / 電腦打字 / MIDI 鍵盤彈奏轉譜'}
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 font-mono font-bold">
                  {activeFeature === 'hum'
                    ? 'MICROPHONE / VOCAL PITCH ENGINE'
                    : activeFeature === 'upload'
                      ? 'AUDIO FILE / OFFLINE VOCAL TRANSCRIBER'
                      : 'KEYBOARD & WEB MIDI ENGINE'}
                </span>
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                {activeFeature === 'hum'
                  ? '佩戴耳機以清晰「噠/啦」唱音或吹奏笛子，系統將自動進行基頻音高偵測、音頭切分與節奏量化。'
                  : activeFeature === 'upload'
                    ? '支援 MP3/WAV/M4A 等音訊格式，離線高精確度基頻萃取與簡譜對齊，支援自訂調號與速度。'
                    : '使用螢幕鋼琴、電腦鍵盤 (A~K 鍵為 1~7 音) 或插入 USB/藍牙 MIDI 琴鍵彈奏轉寫。'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-400">目前樂譜已收錄:</span>
            <span className="px-2.5 py-1 rounded-lg bg-zinc-800 text-amber-300 font-mono font-bold text-xs border border-zinc-700">
              {totalMeasures} 小節 / {totalNotes} 音符
            </span>
          </div>
        </div>

        {/* WORKSPACE CONTAINER: UNIFIED SCORE TRANSCRIPTION DECK */}
        <div className="w-full">
          <ScoreTranscriptionDeck
            isOpen={true}
            isEmbedded={true}
            song={song}
            audioEngine={audioEngine}
            mode={activeFeature}
            onModeChange={setActiveFeature}
            onCommitTranscription={handleCommitTranscription}
          />
        </div>

        {/* ========================================================================= */}
        {/* 3. TRANSCRIBED SCORE SHOWCASE & EXPORT CENTER                             */}
        {/* ========================================================================= */}
        <section
          id="transcribed-score-view"
          className="w-full rounded-3xl bg-zinc-900 border border-zinc-800 shadow-xl overflow-hidden flex flex-col"
        >
          {/* Section Header */}
          <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between gap-4 flex-wrap bg-zinc-900/80">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-2xl bg-amber-500/15 text-amber-400 border border-amber-500/20">
                <Music2 className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-extrabold text-zinc-100">
                    簡譜轉譜成果展示台
                  </h3>
                  <span className="text-[10px] px-2 py-0.5 rounded-full font-mono font-bold bg-amber-500/20 text-amber-300">
                    Numbered Musical Notation
                  </span>
                </div>
                <p className="text-xs text-zinc-400 mt-0.5">
                  即時可視化簡譜、多音色試聽演奏、一鍵匯出 MIDI 與純文字
                </p>
              </div>
            </div>

            {/* Quick Export & Actions */}
            <div className="flex items-center gap-2 flex-wrap">
              <button
                id="score-copy-text-btn"
                type="button"
                onClick={handleCopyNumberedNotation}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 text-xs font-bold transition-all cursor-pointer active:scale-95 shadow-2xs"
                title="複製純文字簡譜"
              >
                <Copy className="w-3.5 h-3.5 text-amber-400" />
                <span>複製簡譜文字</span>
              </button>

              <button
                id="score-export-midi-btn"
                type="button"
                onClick={handleExportMidi}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 font-black text-xs transition-all cursor-pointer active:scale-95 shadow-sm"
                title="下載標準 MIDI 檔 (.mid)"
              >
                <Download className="w-3.5 h-3.5 stroke-[2.5]" />
                <span>下載 MIDI (.mid)</span>
              </button>

              <button
                id="score-export-json-btn"
                type="button"
                onClick={handleExportJson}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 text-xs font-bold transition-all cursor-pointer active:scale-95 shadow-2xs"
                title="下載樂譜 JSON"
              >
                <FileMusic className="w-3.5 h-3.5 text-amber-400" />
                <span>下載 JSON</span>
              </button>

              <button
                id="score-clear-btn"
                type="button"
                onClick={handleClearScore}
                className="p-2 rounded-xl text-zinc-400 hover:text-rose-400 hover:bg-rose-500/10 border border-transparent hover:border-rose-500/30 transition-colors cursor-pointer"
                title="清空重新記譜"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Copy Success Feedback Banner */}
          {copySuccessToast && (
            <div className="px-6 py-2 bg-emerald-500/15 border-b border-emerald-500/30 text-emerald-300 text-xs font-bold flex items-center gap-2 animate-in fade-in">
              <Check className="w-4 h-4 text-emerald-400" />
              <span>{copySuccessToast}</span>
            </div>
          )}

          {/* Playback Control Bar */}
          <div className="px-6 py-3 border-b border-zinc-800/80 bg-zinc-950/60 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <button
                id="score-play-toggle-btn"
                type="button"
                onClick={handleTogglePlayback}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-2xl font-black text-xs sm:text-sm shadow-md transition-all active:scale-95 cursor-pointer ${
                  isPlaying
                    ? 'bg-rose-500 hover:bg-rose-400 text-white'
                    : 'bg-gradient-to-r from-amber-500 to-amber-400 hover:from-amber-400 hover:to-amber-300 text-zinc-950'
                }`}
              >
                {isPlaying ? (
                  <>
                    <Pause className="w-4 h-4 fill-current" />
                    <span>暫停演奏</span>
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 fill-current" />
                    <span>演奏試聽</span>
                  </>
                )}
              </button>

              {/* Synth Instrument Selector */}
              <div className="flex items-center gap-1.5">
                <Volume2 className="w-3.5 h-3.5 text-zinc-400" />
                <select
                  id="score-playback-instrument-select"
                  value={playbackInstrument}
                  onChange={e => setPlaybackInstrument(e.target.value as InstrumentType)}
                  className="px-2.5 py-1.5 bg-zinc-800 border border-zinc-700 rounded-xl text-xs font-bold text-zinc-200 cursor-pointer"
                >
                  <option value="piano">🎹 平台鋼琴 (Piano)</option>
                  <option value="flute">🎋 竹笛笛子 (Flute)</option>
                  <option value="guitar">🎸 木吉他 (Acoustic Guitar)</option>
                  <option value="cello">🎻 大提琴 (Cello/Strings)</option>
                  <option value="synth">⚡ 電子合成 (Synth Lead)</option>
                  <option value="bell">🔔 鐵琴鐘聲 (Glockenspiel)</option>
                </select>
              </div>
            </div>

            {/* Playback Tempo Slider */}
            <div className="flex items-center gap-3 font-mono text-xs">
              <Clock className="w-3.5 h-3.5 text-amber-400" />
              <span className="text-zinc-400">速度:</span>
              <input
                id="score-playback-bpm-slider"
                type="range"
                min="40"
                max="220"
                value={playbackBpm}
                onChange={e => setPlaybackBpm(parseInt(e.target.value, 10))}
                className="accent-amber-500 w-24 sm:w-32 h-1.5 bg-zinc-700 rounded-lg cursor-pointer"
              />
              <span className="font-bold text-amber-300 w-16 text-right">
                {playbackBpm} BPM
              </span>
            </div>
          </div>

          {/* NUMBERED NOTATION SHEET CANVAS */}
          <div className="p-6 sm:p-8 bg-[#0e1117] min-h-[260px] overflow-x-auto flex flex-col gap-6">
            {/* Score Title Header Banner */}
            <div className="flex items-baseline justify-between border-b border-zinc-800 pb-3 flex-wrap gap-2">
              <div className="flex items-baseline gap-3">
                <h4 className="text-xl font-serif font-black text-amber-400 tracking-wide">
                  {song.title || '轉譜簡譜總譜'}
                </h4>
                <span className="text-xs font-mono text-zinc-400">
                  1 = {song.key} ({song.timeSignature}) · ♩ = {playbackBpm}
                </span>
              </div>
              <span className="text-xs font-mono text-zinc-500">
                共 {song.measures?.length || 0} 個小節
              </span>
            </div>

            {/* Measures Flow Grid */}
            <div className="flex flex-wrap items-stretch gap-y-6 gap-x-2">
              {(song.measures || []).map((measure, mIdx) => {
                const isCurrentMeasure = isPlaying && playbackProgress.measureIndex === mIdx;

                return (
                  <div
                    key={measure.id || `m-${mIdx}`}
                    className={`relative flex items-center p-2 rounded-2xl border transition-all ${
                      isCurrentMeasure
                        ? 'bg-amber-500/10 border-amber-500/50 ring-2 ring-amber-400/30'
                        : 'bg-zinc-900/70 border-zinc-800/80 hover:border-zinc-700'
                    }`}
                  >
                    {/* Measure Number Badge */}
                    <span className="absolute -top-3 left-2 px-1.5 py-0.2 rounded font-mono text-[9px] font-bold bg-zinc-800 text-zinc-400 border border-zinc-700">
                      {mIdx + 1}
                    </span>

                    {/* Measure Notes */}
                    <div className="flex items-center gap-1.5 px-1 py-1">
                      {(measure.notes || []).map((note, nIdx) => {
                        const isNoteActive =
                          isCurrentMeasure && playbackProgress.noteIndex === nIdx;

                        return (
                          <NumberedNotationNoteComponent
                            key={note.id || `n-${mIdx}-${nIdx}`}
                            note={note}
                            prevNote={nIdx > 0 ? measure.notes[nIdx - 1] : null}
                            isActive={isNoteActive}
                          />
                        );
                      })}
                    </div>

                    {/* Bar Line */}
                    <div className="w-[1.5px] h-10 bg-zinc-700 mx-1 rounded-full shrink-0" />
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </main>

      {/* ========================================================================= */}
      {/* 4. SAVED TRANSCRIPTIONS DRAWER                                            */}
      {/* ========================================================================= */}
      {isTakesDrawerOpen && (
        <div
          id="saved-takes-drawer-overlay"
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex justify-end animate-in fade-in"
          onClick={() => setIsTakesDrawerOpen(false)}
        >
          <div
            id="saved-takes-drawer"
            className="w-full max-w-md bg-zinc-900 border-l border-zinc-800 h-full p-6 flex flex-col gap-5 shadow-2xl overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-zinc-800 pb-4">
              <div className="flex items-center gap-2">
                <ListMusic className="w-5 h-5 text-amber-400" />
                <h3 className="font-extrabold text-base text-zinc-100">
                  本機歷史轉譜記錄
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setIsTakesDrawerOpen(false)}
                className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 cursor-pointer"
              >
                ✕
              </button>
            </div>

            {savedTakes.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-8 text-center text-zinc-500 gap-2 my-auto">
                <Music2 className="w-10 h-10 stroke-1 text-zinc-600" />
                <p className="text-sm font-bold">尚無歷史轉譜記錄</p>
                <p className="text-xs">進行哼唱或彈奏轉譜後，將自動在此處儲存記錄。</p>
              </div>
            ) : (
              <div className="flex flex-col gap-3 flex-1 overflow-y-auto">
                {savedTakes.map(take => (
                  <div
                    key={take.id}
                    className="p-4 rounded-2xl bg-zinc-950 border border-zinc-800 hover:border-amber-500/50 flex flex-col gap-2 transition-all group"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-zinc-200 flex items-center gap-1.5">
                        {take.source === 'hum' ? (
                          <Mic2 className="w-3.5 h-3.5 text-amber-400" />
                        ) : take.source === 'upload' ? (
                          <Upload className="w-3.5 h-3.5 text-amber-400" />
                        ) : (
                          <Keyboard className="w-3.5 h-3.5 text-amber-400" />
                        )}
                        <span>{take.title}</span>
                      </span>
                      <span className="text-[10px] text-zinc-500 font-mono">
                        {new Date(take.timestamp).toLocaleTimeString()}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-xs text-zinc-400 font-mono">
                      <span>
                        1={take.song.key} · {take.measuresCount} 小節 · {take.notesCount} 音符
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          audioEngine.stop();
                          setIsPlaying(false);
                          setSong(take.song);
                          setPlaybackBpm(take.song.bpm || 80);
                          setIsTakesDrawerOpen(false);
                        }}
                        className="px-2.5 py-1 rounded-lg bg-amber-500 hover:bg-amber-400 text-zinc-950 font-black text-xs cursor-pointer active:scale-95"
                      >
                        載入此份
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {savedTakes.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  if (confirm('確定清空所有轉譜歷史記錄嗎？')) {
                    setSavedTakes([]);
                  }
                }}
                className="w-full py-2.5 rounded-xl border border-zinc-800 hover:bg-rose-500/10 text-rose-400 hover:border-rose-500/30 text-xs font-bold transition-colors cursor-pointer"
              >
                清空全部歷史記錄
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
