// The speech probe requests WAV. A MIME header or arbitrary base64 is not
// evidence that the provider actually returned playable audio.
export function isPcmWav(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value || '');
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' ||
      bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.toString('ascii', 12, 16) !== 'fmt ') return false;
  const declaredSize = bytes.readUInt32LE(4) + 8;
  const formatSize = bytes.readUInt32LE(16);
  const codec = bytes.readUInt16LE(20);
  const channels = bytes.readUInt16LE(22);
  const sampleRate = bytes.readUInt32LE(24);
  return declaredSize <= bytes.length && formatSize >= 16 &&
    (codec === 1 || codec === 3) && channels >= 1 && channels <= 8 &&
    sampleRate >= 8000 && sampleRate <= 192000 && bytes.includes(Buffer.from('data'), 36);
}

// This checks the declared container signature before a result is persisted.
// It is a corruption guard, not a full decoder or playback test.
export function hasAudioContainer(value, format) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value || '');
  if (format === 'wav') return isPcmWav(bytes);
  if (bytes.length < 16) return false;
  if (format === 'flac') return bytes.toString('ascii', 0, 4) === 'fLaC';
  if (format === 'ogg') return bytes.toString('ascii', 0, 4) === 'OggS';
  if (format === 'm4a') return bytes.toString('ascii', 4, 8) === 'ftyp' &&
    bytes.readUInt32BE(0) >= 16 && bytes.readUInt32BE(0) <= bytes.length;
  if (format === 'aac') return bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
  if (format === 'mp3') return bytes.toString('ascii', 0, 3) === 'ID3' ||
    (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x18) !== 0x08);
  return false;
}
