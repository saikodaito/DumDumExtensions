// Voice Blips: turning an audio file into a small blip sample.
// Exposed as dd.shared.codec.
//
// Two groups per character, vowels (v) and consonants (c), up to 8 samples each,
// 160 KB in total (measured as the stored data URI). The samples live in
// the extension storage for that character: they never leave the device (not
// in exported cards, not in backups).

const MAX_ITEMS = 8, MAX_BYTES = 160 * 1024;

function voiceBytes(samples) {
    if (!samples) return 0;
    return [...(samples.v || []), ...(samples.c || [])].reduce((s, u) => s + String(u).length, 0);
}
function toB64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
}
function uriBytes(uri) {
    const bin = atob(uri.slice(uri.indexOf(',') + 1));
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
}

/** 16-bit PCM WAV, mono, 22,050 Hz (fallback for when Opus is not available). */
async function toWav(x, sr) {
    const target = 22050, n = Math.max(1, Math.ceil(x.length * target / sr));
    const off = new OfflineAudioContext(1, n, target);
    const b = off.createBuffer(1, x.length, sr); b.copyToChannel(x, 0);
    const s = off.createBufferSource(); s.buffer = b; s.connect(off.destination); s.start();
    const r = (await off.startRendering()).getChannelData(0);
    const dv = new DataView(new ArrayBuffer(44 + r.length * 2));
    const str = (o, s2) => { for (let i = 0; i < s2.length; i++) dv.setUint8(o + i, s2.charCodeAt(i)); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + r.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, target, true); dv.setUint32(28, target * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    str(36, 'data'); dv.setUint32(40, r.length * 2, true);
    for (let i = 0; i < r.length; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, r[i])) * 0x7fff, true);
    return 'data:audio/wav;base64,' + toB64(new Uint8Array(dv.buffer));
}

// Ogg CRC: polynomial 0x04C11DB7, no reflection, initial value 0.
let crcTable = null;
function oggCrc(u8) {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let i = 0; i < 256; i++) { let r = i << 24; for (let k = 0; k < 8; k++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1); crcTable[i] = r >>> 0; }
    }
    let c = 0;
    for (let i = 0; i < u8.length; i++) c = ((c << 8) ^ crcTable[((c >>> 24) ^ u8[i]) & 0xff]) >>> 0;
    return c >>> 0;
}
/** One Ogg page with the given packets (flags: 2 = first, 4 = last). */
function oggPage(packets, granule, seq, flags) {
    const seg = [];
    for (const p of packets) { let n = p.length; while (n >= 255) { seg.push(255); n -= 255; } seg.push(n); }
    const bodyLen = packets.reduce((s, p) => s + p.length, 0);
    const u8 = new Uint8Array(27 + seg.length + bodyLen), dv = new DataView(u8.buffer);
    u8.set([0x4f, 0x67, 0x67, 0x53], 0);                  // "OggS"
    u8[5] = flags;
    dv.setUint32(6, granule >>> 0, true); dv.setUint32(10, Math.floor(granule / 4294967296), true);
    dv.setUint32(14, 0x44446c62, true);                    // fixed serial number
    dv.setUint32(18, seq, true);
    u8[26] = seg.length; u8.set(seg, 27);
    let o = 27 + seg.length;
    for (const p of packets) { u8.set(p, o); o += p.length; }
    dv.setUint32(22, oggCrc(u8), true);
    return u8;
}
async function toOpus(x, sr) {
    if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return null;
    const cfg = { codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 32000 };
    try { const s = await AudioEncoder.isConfigSupported(cfg); if (!s || !s.supported) return null; } catch (e) { return null; }
    // Opus is 48 kHz; 20 ms of silence at the end closes the last frame.
    const n48 = Math.ceil(x.length * 48000 / sr) + 960;
    const off = new OfflineAudioContext(1, n48, 48000);
    const b = off.createBuffer(1, x.length, sr); b.copyToChannel(x, 0);
    const s0 = off.createBufferSource(); s0.buffer = b; s0.connect(off.destination); s0.start();
    const y = (await off.startRendering()).getChannelData(0);
    const packets = [];
    let failure = null;
    const enc = new AudioEncoder({
        output: (chunk) => { const u = new Uint8Array(chunk.byteLength); chunk.copyTo(u); packets.push(u); },
        error: (e) => { failure = e; },
    });
    enc.configure(cfg);
    const ad = new AudioData({ format: 'f32', sampleRate: 48000, numberOfFrames: y.length, numberOfChannels: 1, timestamp: 0, data: y });
    enc.encode(ad); ad.close();
    await enc.flush();
    try { enc.close(); } catch (e) { /* already closed */ }
    if (failure || !packets.length || packets.length > 255) return null;
    const head = new Uint8Array(19), hv = new DataView(head.buffer);
    head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0);   // "OpusHead"
    head[8] = 1; head[9] = 1;                                          // version, channels
    hv.setUint16(10, 0, true);                                         // pre-skip 0: the player skips the leading silence
    hv.setUint32(12, 48000, true);
    const vendor = [0x64, 0x64];                                       // "dd"
    const tags = new Uint8Array(8 + 4 + vendor.length + 4);
    tags.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73], 0);    // "OpusTags"
    new DataView(tags.buffer).setUint32(8, vendor.length, true);
    tags.set(vendor, 12);
    const pages = [
        oggPage([head], 0, 0, 2),
        oggPage([tags], 0, 1, 0),
        oggPage(packets, y.length, 2, 4),
    ];
    const total = pages.reduce((s, p) => s + p.length, 0), u8 = new Uint8Array(total);
    let o = 0; for (const p of pages) { u8.set(p, o); o += p.length; }
    const uri = 'data:audio/ogg;base64,' + toB64(u8);
    // Only good if it decodes back.
    try { await new OfflineAudioContext(1, 1, 48000).decodeAudioData(uriBytes(uri).buffer); }
    catch (e) { return null; }
    return uri;
}

/** Any audio file at most 0.5s, throws when the file is not audio. */
async function compress(file) {
    if (!file || file.size > 20 * 1024 * 1024) throw new Error('too big');
    const buf = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await file.arrayBuffer());
    const sr = buf.sampleRate, n0 = buf.length, nc = buf.numberOfChannels;
    const mono = new Float32Array(n0);
    for (let c = 0; c < nc; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n0; i++) mono[i] += d[i] / nc; }
    let pk = 0;
    for (let i = 0; i < n0; i++) { const v = Math.abs(mono[i]); if (v > pk) pk = v; }
    if (pk < 1e-4) throw new Error('silent');
    // Silence at the edges: 45 dB below the peak.
    const thr = pk * Math.pow(10, -45 / 20);
    let i0 = 0; while (i0 < n0 && Math.abs(mono[i0]) < thr) i0++;
    let i1 = n0 - 1; while (i1 > i0 && Math.abs(mono[i1]) < thr) i1--;
    i0 = Math.max(0, i0 - Math.floor(0.002 * sr));
    const len = Math.max(1, Math.min(i1 - i0 + 1, Math.floor(0.5 * sr)));
    const x = mono.slice(i0, i0 + len);
    const fadeIn = Math.min(len, Math.floor(0.002 * sr)), fadeOut = Math.min(len, Math.floor(0.010 * sr));
    for (let i = 0; i < fadeIn; i++) x[i] *= i / fadeIn;
    for (let i = 0; i < fadeOut; i++) x[len - 1 - i] *= i / fadeOut;
    // Loudness: same rule as the synthesis (RMS 0.1 over the 25 ms attack, peak <= 0.9).
    const win = Math.min(len, Math.floor(0.025 * sr));
    let sq = 0, pk2 = 0;
    for (let i = 0; i < len; i++) { const v = Math.abs(x[i]); if (v > pk2) pk2 = v; if (i < win) sq += x[i] * x[i]; }
    const rms = Math.sqrt(sq / win) || pk2;
    const gain = Math.min(0.1 / Math.max(1e-6, rms), 0.9 / Math.max(1e-6, pk2));
    for (let i = 0; i < len; i++) x[i] *= gain;
    let uri = null;
    try { uri = await toOpus(x, sr); } catch (e) { uri = null; }
    if (!uri) uri = await toWav(x, sr);
    return { uri, ms: Math.round(len / sr * 1000), bytes: uri.length };
}

dd.shared.codec = { MAX_ITEMS, MAX_BYTES, voiceBytes, uriBytes, compress };
