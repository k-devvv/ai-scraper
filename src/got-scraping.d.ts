// got-scraping.d.ts — type shim (package not installed, declare to satisfy TS)
declare module "got-scraping" {
  interface GotScrapingOptions {
    url?: string;
    headers?: Record<string, string>;
    timeout?: { request?: number };
    proxyUrl?: string;
  }
  export function gotScraping(options: GotScrapingOptions): Promise<{ body: string; statusCode: number; url: string }>;
}
