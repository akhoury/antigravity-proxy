import {describe, expect, test, afterEach} from "bun:test";
import {VideoClock} from "../../src/media/korvo-video-clock";
import {KorvoVideoService, videoFilter} from "../../src/media/korvo-video";

test("smooth detail reduces spatial payload without changing viewport or audio timing", () => {
  for (const detail of ["native", "smooth"] as const) {
    const filter = videoFilter(24, detail);
    expect(filter.startsWith("fps=fps=24:start_time=0,")).toBe(true);
    expect(filter.endsWith("scale=800:416:force_original_aspect_ratio=decrease,pad=800:416:(ow-iw)/2:(oh-ih)/2:black")).toBe(true);
    expect(filter.includes("scale=400:208")).toBe(detail === "smooth");
  }
});

describe("audio-master frame scheduling", () => {
  test("supports stepped tests through 30 FPS without accepting invalid rates", () => {
    expect(new VideoClock(15).pts(16)).toBe(1000);
    expect(new VideoClock(24).pts(25)).toBe(1000);
    expect(new VideoClock(30).pts(31)).toBe(1000);
    for (const fps of [0, 1.5, 31, 60, NaN]) expect(() => new VideoClock(fps)).toThrow();
  });
  test("does not announce prebuffered video before audio starts", () => {
    const c = new VideoClock<string>(4);
    c.push(1, "first");
    expect(c.takeDue()).toBeUndefined();
    c.advance(0);
    expect(c.takeDue()?.ptsMs).toBe(0);
  });
  test("high-FPS HTTP history covers anticipation without increasing capacity", () => {
    const c = new VideoClock<number>(30);
    expect(c.historyFrames).toBe(22);
    expect(new VideoClock(24).historyFrames).toBe(19);
    expect(new VideoClock(30, 4).historyFrames).toBe(3);
    for (let i = 1; i <= 48; i++) c.push(i, i);
    c.advance(1000);
    expect(c.takeDue()?.sequence).toBe(31);
    expect(c.frames.has(10)).toBe(true);
    expect(c.frames.has(9)).toBe(false);
    expect(c.frames.size).toBeLessThanOrEqual(48);
    expect(c.hasCapacity).toBe(true);
  });
  test("never displays a future frame or advances during an audio underrun", () => {
    const c = new VideoClock<number>(4);
    for (let i = 1; i <= 4; i++) c.push(i, i);
    c.advance(249);
    expect(c.takeDue()?.sequence).toBe(1);
    expect(c.takeDue()).toBeUndefined();
    c.advance(250);
    expect(c.takeDue()?.sequence).toBe(2);
    expect(c.takeDue()).toBeUndefined();
  });
  test("skips stale frames on late clock reports, but never chooses future PTS", () => {
    const c = new VideoClock<number>(4);
    for (let i = 1; i <= 12; i++) c.push(i, i);
    c.advance(2620);
    expect(c.takeDue()?.sequence).toBe(11);
    expect(c.frames.has(4)).toBe(true);
    expect(c.frames.has(3)).toBe(false);
  });
  test("bounds memory and releases capacity after progress", () => {
    const c = new VideoClock<number>(4, 4);
    for (let i = 1; i <= 4; i++) c.push(i, i);
    expect(c.hasCapacity).toBe(false);
    expect(() => c.push(5, 5)).toThrow();
    c.advance(750); c.takeDue();
    expect(c.hasCapacity).toBe(true);
    c.push(5, 5);
  });
  test("decoder EOF is not presentation EOF", () => {
    const c = new VideoClock<number>(4);
    for (let i = 1; i <= 4; i++) c.push(i, i);
    c.ended = true;
    c.advance(750);
    expect(c.finished).toBe(false);
    c.advance(1000);
    expect(c.finished).toBe(true);
  });
  test("rejects backwards, fractional, invalid and excessive positions", () => {
    const c = new VideoClock<number>(4);
    c.advance(100);
    for (const value of [99, 1.5, NaN, Infinity, -1, "100", 86400001]) {
      expect(c.advance(value)).toBe(false);
    }
    expect(c.positionMs).toBe(100);
  });
  test("measured presentation latency creates bounded anticipation", () => {
    const c = new VideoClock<number>(4);
    for (let i = 1; i <= 8; i++) c.push(i, i);
    c.advance(0); c.takeDue();
    expect(c.observePresentation(1, 320)).toBe(true);
    expect(c.leadMs).toBe(80);
    c.advance(170);
    expect(c.takeDue()?.sequence).toBe(2);
    expect(c.observePresentation(2, 510)).toBe(true);
    expect(c.leadMs).toBe(145);
    expect(c.observePresentation(1, 320)).toBe(false);
    expect(c.observePresentation(8, 1000)).toBe(false);
    expect(c.observePresentation(2, 100000)).toBe(false);
  });
  test("feedback cannot push anticipation beyond 600 ms", () => {
    const c = new VideoClock<number>(4);
    for (let i = 1; i <= 20; i++) c.push(i, i);
    for (let i = 1; i < 15; i++) {
      c.advance(i * 250);
      const due = c.takeDue();
      if (due) c.observePresentation(due.sequence, Math.round(due.ptsMs + 1200));
    }
    expect(c.leadMs).toBe(600);
  });
});

describe("YouTube source validation", () => {
  test("accepts valid tracks without a second resolution", async () => {
    const service: any = new KorvoVideoService();
    const clients: boolean[] = [];
    service.resolveYoutube = async (_: string, alternate: boolean) => {
      clients.push(alternate);
      return {title: "test", videoUrl: "https://invalid.test/video", audioUrl: "https://invalid.test/audio"};
    };
    service.probeMediaSource = async () => 206;
    service.probeTranscoderSource = async () => true;
    expect((await service.searchYoutube("test")).title).toBe("test");
    expect(clients).toEqual([false]);
  });
  test("403 triggers one alternate resolution before playback", async () => {
    const service: any = new KorvoVideoService();
    const clients: boolean[] = [];
    service.resolveYoutube = async (_: string, alternate: boolean) => {
      clients.push(alternate);
      const prefix = alternate ? "good" : "bad";
      return {title: "test", videoUrl: `https://invalid.test/${prefix}/video`, audioUrl: `https://invalid.test/${prefix}/audio`};
    };
    service.probeMediaSource = async (url: string) => url.includes("/bad/") ? 403 : 200;
    service.probeTranscoderSource = async () => true;
    expect((await service.searchYoutube("test")).videoUrl).toContain("/good/");
    expect(clients).toEqual([false, true]);
  });
  test("both rejected attempts never publish video.start or retain a session", async () => {
    const service: any = new KorvoVideoService();
    const sent: string[] = [];
    service.devices.set("test-device", {socket: {write: (s: string) => {
      const msg = JSON.parse(s);
      if (msg.type === "video.start") sent.push(s);
    }}});
    let attempts = 0;
    service.resolveYoutube = async () => {
      attempts++;
      return {title: "test", videoUrl: "https://invalid.test/private-video", audioUrl: "https://invalid.test/private-audio"};
    };
    service.probeMediaSource = async () => 403;
    await expect(service.startForDevice("test-device", "test")).rejects.toThrow("YouTube stream unavailable after two attempts");
    expect(attempts).toBe(2);
    expect(sent.length).toBe(0);
    expect(service.sessions.size).toBe(0);
  });
  test("Range probe cancels its response body instead of buffering media", async () => {
    const service: any = new KorvoVideoService();
    const original = globalThis.fetch;
    let canceled = false;
    let range = "";
    globalThis.fetch = (async (_: any, init: any) => {
      range = init.headers.Range;
      return new Response(new ReadableStream({cancel() { canceled = true; }}), {status: 206});
    }) as typeof fetch;
    try {
      expect(await service.probeMediaSource("https://invalid.test/video")).toBe(206);
      expect(range).toBe("bytes=0-1023");
      expect(canceled).toBe(true);
    } finally { globalThis.fetch = original; }
  });
});

describe("gateway device clock integration", () => {
  let service: any;
  const deviceId = "clock-test-device";
  afterEach(() => { if (service) service.stopForDevice(deviceId, "test_cleanup"); });
  async function setup() {
    process.env.KORVO_ALLOWED_DEVICE_ID = deviceId;
    process.env.KORVO_MEDIA_BASE_URL = "http://127.0.0.1:3000";
    process.env.KORVO_VIDEO_FPS = "4";
    process.env.KORVO_MEDIA_API_TOKEN = "synthetic-unit-test-token";
    service = new KorvoVideoService();
    service.searchYoutube = async () => ({title: "test", videoUrl: "https://invalid.test/video", audioUrl: "https://invalid.test/audio"});
    service.startFramePump = () => {};
    const sent: any[] = [];
    const connection = {buffer: "", socket: {write: (s: string) => sent.push(JSON.parse(s)), end: () => {}}};
    service.devices.set(deviceId, connection);
    const session = await service.startForDevice(deviceId, "test");
    await service.consumeJpegBytes(session, new Uint8Array([255,216,255,217,255,216,255,217]));
    return {sent, connection, session};
  }
  function progress(connection: any, id: string, position = 0, playing = true) {
    service.handleDeviceFrame(connection, JSON.stringify({v:1, type:"video.progress", payload:{session_id:id, position_ms:position, playing}}));
  }
  test("prebuffer stays on gateway; matching clock sends timestamped frames", async () => {
    const {sent, connection, session} = await setup();
    expect(sent.filter(f => f.type === "video.frame")).toHaveLength(0);
    progress(connection, session.id, 0);
    expect(sent.at(-1).payload.pts_ms).toBe(0);
    progress(connection, session.id, 250);
    expect(sent.at(-1).payload.pts_ms).toBe(250);
  });
  test("authenticated play FPS override is session-local and rejects invalid values", async () => {
    await setup();
    const url = new URL("http://localhost/api/korvo/video/play");
    const play = (fps: unknown, token = "synthetic-unit-test-token") => service.handleHttp(new Request(url, {
      method:"POST", headers:{"Content-Type":"application/json", "x-korvo-media-token":token},
      body:JSON.stringify({deviceId, query:"test", frame_rate:fps}),
    }), url);
    expect((await play(8, "wrong-token")).status).toBe(401);
    for (const fps of [0, 1.5, 31, "8"]) expect((await play(fps)).status).toBe(400);
    const response = await play(8);
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.frame_rate).toBe(8);
    expect(service.sessions.get(body.id).clock.fps).toBe(8);
    expect(service.frameRate).toBe(4);
  });
  test("authenticated JPEG quality is bounded and session-local", async () => {
    await setup();
    const url = new URL("http://localhost/api/korvo/video/play");
    const play = (quality: unknown, token = "synthetic-unit-test-token") => service.handleHttp(new Request(url, {
      method:"POST", headers:{"Content-Type":"application/json", "x-korvo-media-token":token},
      body:JSON.stringify({deviceId, query:"test", jpeg_quality:quality}),
    }), url);
    expect((await play(14, "wrong-token")).status).toBe(401);
    for (const quality of [0, 32, 1.5, "14", null]) expect((await play(quality)).status).toBe(400);
    for (const quality of [7, 14, 20]) {
      const response = await play(quality);
      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body.jpeg_quality).toBe(quality);
      expect(service.sessions.get(body.id).jpegQuality).toBe(quality);
    }
    const body = await (await play(undefined)).json();
    expect(body.jpeg_quality).toBe(20);
    expect(body.frame_rate).toBe(4);
  });
  test("detail preset is authenticated, bounded and session-local", async () => {
    await setup();
    const url = new URL("http://localhost/api/korvo/video/play");
    const play = (detail: unknown, token = "synthetic-unit-test-token") => service.handleHttp(new Request(url, {
      method:"POST", headers:{"Content-Type":"application/json", "x-korvo-media-token":token},
      body:JSON.stringify({deviceId, query:"test", detail}),
    }), url);
    expect((await play("smooth", "wrong-token")).status).toBe(401);
    for (const detail of [0, null, "invalid"]) expect((await play(detail)).status).toBe(400);
    for (const detail of ["native", "smooth"]) {
      const response = await play(detail);
      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body.detail).toBe(detail);
      expect(service.sessions.get(body.id).detail).toBe(detail);
    }
    expect((await (await play(undefined)).json()).detail).toBe("native");
  });
  test("wrong session and unauthenticated connection cannot advance the clock", async () => {
    const {connection, session} = await setup();
    progress(connection, "not-this-session", 250);
    progress({socket:{}}, session.id, 250);
    expect(session.clock.positionMs).toBeNull();
  });
  test("only the owning connection may report a displayed frame", async () => {
    const {connection, session} = await setup();
    progress(connection, session.id, 0);
    const report = JSON.stringify({v:1, type:"video.presented", payload:{action:`video:${session.id}:1`, value:"320"}});
    service.handleDeviceFrame({socket:{}}, report);
    expect(session.clock.leadMs).toBe(0);
    service.handleDeviceFrame(connection, report);
    expect(session.clock.leadMs).toBe(80);
  });
  test("audio EOF closes the session and timer", async () => {
    const {connection, session} = await setup();
    progress(connection, session.id, 250, false);
    expect(service.sessions.has(session.id)).toBe(false);
    expect(session.stopped).toBe(true);
  });
  test("transcoder failure immediately stops both media paths", async () => {
    const {session, sent} = await setup();
    const failed = {stderr: {async *[Symbol.asyncIterator]() { yield new TextEncoder().encode("Server returned 403"); }}, exited: Promise.resolve(8)};
    service.trackTranscoder(session, failed, "audio");
    await Bun.sleep(10);
    expect(session.stopped).toBe(true);
    expect(sent.some((f: any) => f.type === "video.stop")).toBe(true);
    expect(sent.some((f: any) => f.type === "toast.show")).toBe(true);
  });
  test("stop permits only already-announced JPEGs during bounded grace, never audio", async () => {
    const {connection, session} = await setup();
    progress(connection, session.id, 0);
    service.stopForDevice(deviceId, "test_stop");
    const get = (name: string) => {
      const url = new URL(`http://localhost/api/korvo/video/${session.id}/${name}`);
      return service.handleHttp(new Request(url), url);
    };
    expect(service.sessions.has(session.id)).toBe(false);
    expect((await get("frame-1.jpg")).status).toBe(200);
    expect((await get("frame-2.jpg")).status).toBe(404);
    expect((await get("audio.ogg")).status).toBe(404);
    service.retiredFrames.get(session.id).expiresAt = Date.now() - 1;
    expect((await get("frame-1.jpg")).status).toBe(404);
  });
  test("grace cache retains at most eight announced frames", async () => {
    const {connection, session} = await setup();
    for (let i = 3; i <= 20; i++) session.clock.push(i, {bytes: new Uint8Array([255,216,255,217])});
    progress(connection, session.id, 4500);
    service.stopForDevice(deviceId, "test_stop");
    const frames = service.retiredFrames.get(session.id).frames;
    expect(frames.size).toBe(8);
    expect(frames.has(19)).toBe(true);
    expect(frames.has(20)).toBe(false);
    expect(frames.has(11)).toBe(false);
  });
  test("30FPS grace history remains bounded and never exposes a future frame", async () => {
    const {connection, session} = await setup();
    session.clock = new VideoClock(30);
    for (let i = 1; i <= 48; i++) session.clock.push(i, {bytes:new Uint8Array([255,216,255,217])});
    progress(connection, session.id, 1000);
    service.stopForDevice(deviceId, "test");
    expect(service.retiredFrames.get(session.id).frames.size).toBe(22);
    const getFrame = (sequence: number) => {
      const url = new URL(`http://localhost/api/korvo/video/${session.id}/frame-${sequence}.jpg`);
      return service.handleHttp(new Request(url), url);
    };
    expect((await getFrame(10)).status).toBe(200);
    expect((await getFrame(9)).status).toBe(404);
    expect((await getFrame(32)).status).toBe(404);
  });
  test("rapid replacements cannot retain more than four stopped sessions", async () => {
    const {connection} = await setup();
    for (let i = 0; i < 6; i++) {
      const session = await service.startForDevice(deviceId, "test");
      await service.consumeJpegBytes(session, new Uint8Array([255,216,255,217]));
      progress(connection, session.id, 0);
      service.stopForDevice(deviceId, "test_stop");
    }
    expect(service.retiredFrames.size).toBe(4);
  });
  test("full prefetch cache awaits clock progress instead of throwing", async () => {
    const {connection, session} = await setup();
    session.clock = new VideoClock(4, 4);
    session.nextSequence = 1;
    const chunk = new Uint8Array(Array.from({length: 24}, (_, i) => [255,216,255,217][i % 4]!));
    let finished = false;
    const ingest = service.consumeJpegBytes(session, chunk).then(() => { finished = true; });
    await Bun.sleep(35);
    expect(session.clock.frames.size).toBe(4);
    expect(finished).toBe(false);
    progress(connection, session.id, 750);
    await Bun.sleep(35);
    expect(session.clock.highestSequence).toBe(5);
    progress(connection, session.id, 1000);
    await ingest;
    expect(session.clock.highestSequence).toBe(6);
    expect(session.clock.frames.size).toBeLessThanOrEqual(4);
  });
  test("stop cancels a producer blocked on a full cache", async () => {
    const {session} = await setup();
    session.clock = new VideoClock(4, 4);
    session.nextSequence = 1;
    const chunk = new Uint8Array(Array.from({length: 24}, (_, i) => [255,216,255,217][i % 4]!));
    const ingest = service.consumeJpegBytes(session, chunk);
    await Bun.sleep(35);
    service.stopForDevice(deviceId, "test_stop");
    await ingest;
    expect(session.clock.highestSequence).toBe(4);
  });
  test("presentation EOF clears the timer and does not send further events", async () => {
    const {connection, session, sent} = await setup();
    session.clock.ended = true;
    progress(connection, session.id, 500);
    expect(session.stopped).toBe(true);
    const count = sent.length;
    await Bun.sleep(150);
    expect(sent.length).toBe(count);
  });
});
