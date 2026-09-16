import { useEffect, useRef, useState } from 'react';
import {
  MAX_INPUT_VOLUME,
  canChooseSpeaker,
  setMediaPreferences,
  useMediaDevices,
  useMediaPreferences,
} from '../lib/mediaPreferences';
import { cx } from '../lib/util';
import Icon, { type IconName } from './Icon';
import { FIELD, Section } from './SettingsParts';
import { useToast } from './Toast';
import { Button } from './ui';

/**
 * Microphone, speaker and camera choices and the two volume levels for calls.
 * The call reads them as they change, so adjusting them mid-call takes effect
 * without rejoining.
 */
export default function VoiceSettings() {
  const preferences = useMediaPreferences();
  const { devices, labelled, requestAccess } = useMediaDevices();
  const toast = useToast();
  const [asking, setAsking] = useState(false);

  // Chromium also lists "default" and "communications" aliases of real
  // devices; the empty choice already stands for the system default.
  const devicesOf = (kind: MediaDeviceKind) =>
    devices.filter(
      (d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications',
    );

  async function allowAccess() {
    setAsking(true);
    try {
      await requestAccess();
    } catch {
      toast('Access to the microphone was refused. Allow it in your system settings, then try again.', 'error');
    } finally {
      setAsking(false);
    }
  }

  return (
    <>
      <Section title="Devices">
        {!labelled && (
          <div className="mb-3 flex items-center gap-2 rounded-md bg-[var(--color-surface)] px-3 py-2 text-xs">
            <Icon name="shield-lock" className="text-[var(--color-muted)]" />
            <span className="flex-1">
              Device names stay hidden until ParaDOCs is allowed to use your microphone and camera.
            </span>
            <Button variant="subtle" className="shrink-0 text-xs" disabled={asking} onClick={allowAccess}>
              Allow access
            </Button>
          </div>
        )}
        <div className="space-y-2">
          <DeviceSelect
            label="Microphone"
            icon="mic"
            devices={devicesOf('audioinput')}
            labelled={labelled}
            value={preferences.microphoneId}
            onChange={(microphoneId) => setMediaPreferences({ microphoneId })}
          />
          {canChooseSpeaker ? (
            <DeviceSelect
              label="Speakers"
              icon="volume-up"
              devices={devicesOf('audiooutput')}
              labelled={labelled}
              value={preferences.speakerId}
              onChange={(speakerId) => setMediaPreferences({ speakerId })}
            />
          ) : (
            <p className="text-xs text-[var(--color-muted)]">
              This browser always plays call audio through the system output device.
            </p>
          )}
          <div>
            <DeviceSelect
              label="Camera"
              icon="camera-video"
              devices={devicesOf('videoinput')}
              labelled={labelled}
              value={preferences.cameraId}
              onChange={(cameraId) => setMediaPreferences({ cameraId })}
            />
            <CameraPreview deviceId={preferences.cameraId} />
          </div>
        </div>
      </Section>

      <Section title="Volume">
        <div className="space-y-4">
          <div>
            <LevelSlider
              label="Input volume"
              icon="mic"
              value={preferences.inputVolume}
              max={MAX_INPUT_VOLUME}
              onChange={(inputVolume) => setMediaPreferences({ inputVolume })}
            />
            <MicrophoneTest deviceId={preferences.microphoneId} volume={preferences.inputVolume} />
          </div>
          <div>
            <LevelSlider
              label="Output volume"
              icon="volume-up"
              value={preferences.outputVolume}
              max={100}
              onChange={(outputVolume) => setMediaPreferences({ outputVolume })}
            />
            <SpeakerTest deviceId={preferences.speakerId} volume={preferences.outputVolume} />
          </div>
        </div>
      </Section>
    </>
  );
}

function DeviceSelect({
  label,
  icon,
  devices,
  labelled,
  value,
  onChange,
}: {
  label: string;
  icon: IconName;
  devices: MediaDeviceInfo[];
  labelled: boolean;
  value: string;
  onChange: (deviceId: string) => void;
}) {
  const saved = value !== '' && !devices.some((d) => d.deviceId === value);
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
        <Icon name={icon} /> {label}
      </span>
      <select className={FIELD} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">System default</option>
        {devices.map((device, index) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label || `${label} ${index + 1}`}
          </option>
        ))}
        {/* An unplugged device stays chosen, so plugging it back in restores it;
            calls use the system default meanwhile. */}
        {saved && (
          <option value={value}>{labelled ? 'Not connected — using the system default' : 'Saved device'}</option>
        )}
      </select>
    </label>
  );
}

/**
 * The chosen camera, mirrored the way a call shows your own picture. Off until
 * asked for, so opening settings does not switch the camera light on.
 */
function CameraPreview({ deviceId }: { deviceId: string }) {
  const [on, setOn] = useState(false);
  const [starting, setStarting] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const toast = useToast();

  useEffect(() => {
    if (!on) return;
    let cancelled = false;
    let stream: MediaStream | undefined;
    const video = videoRef.current;
    setStarting(true);

    navigator.mediaDevices
      .getUserMedia({ video: deviceId ? { deviceId: { ideal: deviceId } } : true })
      .then((opened) => {
        stream = opened;
        if (cancelled) {
          opened.getTracks().forEach((track) => track.stop());
          return;
        }
        if (video) video.srcObject = opened;
      })
      .catch((err) => {
        if (cancelled) return;
        toast(err instanceof Error ? err.message : 'Could not open the camera', 'error');
        setOn(false);
      })
      .finally(() => {
        if (!cancelled) setStarting(false);
      });

    // Switching camera while previewing restarts it with the new one.
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((track) => track.stop());
      if (video) video.srcObject = null;
      setStarting(false);
    };
  }, [on, deviceId, toast]);

  return (
    <div className="mt-2">
      <Button variant="subtle" className="text-xs" aria-pressed={on} onClick={() => setOn((value) => !value)}>
        <Icon name={on ? 'camera-video-off' : 'camera-video'} /> {on ? 'Hide preview' : 'Show preview'}
      </Button>
      {on && (
        <div className="relative mt-2 aspect-video w-full max-w-sm overflow-hidden rounded-lg bg-black">
          <video ref={videoRef} autoPlay playsInline muted className="h-full w-full scale-x-[-1] object-contain" />
          {starting && (
            <span className="absolute inset-0 grid place-items-center text-xs text-white/70">Starting camera…</span>
          )}
        </div>
      )}
    </div>
  );
}

function LevelSlider({
  label,
  icon,
  value,
  max,
  onChange,
}: {
  label: string;
  icon: IconName;
  value: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center justify-between text-xs text-[var(--color-muted)]">
        <span className="flex items-center gap-1.5">
          <Icon name={icon} /> {label}
        </span>
        <span className="tabular-nums">{value}%</span>
      </span>
      <input
        type="range"
        min={0}
        max={max}
        step={5}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[var(--color-accent)]"
      />
    </label>
  );
}

/**
 * A live level meter for the chosen microphone at the chosen volume, so the
 * slider can be set by watching the bar rather than by asking someone on a call.
 */
function MicrophoneTest({ deviceId, volume }: { deviceId: string; volume: number }) {
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const gainRef = useRef<GainNode | null>(null);
  const toast = useToast();

  // Volume is applied to the running test rather than restarting it.
  useEffect(() => {
    if (gainRef.current) gainRef.current.gain.value = volume / 100;
  }, [volume]);

  useEffect(() => {
    if (!testing) return;
    let cancelled = false;
    let frame = 0;
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { ideal: deviceId } } : true,
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        context = new AudioContext();
        const source = context.createMediaStreamSource(stream);
        const gain = context.createGain();
        gain.gain.value = volume / 100;
        gainRef.current = gain;
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(gain).connect(analyser);

        const samples = new Float32Array(analyser.fftSize);
        const tick = () => {
          analyser.getFloatTimeDomainData(samples);
          let sum = 0;
          for (const sample of samples) sum += sample * sample;
          // The square root of the RMS reads closer to how loud speech sounds,
          // so ordinary talking fills most of the bar instead of a sliver.
          setLevel(Math.min(1, Math.sqrt(Math.sqrt(sum / samples.length)) * 2));
          frame = requestAnimationFrame(tick);
        };
        tick();
      } catch (err) {
        if (cancelled) return;
        toast(err instanceof Error ? err.message : 'Could not open the microphone', 'error');
        setTesting(false);
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close();
      gainRef.current = null;
      setLevel(0);
    };
    // Volume is left out on purpose: the effect above adjusts the live gain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testing, deviceId, toast]);

  return (
    <div className="mt-2 flex items-center gap-2">
      <Button variant="subtle" className="shrink-0 text-xs" onClick={() => setTesting((on) => !on)}>
        <Icon name={testing ? 'stop-fill' : 'mic'} /> {testing ? 'Stop test' : 'Test microphone'}
      </Button>
      <div
        role="meter"
        aria-label="Microphone level"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(level * 100)}
        className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--color-surface)]"
      >
        <div
          className={cx('h-full rounded-full', level >= 0.95 ? 'bg-red-500' : 'bg-emerald-500')}
          style={{ width: `${level * 100}%` }}
        />
      </div>
    </div>
  );
}

/** Plays a short chime through the chosen output at the chosen volume. */
function SpeakerTest({ deviceId, volume }: { deviceId: string; volume: number }) {
  const [playing, setPlaying] = useState(false);
  const toast = useToast();

  async function play() {
    setPlaying(true);
    const context = new AudioContext();
    try {
      const destination = context.createMediaStreamDestination();
      // Two rising notes with a soft attack and release, not a harsh beep.
      [523.25, 783.99].forEach((frequency, index) => {
        const start = context.currentTime + index * 0.18;
        const oscillator = context.createOscillator();
        const envelope = context.createGain();
        oscillator.frequency.value = frequency;
        envelope.gain.setValueAtTime(0, start);
        envelope.gain.linearRampToValueAtTime(0.4, start + 0.02);
        envelope.gain.exponentialRampToValueAtTime(0.001, start + 0.5);
        oscillator.connect(envelope).connect(destination);
        oscillator.start(start);
        oscillator.stop(start + 0.5);
      });

      // Played through an element, as call audio is, because an element is what
      // can be pointed at a device and carries the same volume control.
      const element = new Audio() as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      element.srcObject = destination.stream;
      element.volume = volume / 100;
      if (deviceId && element.setSinkId) await element.setSinkId(deviceId);
      await element.play();
      await new Promise((resolve) => setTimeout(resolve, 800));
      element.pause();
      element.srcObject = null;
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not play the test sound', 'error');
    } finally {
      void context.close();
      setPlaying(false);
    }
  }

  return (
    <Button variant="subtle" className="mt-2 text-xs" disabled={playing} onClick={() => void play()}>
      <Icon name="play-fill" /> {playing ? 'Playing…' : 'Play test sound'}
    </Button>
  );
}
