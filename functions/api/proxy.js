// functions/api/proxy.js

export async function onRequest(context) {
    const { request } = context;
    const urlObj = new URL(request.url);

    // Support both GET (query params) and POST (body)
    let targets = [];

    // 1. INPUT PARSING
    // Check for 'urls' (batch) or 'url' (single)
    const urlsParam = urlObj.searchParams.get('urls');
    const singleUrlParam = urlObj.searchParams.get('url');

    try {
        if (urlsParam) {
            targets = JSON.parse(urlsParam);
        } else if (singleUrlParam) {
            targets = [singleUrlParam];
        } else if (request.method === 'POST') {
            const body = await request.json();
            if (body.urls && Array.isArray(body.urls)) targets = body.urls;
            else if (body.url) targets = [body.url];
        }
    } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid JSON or params" }), { status: 400 });
    }

    if (!targets.length) return new Response("Missing URL(s)", { status: 400 });
    if (targets.length > 20) return new Response("Too many sources (Limit 20)", { status: 400 });

    // --- CONFIGURATION ---
    const MAX_SIZE_BYTES = 1024 * 512; // 512KB limit per source
    const TIMEOUT_MS = 5000;

    // 2. BATCH FETCHING
    const fetchPromises = targets.map(async (targetUrlStr) => {
        try {
            const targetUrl = new URL(targetUrlStr);

            // A. Validation
            if (!['http:', 'https:'].includes(targetUrl.protocol)) {
                return { url: targetUrlStr, success: false, error: "Invalid Protocol" };
            }

            // B. SSRF Check
            const hostname = targetUrl.hostname.toLowerCase();
            const isPrivate = (
                hostname === 'localhost' || hostname.endsWith('.local') ||
                hostname.match(/^127\.|^10\.|^192\.168\.|^0\.|::1/) ||
                hostname.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./)
            );
            if (isPrivate) return { url: targetUrlStr, success: false, error: "Private Network Blocked" };

            // C. The Fetch
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

            const response = await fetch(targetUrl.toString(), {
                headers: { 'User-Agent': 'Tracky-App/1.0' },
                signal: controller.signal,
                redirect: 'follow'
            });

            clearTimeout(timeoutId);

            if (!response.ok) return { url: targetUrlStr, success: false, status: response.status };

            // D. Size Check
            let text = await response.text();
            if (text.length > MAX_SIZE_BYTES) {
                text = text.substring(0, MAX_SIZE_BYTES); // Truncate
            }

            // E. Basic Content Verification (Is it a list?)
            const sample = text.substring(0, 500).toLowerCase();
            const isValid = sample.includes('udp://') || sample.includes('http://') || sample.includes('wss://');

            if (!isValid && text.trim().length > 0) {
                return { url: targetUrlStr, success: false, error: "Invalid Content" };
            }

            return { url: targetUrlStr, success: true, content: text };

        } catch (err) {
            return { url: targetUrlStr, success: false, error: "Fetch Failed" };
        }
    });

    // Wait for all
    const results = await Promise.all(fetchPromises);

    // 3. RESPONSE
    // We return a JSON map so the client knows exactly which URL succeeded/failed
    const responseMap = {};
    results.forEach(r => {
        responseMap[r.url] = r;
    });

    return new Response(JSON.stringify(responseMap), {
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        }
    });
}