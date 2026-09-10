import type { AudioProcessorOptions, Track, TrackProcessor } from 'livekit-client';

/**
 * Scales the microphone before it is sent, for the input volume setting.
 *
 * LiveKit hands a processor the raw microphone track and publishes whatever
 * `processedTrack` it exposes instead. When the microphone is switched it
 * restarts the processor with the new track but without an audio context, so
 * the context from the first init is kept for that.
 */
export class InputGainProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = 'paradocs-input-gain';
  processedTrack?: MediaStreamTrack;

  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private gain?: GainNode;

  constructor(private level: number) {}

  async init(options: AudioProcessorOptions) {
    this.context = options.audioContext ?? this.context;
    if (!this.context) throw new Error('Input volume needs an audio context');

    this.source = this.context.createMediaStreamSource(new MediaStream([options.track]));
    this.gain = this.context.createGain();
    this.gain.gain.value = this.level;
    const destination = this.context.createMediaStreamDestination();
    this.source.connect(this.gain).connect(destination);
    this.processedTrack = destination.stream.getAudioTracks()[0];
  }

  async restart(options: AudioProcessorOptions) {
    await this.destroy();
    await this.init(options);
  }

  async destroy() {
    this.source?.disconnect();
    this.gain?.disconnect();
    this.processedTrack?.stop();
    this.source = undefined;
    this.gain = undefined;
    this.processedTrack = undefined;
  }

  /** Applied to the running graph, so dragging the slider is heard at once. */
  setLevel(level: number) {
    this.level = level;
    if (this.gain) this.gain.gain.value = level;
  }
}
