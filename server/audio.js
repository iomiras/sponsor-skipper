const { WaveFile } = require('wavefile');

const WHISPER_SAMPLE_RATE = 16000;

function decodeAudio(pcmBase64, sampleRate) {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error('sampleRate must be a positive integer');
  }
  const bytes = Buffer.from(pcmBase64, 'base64');
  if (bytes.length === 0 || bytes.length % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error('PCM must contain a non-empty sequence of float32 samples');
  }
  // Copy into an aligned buffer; pooled Node buffers may have a byte offset.
  const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  if (!samples.every(Number.isFinite)) throw new Error('PCM contains non-finite samples');
  const duration = samples.length / sampleRate;
  if (sampleRate === WHISPER_SAMPLE_RATE) return { samples, duration };

  // Transformers.js does not resample Float32Array inputs. Convert explicitly,
  // with a low-pass filter to prevent aliasing when downsampling browser audio.
  const wav = new WaveFile();
  wav.fromScratch(1, sampleRate, '32f', samples);
  wav.toSampleRate(WHISPER_SAMPLE_RATE, { method: 'sinc', LPF: true });
  return { samples: wav.getSamples(false, Float32Array), duration };
}

module.exports = { decodeAudio, WHISPER_SAMPLE_RATE };
