import { describe, it, expect } from 'vitest';
import { validateUrl, validateUrlBatch } from '../../src/lib/sanitize';

describe('validateUrl', () => {
  describe('valid URLs', () => {
    it('accepts https URLs', () => {
      expect(() => validateUrl('https://example.com')).not.toThrow();
    });

    it('accepts http URLs', () => {
      expect(() => validateUrl('http://example.com/page')).not.toThrow();
    });

    it('accepts URLs with paths, query strings, fragments', () => {
      expect(() =>
        validateUrl('https://example.com/path?q=1&page=2#section')
      ).not.toThrow();
    });

    it('returns cleaned URL (strips user:pass)', () => {
      const url = validateUrl('https://user:pass@example.com/page');
      expect(url).not.toContain('user:pass');
      expect(url).toContain('example.com');
    });
  });

  describe('blocked protocols', () => {
    it('blocks file:// — local file read prevention', () => {
      expect(() => validateUrl('file:///etc/passwd')).toThrow('Blocked protocol');
    });

    it('blocks javascript: — XSS in browser context', () => {
      expect(() => validateUrl('javascript:alert(document.cookie)')).toThrow('Blocked protocol');
    });

    it('blocks data: URIs', () => {
      expect(() => validateUrl('data:text/html,<h1>test</h1>')).toThrow('Blocked protocol');
    });

    it('blocks vbscript:', () => {
      expect(() => validateUrl('vbscript:MsgBox(1)')).toThrow('Blocked protocol');
    });
  });

  describe('SSRF prevention', () => {
    it('blocks localhost', () => {
      expect(() => validateUrl('http://localhost:11434')).toThrow('Blocked internal');
    });

    it('blocks 127.0.0.1', () => {
      expect(() => validateUrl('http://127.0.0.1/ollama')).toThrow('Blocked internal');
    });

    it('blocks 0.0.0.0', () => {
      expect(() => validateUrl('http://0.0.0.0:3000')).toThrow('Blocked internal');
    });

    it('blocks 192.168.x.x private range', () => {
      expect(() => validateUrl('http://192.168.1.100')).toThrow('Blocked internal');
    });

    it('blocks 10.x.x.x private range', () => {
      expect(() => validateUrl('http://10.0.0.1')).toThrow('Blocked internal');
    });

    it('blocks AWS metadata endpoint', () => {
      expect(() => validateUrl('http://169.254.169.254/latest/meta-data/')).toThrow('Blocked internal');
    });

    it('blocks .local domains', () => {
      expect(() => validateUrl('http://myservice.local:8080')).toThrow('Blocked internal');
    });
  });

  describe('input validation', () => {
    it('throws on empty string', () => {
      expect(() => validateUrl('')).toThrow('URL is required');
    });

    it('throws on malformed URL', () => {
      expect(() => validateUrl('not-a-url-at-all')).toThrow('Invalid URL format');
    });

    it('throws on URL exceeding max length', () => {
      const long = 'https://example.com/' + 'a'.repeat(2048);
      expect(() => validateUrl(long)).toThrow('max length');
    });
  });
});

describe('validateUrlBatch', () => {
  it('returns only valid URLs', () => {
    const urls = ['https://example.com', 'file:///etc/passwd', 'https://google.com'];
    const valid = validateUrlBatch(urls);
    expect(valid).toHaveLength(2);
    expect(valid).not.toContain('file:///etc/passwd');
  });

  it('calls onInvalid for each rejected URL', () => {
    const invalid: string[] = [];
    validateUrlBatch(
      ['https://ok.com', 'http://localhost', 'data:text/html,x'],
      (url) => invalid.push(url)
    );
    expect(invalid).toHaveLength(2);
  });
});
