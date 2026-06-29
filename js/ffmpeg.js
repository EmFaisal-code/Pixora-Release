/**
 * Pixora FFmpeg Module — Quality Method V2 Implementation
 *
 * ARSITEKTUR v2.1:
 * - FFmpeg v0.12.x (Worker-based) — cocok dengan WASM dari CuteFish
 * - Assets FFmpeg di-bundle lokal di assets/ffmpeg/
 * - Library: ffmpeg-wasm.js (FFmpegWASM.FFmpeg) + ffmpeg-util.js (FFmpegUtil)
 * - Worker: 814.ffmpeg.js (auto-loaded oleh ffmpeg-wasm.js)
 *
 * Pipeline:
 * 1. FFmpegBridge: Load & compress via FFmpeg v0.12.x
 * 2. Full MP4 atom patching (mdhd, elst, stts, stsz, stsc, stco + fake samples)
 *
 * Based on cutefish Quality Method V2 algorithm.
 */

const FFmpegBridge = {
    // Kompatibel dengan panel.js yang panggil FFmpegBridge.init()
    init() {
        return Promise.resolve();
    },

    isReady() {
        return true;
    },

    // ── Helper IndexedDB ──
    _saveToIndexedDB(id, buffer) {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('PixoraVideoDB', 1);
            req.onupgradeneeded = e => e.target.result.createObjectStore('videos');
            req.onsuccess = e => {
                const db = e.target.result;
                const tx = db.transaction('videos', 'readwrite');
                const putReq = tx.objectStore('videos').put(buffer, id);
                putReq.onsuccess = () => resolve();
                putReq.onerror = () => reject(putReq.error);
            };
            req.onerror = e => reject(e.target.error);
        });
    },

    _getFromIndexedDB(id) {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('PixoraVideoDB', 1);
            req.onupgradeneeded = e => e.target.result.createObjectStore('videos');
            req.onsuccess = e => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('videos')) return resolve(null);
                const tx = db.transaction('videos', 'readonly');
                const getReq = tx.objectStore('videos').get(id);
                getReq.onsuccess = () => resolve(getReq.result);
                getReq.onerror = () => reject(getReq.error);
            };
            req.onerror = e => reject(e.target.error);
        });
    },

    _deleteFromIndexedDB(id) {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('PixoraVideoDB', 1);
            req.onsuccess = e => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('videos')) return resolve();
                const tx = db.transaction('videos', 'readwrite');
                const delReq = tx.objectStore('videos').delete(id);
                delReq.onsuccess = () => resolve();
                delReq.onerror = () => reject(delReq.error);
            };
        });
    },

    async compress(arrayBuffer, progressCb) {
        if (progressCb) progressCb(1, 'Menyiapkan proses kompresi background...');
        
        const videoId = 'vid_' + Date.now();
        
        // 1. Simpan input ke IndexedDB
        await this._saveToIndexedDB(videoId, arrayBuffer);

        // 2. Minta background script (core.js) untuk menjalankan Offscreen Document
        return new Promise((resolve, reject) => {
            const listener = (msg) => {
                if (msg.type === 'FFMPEG_PROGRESS' && msg.id === videoId) {
                    if (progressCb) progressCb(msg.progress, msg.status);
                } 
                else if (msg.type === 'FFMPEG_DONE' && msg.id === videoId) {
                    chrome.runtime.onMessage.removeListener(listener);
                    // 3. Ambil output dari IndexedDB
                    this._getFromIndexedDB(videoId + '_out').then(async (outBuffer) => {
                        await this._deleteFromIndexedDB(videoId + '_out'); // cleanup
                        if (!outBuffer || outBuffer.byteLength < 1024) {
                            reject(new Error('Output kosong atau rusak. Coba format video MP4 yang berbeda.'));
                        } else {
                            resolve(outBuffer);
                        }
                    }).catch(reject);
                } 
                else if (msg.type === 'FFMPEG_ERROR' && msg.id === videoId) {
                    chrome.runtime.onMessage.removeListener(listener);
                    this._deleteFromIndexedDB(videoId).catch(()=>{});
                    reject(new Error(msg.error));
                }
            };
            
            chrome.runtime.onMessage.addListener(listener);
            chrome.runtime.sendMessage({ type: 'START_FFMPEG_BG', id: videoId }, (res) => {
                if (chrome.runtime.lastError) {
                    chrome.runtime.onMessage.removeListener(listener);
                    this._deleteFromIndexedDB(videoId).catch(()=>{});
                    reject(new Error('Koneksi ke background processing gagal. Silakan muat ulang ekstensi.'));
                }
            });
        });
    }
};


// ═══ MP4 BOX PARSER ═══

const CONTAINER_TYPES = new Set(['moov','trak','mdia','minf','stbl','edts','dinf','udta','meta','ilst']);
const FAKE_SAMPLE_COUNT = 8573;
const FAKE_SAMPLE_SIZE = 8;

const VIDEO_TIMESCALE = 90000;
const VIDEO_DURATION = 2269500;
const VIDEO_EDIT_MEDIA_TIME = 3000;
const VIDEO_SAMPLE_DELTA = 1500; // 90000/60fps

function readBox(u8, offset, end) {
    if (offset + 8 > end) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let size = dv.getUint32(offset, false);
    let headerSize = 8;
    if (size === 1 && offset + 16 <= end) {
        // Extended size (64-bit)
        size = Number(dv.getBigUint64(offset + 8, false));
        headerSize = 16;
    } else if (size === 0) {
        size = end - offset;
    }
    if (size < headerSize || offset + size > end) return null;
    const type = String.fromCharCode(u8[offset+4], u8[offset+5], u8[offset+6], u8[offset+7]);
    return { type, offset, size, headerSize, dataOffset: offset + headerSize, dataEnd: offset + size };
}

function parseChildren(u8, parentOffset, parentSize, headerSize) {
    const children = [];
    const start = parentOffset + headerSize;
    const end = parentOffset + parentSize;
    let pos = start;
    while (pos < end - 7) {
        const box = readBox(u8, pos, end);
        if (!box) break;
        if (CONTAINER_TYPES.has(box.type)) {
            box.children = parseChildren(u8, box.offset, box.size, box.headerSize);
        }
        children.push(box);
        pos += box.size;
    }
    return children;
}

function findChild(children, type) {
    return children.find(c => c.type === type) || null;
}

function findDescendant(box, types) {
    let current = box;
    for (const t of types) {
        if (!current || !current.children) return null;
        current = findChild(current.children, t);
    }
    return current;
}

function handlerTypeForTrak(u8, trak) {
    const mdia = findDescendant(trak, ['mdia']);
    if (!mdia) return null;
    const hdlr = findChild(mdia.children, 'hdlr');
    if (!hdlr || hdlr.size < 20) return null;
    // handler_type is at offset 16 from box start (8 header + 4 version/flags + 4 pre_defined + 4 handler_type)
    return String.fromCharCode(u8[hdlr.offset + 16], u8[hdlr.offset + 17], u8[hdlr.offset + 18], u8[hdlr.offset + 19]);
}

// ═══ ATOM PARSERS ═══

function parseStsz(u8, stsz) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const off = stsz.offset;
    const sampleSize = dv.getUint32(off + 12, false);
    const sampleCount = dv.getUint32(off + 16, false);
    const sizes = [];
    if (sampleSize !== 0) {
        for (let i = 0; i < sampleCount; i++) sizes.push(sampleSize);
    } else {
        for (let i = 0; i < sampleCount; i++) {
            sizes.push(dv.getUint32(off + 20 + i * 4, false));
        }
    }
    return { sampleSize, sampleCount, sizes };
}

function parseStco(u8, stco) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const count = dv.getUint32(stco.offset + 12, false);
    const offsets = [];
    for (let i = 0; i < count; i++) {
        offsets.push(dv.getUint32(stco.offset + 16 + i * 4, false));
    }
    return { count, offsets };
}

function parseStsc(u8, stsc) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const count = dv.getUint32(stsc.offset + 12, false);
    const rows = [];
    for (let i = 0; i < count; i++) {
        const base = stsc.offset + 16 + i * 12;
        rows.push([
            dv.getUint32(base, false),      // first_chunk
            dv.getUint32(base + 4, false),   // samples_per_chunk
            dv.getUint32(base + 8, false),   // sample_description_index
        ]);
    }
    return { count, rows };
}

// ═══ ATOM BUILDERS ═══

function makeBox(type, data) {
    const size = 8 + data.length;
    const box = new Uint8Array(size);
    const dv = new DataView(box.buffer);
    dv.setUint32(0, size, false);
    box[4] = type.charCodeAt(0); box[5] = type.charCodeAt(1);
    box[6] = type.charCodeAt(2); box[7] = type.charCodeAt(3);
    box.set(data, 8);
    return box;
}

function concatBytes(...arrays) {
    const totalLen = arrays.reduce((sum, a) => sum + a.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const a of arrays) { result.set(a, offset); offset += a.length; }
    return result;
}

function writeUint32BE(val) {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, val, false);
    return buf;
}

function buildMdhd(originalU8, mdhdBox) {
    // IMPORTANT: preserve original timescale and duration!
    // Overwriting with hardcoded values corrupts timestamps → degraded transcode output
    const ver = originalU8[mdhdBox.offset + 8];
    if (ver === 0) {
        const data = originalU8.slice(mdhdBox.dataOffset, mdhdBox.dataEnd);
        // READ existing timescale/duration from original (do NOT overwrite)
        // Fake samples have delta=1500 at 90000 timescale — but since we're preserving
        // original timescale, the fake sample timing will be relative to original timescale.
        // mdhd duration must cover real samples + fake samples:
        //   real_duration = original value (preserved)
        //   We only extend if we're adding fake time (fake samples with delta)
        // For now: preserve mdhd entirely to avoid corruption
        return makeBox('mdhd', data);
    } else {
        const data = originalU8.slice(mdhdBox.dataOffset, mdhdBox.dataEnd);
        return makeBox('mdhd', data);
    }
}

function buildElst(originalU8, elstBox) {
    const data = originalU8.slice(elstBox.dataOffset, elstBox.dataEnd);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const ver = data[0];
    if (ver === 0 && data.length >= 16) {
        // entry at data[8]: segment_duration(4) + media_time(4)
        dv.setUint32(12, VIDEO_EDIT_MEDIA_TIME, false);
    }
    return makeBox('elst', data);
}

function buildSttsV1(realSampleCount, realSampleDelta) {
    // Use REAL sample delta from original video to avoid timing corruption
    const delta = realSampleDelta || VIDEO_SAMPLE_DELTA;
    const data = new Uint8Array(4 + 4 + 2 * 8); // version/flags + count + 2 entries
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    dv.setUint32(4, 2, false);                        // entry_count
    dv.setUint32(8, realSampleCount, false);           // entry 1: count
    dv.setUint32(12, delta, false);                    // entry 1: delta (REAL)
    dv.setUint32(16, FAKE_SAMPLE_COUNT, false);        // entry 2: count
    dv.setUint32(20, delta, false);                    // entry 2: delta (REAL)
    return makeBox('stts', data);
}

function buildStsz(originalSizes) {
    const totalCount = originalSizes.length + FAKE_SAMPLE_COUNT;
    const data = new Uint8Array(4 + 4 + 4 + totalCount * 4); // ver/flags + sampleSize + count + entries
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    dv.setUint32(4, 0, false);                        // sampleSize = 0 (variable)
    dv.setUint32(8, totalCount, false);               // sample_count
    // Original sizes
    for (let i = 0; i < originalSizes.length; i++) {
        dv.setUint32(12 + i * 4, originalSizes[i], false);
    }
    // Fake sample sizes (8 bytes each)
    const fakeOff = 12 + originalSizes.length * 4;
    for (let i = 0; i < FAKE_SAMPLE_COUNT; i++) {
        dv.setUint32(fakeOff + i * 4, FAKE_SAMPLE_SIZE, false);
    }
    return makeBox('stsz', data);
}

function buildStsc(originalRows, originalChunkCount) {
    const rows = [...originalRows];
    // Add new entry for the fake chunk if last row doesn't already have 1 sample/chunk
    const lastRow = rows[rows.length - 1];
    if (!lastRow || lastRow[1] !== 1) {
        rows.push([originalChunkCount + 1, 1, 1]);
    }
    const data = new Uint8Array(4 + 4 + rows.length * 12); // ver/flags + count + entries
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    dv.setUint32(4, rows.length, false);
    for (let i = 0; i < rows.length; i++) {
        dv.setUint32(8 + i * 12, rows[i][0], false);
        dv.setUint32(12 + i * 12, rows[i][1], false);
        dv.setUint32(16 + i * 12, rows[i][2], false);
    }
    return makeBox('stsc', data);
}

function buildStco(originalOffsets, delta, fakeOffset) {
    const hasFake = fakeOffset !== null && fakeOffset !== undefined;
    const totalCount = originalOffsets.length + (hasFake ? FAKE_SAMPLE_COUNT : 0);
    const data = new Uint8Array(4 + 4 + totalCount * 4); // ver/flags + count + entries
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    dv.setUint32(4, totalCount, false);
    for (let i = 0; i < originalOffsets.length; i++) {
        dv.setUint32(8 + i * 4, originalOffsets[i] + delta, false);
    }
    if (hasFake) {
        const baseOff = 8 + originalOffsets.length * 4;
        for (let i = 0; i < FAKE_SAMPLE_COUNT; i++) {
            dv.setUint32(baseOff + i * 4, fakeOffset, false);
        }
    }
    return makeBox('stco', data);
}

// ═══ BOX REBUILD ENGINE ═══

function rebuildBox(box, originalU8, replacements) {
    if (replacements.has(box)) {
        return replacements.get(box);
    }
    if (!box.children || box.children.length === 0) {
        // Leaf box — return original bytes
        return originalU8.slice(box.offset, box.offset + box.size);
    }
    // Container box — rebuild from children
    const childBytes = box.children.map(child => rebuildBox(child, originalU8, replacements));
    const content = concatBytes(...childBytes);
    const result = makeBox(box.type, content);
    return result;
}

// Collect ALL stco boxes across ALL tracks in moov
function collectAllStco(u8, moov) {
    const stcoBoxes = [];
    function walk(box) {
        if (!box.children) return;
        for (const child of box.children) {
            if (child.type === 'stco') stcoBoxes.push(child);
            walk(child);
        }
    }
    walk(moov);
    return stcoBoxes;
}

// Build stco replacements for ALL tracks
function buildStcoReplacements(u8, stcoBoxes, videoStco, delta, fakeOffset) {
    const map = new Map();
    for (const stco of stcoBoxes) {
        const stcoData = parseStco(u8, stco);
        // Only video track stco gets fake samples appended
        const isFake = (stco === videoStco) ? fakeOffset : null;
        map.set(stco, buildStcoDynamic(stcoData.offsets, delta, isFake)); // Change to use buildStcoDynamic that will be defined later
    }
    return map;
}

// V2-specific version that accepts explicit fakeCount to avoid using global FAKE_SAMPLE_COUNT
function buildStcoReplacementsV2(u8, stcoBoxes, videoStco, delta, fakeOffset, fakeCount) {
    const map = new Map();
    for (const stco of stcoBoxes) {
        const stcoData = parseStco(u8, stco);
        const isFake = (stco === videoStco) ? fakeOffset : null;
        // Build stco with explicit fakeCount
        const hasFake = isFake !== null && isFake !== undefined;
        const totalCount = stcoData.offsets.length + (hasFake ? fakeCount : 0);
        const data = new Uint8Array(4 + 4 + totalCount * 4);
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        dv.setUint32(4, totalCount, false);
        for (let i = 0; i < stcoData.offsets.length; i++) {
            dv.setUint32(8 + i * 4, stcoData.offsets[i] + delta, false);
        }
        if (hasFake) {
            const baseOff = 8 + stcoData.offsets.length * 4;
            for (let i = 0; i < fakeCount; i++) {
                dv.setUint32(baseOff + i * 4, isFake, false);
            }
        }
        map.set(stco, makeBox('stco', data));
    }
    return map;
}


function buildSttsV1(realSampleCount) {
    // 2 entries: real samples + fake samples, both with delta=1500
    const data = new Uint8Array(4 + 4 + 2 * 8); // version/flags + count + 2 entries
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    dv.setUint32(4, 2, false);                        // entry_count
    dv.setUint32(8, realSampleCount, false);           // entry 1: count
    dv.setUint32(12, VIDEO_SAMPLE_DELTA, false);       // entry 1: delta
    dv.setUint32(16, FAKE_SAMPLE_COUNT, false);        // entry 2: count
    dv.setUint32(20, VIDEO_SAMPLE_DELTA, false);       // entry 2: delta
    return makeBox('stts', data);
}

function buildStszV1(originalSizes) {
    const totalCount = originalSizes.length + FAKE_SAMPLE_COUNT;
    const data = new Uint8Array(4 + 4 + 4 + totalCount * 4); // ver/flags + sampleSize + count + entries
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    dv.setUint32(4, 0, false);                        // sampleSize = 0 (variable)
    dv.setUint32(8, totalCount, false);               // sample_count
    // Original sizes
    for (let i = 0; i < originalSizes.length; i++) {
        dv.setUint32(12 + i * 4, originalSizes[i], false);
    }
    // Fake sample sizes (8 bytes each)
    const fakeOff = 12 + originalSizes.length * 4;
    for (let i = 0; i < FAKE_SAMPLE_COUNT; i++) {
        dv.setUint32(fakeOff + i * 4, FAKE_SAMPLE_SIZE, false);
    }
    return makeBox('stsz', data);
}

function buildStscV1(originalRows, originalChunkCount) {
    const rows = [...originalRows];
    // Add new entry for the fake chunk if last row doesn't already have 1 sample/chunk
    const lastRow = rows[rows.length - 1];
    if (!lastRow || lastRow[1] !== 1) {
        rows.push([originalChunkCount + 1, 1, 1]);
    }
    const data = new Uint8Array(4 + 4 + rows.length * 12); // ver/flags + count + entries
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    dv.setUint32(4, rows.length, false);
    for (let i = 0; i < rows.length; i++) {
        dv.setUint32(8 + i * 12, rows[i][0], false);
        dv.setUint32(12 + i * 12, rows[i][1], false);
        dv.setUint32(16 + i * 12, rows[i][2], false);
    }
    return makeBox('stsc', data);
}

function buildStcoV1(originalOffsets, delta, fakeOffset) {
    const hasFake = fakeOffset !== null && fakeOffset !== undefined;
    const totalCount = originalOffsets.length + (hasFake ? FAKE_SAMPLE_COUNT : 0);
    const data = new Uint8Array(4 + 4 + totalCount * 4); // ver/flags + count + entries
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    dv.setUint32(4, totalCount, false);
    for (let i = 0; i < originalOffsets.length; i++) {
        dv.setUint32(8 + i * 4, originalOffsets[i] + delta, false);
    }
    if (hasFake) {
        const baseOff = 8 + originalOffsets.length * 4;
        for (let i = 0; i < FAKE_SAMPLE_COUNT; i++) {
            dv.setUint32(baseOff + i * 4, fakeOffset, false);
        }
    }
    return makeBox('stco', data);
}

function buildStcoDynamic(originalOffsets, delta, fakeOffset) {
    const hasFake = fakeOffset !== null && fakeOffset !== undefined;
    const totalCount = originalOffsets.length + (hasFake ? FAKE_SAMPLE_COUNT : 0);
    const data = new Uint8Array(4 + 4 + totalCount * 4); // ver/flags + count + entries
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    dv.setUint32(4, totalCount, false);
    for (let i = 0; i < originalOffsets.length; i++) {
        dv.setUint32(8 + i * 4, originalOffsets[i] + delta, false);
    }
    if (hasFake) {
        const baseOff = 8 + originalOffsets.length * 4;
        for (let i = 0; i < FAKE_SAMPLE_COUNT; i++) {
            dv.setUint32(baseOff + i * 4, fakeOffset, false);
        }
    }
    return makeBox('stco', data);
}

// ═══ MAIN V1 PATCHER ═══

function patchMp4V1(arrayBuffer) {
    try {
        const u8 = new Uint8Array(arrayBuffer);
        const len = u8.length;

        // Parse top-level boxes
        const topLevel = parseChildren(u8, 0, len, 0);

        const ftyp = findChild(topLevel, 'ftyp');
        const moov = findChild(topLevel, 'moov');
        const mdat = findChild(topLevel, 'mdat');

        if (!ftyp || !moov || !mdat) throw new Error('Missing ftyp, moov, or mdat');

        // Find video track
        let videoTrak = null;
        for (const child of (moov.children || [])) {
            if (child.type === 'trak' && handlerTypeForTrak(u8, child) === 'vide') {
                videoTrak = child;
                break;
            }
        }
        if (!videoTrak) throw new Error('Video track not found');

        // Locate required atoms in video track
        const mdhd = findDescendant(videoTrak, ['mdia', 'mdhd']);
        const elst = findDescendant(videoTrak, ['edts', 'elst']);
        const stts = findDescendant(videoTrak, ['mdia', 'minf', 'stbl', 'stts']);
        const stsz = findDescendant(videoTrak, ['mdia', 'minf', 'stbl', 'stsz']);
        const stsc = findDescendant(videoTrak, ['mdia', 'minf', 'stbl', 'stsc']);
        const videoStco = findDescendant(videoTrak, ['mdia', 'minf', 'stbl', 'stco']);

        if (!mdhd || !stts || !stsz || !stsc || !videoStco) throw new Error('Missing required atoms');

        // Collect ALL stco boxes from ALL tracks (audio + video)
        const allStcoBoxes = collectAllStco(u8, moov);

        // Parse original data from video track
        const stszData = parseStsz(u8, stsz);
        const stscData = parseStsc(u8, stsc);
        const originalChunkCount = parseStco(u8, videoStco).count;

        const realSampleCount = stszData.sampleCount;

        // Read actual sample delta from original stts (first entry delta)
        let realSampleDelta = VIDEO_SAMPLE_DELTA; // fallback
        if (stts) {
            const sttsRaw = u8.slice(stts.dataOffset, stts.dataEnd);
            const sttsRawDv = new DataView(sttsRaw.buffer, sttsRaw.byteOffset, sttsRaw.byteLength);
            if (sttsRaw.length >= 16) {
                realSampleDelta = sttsRawDv.getUint32(12, false); // first entry sample_delta
            }
        }

        // Build fixed replacement atoms (not offset-dependent)
        const addedDuration = FAKE_SAMPLE_COUNT * realSampleDelta;
        const newMdhd = buildMdhdDynamic(u8, mdhd, addedDuration);
        const newStts = buildSttsV1(realSampleCount, realSampleDelta);
        const newStsz = buildStszV1(stszData.sizes);
        const newStsc = buildStscV1(stscData.rows, originalChunkCount);

        let newElst = null;
        if (elst) newElst = buildElst(u8, elst);

        // Build fixed replacements map (non-offset-dependent)
        const fixedReplacements = new Map();
        fixedReplacements.set(mdhd, newMdhd);
        fixedReplacements.set(stts, newStts);
        fixedReplacements.set(stsz, newStsz);
        fixedReplacements.set(stsc, newStsc);
        if (elst && newElst) fixedReplacements.set(elst, newElst);

        // Preserved top-level boxes (everything except ftyp, moov, mdat)
        const preservedBoxes = [];
        for (const box of topLevel) {
            if (box === ftyp || box === moov || box === mdat) continue;
            preservedBoxes.push(u8.slice(box.offset, box.offset + box.size));
        }
        const preservedSize = preservedBoxes.reduce((s, b) => s + b.length, 0);

        const ftypSize = ftyp.size;
        const mdatHeaderSize = mdat.headerSize;
        const mdatDataSize = mdat.size - mdatHeaderSize;

        // 3-pass offset resolution (same approach as CuteFish)
        let delta = 0;
        let fakeOffset = 0;

        for (let pass = 0; pass < 3; pass++) {
            // Build ALL replacements including stco for all tracks
            const replacements = new Map(fixedReplacements);
            const stcoReplacements = buildStcoReplacements(u8, allStcoBoxes, videoStco, delta, fakeOffset);
            stcoReplacements.forEach((v, k) => replacements.set(k, v));

            // Rebuild moov
            const newMoovBytes = rebuildBox(moov, u8, replacements);
            const newMoovSize = newMoovBytes.length;

            // Calculate new mdat content start position
            const newMdatStart = ftypSize + newMoovSize + preservedSize + mdatHeaderSize;
            delta = newMdatStart - mdat.dataOffset;
            fakeOffset = newMdatStart + mdatDataSize;
        }

        // Final assembly
        const finalReplacements = new Map(fixedReplacements);
        const finalStcoReplacements = buildStcoReplacements(u8, allStcoBoxes, videoStco, delta, fakeOffset);
        finalStcoReplacements.forEach((v, k) => finalReplacements.set(k, v));

        const finalMoov = rebuildBox(moov, u8, finalReplacements);

        // Build output: ftyp + newMoov + preserved boxes + mdat + fake bytes
        const ftypBytes = u8.slice(ftyp.offset, ftyp.offset + ftyp.size);
        const mdatBytes = u8.slice(mdat.offset, mdat.offset + mdat.size);

        const FAKE_SAMPLE_BYTES_V1 = new Uint8Array(FAKE_SAMPLE_COUNT * FAKE_SAMPLE_SIZE);
        const totalSize = ftypBytes.length + finalMoov.length +
            preservedSize +
            mdatBytes.length + FAKE_SAMPLE_BYTES_V1.length;

        const output = new Uint8Array(totalSize);
        let pos = 0;

        output.set(ftypBytes, pos); pos += ftypBytes.length;
        output.set(finalMoov, pos); pos += finalMoov.length;
        for (const pb of preservedBoxes) { output.set(pb, pos); pos += pb.length; }
        output.set(mdatBytes, pos); pos += mdatBytes.length;
        output.set(FAKE_SAMPLE_BYTES_V1, pos);

        return output.buffer;
    } catch (err) {
        console.error('[Pixora patchMp4V1 Error Stack]:', err.stack || err);
        throw err;
    }
}



function parseSttsDynamic(u8, stts) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const count = dv.getUint32(stts.offset + 12, false);
    const entries = [];
    for (let i = 0; i < count; i++) {
        entries.push({
            count: dv.getUint32(stts.offset + 16 + i * 8, false),
            delta: dv.getUint32(stts.offset + 20 + i * 8, false)
        });
    }
    return entries;
}

function buildSttsDynamic(originalEntries, fakeCount, fakeDelta) {
    const data = new Uint8Array(4 + 4 + (originalEntries.length + 1) * 8);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    dv.setUint32(4, originalEntries.length + 1, false);
    
    let offset = 8;
    for (const entry of originalEntries) {
        dv.setUint32(offset, entry.count, false);
        dv.setUint32(offset + 4, entry.delta, false);
        offset += 8;
    }
    dv.setUint32(offset, fakeCount, false);
    dv.setUint32(offset + 4, fakeDelta, false);
    
    return makeBox('stts', data);
}

function buildStszDynamic(originalSizes, fakeCount, fakeSize) {
    const totalCount = originalSizes.length + fakeCount;
    const data = new Uint8Array(4 + 4 + 4 + totalCount * 4);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    dv.setUint32(4, 0, false);
    dv.setUint32(8, totalCount, false);
    
    for (let i = 0; i < originalSizes.length; i++) {
        dv.setUint32(12 + i * 4, originalSizes[i], false);
    }
    const fakeOff = 12 + originalSizes.length * 4;
    for (let i = 0; i < fakeCount; i++) {
        dv.setUint32(fakeOff + i * 4, fakeSize, false);
    }
    return makeBox('stsz', data);
}

function buildStscDynamic(originalRows, originalChunkCount, fakeCount) {
    const data = new Uint8Array(4 + 4 + (originalRows.length + 1) * 12);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    dv.setUint32(4, originalRows.length + 1, false);
    
    let offset = 8;
    for (const row of originalRows) {
        dv.setUint32(offset, row[0], false);
        dv.setUint32(offset + 4, row[1], false);
        dv.setUint32(offset + 8, row[2], false);
        offset += 12;
    }
    
    dv.setUint32(offset, originalChunkCount + 1, false);
    dv.setUint32(offset + 4, 1, false); // THIS MUST BE 1
    dv.setUint32(offset + 8, 1, false);
    
    return makeBox('stsc', data);
}

// ═══ MAIN V2 PATCHER ═══

function patchMp4V2(arrayBuffer) {
    try {
        const u8 = new Uint8Array(arrayBuffer);
        const len = u8.length;
        const topLevel = parseChildren(u8, 0, len, 0);

        const ftyp = findChild(topLevel, 'ftyp');
        const moov = findChild(topLevel, 'moov');
        const mdat = findChild(topLevel, 'mdat');
        if (!ftyp || !moov || !mdat) throw new Error('Missing ftyp, moov, or mdat');

        const trakBoxes = moov.children.filter(c => c.type === 'trak');
        let videoTrak = null;
        for (const trak of trakBoxes) {
            const hType = handlerTypeForTrak(u8, trak);
            if (hType === 'vide') {
                videoTrak = trak;
                break;
            }
        }
        if (!videoTrak) throw new Error('video trak not found');

        const stts = findDescendant(videoTrak, ['mdia', 'minf', 'stbl', 'stts']);
        const stsz = findDescendant(videoTrak, ['mdia', 'minf', 'stbl', 'stsz']);
        const stsc = findDescendant(videoTrak, ['mdia', 'minf', 'stbl', 'stsc']);
        const videoStco = findDescendant(videoTrak, ['mdia', 'minf', 'stbl', 'stco']);

        if (!stts || !stsz || !stsc || !videoStco) throw new Error('Missing required atoms');

        const allStcoBoxes = collectAllStco(u8, moov);
        const stszData = parseStsz(u8, stsz);
        const stscData = parseStsc(u8, stsc);
        const sttsData = parseSttsDynamic(u8, stts);
        const originalChunkCount = parseStco(u8, videoStco).count;

        const realSampleCount = stszData.sampleCount;
        
        // PIXORA METHOD: 10x total frames for 30fps (add 9x fake frames).
        // For V1 which is 60fps, 10x makes it 600fps which TikTok rejects (falls back to 720p).
        // We dynamically calculate multiplier so total fps is around 300.
        // Approximate original FPS based on realSampleCount and mdhd duration.
        const FAKE_SAMPLE_SIZE = 8;
        let v2FakeSampleCount = realSampleCount * 9; // Default 10x (9x fake)
        
        const mdhd = findDescendant(videoTrak, ['mdia', 'mdhd']);
        if (mdhd) {
            const data = u8.slice(mdhd.dataOffset, mdhd.dataEnd);
            const dvMdhd = new DataView(data.buffer, data.byteOffset, data.byteLength);
            const ver = data[0];
            const timescale = ver === 0 ? dvMdhd.getUint32(12, false) : dvMdhd.getUint32(20, false);
            const duration = ver === 0 ? dvMdhd.getUint32(16, false) : dvMdhd.getUint32(28, false);
            
            if (timescale > 0 && duration > 0) {
                const durationSec = duration / timescale;
                const fps = realSampleCount / durationSec;
                if (fps > 45) {
                    // Video is likely 60fps. Use 5x multiplier to keep total fps around 300.
                    v2FakeSampleCount = realSampleCount * 4;
                    console.log(`[Pixora V2] Detected High FPS (${fps.toFixed(1)}). Adjusting multiplier to 5x.`);
                } else {
                    console.log(`[Pixora V2] Detected Standard FPS (${fps.toFixed(1)}). Using 10x multiplier.`);
                }
            }
        }
        
        const v2FakeSampleBytes = new Uint8Array(v2FakeSampleCount * FAKE_SAMPLE_SIZE);
        
        // Get delta from original stts (last entry)
        const lastDelta = sttsData.length > 0 ? sttsData[sttsData.length - 1].delta : 512;

        // Build replacement atoms — pass v2FakeSampleCount explicitly to all builders
        const addedDuration = v2FakeSampleCount * lastDelta;
        const newMdhd = buildMdhdDynamic(u8, mdhd, addedDuration);
        const newStts = buildSttsDynamic(sttsData, v2FakeSampleCount, lastDelta);
        const newStsz = buildStszDynamic(stszData.sizes, v2FakeSampleCount, FAKE_SAMPLE_SIZE);
        const newStsc = buildStscDynamic(stscData.rows, originalChunkCount, v2FakeSampleCount);

        const fixedReplacements = new Map();
        fixedReplacements.set(mdhd, newMdhd);
        fixedReplacements.set(stts, newStts);
        fixedReplacements.set(stsz, newStsz);
        fixedReplacements.set(stsc, newStsc);

        const preservedBoxes = [];
        for (const box of topLevel) {
            if (box === ftyp || box === moov || box === mdat) continue;
            preservedBoxes.push(u8.slice(box.offset, box.offset + box.size));
        }
        const preservedSize = preservedBoxes.reduce((s, b) => s + b.length, 0);

        const ftypSize = ftyp.size;
        const mdatHeaderSize = mdat.headerSize;
        const mdatDataSize = mdat.size - mdatHeaderSize;

        let delta = 0;
        let fakeOffset = 0;
        let finalMoov = null;

        for (let pass = 0; pass < 3; pass++) {
            const replacements = new Map(fixedReplacements);
            // Pass v2FakeSampleCount explicitly to avoid using global FAKE_SAMPLE_COUNT
            const stcoReplacements = buildStcoReplacementsV2(u8, allStcoBoxes, videoStco, delta, fakeOffset, v2FakeSampleCount);
            stcoReplacements.forEach((v, k) => replacements.set(k, v));

            finalMoov = rebuildBox(moov, u8, replacements);
            const newMdatStart = ftypSize + finalMoov.length + preservedSize + mdatHeaderSize;
            delta = newMdatStart - mdat.dataOffset;
            fakeOffset = newMdatStart + mdatDataSize;
        }

        const totalSize = ftypSize + finalMoov.length + preservedSize + mdatDataSize + v2FakeSampleBytes.length + mdatHeaderSize;
        const output = new Uint8Array(totalSize);
        let pos = 0;

        output.set(u8.slice(ftyp.offset, ftyp.offset + ftypSize), pos); pos += ftypSize;
        output.set(finalMoov, pos); pos += finalMoov.length;
        for (const pb of preservedBoxes) { output.set(pb, pos); pos += pb.length; }

        const mdatHeader = u8.slice(mdat.offset, mdat.dataOffset);
        if (mdatHeaderSize === 8) {
            new DataView(mdatHeader.buffer, mdatHeader.byteOffset, mdatHeader.byteLength)
                .setUint32(0, mdat.size + v2FakeSampleBytes.length, false);
        } else {
            new DataView(mdatHeader.buffer, mdatHeader.byteOffset, mdatHeader.byteLength)
                .setBigUint64(8, BigInt(mdat.size + v2FakeSampleBytes.length), false);
        }
        
        output.set(mdatHeader, pos); pos += mdatHeaderSize;
        output.set(u8.slice(mdat.dataOffset, mdat.dataEnd), pos); pos += mdatDataSize;
        output.set(v2FakeSampleBytes, pos);

        console.log(`[Pixora V2] Added ${v2FakeSampleCount} Fake Samples (${Math.round(v2FakeSampleCount/realSampleCount+1)}x Original). File size: ${(totalSize/1024/1024).toFixed(1)} MB`);
        return output.buffer;
    } catch (err) {
        console.error('[Pixora patchMp4V2 Error Stack]:', err.stack || err);
        throw err;
    }
}

// ═══ PUBLIC API ═══

/**
 * Full 1080p pipeline: FFmpeg compress → V2 atom patch → return ArrayBuffer
 * @param {ArrayBuffer} inputBuffer - Original video file
 * @param {Function} progressCb - (percent: number, message: string) => void
 * @returns {Promise<ArrayBuffer>} Patched video ready for upload
 */
async function process1080p(inputBuffer, progressCb) {
    const progress = progressCb || (() => {});

    // Step 1: FFmpeg compression
    progress(0, 'Initializing FFmpeg...');
    const compressedBuffer = await FFmpegBridge.compress(inputBuffer, (pct, msg) => {
        // FFmpeg progress maps to 0-85% of total
        progress(Math.round(pct * 0.85), msg);
    });

    progress(88, 'Applying V2 atom patches...');

    // Step 2: V2 atom patching
    const patchedBuffer = patchMp4V2(compressedBuffer);

    progress(100, 'Complete');
    return patchedBuffer;
}

/**
 * Patches the container metadata dimensions (tkhd and stsd) to claim a new resolution (e.g. 720x1280),
 * while leaving the actual bitstream untouched.
 * 
 * @param {ArrayBuffer} arrayBuffer - Original video buffer
 * @param {number} newWidth - New metadata width (default: 720)
 * @param {number} newHeight - New metadata height (default: 1280)
 * @returns {ArrayBuffer} Patched video buffer
 */
function patchMp4Dimensions(arrayBuffer, newWidth = 720, newHeight = 1280) {
    try {
        const u8 = new Uint8Array(arrayBuffer);
        const len = u8.length;
        
        // Parse top-level boxes
        const topLevel = parseChildren(u8, 0, len, 0);
        const moov = findChild(topLevel, 'moov');
        if (!moov) throw new Error('Missing moov box');
        
        // Find video track
        let videoTrak = null;
        for (const child of (moov.children || [])) {
            if (child.type === 'trak' && handlerTypeForTrak(u8, child) === 'vide') {
                videoTrak = child;
                break;
            }
        }
        if (!videoTrak) {
            // Fallback to the first track if we can't find track with 'vide' handler
            for (const child of (moov.children || [])) {
                if (child.type === 'trak') {
                    videoTrak = child;
                    break;
                }
            }
        }
        if (!videoTrak) throw new Error('Video track (trak) not found');
        
        // 1. Locate and patch tkhd
        const tkhd = findChild(videoTrak.children || [], 'tkhd');
        if (!tkhd) throw new Error('tkhd box not found');
        
        const dv = new DataView(arrayBuffer);
        const header = tkhd.offset + 8; // skip size + type
        const version = u8[header];
        let widthOffset, heightOffset;
        if (version === 0) {
            widthOffset = header + 76;
            heightOffset = widthOffset + 4;
        } else if (version === 1) {
            widthOffset = header + 88;
            heightOffset = widthOffset + 4;
        } else {
            throw new Error('Unknown tkhd version: ' + version);
        }
        
        // Read original dimensions from tkhd
        const oldWidthRaw = dv.getUint32(widthOffset, false);
        const oldHeightRaw = dv.getUint32(heightOffset, false);
        const oldWidth = oldWidthRaw >> 16;
        const oldHeight = oldHeightRaw >> 16;
        
        let targetWidth = newWidth;
        let targetHeight = newHeight;
        
        if (oldWidth > oldHeight) {
            // Landscape video: target 1280x720 (1280 wide, 720 high)
            targetWidth = 1280;
            targetHeight = 720;
        } else if (oldWidth < oldHeight) {
            // Portrait video: target 720x1280 (720 wide, 1280 high)
            targetWidth = 720;
            targetHeight = 1280;
        } else {
            // Square video: target 720x720 (720 wide, 720 high)
            targetWidth = 720;
            targetHeight = 720;
        }
        
        console.log(`[Pixora] Original dimensions: ${oldWidth}x${oldHeight}. Target claim dimensions: ${targetWidth}x${targetHeight}`);
        
        // Write fixed-point 16.16 width and height
        dv.setUint32(widthOffset, targetWidth << 16, false);
        dv.setUint32(heightOffset, targetHeight << 16, false);
        
        // 2. Locate and patch stsd
        const stsd = findDescendant(videoTrak, ['mdia', 'minf', 'stbl', 'stsd']);
        if (!stsd) throw new Error('stsd box not found');
        
        const entryStart = stsd.offset + 16;
        const videoTypes = ['avc1', 'hev1', 'hvc1', 'avc3'];
        let pos = entryStart;
        const end = stsd.offset + stsd.size;
        let patchedstsd = false;
        
        while (pos < end - 8) {
            const entrySize = dv.getUint32(pos, false);
            if (entrySize < 8) break;
            const entryType = String.fromCharCode(u8[pos+4], u8[pos+5], u8[pos+6], u8[pos+7]);
            if (videoTypes.includes(entryType)) {
                // Width at offset 24, Height at offset 26 (from entry start) -> pos + 8 (header) + 24 = pos + 32
                const wOffset = pos + 32;
                const hOffset = wOffset + 2;
                
                dv.setUint16(wOffset, targetWidth, false);
                dv.setUint16(hOffset, targetHeight, false);
                patchedstsd = true;
            }
            pos += entrySize;
        }
        
        if (!patchedstsd) {
            console.warn('[Pixora] stsd video entry (avc1/hev1/hvc1/avc3) not found');
        }
        
        console.log('[Pixora] Metadata successfully patched to 720p (720x1280)');
        return arrayBuffer;
    } catch (err) {
        console.error('[Pixora patchMp4Dimensions Error]:', err);
        throw err;
    }
}








function buildMvhdDynamic(originalU8, mvhdBox, addedSeconds) {
    const data = originalU8.slice(mvhdBox.dataOffset, mvhdBox.dataEnd);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const ver = data[0];
    
    if (ver === 0) {
        const timescale = dv.getUint32(12, false);
        const oldDuration = dv.getUint32(16, false);
        const addedDuration = Math.round(addedSeconds * timescale);
        dv.setUint32(16, oldDuration + addedDuration, false);
    } else {
        const timescale = dv.getUint32(20, false);
        const oldDuration = Number(dv.getBigUint64(24, false));
        const addedDuration = Math.round(addedSeconds * timescale);
        dv.setBigUint64(24, BigInt(oldDuration + addedDuration), false);
    }
    return makeBox('mvhd', data);
}

function buildMdhdDynamic(originalU8, mdhdBox, addedDurationTrack) {
    const data = originalU8.slice(mdhdBox.dataOffset, mdhdBox.dataEnd);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const ver = data[0];
    
    if (ver === 0) {
        const oldDuration = dv.getUint32(16, false);
        dv.setUint32(16, oldDuration + addedDurationTrack, false);
    } else {
        const oldDuration = Number(dv.getBigUint64(24, false));
        dv.setBigUint64(24, BigInt(oldDuration + addedDurationTrack), false);
    }
    return makeBox('mdhd', data);
}

function patchMp4V3(arrayBuffer) {
    try {
        const u8 = new Uint8Array(arrayBuffer);
        const len = u8.length;
        const topLevel = parseChildren(u8, 0, len, 0);

        const ftyp = findChild(topLevel, 'ftyp');
        const moov = findChild(topLevel, 'moov');
        const mdat = findChild(topLevel, 'mdat');
        if (!ftyp || !moov || !mdat) throw new Error('Missing ftyp, moov, or mdat');

        const mvhd = findChild(moov.children, 'mvhd');
        if (!mvhd) throw new Error('Missing mvhd');

        const trakBoxes = moov.children.filter(c => c.type === 'trak');
        let videoTrak = null;
        for (const trak of trakBoxes) {
            if (handlerTypeForTrak(u8, trak) === 'vide') {
                videoTrak = trak;
                break;
            }
        }
        if (!videoTrak) throw new Error('video trak not found');

        const mdhd = findDescendant(videoTrak, ['mdia', 'mdhd']);
        const stts = findDescendant(videoTrak, ['mdia', 'minf', 'stbl', 'stts']);
        const stsz = findDescendant(videoTrak, ['mdia', 'minf', 'stbl', 'stsz']);
        const stsc = findDescendant(videoTrak, ['mdia', 'minf', 'stbl', 'stsc']);
        const videoStco = findDescendant(videoTrak, ['mdia', 'minf', 'stbl', 'stco']);

        if (!mdhd || !stts || !stsz || !stsc || !videoStco) throw new Error('Missing required atoms');

        const allStcoBoxes = collectAllStco(u8, moov);

        const stszData = parseStsz(u8, stsz);
        const stscData = parseStsc(u8, stsc);
        const sttsData = parseSttsDynamic(u8, stts);
        const originalChunkCount = parseStco(u8, videoStco).count;

        // V3 STRATEGY: Use real delta for fake samples so parser MUST process all of them
        // (delta=1 doesn't work — TikTok parser stops at mdhd duration, never reaches fake samples)
        // We inflate mdhd+mvhd duration, but add an elst that clips playback to ORIGINAL duration.
        // Result: TikTok transcoder sees the full inflated file → timeout/bypass ✅
        //         Video players see elst → show original duration ✅
        const FAKE_SAMPLE_COUNT = 8573;
        const FAKE_SAMPLE_SIZE = 8;
        const lastDelta = sttsData.length > 0 ? sttsData[sttsData.length - 1].delta : 512;
        const FAKE_SAMPLE_DELTA = lastDelta; // Must match real frame timing to trigger parser overwhelm

        // --- Read original mdhd duration & timescale ---
        const mdhdData = u8.slice(mdhd.dataOffset, mdhd.dataEnd);
        const mdhdDv = new DataView(mdhdData.buffer, mdhdData.byteOffset, mdhdData.byteLength);
        const mdhdVer = mdhdData[0];
        const trackTimescale = mdhdVer === 0 ? mdhdDv.getUint32(12, false) : mdhdDv.getUint32(20, false);
        const originalMdhdDuration = mdhdVer === 0 ? mdhdDv.getUint32(16, false) : Number(mdhdDv.getBigUint64(24, false));

        // --- Read original mvhd duration & timescale ---
        const mvhdData = u8.slice(mvhd.dataOffset, mvhd.dataEnd);
        const mvhdDv = new DataView(mvhdData.buffer, mvhdData.byteOffset, mvhdData.byteLength);
        const mvhdVer = mvhdData[0];
        const movieTimescale = mvhdVer === 0 ? mvhdDv.getUint32(12, false) : mvhdDv.getUint32(20, false);
        const originalMvhdDuration = mvhdVer === 0 ? mvhdDv.getUint32(16, false) : Number(mvhdDv.getBigUint64(24, false));

        // --- Calculate inflated durations ---
        const addedTrackTicks = FAKE_SAMPLE_COUNT * lastDelta;
        const addedSeconds = addedTrackTicks / trackTimescale;
        const addedMovieTicks = Math.round(addedSeconds * movieTimescale);

        // --- Build inflated mdhd (parser sees full file duration) ---
        const newMdhdData = mdhdData.slice();
        const newMdhdDv = new DataView(newMdhdData.buffer, newMdhdData.byteOffset, newMdhdData.byteLength);
        if (mdhdVer === 0) {
            newMdhdDv.setUint32(16, originalMdhdDuration + addedTrackTicks, false);
        } else {
            newMdhdDv.setBigUint64(24, BigInt(originalMdhdDuration + addedTrackTicks), false);
        }
        const newMdhd = makeBox('mdhd', newMdhdData);

        

        // --- Build elst that clips presentation to ORIGINAL duration ---
        // elst v0: version(1)+flags(3) + entry_count(4) + segment_duration(4)+media_time(4)+media_rate(4)
        // segment_duration in movie timescale = original duration
        // media_time in track timescale = 0 (start from beginning)
        const elstPayload = new Uint8Array(4 + 4 + 12); // ver/flags + count + 1 entry
        const elstDv = new DataView(elstPayload.buffer, elstPayload.byteOffset, elstPayload.byteLength);
        elstDv.setUint32(0, 0, false); // version=0, flags=0
        elstDv.setUint32(4, 1, false); // entry_count = 1
        elstDv.setUint32(8, originalMvhdDuration, false);  // segment_duration = ORIGINAL movie duration
        elstDv.setInt32(12, 0, false);  // media_time = 0 (start from track beginning)
        elstDv.setUint32(16, 0x00010000, false); // media_rate = 1.0 (fixed-point 16.16)
        const newElstBox = makeBox('elst', elstPayload);

        // Wrap elst in edts container
        const newEdtsBox = makeBox('edts', newElstBox);

        // --- Check if videoTrak already has edts ---
        const existingEdts = videoTrak.children ? videoTrak.children.find(c => c.type === 'edts') : null;

        // --- Build sample table atoms ---
        const newStts = buildSttsDynamic(sttsData, FAKE_SAMPLE_COUNT, FAKE_SAMPLE_DELTA);
        const newStsz = buildStszDynamic(stszData.sizes, FAKE_SAMPLE_COUNT, FAKE_SAMPLE_SIZE);
        const newStsc = buildStscDynamic(stscData.rows, originalChunkCount, FAKE_SAMPLE_COUNT);

        const fixedReplacements = new Map();
        // fixedReplacements.set(mvhd, newMvhd); // REMOVED TO FIX DURATION BUG
        fixedReplacements.set(mdhd, newMdhd);
        fixedReplacements.set(stts, newStts);
        fixedReplacements.set(stsz, newStsz);
        fixedReplacements.set(stsc, newStsc);
        if (existingEdts) {
            // Replace existing edts with our new one
            fixedReplacements.set(existingEdts, newEdtsBox);
        }

        const preservedBoxes = [];
        for (const box of topLevel) {
            if (box === ftyp || box === moov || box === mdat) continue;
            preservedBoxes.push(u8.slice(box.offset, box.offset + box.size));
        }
        const preservedSize = preservedBoxes.reduce((s, b) => s + b.length, 0);

        // If videoTrak has no edts, we need to inject edts after rebuilding moov.
        // We do this by building a custom trak bytes function.
        function buildTrakWithEdts(trak, originalU8, replacements, edtsToInject) {
            // Rebuild all children
            const childBytes = trak.children.map(child => rebuildBox(child, originalU8, replacements));
            // Inject edts right after tkhd (first child) if not already present
            const hasEdts = trak.children.some(c => c.type === 'edts');
            if (!hasEdts && edtsToInject) {
                // Insert edts after tkhd (index 0) or at start
                const tkhdIdx = trak.children.findIndex(c => c.type === 'tkhd');
                const insertIdx = tkhdIdx >= 0 ? tkhdIdx + 1 : 0;
                childBytes.splice(insertIdx, 0, edtsToInject);
            }
            const content = concatBytes(...childBytes);
            return makeBox('trak', content);
        }

        let delta = 0;
        let fakeOffset = 0;
        let finalMoov = null;

        for (let pass = 0; pass < 3; pass++) {
            const replacements = new Map(fixedReplacements);
            const stcoReplacements = buildStcoReplacementsV2(u8, allStcoBoxes, videoStco, delta, fakeOffset, FAKE_SAMPLE_COUNT);
            stcoReplacements.forEach((v, k) => replacements.set(k, v));

            // Rebuild moov: if no existing edts, manually inject edts into videoTrak
            if (!existingEdts) {
                // Build each moov child manually
                const moovChildren = moov.children.map(child => {
                    if (child === videoTrak) {
                        return buildTrakWithEdts(child, u8, replacements, newEdtsBox);
                    }
                    return rebuildBox(child, u8, replacements);
                });
                finalMoov = makeBox('moov', concatBytes(...moovChildren));
            } else {
                finalMoov = rebuildBox(moov, u8, replacements);
            }

            const newMdatStart = ftyp.size + finalMoov.length + preservedSize + mdat.headerSize;
            delta = newMdatStart - mdat.dataOffset;
            fakeOffset = newMdatStart + (mdat.size - mdat.headerSize);
        }

        const ftypBytes = u8.slice(ftyp.offset, ftyp.offset + ftyp.size);
        const mdatBytes = u8.slice(mdat.offset, mdat.offset + mdat.size);
        const FAKE_SAMPLE_BYTES_V3 = new Uint8Array(FAKE_SAMPLE_COUNT * FAKE_SAMPLE_SIZE);

        const totalSize = ftypBytes.length + finalMoov.length + preservedSize + mdatBytes.length + FAKE_SAMPLE_BYTES_V3.length;
        
        const output = new Uint8Array(totalSize);
        let pos = 0;
        output.set(ftypBytes, pos); pos += ftypBytes.length;
        output.set(finalMoov, pos); pos += finalMoov.length;
        for (const pb of preservedBoxes) { output.set(pb, pos); pos += pb.length; }
        output.set(mdatBytes, pos); pos += mdatBytes.length;
        output.set(FAKE_SAMPLE_BYTES_V3, pos);
        
        const addedSec = addedSeconds.toFixed(1);
        console.log(`[Pixora V3] ${FAKE_SAMPLE_COUNT} fake samples injected (+${addedSec}s hidden by elst). Duration preserved. File: ${(totalSize/1024/1024).toFixed(1)} MB`);
        return output.buffer;
    } catch (err) {
        console.error('[Pixora patchMp4V3 Error]:', err.stack || err);
        throw err;
    }
}



// -----------------------------------------------------------
// --- V5: PHANTOM 8K GHOST TRACK ---------------------------
// -----------------------------------------------------------

function buildGhostTrack(u8, originalVideoTrak, ghostTrackId, movieTimescale, movieDurationTicks, ghostDataOffset) {
    const GHOST_W         = 7680;
    const GHOST_H         = 4320;
    const GHOST_TIMESCALE = 90000;
    const GHOST_SAMPLES   = 100000;  // doubled from 50K for more pressure
    // CRITICAL FIX: delta=1 packs ALL 100K samples into just 1.11 seconds of media time.
    // With delta=3000 (30fps), only ~300 samples fit in a 10-second movie (10s × 30fps).
    // With delta=1, ALL 100,000 samples must be processed by FFmpeg within the first ~1s.
    const GHOST_DELTA     = 1;
    const GHOST_SAMPLE_SZ = 1;

    // tkhd (v0 payload = 84 bytes)
    const tkhdPayload = new Uint8Array(84);
    const tkhdDv = new DataView(tkhdPayload.buffer);
    tkhdDv.setUint32(0, 0x00000003, false);     // enabled + in movie
    tkhdDv.setUint32(12, ghostTrackId, false);
    tkhdDv.setUint32(20, movieDurationTicks, false); // match real movie duration
    tkhdDv.setUint32(40, 0x00010000, false);    // matrix a=1
    tkhdDv.setUint32(56, 0x00010000, false);    // matrix d=1
    tkhdDv.setUint32(72, 0x40000000, false);    // matrix w=1
    tkhdDv.setUint32(76, GHOST_W << 16, false); // width fp16.16
    tkhdDv.setUint32(80, GHOST_H << 16, false); // height fp16.16
    const ghostTkhd = makeBox('tkhd', tkhdPayload);

    // mdhd (v0 payload = 24 bytes)
    // mdhd.duration = 100,000 × 1 = 100,000 ticks = ~1.11s at 90,000 Hz
    // tkhd.duration = original movie duration (longer), so ghost media ends quickly
    // but FFmpeg must process all 100,000 samples within those ~1.11 seconds
    const mdhdPayload = new Uint8Array(24);
    const mdhdDv2 = new DataView(mdhdPayload.buffer);
    mdhdDv2.setUint32(12, GHOST_TIMESCALE, false);
    mdhdDv2.setUint32(16, GHOST_SAMPLES * GHOST_DELTA, false); // = 100,000 ticks = 1.11s
    mdhdDv2.setUint16(20, 0x55C4, false); // 'und'
    const ghostMdhd = makeBox('mdhd', mdhdPayload);

    // hdlr
    const hdlrPayload = new Uint8Array(4 + 4 + 4 + 12 + 18);
    hdlrPayload[8]=0x76;hdlrPayload[9]=0x69;hdlrPayload[10]=0x64;hdlrPayload[11]=0x65; // 'vide'
    const hname=[71,104,111,115,116,84,114,97,99,107,72,97,110,100,108,101,114,0];
    hdlrPayload.set(hname, 24);
    const ghostHdlr = makeBox('hdlr', hdlrPayload);

    // vmhd
    const vmhdPayload = new Uint8Array(12);
    new DataView(vmhdPayload.buffer).setUint32(0, 0x00000001, false);
    const ghostVmhd = makeBox('vmhd', vmhdPayload);

    // dinf/dref (self-contained url)
    const urlPayload = new Uint8Array(4);
    new DataView(urlPayload.buffer).setUint32(0, 0x00000001, false);
    const urlBox = makeBox('url ', urlPayload);
    const drefPayload = new Uint8Array(8);
    new DataView(drefPayload.buffer).setUint32(4, 1, false);
    const ghostDinf = makeBox('dinf', makeBox('dref', concatBytes(drefPayload, urlBox)));

    // stsd: copy from original video trak, patch width/height to 8K
    const originalStsd = findDescendant(originalVideoTrak, ['mdia', 'minf', 'stbl', 'stsd']);
    let ghostStsd;
    if (originalStsd && originalStsd.size > 52) {
        const stsdBytes = u8.slice(originalStsd.offset, originalStsd.offset + originalStsd.size).slice();
        // VisualSampleEntry: stsd_hdr(16) + entry_hdr(8) + reserved(6) + dri(2) + pre_defined(2)
        //                    + reserved(2) + pre_defined(12) = 48 → width at [48], height at [50]
        const stsdDv2 = new DataView(stsdBytes.buffer, stsdBytes.byteOffset, stsdBytes.byteLength);
        stsdDv2.setUint16(48, GHOST_W, false);
        stsdDv2.setUint16(50, GHOST_H, false);
        ghostStsd = stsdBytes;
    } else {
        const fb = new Uint8Array(8);
        new DataView(fb.buffer).setUint32(4, 0, false);
        ghostStsd = makeBox('stsd', fb);
    }

    // stts: 1 entry — 100,000 samples each 1 tick apart
    const sttsPayload = new Uint8Array(16);
    const sttsDv2 = new DataView(sttsPayload.buffer);
    sttsDv2.setUint32(4, 1, false);
    sttsDv2.setUint32(8, GHOST_SAMPLES, false);
    sttsDv2.setUint32(12, GHOST_DELTA, false); // = 1
    const ghostStts = makeBox('stts', sttsPayload);

    // stsz: fixed sample size = 1 byte (no per-entry table needed)
    const stszPayload = new Uint8Array(12);
    const stszDv2 = new DataView(stszPayload.buffer);
    stszDv2.setUint32(4, GHOST_SAMPLE_SZ, false);
    stszDv2.setUint32(8, GHOST_SAMPLES, false);
    const ghostStsz = makeBox('stsz', stszPayload);

    // stsc: 1 sample per chunk (100,000 chunks total)
    const stscPayload = new Uint8Array(20);
    const stscDv2 = new DataView(stscPayload.buffer);
    stscDv2.setUint32(4, 1, false);
    stscDv2.setUint32(8, 1, false);   // first_chunk = 1
    stscDv2.setUint32(12, 1, false);  // samples_per_chunk = 1
    stscDv2.setUint32(16, 1, false);  // sample_description_index = 1
    const ghostStsc = makeBox('stsc', stscPayload);

    // CRITICAL FIX: Each entry points to a UNIQUE offset (ghostDataOffset + i).
    // Previously all entries pointed to the SAME offset → FFmpeg optimized to 1 seek.
    // Now: 100,000 unique seeks → massive I/O overhead on transcoder.
    // Ghost data must be GHOST_SAMPLES bytes (100KB) to accommodate all unique offsets.
    const stcoPayload = new Uint8Array(4 + 4 + GHOST_SAMPLES * 4);
    const stcoDv2 = new DataView(stcoPayload.buffer);
    stcoDv2.setUint32(4, GHOST_SAMPLES, false);
    for (let i = 0; i < GHOST_SAMPLES; i++) {
        stcoDv2.setUint32(8 + i * 4, (ghostDataOffset + i) >>> 0, false);
    }
    const ghostStco = makeBox('stco', stcoPayload);

    const ghostStbl = makeBox('stbl', concatBytes(ghostStsd, ghostStts, ghostStsz, ghostStsc, ghostStco));
    const ghostMinf = makeBox('minf', concatBytes(ghostVmhd, ghostDinf, ghostStbl));
    const ghostMdia = makeBox('mdia', concatBytes(ghostMdhd, ghostHdlr, ghostMinf));
    return makeBox('trak', concatBytes(ghostTkhd, ghostMdia));
}

function patchMp4V5(arrayBuffer) {
    try {
        const u8 = new Uint8Array(arrayBuffer);
        const len = u8.length;
        const topLevel = parseChildren(u8, 0, len, 0);

        const ftyp = findChild(topLevel, 'ftyp');
        const moov = findChild(topLevel, 'moov');
        const mdat = findChild(topLevel, 'mdat');
        if (!ftyp || !moov || !mdat) throw new Error('Missing ftyp, moov, or mdat');

        const mvhd = findChild(moov.children, 'mvhd');
        if (!mvhd) throw new Error('Missing mvhd');

        let videoTrak = null;
        for (const trak of moov.children.filter(c => c.type === 'trak')) {
            if (handlerTypeForTrak(u8, trak) === 'vide') { videoTrak = trak; break; }
        }
        if (!videoTrak) throw new Error('Video track not found');

        // Read mvhd: timescale, duration, next_track_id
        // v0 payload offsets: timescale@12, duration@16, next_track_id@96
        // v1 payload offsets: timescale@20, duration@24, next_track_id@108
        const mvhdData = u8.slice(mvhd.dataOffset, mvhd.dataEnd);
        const mvhdDvV5 = new DataView(mvhdData.buffer, mvhdData.byteOffset, mvhdData.byteLength);
        const mvhdVer5 = mvhdData[0];
        const movieTimescale5 = mvhdVer5 === 0 ? mvhdDvV5.getUint32(12, false) : mvhdDvV5.getUint32(20, false);
        const movieDuration5  = mvhdVer5 === 0 ? mvhdDvV5.getUint32(16, false) : Number(mvhdDvV5.getBigUint64(24, false));
        const ntiOff5         = mvhdVer5 === 0 ? 96 : 108;
        const ghostTrackId    = mvhdDvV5.getUint32(ntiOff5, false);

        // Updated mvhd: increment next_track_id
        const newMvhdData5 = mvhdData.slice();
        const newMvhdDv5   = new DataView(newMvhdData5.buffer, newMvhdData5.byteOffset, newMvhdData5.byteLength);
        newMvhdDv5.setUint32(ntiOff5, ghostTrackId + 1, false);
        const newMvhd5 = makeBox('mvhd', newMvhdData5);

        // Preserved boxes
        const preservedBoxes = [];
        for (const box of topLevel) {
            if (box === ftyp || box === moov || box === mdat) continue;
            preservedBoxes.push(u8.slice(box.offset, box.offset + box.size));
        }
        const preservedSize = preservedBoxes.reduce((s, b) => s + b.length, 0);

        const allOriginalStco = collectAllStco(u8, moov);

        // 3-pass convergence for stco offsets
        let deltaV5 = 0;
        let ghostOffset = 0;
        let finalMoov = null;

        for (let pass = 0; pass < 3; pass++) {
            // Shift original stco (no fake samples: videoStco=null)
            const stcoFixes = buildStcoReplacementsV2(u8, allOriginalStco, null, deltaV5, 0, 0);

            // Rebuild original moov children with shifted stco
            const moovChildren = moov.children.map(child => {
                if (child === mvhd) return newMvhd5;
                if (stcoFixes.has(child)) return stcoFixes.get(child);
                return rebuildBox(child, u8, stcoFixes);
            });

            // Append ghost trak with current ghostOffset estimate
            const ghostTrak = buildGhostTrack(u8, videoTrak, ghostTrackId, movieTimescale5, movieDuration5, ghostOffset);
            moovChildren.push(ghostTrak);

            finalMoov = makeBox('moov', concatBytes(...moovChildren));

            const newMdatStart = ftyp.size + finalMoov.length + preservedSize;
            deltaV5    = newMdatStart - mdat.offset;
            ghostOffset = newMdatStart + mdat.size; // ghost data after mdat
        }

        // 100,000 ghost bytes — one byte per unique stco entry (ghostDataOffset + i)
        const GHOST_DATA = new Uint8Array(100000);

        const ftypBytes = u8.slice(ftyp.offset, ftyp.offset + ftyp.size);
        const mdatBytes = u8.slice(mdat.offset, mdat.offset + mdat.size);
        const totalSize = ftypBytes.length + finalMoov.length + preservedSize + mdatBytes.length + GHOST_DATA.length;

        const output = new Uint8Array(totalSize);
        let pos = 0;
        output.set(ftypBytes, pos);  pos += ftypBytes.length;
        output.set(finalMoov, pos);  pos += finalMoov.length;
        for (const pb of preservedBoxes) { output.set(pb, pos); pos += pb.length; }
        output.set(mdatBytes, pos);  pos += mdatBytes.length;
        output.set(GHOST_DATA, pos);

        console.log(`[Pixora V5] Ghost 8K track injected (ID=${ghostTrackId}, 100k unique-offset samples @ 7680x4320, delta=1). File: ${(totalSize/1024/1024).toFixed(1)} MB`);
        return output.buffer;
    } catch (err) {
        console.error('[Pixora patchMp4V5 Error]:', err.stack || err);
        throw err;
    }
}



// ═══════════════════════════════════════════════════════════
// ═══ V6: ctts PTS SCRAMBLE BOMB ═══════════════════════════
// ═══════════════════════════════════════════════════════════
//
// Strategy: Inject a ctts (Composition Time Offset) box into the REAL video
// track's stbl. The ctts gives:
//   • First half of frames → +4,294,967,295 ticks PTS offset  (~13 hours)
//   • Second half of frames → 0 offset (normal)
//
// Effect: All "first half" frames have PTS far in the future vs "second half".
// The transcoder must OUTPUT frames in PTS order, but RECEIVES them in DTS order.
// This forces buffering ALL frames before any can be output:
//   • N frames × frame_size (1080p ≈ 3MB each) → hundreds of MB buffer
//   → OOM / timeout → TikTok serves original file as-is ✅
//
// Key advantage over V6 avcC spoof: does NOT touch codec config, so TikTok's
// uploader/validator accepts the file. The transcoder fails DURING processing.
// File size increase: ~24 bytes (2 ctts entries).

function patchMp4V6(arrayBuffer) {
    try {
        const u8  = new Uint8Array(arrayBuffer);
        const len = u8.length;
        const topLevel = parseChildren(u8, 0, len, 0);

        const ftyp = findChild(topLevel, 'ftyp');
        const moov = findChild(topLevel, 'moov');
        const mdat = findChild(topLevel, 'mdat');
        if (!ftyp || !moov || !mdat) throw new Error('Missing ftyp/moov/mdat');

        // Find video track
        let videoTrak = null;
        for (const trak of moov.children.filter(c => c.type === 'trak')) {
            if (handlerTypeForTrak(u8, trak) === 'vide') { videoTrak = trak; break; }
        }
        if (!videoTrak) throw new Error('Video track not found');

        // Navigate to stbl and stts
        const stbl = findDescendant(videoTrak, ['mdia', 'minf', 'stbl']);
        if (!stbl) throw new Error('Missing stbl');

        const stts = findChild(stbl.children, 'stts');
        if (!stts) throw new Error('Missing stts');

        // Read total sample count from stts
        const sttsData = u8.slice(stts.dataOffset, stts.dataEnd);
        const sttsDvV6  = new DataView(sttsData.buffer, sttsData.byteOffset, sttsData.byteLength);
        const sttsEntryCount = sttsDvV6.getUint32(4, false);
        let totalSamples = 0;
        for (let i = 0; i < sttsEntryCount; i++) {
            totalSamples += sttsDvV6.getUint32(8 + i * 8, false);
        }
        if (totalSamples === 0) throw new Error('Could not read sample count from stts');

        // Build ctts box (version 0 — unsigned 32-bit offsets)
        // Calculate total track duration to use as a realistic PTS offset
        // We use an offset equal to the track's duration. This pushes the first half of frames
        // to the end of the video, forcing the transcoder to buffer them, but stays within
        // valid file duration bounds so the parser doesn't flag it as corrupt.
        const sttsRaw = u8.slice(stts.dataOffset, stts.dataEnd);
        const sttsDvRaw = new DataView(sttsRaw.buffer, sttsRaw.byteOffset, sttsRaw.byteLength);
        const sampleDelta = sttsRaw.length >= 16 ? sttsDvRaw.getUint32(12, false) : 512;
        const trackDurationTicks = totalSamples * sampleDelta;

        const half = Math.ceil(totalSamples / 2);
        const cttsPayload = new Uint8Array(4 + 4 + 8 + 8); // ver+flags, count, 2×{count,offset}
        const cttsDvV6 = new DataView(cttsPayload.buffer);
        cttsDvV6.setUint32(0,  0x00000000, false); // version=0, flags=0
        cttsDvV6.setUint32(4,  2, false);          // entry_count = 2
        // Entry 1: first half frames get PTS shifted to the end of the video
        cttsDvV6.setUint32(8,  half, false);
        cttsDvV6.setUint32(12, trackDurationTicks, false); // Realistic offset instead of 0xFFFFFFFF
        // Entry 2: second half frames get normal PTS
        cttsDvV6.setUint32(16, totalSamples - half, false);
        cttsDvV6.setUint32(20, 0x00000000, false);
        const cttsBox = makeBox('ctts', cttsPayload);

        // Preserved non-structural boxes
        const preservedBoxes = [];
        for (const box of topLevel) {
            if (box === ftyp || box === moov || box === mdat) continue;
            preservedBoxes.push(u8.slice(box.offset, box.offset + box.size));
        }
        const preservedSize = preservedBoxes.reduce((s, b) => s + b.length, 0);

        const allOriginalStco = collectAllStco(u8, moov);

        // 3-pass convergence: shift original stco + inject ctts into stbl
        let deltaV6 = 0;
        let finalMoov = null;

        for (let pass = 0; pass < 3; pass++) {
            // Shift all stco offsets by delta (no fake samples in V6)
            const stcoFixes = buildStcoReplacementsV2(u8, allOriginalStco, null, deltaV6, 0, 0);

            // Build new stbl: insert ctts after stts, replace stco with shifted version
            const newStblChildren = [];
            let cttsInserted = false;
            for (const child of stbl.children) {
                const childBytes = stcoFixes.has(child) ? stcoFixes.get(child) : rebuildBox(child, u8, stcoFixes);
                newStblChildren.push(childBytes);
                // Insert ctts immediately after stts
                if (child.type === 'stts' && !cttsInserted) {
                    newStblChildren.push(cttsBox);
                    cttsInserted = true;
                }
            }
            if (!cttsInserted) newStblChildren.push(cttsBox); // fallback
            const newStbl = makeBox('stbl', concatBytes(...newStblChildren));

            // Register the new stbl so rebuildBox uses it when processing trak tree
            stcoFixes.set(stbl, newStbl);

            // Rebuild moov
            const moovChildren = moov.children.map(child => rebuildBox(child, u8, stcoFixes));
            finalMoov = makeBox('moov', concatBytes(...moovChildren));

            const newMdatStart = ftyp.size + finalMoov.length + preservedSize;
            deltaV6 = newMdatStart - mdat.offset;
        }

        // Assemble output (no ghost data — same size as original + ctts)
        const ftypBytes = u8.slice(ftyp.offset, ftyp.offset + ftyp.size);
        const mdatBytes = u8.slice(mdat.offset, mdat.offset + mdat.size);
        const totalSize = ftypBytes.length + finalMoov.length + preservedSize + mdatBytes.length;

        const output = new Uint8Array(totalSize);
        let pos = 0;
        output.set(ftypBytes, pos); pos += ftypBytes.length;
        output.set(finalMoov, pos); pos += finalMoov.length;
        for (const pb of preservedBoxes) { output.set(pb, pos); pos += pb.length; }
        output.set(mdatBytes, pos);

        console.log(
            `[Pixora V6 ctts] ${totalSamples} samples — first ${half} get +${trackDurationTicks} PTS offset. ` +
            `Transcoder must buffer all frames → OOM/timeout. ` +
            `File: ${(totalSize/1024/1024).toFixed(2)} MB (+${totalSize - len} bytes)`
        );
        return output.buffer;
    } catch (err) {
        console.error('[Pixora patchMp4V6 Error]:', err.stack || err);
        throw err;
    }
}
