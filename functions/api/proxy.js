export async function onRequestGet(context) {
    const { request } = context;
    const url = new URL(request.url);
    const targetUrlStr = url.searchParams.get('url');

    // --- CONFIGURATION ---
    const MAX_SIZE_BYTES = 1024 * 512; // 512KB limit
    const TIMEOUT_MS = 5000; // 5 second timeout
    const ALLOWED_PROTOCOLS = ['http:', 'https:'];

    // 1. INPUT VALIDATION (The "Gatekeeper")
    if (!targetUrlStr) return new Response("Missing URL", { status: 400 });

    let targetUrl;
    try {
        targetUrl = new URL(targetUrlStr);
    } catch (e) {
        return new Response("Invalid URL format", { status: 400 });
    }

    // 2. PROTOCOL LOCKDOWN
    if (!ALLOWED_PROTOCOLS.includes(targetUrl.protocol)) {
        return new Response("Blocked: Only HTTP/HTTPS allowed", { status: 403 });
    }

    // 3. SSRF PROTECTION (Private IP Blocking)
    // We must block localhost, 127.0.0.1, and private ranges (10.x, 192.168.x, etc)
    const hostname = targetUrl.hostname.toLowerCase();

    const isPrivate = (
        hostname === 'localhost' ||
        hostname.endsWith('.local') ||
        hostname.match(/^127\./) ||
        hostname.match(/^10\./) ||
        hostname.match(/^192\.168\./) ||
        hostname.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./) || // 172.16 - 172.31
        hostname.match(/^0\./) ||
        hostname.includes('::1') // IPv6 Loopback
    );

    if (isPrivate) {
        return new Response("Blocked: Access to private networks denied", { status: 403 });
    }

    // 4. ORIGIN GUARD (CORS)
    // Ensure the request comes from YOUR site or localhost (for dev)
    const origin = request.headers.get('Origin') || request.headers.get('Referer') || "";
    const allowedOrigin = url.origin; // The domain this worker is running on

    // Note: Origin headers can be spoofed by scripts, but this stops browser-based misuse
    if (origin && !origin.includes(allowedOrigin) && !origin.includes('localhost') && !origin.includes('127.0.0.1')) {
        return new Response("Unauthorized Proxy Usage", { status: 403 });
    }

    try {
        // 5. FETCH WITH TIMEOUT (Prevent hanging processes)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

        const response = await fetch(targetUrl.toString(), {
            headers: {
                'User-Agent': 'Tracky-App/1.0 (Mozilla/5.0 Compatible)',
                'Accept': 'text/plain,text/*'
            },
            signal: controller.signal,
            redirect: 'follow' // Cloudflare handles redirects, but be careful of loops
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            return new Response(`Upstream Error: ${response.status}`, { status: 502 });
        }

        // 6. HEADER SIZE CHECK (Fail Fast)
        const contentLength = response.headers.get('Content-Length');
        if (contentLength && parseInt(contentLength) > MAX_SIZE_BYTES) {
            return new Response("File too large (Header Check)", { status: 413 });
        }

        // 7. CONTENT VALIDATION (The "Is it a tracker?" check)
        // We read as text, but we enforce the limit during the read if possible.
        // Since we need to regex the content, we must read into memory.
        let text = await response.text();

        // 8. TRUNCATION DEFENSE
        // If the server lied about Content-Length, cut it off manually.
        if (text.length > MAX_SIZE_BYTES) {
            text = text.substring(0, MAX_SIZE_BYTES);
            // Optional: Return 413 here if you prefer not to serve partials
        }

        // 9. PATTERN MATCHING (Deep Inspection)
        // We check the first 1000 chars to ensure it looks like a tracker list
        const sample = text.substring(0, 1000).toLowerCase();

        // A valid list usually has udp://, http://, or blank lines/comments
        // We look for at least ONE tracker protocol or specific keywords
        const isValidTrackerList = (
            sample.includes('udp://') ||
            sample.includes('http://') ||
            sample.includes('https://') ||
            sample.includes('wss://')
        );

        if (!isValidTrackerList) {
            return new Response("Security Block: Content does not look like a tracker list", { status: 422 });
        }

        // 10. SUCCESS RESPONSE
        return new Response(text, {
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
            }
        });

    } catch (err) {
        if (err.name === 'AbortError') {
            return new Response("Upstream Timeout", { status: 504 });
        }
        return new Response("Proxy Error", { status: 500 });
    }
}