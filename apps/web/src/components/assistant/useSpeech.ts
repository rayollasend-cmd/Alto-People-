import { useCallback, useEffect, useRef, useState } from 'react';
import type { Lang } from '@/lib/i18n';

/**
 * Hugo's voice: speech to text for the microphone, text to speech for
 * reading answers aloud — the browser's own (Chrome and Edge send the audio
 * to Google, Safari to Apple; the panel says "your browser turns your voice
 * into text"). Nothing is recorded or kept here: only the transcript is sent,
 * as a typed question would be.
 *
 * Where the browser has no speech recognition (Firefox, an in-app web view),
 * `supported` is false and the panel shows no microphone.
 */

/** The app's languages as speech engines name them. Haitian Creole has few voices; the browser falls back. */
export const SPEECH_LANG: Record<Lang, string> = { en: 'en-US', es: 'es-US', tr: 'tr-TR', ht: 'ht-HT', pt: 'pt-BR', uk: 'uk-UA' };

interface RecognitionResultList {
  length: number;
  [i: number]: { isFinal: boolean; 0: { transcript: string } };
}
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { results: RecognitionResultList }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export type SpeechInputError = 'denied' | 'no-speech' | null;

/** Speak a question: interim words as they come, then `onFinal` with what was said. */
export function useSpeechInput(lang: Lang, onFinal: (text: string) => void) {
  const supported = Boolean(recognitionCtor());
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<SpeechInputError>(null);
  const rec = useRef<Recognition | null>(null);
  const heard = useRef('');
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  const stop = useCallback(() => rec.current?.stop(), []);
  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    rec.current?.abort();
    const r = new Ctor();
    r.lang = SPEECH_LANG[lang];
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    heard.current = '';
    setInterim('');
    setError(null);
    r.onresult = (e) => {
      let text = '';
      for (let i = 0; i < e.results.length; i++) text += e.results[i]![0].transcript;
      heard.current = text;
      setInterim(text);
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') setError('denied');
      else if (e.error === 'no-speech') setError('no-speech');
    };
    r.onend = () => {
      rec.current = null;
      setListening(false);
      setInterim('');
      const said = heard.current.trim();
      if (said) onFinalRef.current(said);
    };
    rec.current = r;
    setListening(true);
    try {
      r.start();
    } catch {
      rec.current = null;
      setListening(false);
    }
  }, [lang]);

  useEffect(() => () => rec.current?.abort(), []);
  return { supported, listening, interim, error, start, stop, clearError: () => setError(null) };
}

/** Read an answer aloud in the person's language, with a voice for it where the device has one. */
export function useSpeechOutput(lang: Lang) {
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';
  const [speaking, setSpeaking] = useState(false);

  const stop = useCallback(() => {
    if (supported) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [supported]);

  const speak = useCallback(
    (text: string) => {
      if (!supported || !text.trim()) return;
      const synth = window.speechSynthesis;
      synth.cancel();
      const u = new window.SpeechSynthesisUtterance(text);
      const want = SPEECH_LANG[lang];
      u.lang = want;
      const voices = synth.getVoices();
      const voice = voices.find((v) => v.lang === want) ?? voices.find((v) => v.lang.startsWith(want.slice(0, 2)));
      if (voice) u.voice = voice;
      u.onend = () => setSpeaking(false);
      u.onerror = () => setSpeaking(false);
      setSpeaking(true);
      synth.speak(u);
    },
    [lang, supported],
  );

  useEffect(() => () => {
    if (supported) window.speechSynthesis.cancel();
  }, [supported]);
  return { supported, speaking, speak, stop };
}
