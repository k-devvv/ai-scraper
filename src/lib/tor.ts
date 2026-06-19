/**
 * src/lib/tor.ts
 * Tor circuit manager — free rotating IP pool.
 *
 * Tor gives you 1000s of exit nodes (different IPs) for free.
 * Each "circuit" is a 3-hop path through the Tor network.
 * Circuits rotate automatically every CIRCUIT_LIFETIME_MS.
 *
 * Usage:
 *   const tor = TorManager.getInstance();
 *   await tor.start();
 *   const proxy = tor.getSocksProxy();   // "socks5://127.0.0.1:9050"
 *   await tor.newCircuit();              // rotate IP now
 *   await tor.stop();
 *
 * Requires Tor to be installed:
 *   Docker:  apt-get install -y tor
 *   Windows: choco install tor  OR  winget install TorProject.TorBrowser
 *   Mac:     brew install tor
 */

import { spawn, ChildProcess, exec } from "child_process";
import { promisify } from "util";
import net from "net";

const execAsync = promisify(exec);

export interface TorConfig {
  socksPort?: number;
  controlPort?: number;
  controlPassword?: string;
  circuitLifetimeMs?: number;
  dataDir?: string;
}

export class TorManager {
  private static instance: TorManager | null = null;

  private socksPort: number;
  private controlPort: number;
  private controlPassword: string;
  private circuitLifetimeMs: number;
  private dataDir: string;
  private torProcess: ChildProcess | null = null;
  private rotateTimer: NodeJS.Timeout | null = null;
  private requestCount = 0;
  private rotateEveryN: number;

  private constructor(config: TorConfig = {}) {
    this.socksPort = config.socksPort ?? 9050;
    this.controlPort = config.controlPort ?? 9051;
    this.controlPassword = config.controlPassword ?? "ai-scraper-tor";
    this.circuitLifetimeMs = config.circuitLifetimeMs ?? 60_000; // rotate every 60s
    this.dataDir = config.dataDir ?? "/tmp/tor-ai-scraper";
    this.rotateEveryN = parseInt(process.env.TOR_ROTATE_EVERY ?? "10", 10);
  }

  static getInstance(config?: TorConfig): TorManager {
    if (!TorManager.instance) {
      TorManager.instance = new TorManager(config);
    }
    return TorManager.instance;
  }

  /** Get proxy URL for use with got-scraping or Playwright */
  getSocksProxy(): string {
    return `socks5://127.0.0.1:${this.socksPort}`;
  }

  /** Check if Tor SOCKS port is reachable */
  async isRunning(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(2000);
      socket.on("connect", () => { socket.destroy(); resolve(true); });
      socket.on("error", () => resolve(false));
      socket.on("timeout", () => resolve(false));
      socket.connect(this.socksPort, "127.0.0.1");
    });
  }

  /** Start Tor process if not already running */
  async start(): Promise<void> {
    // Check if Tor is already running (e.g. system service)
    if (await this.isRunning()) {
      console.log(`[tor] Already running on port ${this.socksPort}`);
      this.startRotationTimer();
      return;
    }

    // Check if tor binary exists
    try {
      await execAsync("which tor || where tor");
    } catch {
      console.warn("[tor] Tor binary not found. Install with: apt-get install -y tor");
      console.warn("[tor] Continuing without Tor — proxy will not be available");
      return;
    }

    console.log("[tor] Starting Tor...");

    const torArgs = [
      "--SocksPort", String(this.socksPort),
      "--ControlPort", String(this.controlPort),
      "--HashedControlPassword", await this.hashPassword(this.controlPassword),
      "--DataDirectory", this.dataDir,
      "--MaxCircuitDirtiness", String(Math.floor(this.circuitLifetimeMs / 1000)),
      "--NewCircuitPeriod", "30",
      "--Log", "notice stdout",
    ];

    this.torProcess = spawn("tor", torArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.torProcess.stdout?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg.includes("Bootstrapped 100%")) {
        console.log("[tor] Ready — 100% bootstrapped");
      }
    });

    this.torProcess.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (!msg.includes("[notice]")) {
        console.warn("[tor] stderr:", msg);
      }
    });

    this.torProcess.on("exit", (code) => {
      console.log(`[tor] Process exited with code ${code}`);
      this.torProcess = null;
    });

    // Wait for Tor to be ready
    await this.waitForReady(30_000);
    this.startRotationTimer();
    console.log(`[tor] Running. Proxy: ${this.getSocksProxy()}`);
  }

  /** Request a new Tor circuit (new exit node = new IP) */
  async newCircuit(): Promise<void> {
    try {
      await this.sendControlCommand("SIGNAL NEWNYM");
      console.log("[tor] New circuit requested — IP rotated");
      // Tor needs ~1s to establish new circuit
      await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      console.warn("[tor] Failed to rotate circuit:", (err as Error).message);
    }
  }

  /** Call this after each request — auto-rotates every N requests */
  async onRequest(): Promise<void> {
    this.requestCount++;
    if (this.requestCount % this.rotateEveryN === 0) {
      await this.newCircuit();
    }
  }

  /** Stop Tor process */
  async stop(): Promise<void> {
    if (this.rotateTimer) {
      clearInterval(this.rotateTimer);
      this.rotateTimer = null;
    }
    if (this.torProcess) {
      this.torProcess.kill("SIGTERM");
      this.torProcess = null;
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private startRotationTimer(): void {
    if (this.rotateTimer) return;
    this.rotateTimer = setInterval(async () => {
      await this.newCircuit();
    }, this.circuitLifetimeMs);
    this.rotateTimer.unref();
  }

  private async waitForReady(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.isRunning()) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Tor did not start within ${timeoutMs}ms`);
  }

  private async sendControlCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let response = "";

      socket.connect(this.controlPort, "127.0.0.1", () => {
        socket.write(`AUTHENTICATE "${this.controlPassword}"\r\n`);
        socket.write(`${command}\r\n`);
        socket.write("QUIT\r\n");
      });

      socket.on("data", (data) => {
        response += data.toString();
      });

      socket.on("close", () => resolve(response));
      socket.on("error", reject);
      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new Error("Tor control connection timed out"));
      });
    });
  }

  private async hashPassword(password: string): Promise<string> {
    try {
      const { stdout } = await execAsync(`tor --hash-password "${password}"`);
      return stdout.trim().split("\n").pop() ?? "";
    } catch {
      // Fallback — no password hashing (less secure but functional)
      return "";
    }
  }
}

// ── Convenience functions ─────────────────────────────────────────────────────

export async function getTorProxy(): Promise<string | null> {
  const tor = TorManager.getInstance();
  if (await tor.isRunning()) {
    return tor.getSocksProxy();
  }
  return null;
}

export async function rotateTorIP(): Promise<void> {
  const tor = TorManager.getInstance();
  await tor.newCircuit();
}
