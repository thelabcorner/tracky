// functions/api/raw.js

export async function onRequestGet(context) {
    const { request } = context;
    const url = new URL(request.url);
    const encodedData = url.searchParams.get('data');

    // --- CONFIGURATION ---
    const TIMEOUT_MS = 4000; // 4 seconds max per source
    const MAX_SOURCES = 10;  // Prevent abuse

    // 1. Decode Payload
    if (!encodedData) return new Response("# Error: No config provided", { status: 400 });

    let config;
    try {
        // Decode Base64 (handle spaces as pluses)
        const jsonString = atob(encodedData.replace(/ /g, '+'));
        config = JSON.parse(jsonString);
    } catch (e) {
        return new Response("# Error: Invalid Base64 JSON", { status: 400 });
    }

    // 2. Validate Structure
    // Expected JSON: { sources: ["https://..."], manual: ["udp://..."] }
    const sources = Array.isArray(config.sources) ? config.sources : [];
    const manual = Array.isArray(config.manual) ? config.manual : [];

    if (sources.length > MAX_SOURCES) {
        return new Response(`# Error: Too many sources (Max ${MAX_SOURCES})`, { status: 400 });
    }

    // 3. Parallel Fetching with Safety & Caching
    // We fetch all sources at the same time.
    const fetchPromises = sources.map(async (sourceUrl) => {
        return await safeFetchSource(sourceUrl, TIMEOUT_MS);
    });

    // Wait for all to finish (or fail)
    const results = await Promise.all(fetchPromises);

    // 4. Aggregation & Deduplication
    const uniqueTrackers = new Set();

    // Add manual trackers first
    manual.forEach(t => cleanAndAdd(t, uniqueTrackers));

    // Add fetched trackers
    results.forEach(text => {
        if (!text) return; // Skip failed fetches
        const lines = text.split('\n');
        lines.forEach(line => cleanAndAdd(line, uniqueTrackers));
    });

    // 5. Generate Response
    const responseText = Array.from(uniqueTrackers).join('\n');

    return new Response(responseText, {
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': 'inline; filename="trackers_sync.txt"',
            'Cache-Control': 'public, max-age=3600', // Browser/Client cache for 1 hour
            'Access-Control-Allow-Origin': '*'
        }
    });
}

/**
 * Helper: Adds a tracker to the Set if it looks valid
 */
function cleanAndAdd(line, set) {
    const clean = line.trim();
    // Basic validation: must allow empty lines, comments, but filter for protocols
    if (!clean || clean.startsWith('#')) return;

    // Strict Protocol Check (UDP, HTTP, HTTPS, WSS)
    if (/^(udp|http|https|wss):\/\//i.test(clean)) {
        set.add(clean);
    }
}

/**
 * Helper: Fetches a URL securely with timeout and caching
 */
async function safeFetchSource(urlStr, timeout) {
    try {
        const url = new URL(urlStr);

        // A. Security Checks (SSRF Prevention)
        const hostname = url.hostname.toLowerCase();
        if (hostname === 'localhost' || hostname.match(/^127\.|^10\.|^192\.168\./)) {
            return null; // Silently fail private IPs
        }
        if (!['http:', 'https:'].includes(url.protocol)) {
            return null;
        }

        // B. The Fetch
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);

        const res = await fetch(url.toString(), {
            signal: controller.signal,
            headers: { 'User-Agent': 'Tracky-Sync/1.0' },
            // C. Cloudflare Cache Integration
            // This tells Cloudflare to cache the *outgoing* request result
            // so we don't spam GitHub if 100 users hit this endpoint at once.
            cf: {
                cacheTtl: 3600, // Cache this source for 1 hour
                cacheEverything: true
            }
        });

        clearTimeout(id);

        if (!res.ok) return null;

        // D. Size Limit (Read only first 512KB)
        // We use .text() for simplicity, assuming lists aren't massive.
        const text = await res.text();
        if (text.length > 512 * 1024) return null; // Too big

        return text;

    } catch (e) {
        return null; // Return null so the main list continues without this source
    }
}