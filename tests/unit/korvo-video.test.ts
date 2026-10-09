import { afterEach, expect, test } from "bun:test";
import { KorvoVideoService, audioTranscodeArgs, parseYoutubeSources, parseYoutubeSourceCandidates } from "../../src/media/korvo-video";

test("adaptive streams retain independently selected video/audio URLs", () => {
  expect(parseYoutubeSources(JSON.stringify({ title: '影片 "測試"', url: "NA", requested_formats: [
    { url: "https://media.test/video", vcodec: "vp9", acodec: "none" },
    { url: "https://media.test/audio", vcodec: "none", acodec: "opus" },
  ] }))).toEqual({ title: '影片 "測試"', videoUrl: "https://media.test/video", audioUrl: "https://media.test/audio" });
});

test("known video duration bounds audio transcoding and reconnects an early EOF", () => {
  const media = parseYoutubeSources(JSON.stringify({ title: "long video", duration: 216, url: "NA",
    requested_formats: [
      { url: "https://media.test/video", vcodec: "vp9", acodec: "none" },
      { url: "https://media.test/audio", vcodec: "none", acodec: "opus" },
    ] }));
  expect(media.durationSeconds).toBe(216);
  const args = audioTranscodeArgs("ffmpeg", media.audioUrl, undefined, media.durationSeconds);
  expect(args).toContain("-reconnect_at_eof");
  expect(args.slice(args.indexOf("-af"), args.indexOf("-af") + 4)).toEqual(["-af", "apad", "-t", "216"]);
  expect(args.indexOf("-reconnect_at_eof")).toBeLessThan(args.indexOf("-i"));
  const unknown = audioTranscodeArgs("ffmpeg", "https://media.test/audio");
  expect(unknown).not.toContain("-reconnect_at_eof");
  expect(unknown).not.toContain("-af");
  expect(parseYoutubeSources(JSON.stringify({duration: 100000, url: "https://media.test/muxed"})).durationSeconds)
    .toBeUndefined();
});

test("selected formats retain the User-Agent required by FFmpeg", () => {
  const result = parseYoutubeSources(JSON.stringify({ title: "test", url: "NA", requested_formats: [
    { url: "https://media.test/video", vcodec: "vp9", acodec: "none",
      http_headers: { "User-Agent": "Video-Agent/1" } },
    { url: "https://media.test/audio", vcodec: "none", acodec: "opus",
      http_headers: { "User-Agent": "Audio-Agent/2" } },
  ] }));
  expect(result.videoUserAgent).toBe("Video-Agent/1");
  expect(result.audioUserAgent).toBe("Audio-Agent/2");
});

test("muxed result accepts yt-dlp's missing-array placeholder", () => {
  expect(parseYoutubeSources('{"url":"https://media.test/muxed","requested_formats":"NA"}'))
    .toEqual({ title: undefined, videoUrl: "https://media.test/muxed", audioUrl: "https://media.test/muxed" });
});

test("invalid JSON and unplayable URLs fail without accepting local files", () => {
  for (const value of ["null", "[]", "not json"]) expect(() => parseYoutubeSources(value)).toThrow("invalid metadata");
  for (const value of ['{"url":"file:///etc/passwd"}', '{"requested_formats":[null]}', '{}']) {
    expect(() => parseYoutubeSources(value)).toThrow("no playable");
  }
});

test("search candidates skip an unavailable first result", () => {
  const unplayable = JSON.stringify({ title: "removed", url: "NA", requested_formats: "NA" });
  const playable = JSON.stringify({ title: "available", url: "https://media.test/video", requested_formats: "NA" });
  expect(parseYoutubeSourceCandidates(`${unplayable}\n${playable}\n`)).toEqual([
    { title: "available", videoUrl: "https://media.test/video", audioUrl: "https://media.test/video" },
  ]);
  expect(() => parseYoutubeSourceCandidates(`${unplayable}\n`)).toThrow("no playable results");
});

test("source validation falls back to the next search result", async () => {
  const service = new KorvoVideoService();
  (service as any).resolveYoutube = async () => [
    { title: "blocked", videoUrl: "https://media.test/blocked", audioUrl: "https://media.test/blocked" },
    { title: "available", videoUrl: "https://media.test/available", audioUrl: "https://media.test/available" },
  ];
  (service as any).probeMediaSource = async (url: string) => url.endsWith("blocked") ? 403 : 206;
  (service as any).probeTranscoderSource = async () => true;
  expect((await (service as any).searchYoutube("test")).title).toBe("available");
});

test("fresh default-client resolution recovers after a transient 403 round", async () => {
  const service = new KorvoVideoService();
  let resolutions = 0;
  (service as any).resolveYoutube = async (_query: string, alternate: boolean) => {
    expect(alternate).toBe(false);
    const suffix = ++resolutions === 1 ? "blocked" : "available";
    return [{ title: suffix, videoUrl: `https://media.test/${suffix}`,
      audioUrl: `https://media.test/${suffix}` }];
  };
  (service as any).probeMediaSource = async (url: string) => url.endsWith("blocked") ? 403 : 206;
  (service as any).probeTranscoderSource = async () => true;
  expect((await (service as any).searchYoutube("test")).title).toBe("available");
  expect(resolutions).toBe(2);
});

const previousToken = process.env.KORVO_MEDIA_API_TOKEN;
afterEach(() => {
  if (previousToken === undefined) delete process.env.KORVO_MEDIA_API_TOKEN;
  else process.env.KORVO_MEDIA_API_TOKEN = previousToken;
});

test("stop remains token protected and is idempotent for a valid device", async () => {
  process.env.KORVO_MEDIA_API_TOKEN = "unit-test-token";
  const service = new KorvoVideoService();
  const url = new URL("http://localhost/api/korvo/video/stop");
  expect((await service.handleHttp(new Request(url, { method: "POST" }), url))?.status).toBe(401);
  const request = () => new Request(url, { method: "POST", headers: { "x-korvo-media-token": "unit-test-token" },
    body: JSON.stringify({ deviceId: "esp32s31-korvo-1" }) });
  expect((await service.handleHttp(request(), url))?.status).toBe(200);
  expect((await service.handleHttp(request(), url))?.status).toBe(200);
});


test("stalled audio clock retries a fresh stream once, then stops", async () => {
  const previousBase = process.env.KORVO_MEDIA_BASE_URL;
  process.env.KORVO_MEDIA_BASE_URL = "http://localhost:3000";
  const service = new KorvoVideoService() as any;
  const outbound: any[] = [];
  service.devices.set("esp32s31-korvo-1", {
    socket: { write: (line: string) => outbound.push(JSON.parse(line)), end() {} }, buffer: "",
  });
  service.searchYoutube = async () => ({
    title: "test", videoUrl: "https://media.test/video", audioUrl: "https://media.test/audio",
  });
  service.startFramePump = () => {};
  try {
    const first = await service.startForDevice("esp32s31-korvo-1", "test");
    first.clock.lastAdvanceAt = Date.now() - 16_000;
    await Bun.sleep(80);
    const second = [...service.sessions.values()][0];
    expect(second).toBeDefined();
    expect(second.id).not.toBe(first.id);
    expect(second.recoveryAttempt).toBe(1);
    second.clock.lastAdvanceAt = Date.now() - 31_000;
    await Bun.sleep(80);
    expect(service.sessions.size).toBe(0);
    expect(outbound.some(frame => frame.type === "toast.show" &&
      frame.payload.body === "Audio clock timed out")).toBe(true);
  } finally {
    service.stopForDevice("esp32s31-korvo-1", "test_cleanup");
    if (previousBase === undefined) delete process.env.KORVO_MEDIA_BASE_URL;
    else process.env.KORVO_MEDIA_BASE_URL = previousBase;
  }
});
