import { afterEach, expect, test } from "bun:test";
import { KorvoVideoService, parseYoutubeSources } from "../../src/media/korvo-video";

test("adaptive streams retain independently selected video/audio URLs", () => {
  expect(parseYoutubeSources(JSON.stringify({ title: '影片 "測試"', url: "NA", requested_formats: [
    { url: "https://media.test/video", vcodec: "vp9", acodec: "none" },
    { url: "https://media.test/audio", vcodec: "none", acodec: "opus" },
  ] }))).toEqual({ title: '影片 "測試"', videoUrl: "https://media.test/video", audioUrl: "https://media.test/audio" });
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
