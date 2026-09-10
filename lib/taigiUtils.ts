import {
  GraceNote,
  InstrumentType,
  KeySignature,
  Measure,
  NumberedNotationNote,
  PitchNumber,
  Song,
  TimeSignature,
} from '@/types/song';

// Semitones relative to C4 (MIDI note 60)
export const KEY_SEMITONES: Record<string, number> = {
  'C': 0,
  'C#': 1,
  'Db': 1,
  'D': 2,
  'D#': 3,
  'Eb': 3,
  'E': 4,
  'F': 5,
  'F#': 6,
  'Gb': 6,
  'G': 7,
  'G#': 8,
  'Ab': 8,
  'A': 9,
  'A#': 10,
  'Bb': 10,
  'B': 11,
};

// Major scale scale degree intervals from root 1 (in semitones)
export const SCALE_DEGREE_SEMITONES: Record<string, number> = {
  0: -100, // Rest
  'empty': -100, // Empty notation / spacer / punctuation slot
  1: 0,
  2: 2,
  3: 4,
  4: 5,
  5: 7,
  6: 9,
  7: 11,
};

export const CHROMATIC_KEYS: KeySignature[] = [
  'C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'
];

export const STANDARD_TIME_SIGNATURES: {
  value: TimeSignature;
  label: string;
  sublabel: string;
  beatsPerMeasure: number;
}[] = [
  { value: '4/4', label: '4/4', sublabel: '四四拍 (Common Time · 4 拍/小節)', beatsPerMeasure: 4 },
  { value: '3/4', label: '3/4', sublabel: '三四拍 (Waltz · 3 拍/小節)', beatsPerMeasure: 3 },
  { value: '2/4', label: '2/4', sublabel: '二四拍 (March · 2 拍/小節)', beatsPerMeasure: 2 },
  { value: '6/8', label: '6/8', sublabel: '八六拍 (Compound Duple · 3 拍/小節)', beatsPerMeasure: 3 },
];

export const INSTRUMENT_LABELS: Record<InstrumentType, { en: string; zh: string }> = {
  piano: { en: 'Grand Piano', zh: '平台鋼琴' },
  flute: { en: 'Flute / Dizi', zh: '笛子 / 長笛' },
  whistle: { en: 'Tin Whistle', zh: '愛爾蘭哨笛' },
  guitar: { en: 'Acoustic Guitar', zh: '木吉他' },
  synth: { en: 'Lead Synth', zh: '電子合成' },
  bell: { en: 'Glockenspiel', zh: '鐵琴鐘聲' },
  cello: { en: 'Cello / Erhu', zh: '大提琴 / 二胡' },
};

/**
 * Calculate frequency in Hz for a given Key, Pitch number (1-7), Octave offset, and Accidental.
 */
export function getPitchFrequency(
  key: KeySignature,
  pitch: PitchNumber,
  octave: number = 0,
  accidental: '' | '#' | 'b' = '',
  transposeSemitones: number = 0
): number {
  if (pitch === 0 || pitch === 'empty' || !pitch) return 0;

  const baseKeyOffset = KEY_SEMITONES[key] || 0;
  const degreeOffset = SCALE_DEGREE_SEMITONES[pitch] || 0;
  let accidentalOffset = 0;
  if (accidental === '#') accidentalOffset = 1;
  if (accidental === 'b') accidentalOffset = -1;

  const totalSemitonesFromC4 =
    baseKeyOffset + degreeOffset + octave * 12 + accidentalOffset + transposeSemitones;
  const midiNote = 60 + totalSemitonesFromC4;

  return 440 * Math.pow(2, (midiNote - 69) / 12);
}

/**
 * Chord note frequencies for accompaniment synthesis.
 */
export function getChordNotes(chordName: string, transposeSemitones: number = 0): number[] {
  if (!chordName || chordName.trim() === '') return [];

  const cleanName = chordName.trim().replace(/[()]/g, '').replace(/♭/g, 'b').replace(/♯/g, '#');
  if (/^N\.?C\.?$/i.test(cleanName) || cleanName.toLowerCase() === 'none') {
    return [];
  }

  const [mainChord, slashBass] = cleanName.split('/');
  const rootMatch = mainChord.trim().match(/^([A-G][#b]?)(.*)$/);
  if (!rootMatch) return [];

  const rootStr = rootMatch[1] as KeySignature;
  const quality = rootMatch[2].toLowerCase();

  const rootSemitone = (KEY_SEMITONES[rootStr] ?? 0) + transposeSemitones;

  let bassSemitone = rootSemitone;
  const trimmedSlashBass = slashBass ? slashBass.trim() : '';
  if (trimmedSlashBass && KEY_SEMITONES[trimmedSlashBass as KeySignature] !== undefined) {
    bassSemitone = (KEY_SEMITONES[trimmedSlashBass as KeySignature] ?? 0) + transposeSemitones;
  }
  const bassMidi = 36 + (((bassSemitone % 12) + 12) % 12);

  const harmonyRootMidi = 48 + (((rootSemitone % 12) + 12) % 12);
  let intervals = [0, 4, 7];

  if (quality.includes('m') && !quality.includes('maj')) {
    if (quality.includes('m7')) {
      intervals = [0, 3, 7, 10];
    } else if (quality.includes('m6')) {
      intervals = [0, 3, 7, 9];
    } else {
      intervals = [0, 3, 7];
    }
  } else if (quality.includes('dim')) {
    intervals = quality.includes('7') ? [0, 3, 6, 9] : [0, 3, 6];
  } else if (quality.includes('aug')) {
    intervals = [0, 4, 8];
  } else if (quality.includes('sus4')) {
    intervals = [0, 5, 7];
  } else if (quality.includes('sus2')) {
    intervals = [0, 2, 7];
  } else if (quality.includes('add9')) {
    intervals = [0, 4, 7, 14];
  } else if (quality.includes('6')) {
    intervals = [0, 4, 7, 9];
  } else if (quality.includes('7')) {
    if (quality.includes('maj7')) {
      intervals = [0, 4, 7, 11];
    } else {
      intervals = [0, 4, 7, 10];
    }
  }

  const harmonyMidis = intervals.map(interval => {
    let midi = harmonyRootMidi + interval;
    while (midi > 63) {
      midi -= 12;
    }
    return midi;
  });

  const sortedHarmony = Array.from(new Set(harmonyMidis)).sort((a, b) => a - b);
  const allMidis = [bassMidi, ...sortedHarmony];

  return allMidis.map(midiNote => 440 * Math.pow(2, (midiNote - 69) / 12));
}

/**
 * Compare two notes to see if they have identical musical pitch (pitch number, octave, accidental).
 */
export function isSamePitch(a: NumberedNotationNote | null | undefined, b: NumberedNotationNote | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.pitch === 'empty' || b.pitch === 'empty') return false;
  if (a.pitch === 0 || b.pitch === 0) return a.pitch === b.pitch;
  return (
    a.pitch === b.pitch &&
    (a.octave || 0) === (b.octave || 0) &&
    (a.accidental || '') === (b.accidental || '')
  );
}

/**
 * Check if a Tie is active from currentNote into nextNote.
 */
export function isTieActive(currentNote: NumberedNotationNote | null | undefined, nextNote?: NumberedNotationNote | null): boolean {
  if (!currentNote || !nextNote) return false;
  const wantsTie = Boolean(currentNote.tieToNext || currentNote.isTied);
  return wantsTie && isSamePitch(currentNote, nextNote);
}

/**
 * Check if a Slur is active from currentNote into nextNote.
 */
export function isSlurActive(currentNote: NumberedNotationNote | null | undefined, nextNote?: NumberedNotationNote | null): boolean {
  if (!currentNote) return false;
  if (currentNote.slurToNext) return true;
  if (currentNote.isTied && nextNote && !isSamePitch(currentNote, nextNote)) {
    return true;
  }
  return false;
}

/**
 * Check if a note is a melisma continuation under a slur.
 */
export function isMelismaContinuation(note: NumberedNotationNote | null | undefined, prevNote?: NumberedNotationNote | null): boolean {
  if (!note || !prevNote) return false;
  const prevSlurred = isSlurActive(prevNote, note);
  const noteHasOwnLyric = Boolean(
    note.lyric?.hanlo?.trim() ||
    note.lyric?.poj?.trim() ||
    note.lyric?.hanji?.trim() ||
    note.lyric?.custom?.trim()
  );
  return prevSlurred && !noteHasOwnLyric;
}

/**
 * Format grace notes into compact display string e.g. "(3 5)"
 */
export function formatGraceNotes(notes?: GraceNote[]): string {
  if (!notes || notes.length === 0) return '';
  return notes
    .map(g => {
      let p = `${g.accidental || ''}${g.pitch}`;
      if (g.octave > 0) p += '̇'.repeat(g.octave);
      else if (g.octave < 0) p += '̣'.repeat(Math.abs(g.octave));
      return p;
    })
    .join('');
}

/**
 * Check if a note is punctuation, an annotation, a newline, or whitespace/blank spacer.
 */
export function isNonNotationItem(note: NumberedNotationNote | null | undefined): boolean {
  if (!note) return false;

  if (typeof note.duration === 'number' && note.duration <= 0) return true;
  if (note.pitch === 'empty') return true;

  const isMusicalPitch = typeof note.pitch === 'number' && note.pitch > 0;
  if (note.annotation && !isMusicalPitch) {
    return true;
  }

  const rawHanlo = note.lyric?.hanlo ?? note.lyric?.custom ?? note.lyric?.hanji ?? '';
  const rawPoj = note.lyric?.poj ?? note.lyric?.tl ?? '';

  const hasAnyLyric = rawHanlo.length > 0 || rawPoj.length > 0;

  const isPurePunctuationLyric =
    hasAnyLyric &&
    (!rawHanlo || isPunctuationOrSpacer(rawHanlo)) &&
    (!rawPoj || isPunctuationOrSpacer(rawPoj));

  if (isPurePunctuationLyric && !isMusicalPitch) {
    return true;
  }

  return false;
}

export function isPunctuationZeroNote(note: NumberedNotationNote | null | undefined): boolean {
  if (!note) return false;
  return isNonNotationItem(note) && !note.annotation;
}

export function isStandaloneAnnotationNote(note: NumberedNotationNote | null | undefined): boolean {
  if (!note) return false;
  return isNonNotationItem(note) && Boolean(note.annotation);
}

export function getPunctuationDisplayChar(note: NumberedNotationNote | null | undefined): string {
  if (!note) return '';
  const hanlo = note.lyric?.hanlo ?? '';
  const hanji = note.lyric?.hanji ?? '';
  const custom = note.lyric?.custom ?? '';
  const raw = hanlo || hanji || custom || '';
  if (raw === '\n' || raw === '\r' || raw === '↵') return '↵';
  if (raw === ' ') return '␣';
  if (raw.trim()) return raw.trim().slice(-1);
  return '␣';
}

export function isPunctuationOrSpacer(str?: string): boolean {
  if (!str) return false;
  const trimmed = str.trim();
  if (
    trimmed === '' ||
    trimmed === '—' ||
    trimmed === '…' ||
    trimmed === 'V' ||
    trimmed === '↵' ||
    trimmed === '\n' ||
    trimmed === '\r'
  ) {
    return true;
  }
  return /^[，。！？、；：""''（）()「」,.!?;:\s—…\n\r↵]+$/.test(trimmed);
}

export function isNewlineBreak(str?: string): boolean {
  if (!str) return false;
  return /[\n\r↵]/.test(str);
}

/**
 * Extract all chords from a measure, supporting both measure.chords array and measure.chord string
 */
export function getMeasureChords(measure?: Partial<Measure> | { chord?: string; chords?: string[] } | null): string[] {
  if (!measure) return [];
  if (Array.isArray(measure.chords) && measure.chords.length > 0) {
    const list = measure.chords.map(c => c.trim()).filter(Boolean);
    if (list.length > 0) return list;
  }
  if (measure.chord && typeof measure.chord === 'string') {
    return measure.chord
      .split(/[\s,\-|]+/)
      .map(c => c.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Format an array of chords for measure.chord string storage and clean display
 */
export function formatMeasureChords(chords: string[]): string {
  return chords.map(c => c.trim()).filter(Boolean).join(' ');
}

/**
 * Resolves the effective chords for a measure within a song.
 */
export function getEffectiveMeasureChords(song: Song, measureIndex: number): string[] {
  if (!song || !Array.isArray(song.measures) || measureIndex < 0 || measureIndex >= song.measures.length) {
    return [];
  }

  const targetMeasure = song.measures[measureIndex];
  if (!targetMeasure) return [];

  const directChords = getMeasureChords(targetMeasure);
  if (directChords.length > 0) {
    const isExplicitNoChord = directChords.some(c => {
      const u = c.trim().toUpperCase();
      return u === 'N.C.' || u === 'NC' || u === 'NONE';
    });
    if (isExplicitNoChord) return [];
    return directChords;
  }

  for (let i = measureIndex - 1; i >= 0; i--) {
    const prevMeasure = song.measures[i];
    if (prevMeasure) {
      const prevChords = getMeasureChords(prevMeasure);
      if (prevChords.length > 0) {
        const isExplicitNoChord = prevChords.some(c => {
          const u = c.trim().toUpperCase();
          return u === 'N.C.' || u === 'NC' || u === 'NONE';
        });
        if (isExplicitNoChord) return [];
        return prevChords;
      }
    }
  }

  for (let i = measureIndex + 1; i < song.measures.length; i++) {
    const nextMeasure = song.measures[i];
    if (nextMeasure) {
      const nextChords = getMeasureChords(nextMeasure);
      if (nextChords.length > 0) {
        const isExplicitNoChord = nextChords.some(c => {
          const u = c.trim().toUpperCase();
          return u === 'N.C.' || u === 'NC' || u === 'NONE';
        });
        if (!isExplicitNoChord) return nextChords;
      }
    }
  }

  return [song.key || 'C'];
}
