/**
 * Sound synthesis utility for Sitting Tracker
 * 
 * Supports both HTMLAudioElement (pre-synthesized WAV Blob audio) and Web Audio API.
 * HTMLAudioElement is critical because Chrome allows HTML5 Audio elements to play
 * seamlessly when the tab is in the background, minimized, or inactive once the
 * page has had user interaction, whereas raw Web Audio AudioContext oscillators
 * are suspended by Chrome's background throttling.
 */

// Helper to synthesize a PCM WAV audio Blob directly in the browser
function createWavBlob(sampleRate: number, durationSec: number, sampleFn: (t: number) => number): Blob {
  const numSamples = Math.floor(sampleRate * durationSec);
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  // RIFF header
  view.setUint8(0, 0x52); view.setUint8(1, 0x49); view.setUint8(2, 0x46); view.setUint8(3, 0x46); // "RIFF"
  view.setUint32(4, 36 + numSamples * 2, true);
  view.setUint8(8, 0x57); view.setUint8(9, 0x41); view.setUint8(10, 0x56); view.setUint8(11, 0x45); // "WAVE"
  view.setUint8(12, 0x66); view.setUint8(13, 0x6d); view.setUint8(14, 0x74); view.setUint8(15, 0x20); // "fmt "
  view.setUint32(16, 16, true); // PCM SubChunk size
  view.setUint16(20, 1, true); // Format 1 = PCM
  view.setUint16(22, 1, true); // 1 Channel (Mono)
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // Byte rate
  view.setUint16(32, 2, true); // Block align
  view.setUint16(34, 16, true); // Bits per sample
  view.setUint8(36, 0x64); view.setUint8(37, 0x61); view.setUint8(38, 0x74); view.setUint8(39, 0x61); // "data"
  view.setUint32(40, numSamples * 2, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++, offset += 2) {
    const t = i / sampleRate;
    const sample = Math.max(-1, Math.min(1, sampleFn(t)));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

class SoundController {
  private ctx: AudioContext | null = null;
  private soundEnabled: boolean = true;
  private isUnlocked: boolean = false;

  // Pre-instantiated HTML5 Audio elements for background tab playback
  private sitDownAudio: HTMLAudioElement | null = null;
  private standUpAudio: HTMLAudioElement | null = null;
  private breakAudio: HTMLAudioElement | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('sitting_tracker_sound');
      if (stored !== null) {
        this.soundEnabled = stored === 'true';
      }

      this.initAudioElements();
    }
  }

  private initAudioElements(): void {
    if (typeof window === 'undefined') return;

    try {
      const sampleRate = 44100;

      // 1. Sit Down chime: Pleasant ascending dual tone (C5 -> E5 + G5 harmonic)
      const sitDownBlob = createWavBlob(sampleRate, 0.6, (t) => {
        // First tone: 523Hz (C5) ramping to 659Hz (E5)
        const freq1 = t < 0.15 ? 523.25 + (659.25 - 523.25) * (t / 0.15) : 659.25;
        const env1 = t < 0.03 ? t / 0.03 : Math.max(0, 1 - (t - 0.03) / 0.35);

        // Second tone: 783.99Hz (G5) starting at 0.1s
        const t2 = t - 0.1;
        const env2 = t2 < 0 ? 0 : t2 < 0.04 ? t2 / 0.04 : Math.max(0, 1 - (t2 - 0.04) / 0.45);

        return 0.35 * env1 * Math.sin(2 * Math.PI * freq1 * t) +
               0.30 * env2 * Math.sin(2 * Math.PI * 783.99 * t2);
      });
      this.sitDownAudio = new Audio(URL.createObjectURL(sitDownBlob));
      this.sitDownAudio.preload = 'auto';

      // 2. Stand Up chime: Gentle descending chime (E5 -> A4)
      const standUpBlob = createWavBlob(sampleRate, 0.55, (t) => {
        const freq = t < 0.3 ? 659.25 - (659.25 - 440.0) * (t / 0.3) : 440.0;
        const env = t < 0.04 ? t / 0.04 : Math.max(0, 1 - (t - 0.04) / 0.5);
        return 0.4 * env * Math.sin(2 * Math.PI * freq * t);
      });
      this.standUpAudio = new Audio(URL.createObjectURL(standUpBlob));
      this.standUpAudio.preload = 'auto';

      // 3. Break Reminder chime: 3 gentle alert pulses (G5, G5, A5)
      const breakBlob = createWavBlob(sampleRate, 0.8, (t) => {
        let sample = 0;
        const pulses = [
          { start: 0.0, freq: 783.99 },
          { start: 0.22, freq: 783.99 },
          { start: 0.44, freq: 880.0 },
        ];
        for (const p of pulses) {
          const dt = t - p.start;
          if (dt >= 0 && dt < 0.3) {
            const env = dt < 0.02 ? dt / 0.02 : Math.max(0, Math.exp(-dt * 10));
            sample += 0.35 * env * Math.sin(2 * Math.PI * p.freq * dt);
          }
        }
        return sample;
      });
      this.breakAudio = new Audio(URL.createObjectURL(breakBlob));
      this.breakAudio.preload = 'auto';
    } catch (e) {
      console.warn('Failed to pre-synthesize audio elements:', e);
    }
  }

  /**
   * Unlock audio engine on first user interaction.
   * Required by Chrome Autoplay Policy so audio can play freely in background tabs.
   */
  public unlock(): void {
    if (typeof window === 'undefined') return;
    this.isUnlocked = true;

    // Resume AudioContext if created
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }

    // Warm up the HTML5 Audio elements
    [this.sitDownAudio, this.standUpAudio, this.breakAudio].forEach((audio) => {
      if (audio) {
        const prevVolume = audio.volume;
        audio.volume = 0;
        audio.play().then(() => {
          audio.pause();
          audio.currentTime = 0;
          audio.volume = prevVolume;
        }).catch(() => {
          // Allowed to fail if interaction wasn't registered yet
        });
      }
    });
  }

  public isAudioUnlocked(): boolean {
    return this.isUnlocked;
  }

  private getContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  public isEnabled(): boolean {
    return this.soundEnabled;
  }

  public setEnabled(enabled: boolean): void {
    this.soundEnabled = enabled;
    if (typeof window !== 'undefined') {
      localStorage.setItem('sitting_tracker_sound', String(enabled));
    }
    if (enabled) {
      this.unlock();
    }
  }

  private playHtmlAudio(audio: HTMLAudioElement | null): boolean {
    if (!audio) return false;
    try {
      audio.currentTime = 0;
      audio.volume = 0.85;
      const promise = audio.play();
      if (promise !== undefined) {
        promise.catch((err) => {
          console.warn('HTMLAudioElement play deferred or blocked:', err);
        });
      }
      return true;
    } catch (e) {
      console.warn('playHtmlAudio error:', e);
      return false;
    }
  }

  /**
   * Pleasant ascending dual-tone chime when user sits down
   */
  public playSitDown(): void {
    if (!this.soundEnabled) return;

    // 1. Primary: HTMLAudioElement (works in background tabs in Chrome)
    if (this.sitDownAudio) {
      this.playHtmlAudio(this.sitDownAudio);
      return;
    }

    // 2. Fallback: Web Audio API
    const ctx = this.getContext();
    if (!ctx) return;

    try {
      const now = ctx.currentTime;
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(523.25, now);
      osc1.frequency.exponentialRampToValueAtTime(659.25, now + 0.12);

      gain1.gain.setValueAtTime(0.001, now);
      gain1.gain.linearRampToValueAtTime(0.18, now + 0.04);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.35);

      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(783.99, now + 0.1);

      gain2.gain.setValueAtTime(0.001, now + 0.1);
      gain2.gain.linearRampToValueAtTime(0.15, now + 0.15);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.55);

      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(now + 0.1);
      osc2.stop(now + 0.55);
    } catch (e) {
      console.warn('Audio play failed:', e);
    }
  }

  /**
   * Gentle descending tone when user stands up / walks away
   */
  public playStandUp(): void {
    if (!this.soundEnabled) return;

    if (this.standUpAudio) {
      this.playHtmlAudio(this.standUpAudio);
      return;
    }

    const ctx = this.getContext();
    if (!ctx) return;

    try {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(659.25, now);
      osc.frequency.exponentialRampToValueAtTime(440.0, now + 0.3);

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.16, now + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.45);
    } catch (e) {
      console.warn('Audio play failed:', e);
    }
  }

  /**
   * Ergonomic break reminder bell (warm chime with gentle harmonics)
   */
  public playBreakReminder(): void {
    if (!this.soundEnabled) return;

    if (this.breakAudio) {
      this.playHtmlAudio(this.breakAudio);
      return;
    }

    const ctx = this.getContext();
    if (!ctx) return;

    try {
      const now = ctx.currentTime;
      [0, 0.22, 0.44].forEach((delay, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(idx === 2 ? 880 : 784, now + delay);

        gain.gain.setValueAtTime(0.001, now + delay);
        gain.gain.linearRampToValueAtTime(0.2, now + delay + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, now + delay + 0.3);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + delay);
        osc.stop(now + delay + 0.3);
      });
    } catch (e) {
      console.warn('Audio play failed:', e);
    }
  }
}

export const soundManager = new SoundController();
