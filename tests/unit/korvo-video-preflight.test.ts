import { describe, test, expect, spyOn, afterEach } from "bun:test";
import { KorvoVideoService } from "../../src/media/korvo-video";

function makeProcessMock({
  stdoutBytes = new Uint8Array(),
  stderrBytes = new Uint8Array(),
  exitCode = 0,
  onKill,
}: {
  stdoutBytes?: Uint8Array;
  stderrBytes?: Uint8Array;
  exitCode?: number;
  onKill?: (signal?: string) => void;
}) {
  let resolveExit: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      if (stdoutBytes.length > 0) controller.enqueue(stdoutBytes);
      controller.close();
    },
  });

  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      if (stderrBytes.length > 0) controller.enqueue(stderrBytes);
      controller.close();
    },
  });

  queueMicrotask(() => resolveExit(exitCode));

  return {
    stdout,
    stderr,
    exited,
    kill: (signal?: string) => {
      onKill?.(signal);
      resolveExit(exitCode);
    },
  };
}

describe("gateway-video-transcoder-preflight", () => {
  const activeSpies: Array<{ mockRestore: () => void }> = [];
  const originalEnvBase = process.env.KORVO_MEDIA_BASE_URL;

  afterEach(() => {
    for (const spy of activeSpies) {
      try { spy.mockRestore(); } catch {}
    }
    activeSpies.length = 0;
    if (originalEnvBase !== undefined) {
      process.env.KORVO_MEDIA_BASE_URL = originalEnvBase;
    } else {
      delete process.env.KORVO_MEDIA_BASE_URL;
    }
  });

  test("probeTranscoderSource validates exact 3072 bytes for video", async () => {
    const service = new KorvoVideoService();
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((args: any) => {
      expect(args).toContain("scale=32:32");
      expect(args).toContain("rawvideo");
      return makeProcessMock({ stdoutBytes: new Uint8Array(3072), exitCode: 0 }) as any;
    });
    activeSpies.push(spawnSpy);

    const ok = await (service as any).probeTranscoderSource("http://example.com/v.mp4", "video");
    expect(ok).toBe(true);
  });

  test("probeTranscoderSource rejects wrong-size, empty, or nonzero video exit", async () => {
    const service = new KorvoVideoService();

    const spawnSpy = spyOn(Bun, "spawn");
    activeSpies.push(spawnSpy);

    spawnSpy.mockImplementation(() => makeProcessMock({ stdoutBytes: new Uint8Array(3071), exitCode: 0 }) as any);
    expect(await (service as any).probeTranscoderSource("http://example.com/v.mp4", "video")).toBe(false);

    spawnSpy.mockImplementation(() => makeProcessMock({ stdoutBytes: new Uint8Array(0), exitCode: 0 }) as any);
    expect(await (service as any).probeTranscoderSource("http://example.com/v.mp4", "video")).toBe(false);

    spawnSpy.mockImplementation(() => makeProcessMock({ stdoutBytes: new Uint8Array(3072), exitCode: 8 }) as any);
    expect(await (service as any).probeTranscoderSource("http://example.com/v.mp4", "video")).toBe(false);
  });

  test("probeTranscoderSource validates non-empty audio within limit and rejects empty/nonzero", async () => {
    const service = new KorvoVideoService();
    const spawnSpy = spyOn(Bun, "spawn");
    activeSpies.push(spawnSpy);

    spawnSpy.mockImplementation((args: any) => {
      expect(args).toContain("s16le");
      return makeProcessMock({ stdoutBytes: new Uint8Array(7200), exitCode: 0 }) as any;
    });
    expect(await (service as any).probeTranscoderSource("http://example.com/a.m4a", "audio")).toBe(true);

    spawnSpy.mockImplementation(() => makeProcessMock({ stdoutBytes: new Uint8Array(0), exitCode: 0 }) as any);
    expect(await (service as any).probeTranscoderSource("http://example.com/a.m4a", "audio")).toBe(false);

    spawnSpy.mockImplementation(() => makeProcessMock({ stdoutBytes: new Uint8Array(7201), exitCode: 0 }) as any);
    expect(await (service as any).probeTranscoderSource("http://example.com/a.m4a", "audio")).toBe(false);

    spawnSpy.mockImplementation(() => makeProcessMock({ stdoutBytes: new Uint8Array(7200), exitCode: 1 }) as any);
    expect(await (service as any).probeTranscoderSource("http://example.com/a.m4a", "audio")).toBe(false);

    spawnSpy.mockImplementation(() => makeProcessMock({ stdoutBytes: new Uint8Array(7200), stderrBytes: new Uint8Array(16385), exitCode: 0 }) as any);
    expect(await (service as any).probeTranscoderSource("http://example.com/a.m4a", "audio")).toBe(false);

    spawnSpy.mockImplementation(() => ({ exited: Promise.resolve(0), kill: () => {} }) as any);
    expect(await (service as any).probeTranscoderSource("http://example.com/a.m4a", "audio")).toBe(false);
  });

  test("probeTranscoderSource handles missing ffmpeg spawn cleanly", async () => {
    const service = new KorvoVideoService();
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("ffmpeg executable not found");
    });
    activeSpies.push(spawnSpy);

    const ok = await (service as any).probeTranscoderSource("http://example.com/v.mp4", "video");
    expect(ok).toBe(false);
  });

  test("probeTranscoderSource cleans up and returns false on timeout", async () => {
    const service = new KorvoVideoService();
    let killSignal: string | undefined;

    let resolveExit: (code: number) => void;
    const exitedPromise = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });

    const mockProc = {
      stdout: new ReadableStream<Uint8Array>({
        start() {},
        cancel() {},
      }),
      stderr: new ReadableStream<Uint8Array>({
        start() {},
        cancel() {},
      }),
      exited: exitedPromise,
      kill: (sig?: string) => {
        killSignal = sig;
        resolveExit(-9);
      },
    };

    const spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => mockProc as any);
    activeSpies.push(spawnSpy);

    const originalSetTimeout = globalThis.setTimeout;
    const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((cb: (...args: any[]) => void, ms?: number, ...args: any[]) => {
      if (ms === 6000) {
        return originalSetTimeout(() => cb(...args), 2);
      }
      return originalSetTimeout(cb, ms, ...args);
    }) as any);
    activeSpies.push(timeoutSpy);

    const ok = await (service as any).probeTranscoderSource("http://example.com/v.mp4", "video");
    expect(ok).toBe(false);
    expect(killSignal).toBe("SIGKILL");
  });

  test("HTTP probe passes but decode failure triggers alternate retry with android_vr", async () => {
    process.env.KORVO_MEDIA_BASE_URL = "http://127.0.0.1:8080";
    const service = new KorvoVideoService();

    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => ({
      status: 206,
      body: { cancel: async () => {} },
    } as any));
    activeSpies.push(fetchSpy);

    let attemptCounter = 0;
    const spawnedCommands: string[][] = [];

    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((args: any) => {
      const command = args as string[];
      spawnedCommands.push(command);
      if (command[0] === "yt-dlp" || command.some((arg) => arg.includes("ytsearch1:"))) {
        attemptCounter++;
        const metadata = JSON.stringify({
          title: `Attempt ${attemptCounter}`,
          requested_formats: [
            { url: `http://video.url/${attemptCounter}`, vcodec: "avc1" },
            { url: `http://audio.url/${attemptCounter}`, acodec: "mp4a" },
          ],
        });
        return makeProcessMock({ stdoutBytes: new TextEncoder().encode(metadata), exitCode: 0 }) as any;
      }
      // ffmpeg probe invocations
      if (command.includes("scale=32:32")) {
        // Fail video decode on attempt 1, pass on attempt 2
        if (command.includes("http://video.url/1")) {
          return makeProcessMock({ stdoutBytes: new Uint8Array(0), exitCode: 8 }) as any;
        }
        return makeProcessMock({ stdoutBytes: new Uint8Array(3072), exitCode: 0 }) as any;
      }
      if (command.includes("s16le")) {
        return makeProcessMock({ stdoutBytes: new Uint8Array(7200), exitCode: 0 }) as any;
      }
      return makeProcessMock({ exitCode: 0 }) as any;
    });
    activeSpies.push(spawnSpy);

    const media = await (service as any).searchYoutube("YOASOBI Idol");
    expect(media.videoUrl).toBe("http://video.url/2");
    expect(media.audioUrl).toBe("http://audio.url/2");

    const hasAltClientArg = spawnedCommands.some((cmd) =>
      cmd.includes("--extractor-args") && cmd.includes("youtube:player_client=android_vr"),
    );
    expect(hasAltClientArg).toBe(true);
  });

  test("both actual tracks are required; audio failure prevents track acceptance", async () => {
    const service = new KorvoVideoService();

    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => ({
      status: 200,
      body: { cancel: async () => {} },
    } as any));
    activeSpies.push(fetchSpy);

    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((args: any) => {
      const command = args as string[];
      if (command.some((arg) => arg.includes("ytsearch1:"))) {
        const metadata = JSON.stringify({
          title: "Test Title",
          requested_formats: [
            { url: "http://video.url/track", vcodec: "avc1" },
            { url: "http://audio.url/track", acodec: "mp4a" },
          ],
        });
        return makeProcessMock({ stdoutBytes: new TextEncoder().encode(metadata), exitCode: 0 }) as any;
      }
      if (command.includes("scale=32:32")) {
        return makeProcessMock({ stdoutBytes: new Uint8Array(3072), exitCode: 0 }) as any;
      }
      if (command.includes("s16le")) {
        // Audio decode fails
        return makeProcessMock({ stdoutBytes: new Uint8Array(0), exitCode: 1 }) as any;
      }
      return makeProcessMock({ exitCode: 0 }) as any;
    });
    activeSpies.push(spawnSpy);

    await expect((service as any).searchYoutube("test track")).rejects.toThrow(
      "YouTube stream unavailable after two attempts",
    );
  });

  test("both attempts fail decode and does not publish video.start early", async () => {
    process.env.KORVO_MEDIA_BASE_URL = "http://127.0.0.1:8080";
    const service = new KorvoVideoService();

    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => ({
      status: 200,
      body: { cancel: async () => {} },
    } as any));
    activeSpies.push(fetchSpy);

    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((args: any) => {
      const command = args as string[];
      if (command.some((arg) => arg.includes("ytsearch1:"))) {
        const metadata = JSON.stringify({
          title: "Track Failing Both",
          requested_formats: [
            { url: "http://video.url/fail", vcodec: "avc1" },
            { url: "http://audio.url/fail", acodec: "mp4a" },
          ],
        });
        return makeProcessMock({ stdoutBytes: new TextEncoder().encode(metadata), exitCode: 0 }) as any;
      }
      // Both video and audio fail decode on all attempts
      return makeProcessMock({ stdoutBytes: new Uint8Array(0), exitCode: 8 }) as any;
    });
    activeSpies.push(spawnSpy);

    const sentMessages: string[] = [];
    const mockSocket = {
      write: (data: string) => sentMessages.push(data),
      end: () => {},
    };
    (service as any).devices.set("esp32s31-korvo-1", { socket: mockSocket, buffer: "" });

    await expect(
      (service as any).startForDevice("esp32s31-korvo-1", "failing query"),
    ).rejects.toThrow("YouTube stream unavailable after two attempts");

    const publishedStart = sentMessages.some((msg) => msg.includes("video.start"));
    expect(publishedStart).toBe(false);
  });
});
