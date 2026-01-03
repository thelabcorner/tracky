// functions/api/raw.js

export async function onRequestGet(context) {
    const { request } = context;
    const urlObj = new URL(request.url);
    const encodedData = urlObj.searchParams.get('data');
    const directUrls = urlObj.searchParams.get('urls'); // Support direct URL list (no config)

    // --- CONFIGURATION ---
    const TIMEOUT_MS = 4000;
    const MAX_SOURCES = 20;

    let sources = [];
    let manual = [];
    let useDoubleNewline = false; // Default: Single newline

    // 1. Determine Input Mode
    if (encodedData) {
        // Mode A: Base64 Config (Standard)
        try {
            const decodedData = atob(encodedData.replace(/ /g, '+'));
            const original = latin1ToString(decodedData); // Decode escape-encoded format
            const jsonString = decompress(original); // Decompress to get original JSON
            const config = JSON.parse(jsonString);

            sources = Array.isArray(config.sources) ? config.sources : [];
            manual = Array.isArray(config.manual) ? config.manual : [];

            // Check for the formatting setting
            if (config.doubleNewline === true) {
                useDoubleNewline = true;
            }

        } catch (e) {
            return new Response("# Error: Invalid Base64 JSON", { status: 400 });
        }
    } else if (directUrls) {
        // Mode B: Direct CSV (Ad-hoc)
        sources = directUrls.split(',');
    } else {
        return new Response("# Error: No config provided", { status: 400 });
    }

    if (sources.length > MAX_SOURCES) {
        return new Response(`# Error: Too many sources (Max ${MAX_SOURCES})`, { status: 400 });
    }

    // 2. Parallel Fetching
    const fetchPromises = sources.map(async (sourceUrl) => {
        return await safeFetchSource(sourceUrl, TIMEOUT_MS);
    });

    const results = await Promise.all(fetchPromises);

    // 3. Aggregation & Deduplication
    const uniqueTrackers = new Set();

    // Add manual trackers first
    manual.forEach(t => cleanAndAdd(t, uniqueTrackers));

    // Add fetched trackers
    results.forEach(text => {
        if (!text) return;
        const lines = text.split('\n');
        lines.forEach(line => cleanAndAdd(line, uniqueTrackers));
    });

    // 4. Generate Response
    // Select separator based on config
    const separator = useDoubleNewline ? '\n\n' : '\n';
    const responseText = Array.from(uniqueTrackers).join(separator);

    return new Response(responseText, {
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': 'inline; filename="trackers_sync.txt"',
            'Cache-Control': 'public, max-age=3600',
            'Access-Control-Allow-Origin': '*'
        }
    });
}

function cleanAndAdd(line, set) {
    const clean = line.trim();
    if (!clean || clean.startsWith('#')) return;
    if (/^(udp|http|https|wss):\/\//i.test(clean)) {
        set.add(clean);
    }
}

async function safeFetchSource(urlStr, timeout) {
    try {
        const url = new URL(urlStr);

        // Security Checks
        const hostname = url.hostname.toLowerCase();
        if (hostname.match(/^127\.|^10\.|^192\.168\.|^0\.|::1/) || hostname === 'localhost') {
            return null;
        }
        if (!['http:', 'https:'].includes(url.protocol)) {
            return null;
        }

        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);

        const res = await fetch(url.toString(), {
            signal: controller.signal,
            headers: { 'User-Agent': 'Tracky-Sync/1.0' },
            cf: {
                cacheTtl: 3600,
                cacheEverything: true
            }
        });

        clearTimeout(id);

        if (!res.ok) return null;

        const text = await res.text();
        if (text.length > 512 * 1024) return null;

        return text;

    } catch (e) {
        return null;
    }
}



// ========================================
// DECOMPRESSION ALGORITHM
// ========================================

function decompress(encoded) {
    // Check if uncompressed (fallback marker)
    if (encoded.charCodeAt(0) === 0xFF) {
        return encoded.substring(1);
    }

    let pos = 0;
    const dictCount = encoded.charCodeAt(pos++);
    const dictionary = [];

    // Read dictionary entries
    for (let i = 0; i < dictCount; i++) {
        const lenHi = encoded.charCodeAt(pos++);
        const lenLo = encoded.charCodeAt(pos++);
        const len = (lenHi << 8) | lenLo;
        const entry = encoded.substring(pos, pos + len);
        pos += len;
        dictionary.push(entry);
    }

    // Decompress by replacing markers with original patterns
    let result = encoded.substring(pos);

    // Reverse order to handle nested replacements correctly
    for (let i = dictionary.length - 1; i >= 0; i--) {
        const marker = String.fromCharCode(0xE000 + i);
        result = result.split(marker).join(dictionary[i]);
    }

    return result;
}

// Convert Latin1-safe format (with escape sequences) back to original string with high Unicode chars
function latin1ToString(str) {
    let result = '';
    for (let i = 0; i < str.length; i++) {
        if (str.charCodeAt(i) === 0xFF && i + 2 < str.length) {
            // Decode escape sequence: \xFF + low byte + high byte
            const low = str.charCodeAt(i + 1);
            const high = str.charCodeAt(i + 2);
            const code = (high << 8) | low;
            result += String.fromCharCode(code);
            i += 2;
        } else {
            result += str.charAt(i);
        }
    }
    return result;
}
