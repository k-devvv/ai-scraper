/**
 * URL validation with SSRF prevention and protocol blocking.
 * Wrap every user-supplied URL through validateUrl() before passing to
 * Playwright, Axios, or any fetch engine.
 */

const BLOCKED_PROTOCOLS = ['file:', 'javascript:', 'data:', 'vbscript:', 'blob:'];
const MAX_URL_LENGTH = 2048;

// Private IPv4 ranges + localhost
const PRIVATE_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/,   // link-local (AWS metadata)
  /^fc00:/i,                  // IPv6 private
  /\.local$/i,
  /^metadata\.google\.internal$/i,
  /^169\.254\.169\.254$/,    // AWS/GCP/Azure metadata
];

export function validateUrl(raw: string): string {
  if (!raw || typeof raw !== 'string') {
    throw new Error('URL is required and must be a string');
  }

  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    throw new Error('URL is required');
  }

  if (trimmed.length > MAX_URL_LENGTH) {
    throw new Error(`URL exceeds max length of ${MAX_URL_LENGTH} characters`);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid URL format: ${trimmed}`);
  }

  if (BLOCKED_PROTOCOLS.includes(parsed.protocol)) {
    throw new Error(`Blocked protocol: ${parsed.protocol} — only http/https allowed`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  if (PRIVATE_HOSTNAME_PATTERNS.some((p) => p.test(hostname))) {
    throw new Error(
      `Blocked internal/private address: ${hostname} — SSRF prevention`
    );
  }

  // Strip any auth credentials from URL (user:pass@host)
  parsed.username = '';
  parsed.password = '';

  return parsed.href;
}

/**
 * Validate a batch of URLs. Returns validated URLs and skips invalid ones
 * with a warning, rather than throwing the whole batch.
 */
export function validateUrlBatch(
  urls: string[],
  onInvalid?: (url: string, reason: string) => void
): string[] {
  const valid: string[] = [];
  for (const url of urls) {
    try {
      valid.push(validateUrl(url));
    } catch (err) {
      onInvalid?.(url, (err as Error).message);
    }
  }
  return valid;
}
