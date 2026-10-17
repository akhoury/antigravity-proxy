const CONTROL_FRAME_LIMIT = 4096;
const JPEG_FRAME_LIMIT = 1_500_000;
import { VideoClock, MAX_VIDEO_FPS } from "./korvo-video-clock";
const DEFAULT_FRAME_RATE = 30;
const DEFAULT_JPEG_QUALITY = 20;
type VideoDetail = "native" | "smooth";
const DEFAULT_VIDEO_DETAIL: VideoDetail = "native";

export function videoFilter(fps: number, detail: VideoDetail): string {
  const preScale = detail === "smooth" ? ",scale=400:240:force_original_aspect_ratio=decrease" : "";
  return `fps=fps=${fps}:start_time=0${preScale},scale=800:480:force_original_aspect_ratio=decrease,pad=800:480:(ow-iw)/2:(oh-ih)/2:black`;
}
// Project before serialization: full yt-dlp metadata includes descriptions,
// every available format and potentially thousands of manifest fragments.
export const YOUTUBE_METADATA_TEMPLATE = '{"title":%(title)j,"duration":%(duration)j,"url":%(url)j,"http_headers":%(http_headers)j,"requested_formats":%(requested_formats.:.{url,vcodec,acodec,http_headers})j}';

type DeviceSocket = {
  write(data: string): unknown;
  end(): void;
};

type VideoFrame = {
  bytes: Uint8Array<ArrayBuffer>;
};

type VideoSession = {
  id: string;
  deviceId: string;
  title: string;
  query: string;
  durationSeconds?: number;
  recoveryAttempt: number;
  lastProgressAt?: number;
  lastProgressPlaying?: boolean;
  audioProcessExitCode?: number;
  videoSourceUrl: string;
  audioSourceUrl: string;
  videoUserAgent?: string;
  audioUserAgent?: string;
  clock: VideoClock<VideoFrame>;
  jpegQuality: number;
  detail: VideoDetail;
  clockTimer?: ReturnType<typeof setInterval>;
  partialJpeg: Uint8Array;
  nextSequence: number;
  stopped: boolean;
  frameProcess?: any;
  audioProcess?: any;
};

type DeviceConnection = {
  socket: DeviceSocket;
  buffer: string;
};

type YoutubeFormat = {
  url?: string;
  vcodec?: string;
  acodec?: string;
  http_headers?: Record<string, string>;
};

type YoutubeMetadata = {
  title?: string;
  duration?: number;
  url?: string;
  http_headers?: Record<string, string>;
  requested_formats?: YoutubeFormat[];
};

type MediaSources = {
  title?: string;
  durationSeconds?: number;
  videoUrl: string;
  audioUrl: string;
  videoUserAgent?: string;
  audioUserAgent?: string;
};

const textDecoder = new TextDecoder();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function compactId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function isSafeDeviceId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,47}$/.test(value);
}

function isSafeQuery(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function isHttpSource(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 8192) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function userAgentFrom(headers: Record<string, string> | undefined): string | undefined {
  const value = headers?.["User-Agent"];
  return typeof value === "string" && /^[\x20-\x7e]{1,256}$/.test(value) ? value : undefined;
}

export function parseYoutubeSources(stdout: string): MediaSources {
  let metadata: YoutubeMetadata;
  try {
    metadata = JSON.parse(stdout) as YoutubeMetadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error();
  } catch {
    throw new Error("YouTube search returned invalid metadata");
  }
  // A missing output-template field is emitted as "NA", including on muxed results.
  const formats = Array.isArray(metadata.requested_formats) ? metadata.requested_formats : [];
  const videoFormat = formats.find((format) =>
    format?.vcodec && format.vcodec !== "none" && isHttpSource(format.url));
  const audioFormat = formats.find((format) =>
    format?.acodec && format.acodec !== "none" && isHttpSource(format.url));
  const title = typeof metadata.title === "string" ? metadata.title : undefined;
  const durationSeconds = typeof metadata.duration === "number" &&
    Number.isFinite(metadata.duration) && metadata.duration > 0 && metadata.duration <= 86400
    ? metadata.duration : undefined;
  const duration = durationSeconds !== undefined ? { durationSeconds } : {};
  if (videoFormat && audioFormat) {
    const videoUserAgent = userAgentFrom(videoFormat.http_headers);
    const audioUserAgent = userAgentFrom(audioFormat.http_headers);
    return { title, ...duration, videoUrl: videoFormat.url!, audioUrl: audioFormat.url!,
      ...(videoUserAgent ? { videoUserAgent } : {}), ...(audioUserAgent ? { audioUserAgent } : {}) };
  }
  if (isHttpSource(metadata.url)) {
    const userAgent = userAgentFrom(metadata.http_headers);
    return { title, ...duration, videoUrl: metadata.url, audioUrl: metadata.url,
      ...(userAgent ? { videoUserAgent: userAgent, audioUserAgent: userAgent } : {}) };
  }
  throw new Error("YouTube search returned no playable audio/video sources");
}

// A long lived YouTube HTTP connection can close before the media ends. Resume
// from the current byte offset; if recovery still fails, keep the Ogg stream
// valid and the device clock moving through the video's known duration.
export function audioTranscodeArgs(ffmpegPath: string, url: string, userAgent?: string,
    durationSeconds?: number): string[] {
  return [
    ffmpegPath, "-nostdin", "-re", "-v", "error",
    "-reconnect", "1",
    ...(durationSeconds !== undefined ? ["-reconnect_at_eof", "1"] : []),
    "-reconnect_streamed", "1", "-reconnect_on_network_error", "1",
    "-reconnect_on_http_error", "5xx", "-reconnect_delay_max", "2",
    ...(userAgent ? ["-user_agent", userAgent] : []),
    "-i", url,
    "-vn", "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "80k",
    ...(durationSeconds !== undefined ? ["-af", "apad", "-t", String(durationSeconds)] : []),
    "-f", "ogg", "pipe:1",
  ];
}

export function parseYoutubeSourceCandidates(stdout: string): MediaSources[] {
  const candidates: MediaSources[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { candidates.push(parseYoutubeSources(line)); } catch {}
  }
  if (!candidates.length) throw new Error("YouTube search returned no playable results");
  return candidates;
}

function concatBytes(first: Uint8Array, second: Uint8Array): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(first.length + second.length);
  output.set(first);
  output.set(second, first.length);
  return output;
}

function findMarker(data: Uint8Array, first: number, second: number, start = 0): number {
  for (let index = start; index + 1 < data.length; index++) {
    if (data[index] === first && data[index + 1] === second) return index;
  }
  return -1;
}

async function collectProcess(stream: ReadableStream<Uint8Array>, limit = 256 * 1024): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) {
        await reader.cancel();
        throw new Error("media tool response exceeds limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return textDecoder.decode(output);
}

export class KorvoVideoService {
  private readonly sessions = new Map<string, VideoSession>();
  private readonly retiredFrames = new Map<string, {
    frames: Map<number, VideoFrame>;
    expiresAt: number;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly devices = new Map<string, DeviceConnection>();
  private readonly deviceGenerations = new Map<string, number>();
  private readonly mediaBaseUrl: string;
  private readonly ytDlpPath: string;
  private readonly ffmpegPath: string;
  private readonly allowedDeviceId: string;
  private readonly apiToken: string;
  private readonly frameRate: number;

  constructor() {
    this.mediaBaseUrl = (process.env.KORVO_MEDIA_BASE_URL || "").replace(/\/+$/, "");
    this.ytDlpPath = process.env.KORVO_YTDLP_PATH || "yt-dlp";
    this.ffmpegPath = process.env.KORVO_FFMPEG_PATH || "ffmpeg";
    this.allowedDeviceId = process.env.KORVO_ALLOWED_DEVICE_ID || "esp32s31-korvo-1";
    this.apiToken = process.env.KORVO_MEDIA_API_TOKEN || "";
    const requestedFps = Number.parseInt(process.env.KORVO_VIDEO_FPS || "", 10);
    this.frameRate = Number.isFinite(requestedFps) && requestedFps >= 1 && requestedFps <= MAX_VIDEO_FPS
      ? requestedFps
      : DEFAULT_FRAME_RATE;
  }

  startControlServer(port: number, hostname: string): void {
    Bun.listen({
      hostname,
      port,
      socket: {
        open: (socket: any) => {
          (socket as DeviceSocket & { data?: DeviceConnection }).data = { socket, buffer: "" };
        },
        data: (socket: any, chunk: Uint8Array) => {
          const connection = socket.data as DeviceConnection | undefined;
          if (!connection) return;
          connection.buffer += textDecoder.decode(chunk, { stream: true });
          if (connection.buffer.length > CONTROL_FRAME_LIMIT * 2) {
            socket.end();
            return;
          }
          let newline = connection.buffer.indexOf("\n");
          while (newline >= 0) {
            const line = connection.buffer.slice(0, newline).trim();
            connection.buffer = connection.buffer.slice(newline + 1);
            if (line.length > 0) this.handleDeviceFrame(connection, line);
            newline = connection.buffer.indexOf("\n");
          }
        },
        close: (socket: any) => this.removeConnection(socket.data as DeviceConnection | undefined),
        error: (socket: any) => this.removeConnection(socket.data as DeviceConnection | undefined),
      },
    });
    console.log(`Korvo video control listening on tcp://${hostname}:${port}`);
  }

  async handleHttp(request: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    if (request.method === "POST" && (path === "/api/korvo/video/play" || path === "/api/korvo/video/stop")) {
      if (!this.apiToken || request.headers.get("x-korvo-media-token") !== this.apiToken) {
        return jsonResponse({ error: "media API token is required" }, 401);
      }
      let body: { deviceId?: unknown; query?: unknown; frame_rate?: unknown; jpeg_quality?: unknown; detail?: unknown };
      try {
        const parsed = await request.json();
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return jsonResponse({ error: "invalid JSON object" }, 400);
        }
        body = parsed as { deviceId?: unknown; query?: unknown; frame_rate?: unknown; jpeg_quality?: unknown; detail?: unknown };
      } catch {
        return jsonResponse({ error: "invalid JSON" }, 400);
      }
      if (!isSafeDeviceId(body.deviceId) || (path.endsWith("/play") && !isSafeQuery(body.query))) {
        return jsonResponse({ error: "deviceId or query is invalid" }, 400);
      }
      if (path.endsWith("/play") && body.frame_rate !== undefined &&
          (typeof body.frame_rate !== "number" || !Number.isInteger(body.frame_rate) ||
           body.frame_rate < 1 || body.frame_rate > MAX_VIDEO_FPS)) {
        return jsonResponse({ error: `frame_rate must be an integer from 1 to ${MAX_VIDEO_FPS}` }, 400);
      }
      if (path.endsWith("/play") && body.jpeg_quality !== undefined &&
          (typeof body.jpeg_quality !== "number" || !Number.isInteger(body.jpeg_quality) ||
           body.jpeg_quality < 1 || body.jpeg_quality > 31)) {
        return jsonResponse({ error: "jpeg_quality must be an integer from 1 to 31" }, 400);
      }
      if (path.endsWith("/play") && body.detail !== undefined && body.detail !== "native" && body.detail !== "smooth") {
        return jsonResponse({ error: "detail must be native or smooth" }, 400);
      }
      if (path.endsWith("/stop")) {
        const dId = body.deviceId as string;
        this.deviceGenerations.set(dId, (this.deviceGenerations.get(dId) || 0) + 1);
        this.stopForDevice(dId, "api_exit");
        return jsonResponse({ stopped: true });
      }
      try {
        console.log("KORVO_VIDEO_LIFECYCLE", JSON.stringify({ event: "received_request", deviceId: body.deviceId }));
        const session = await this.startForDevice(body.deviceId as string, body.query as string,
          body.frame_rate as number | undefined, body.jpeg_quality as number | undefined,
          body.detail as VideoDetail | undefined);
        return jsonResponse({ id: session.id, title: session.title, frame_rate: session.clock.fps,
          jpeg_quality: session.jpegQuality, detail: session.detail }, 202);
      } catch (error) {
        const msg = error instanceof Error ? error.message : "video start failed";
        return jsonResponse({ error: msg.includes("superseded") ? "Request superseded" : "video start failed" }, msg.includes("superseded") ? 409 : 502);
      }
    }

    const match = path.match(/^\/api\/korvo\/video\/([a-f0-9]{32})\/(audio\.ogg|frame-(\d+)\.jpg)$/);
    if (!match) return null;
    const session = this.sessions.get(match[1]);
    if (match[2] === "audio.ogg") {
      return session && !session.stopped ? this.streamAudio(session) : new Response("Not Found", { status: 404 });
    }
    const sequence = Number.parseInt(match[3], 10);
    // A stop closes control/audio immediately, but an already-announced JPEG
    // may still be in flight on the device's independent HTTP worker.
    const retired = this.retiredFrames.get(match[1]);
    const live = session && !session.stopped;
    const frame = live ? session.clock.frames.get(sequence) :
      retired && retired.expiresAt > Date.now() ? retired.frames.get(sequence) : undefined;
    if (!frame) return new Response(live ? "Frame expired" : "Not Found", { status: live ? 410 : 404 });
    return new Response(frame.bytes, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "image/jpeg",
        "Content-Length": String(frame.bytes.length),
      },
    });
  }

  private handleDeviceFrame(connection: DeviceConnection, line: string): void {
    if (line.length > CONTROL_FRAME_LIMIT) return;
    let frame: { v?: unknown; type?: unknown; payload?: unknown };
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (frame.v !== 1 || typeof frame.type !== "string" || !frame.payload || typeof frame.payload !== "object") {
      return;
    }
    const payload = frame.payload as Record<string, unknown>;
    if (frame.type === "device.hello") {
      const deviceId = payload.device_id;
      if (!isSafeDeviceId(deviceId) || deviceId !== this.allowedDeviceId) {
        connection.socket.end();
        return;
      }
      this.devices.set(deviceId, connection);
      this.send(deviceId, "ai.state", { state: "idle" });
      return;
    }
    if (frame.type === "device.status" || frame.type === "ui.status") {
      const allowed = new Set(["idle", "ready", "playing", "video_loading", "screen", "ok", "connected", "rejected", "full", "status"]);
      const statusVal = String(payload.video || payload.ui_queue || payload.state || payload.status || payload.screen || "");
      console.log("KORVO_VIDEO_LIFECYCLE", JSON.stringify({ event: "device_status", status: allowed.has(statusVal) ? statusVal : "unknown" }));
      const deviceId = this.deviceIdFor(connection);
      if (deviceId && (payload.video === "rejected" || (payload.screen === "video" && (payload.state === "rejected" || payload.status === "rejected")))) {
        this.send(deviceId, "toast.show", { title: "Video unavailable", body: "Video request failed" });
        this.stopForDevice(deviceId, "rejected");
      }
      return;
    }
    if (frame.type === "asset.error") {
      // Device reports a bounded, local decoder/HTTP reason. Keep it in server
      // logs so intermittent JPEG failures can be diagnosed after the fact.
      const reason = typeof payload.value === "string" ? payload.value.slice(0, 120) : "unknown";
      console.warn("KORVO_ASSET_ERROR", JSON.stringify({reason}));
      return;
    }
    if (frame.type === "protocol.error") {
      const allowedCodes = new Set([
        "invalid_json",
        "missing_type",
        "invalid_type",
        "missing_payload",
        "invalid_payload",
        "unknown_command",
        "invalid_command",
        "invalid_param",
        "bad_request",
        "unsupported",
        "payload_too_large",
        "rejected",
        "overflow",
        "parse_error",
      ]);
      const codeVal = typeof payload.code === "string" ? payload.code : "";
      console.log("KORVO_VIDEO_LIFECYCLE", JSON.stringify({
        event: "protocol_error",
        code: allowedCodes.has(codeVal) ? codeVal : "unknown",
      }));
      return;
    }
    if (frame.type === "video.request" && payload.action === "play" && isSafeQuery(payload.value)) {
      const deviceId = this.deviceIdFor(connection);
      if (deviceId) {
        const reqGen = (this.deviceGenerations.get(deviceId) || 0) + 1;
        this.deviceGenerations.set(deviceId, reqGen);
        console.log("KORVO_VIDEO_LIFECYCLE", JSON.stringify({ event: "received_request", deviceId }));
        void this.startForDevice(deviceId, payload.value, undefined, undefined, undefined, reqGen).catch(() => {});
      }
      return;
    }
    if (frame.type === "video.action" && payload.action === "exit") {
      const deviceId = this.deviceIdFor(connection);
      if (deviceId) {
        this.deviceGenerations.set(deviceId, (this.deviceGenerations.get(deviceId) || 0) + 1);
        this.stopForDevice(deviceId, "device_exit");
      }
    }
    if (frame.type === "video.progress" && typeof payload.session_id === "string" &&
        typeof payload.playing === "boolean") {
      const deviceId = this.deviceIdFor(connection);
      const session = this.sessions.get(payload.session_id);
      if (!session || session.deviceId !== deviceId || session.stopped) return;
      session.lastProgressAt = Date.now();
      session.lastProgressPlaying = payload.playing;
      if (session.clock.advance(payload.position_ms)) this.flushDueFrame(session);
      if (!payload.playing && !session.stopped && this.sessions.get(session.id) === session) this.stopSession(session, "audio_ended");
    }
    if (frame.type === "video.presented" && typeof payload.action === "string" &&
        typeof payload.value === "string" && /^\d{1,8}$/.test(payload.value)) {
      const match = /^video:([a-f0-9]{32}):(\d+)$/.exec(payload.action);
      const session = match ? this.sessions.get(match[1]!) : undefined;
      if (!match || !session || session.stopped || session.deviceId !== this.deviceIdFor(connection)) return;
      session.clock.observePresentation(Number(match[2]), Number(payload.value));
    }
  }

  private removeConnection(connection: DeviceConnection | undefined): void {
    if (!connection) return;
    for (const [deviceId, active] of this.devices.entries()) {
      if (active === connection) {
        this.devices.delete(deviceId);
        this.deviceGenerations.set(deviceId, (this.deviceGenerations.get(deviceId) || 0) + 1);
      }
    }
  }

  private deviceIdFor(connection: DeviceConnection): string | undefined {
    for (const [deviceId, active] of this.devices.entries()) {
      if (active === connection) return deviceId;
    }
    return undefined;
  }

  private async startForDevice(deviceId: string, query: string, frameRate = this.frameRate,
      jpegQuality = DEFAULT_JPEG_QUALITY, detail = DEFAULT_VIDEO_DETAIL, existingGen?: number,
      recoveryAttempt = 0): Promise<VideoSession> {
    if (!this.mediaBaseUrl) throw new Error("KORVO_MEDIA_BASE_URL is not configured");
    const connection = this.devices.get(deviceId);
    if (!connection) throw new Error("Korvo device is not connected");
    const generation = existingGen ?? ((this.deviceGenerations.get(deviceId) || 0) + 1);
    this.deviceGenerations.set(deviceId, generation);
    this.send(deviceId, "ai.state", { state: "video_loading" });
    this.stopForDevice(deviceId, "replaced");
    let media: MediaSources;
    try {
      media = await this.searchYoutube(query.trim());
      console.log("KORVO_VIDEO_LIFECYCLE", JSON.stringify({ event: "source_ready", deviceId, generation }));
    } catch (err) {
      if (this.deviceGenerations.get(deviceId) !== generation) {
        console.log("KORVO_VIDEO_LIFECYCLE", JSON.stringify({ event: "source_failed", deviceId, generation, reason: "superseded" }));
        throw new Error("Request superseded");
      }
      this.send(deviceId, "toast.show", { title: "Video unavailable", body: "Video request failed" });
      console.log("KORVO_VIDEO_LIFECYCLE", JSON.stringify({ event: "source_failed", deviceId, generation, reason: "search_failed" }));
      throw err;
    }
    if (this.deviceGenerations.get(deviceId) !== generation) {
      console.log("KORVO_VIDEO_LIFECYCLE", JSON.stringify({ event: "source_failed", deviceId, generation, reason: "superseded" }));
      throw new Error("Request superseded");
    }
    if (this.devices.get(deviceId) !== connection) {
      console.log("KORVO_VIDEO_LIFECYCLE", JSON.stringify({ event: "source_failed", deviceId, generation, reason: "disconnected" }));
      throw new Error("Device disconnected");
    }
    const session: VideoSession = {
      id: compactId(),
      deviceId,
      title: media.title || query.trim(),
      query: query.trim(),
      durationSeconds: media.durationSeconds,
      recoveryAttempt,
      videoSourceUrl: media.videoUrl,
      audioSourceUrl: media.audioUrl,
      videoUserAgent: media.videoUserAgent,
      audioUserAgent: media.audioUserAgent,
      clock: new VideoClock(frameRate),
      jpegQuality,
      detail,
      partialJpeg: new Uint8Array(),
      nextSequence: 1,
      stopped: false,
    };
    this.sessions.set(session.id, session);
    session.clockTimer = setInterval(() => {
      if (session.stopped) return;
      const stalledForMs = Date.now() - session.clock.lastAdvanceAt;
      const timeoutMs = session.recoveryAttempt === 0 ? 15_000 : 30_000;
      if (stalledForMs > timeoutMs) {
        if (this.sessions.get(session.id) !== session) return;
        console.warn("KORVO_AUDIO_STALL", JSON.stringify({
          attempt: session.recoveryAttempt, stalledForMs,
          audioMs: session.clock.positionMs,
          lastProgressAgeMs: session.lastProgressAt ? Date.now() - session.lastProgressAt : null,
          lastProgressPlaying: session.lastProgressPlaying ?? null,
          audioProcessExitCode: session.audioProcessExitCode ?? null,
        }));
        if (session.recoveryAttempt === 0) {
          void this.startForDevice(session.deviceId, session.query, session.clock.fps,
            session.jpegQuality, session.detail, undefined, 1).catch(() => {});
        } else {
          this.send(session.deviceId, "toast.show", {title: "Video stopped", body: "Audio clock timed out"});
          this.stopSession(session, "audio_clock_timeout");
        }
      } else this.flushDueFrame(session);
    }, 20);
    console.log("KORVO_VIDEO_LIFECYCLE", JSON.stringify({ event: "publish_start", deviceId, sessionId: session.id, fps: session.clock.fps }));
    this.send(deviceId, "video.start", {
      title: session.title,
      audio_url: `${this.mediaBaseUrl}/api/korvo/video/${session.id}/audio.ogg`,
      frame_rate: session.clock.fps,
    });
    this.startFramePump(session);
    return session;
  }

  private async searchYoutube(query: string): Promise<MediaSources> {
    // Search multiple results: the first match can be removed, blocked, or have
    // signed streams that ffmpeg cannot open. Keep the full search below the
    // control API's 75-second timeout and validate before video.start.
    const deadline = Date.now() + 68_000;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) {
        // YouTube intermittently rejects every fresh signed stream for a few
        // seconds. A delayed default-client retry succeeds where immediately
        // switching to android_vr returns the same 403 or no adaptive formats.
        const backoffMs = attempt * 1500;
        if (Date.now() + backoffMs + 35_000 > deadline) break;
        await Bun.sleep(backoffMs);
      }
      let candidates: MediaSources[];
      try {
        candidates = await this.resolveYoutube(query, false);
      } catch {
        console.warn("KORVO_MEDIA_SOURCE_RETRY", JSON.stringify({attempt: attempt + 1, resolutionFailed: true}));
        continue;
      }
      for (let index = 0; index < candidates.length; index++) {
        if (Date.now() + 12_000 > deadline) break;
        const media = candidates[index];
        try {
          const probes = await Promise.allSettled([
            this.probeMediaSource(media.videoUrl, media.videoUserAgent),
            this.probeMediaSource(media.audioUrl, media.audioUserAgent),
          ]);
          const status = probes.map(p => p.status === "fulfilled" ? p.value : 0);
          if (status.every(code => code === 200 || code === 206)) {
            const [videoValid, audioValid] = await Promise.all([
              this.probeTranscoderSource(media.videoUrl, "video", media.videoUserAgent),
              this.probeTranscoderSource(media.audioUrl, "audio", media.audioUserAgent),
            ]);
            if (videoValid && audioValid) return media;
            console.warn("KORVO_MEDIA_SOURCE_RETRY", JSON.stringify({attempt: attempt + 1, candidate: index + 1, videoValid, audioValid}));
          } else {
            console.warn("KORVO_MEDIA_SOURCE_RETRY", JSON.stringify({attempt: attempt + 1, candidate: index + 1, status}));
          }
        } catch {
          console.warn("KORVO_MEDIA_SOURCE_RETRY", JSON.stringify({attempt: attempt + 1, candidate: index + 1, probeFailed: true}));
        }
      }
    }
    throw new Error("YouTube stream unavailable after candidate validation");
  }

  private async probeTranscoderSource(url: string, kind: "video" | "audio", userAgent?: string): Promise<boolean> {
    const args = kind === "video"
      ? [
          this.ffmpegPath,
          "-nostdin", "-v", "error", "-rw_timeout", "5000000",
          ...(userAgent ? ["-user_agent", userAgent] : []), "-i", url,
          "-an", "-frames:v", "1", "-vf", "scale=32:32", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
        ]
      : [
          this.ffmpegPath,
          "-nostdin", "-v", "error", "-rw_timeout", "5000000",
          ...(userAgent ? ["-user_agent", userAgent] : []), "-i", url,
          "-vn", "-t", "0.15", "-ac", "1", "-ar", "24000", "-f", "s16le", "pipe:1",
        ];

    let proc: any;
    try {
      proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    } catch {
      return false;
    }

    let timedOut = false;
    const readers: any[] = [];
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill("SIGKILL"); } catch {}
      for (const r of readers) {
        try { r.cancel().catch(() => {}); } catch {}
      }
    }, 6000);

    const drainStream = async (stream: any, limit: number): Promise<{ length: number; error: boolean }> => {
      if (!stream) return { length: 0, error: true };
      let reader: any;
      try {
        reader = stream.getReader();
      } catch {
        return { length: 0, error: true };
      }
      readers.push(reader);
      let length = 0;
      let error = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > limit) {
            error = true;
            try { reader.cancel().catch(() => {}); } catch {}
            break;
          }
        }
      } catch {
        error = true;
      } finally {
        const idx = readers.indexOf(reader);
        if (idx !== -1) readers.splice(idx, 1);
        try { reader.releaseLock(); } catch {}
      }
      return { length, error };
    };

    try {
      const [stdoutRes, stderrRes, exitCode] = await Promise.all([
        drainStream(proc.stdout, 32768),
        drainStream(proc.stderr, 16384),
        proc.exited.catch(() => -1),
      ]);

      if (timedOut || exitCode !== 0 || stdoutRes.error || stderrRes.error) {
        console.warn("KORVO_MEDIA_PROBE_RESULT", JSON.stringify({kind, timedOut, exitCode,
          stdoutLength: stdoutRes.length, stderrLength: stderrRes.length,
          stdoutError: stdoutRes.error, stderrError: stderrRes.error}));
        return false;
      }
      const valid = kind === "video" ? stdoutRes.length === 3072
        : stdoutRes.length > 0 && stdoutRes.length <= 32768 && stdoutRes.length % 2 === 0;
      if (!valid) console.warn("KORVO_MEDIA_PROBE_RESULT", JSON.stringify({kind, exitCode,
        stdoutLength: stdoutRes.length, stderrLength: stderrRes.length, invalidLength: true}));
      return valid;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      try { proc.kill("SIGKILL"); } catch {}
      for (const r of readers) {
        try { r.cancel().catch(() => {}); } catch {}
      }
      try { await proc.exited; } catch {}
    }
  }

  private async probeMediaSource(url: string, userAgent?: string): Promise<number> {
    const headers = {Range: "bytes=0-1023", ...(userAgent ? {"User-Agent": userAgent} : {})};
    const response = await fetch(url, {headers, signal: AbortSignal.timeout(5000)});
    try { return response.status; }
    finally { await response.body?.cancel(); } // No media buffering/download.
  }

  private async resolveYoutube(query: string, alternateClient: boolean): Promise<MediaSources[]> {
    const process = Bun.spawn([
      this.ytDlpPath,
      "--no-playlist",
      "--no-warnings",
      "--skip-download",
      "--output-na-placeholder", "null",
      "--print", YOUTUBE_METADATA_TEMPLATE,
      // Most YouTube results expose adaptive video/audio tracks. The gateway
      // owns both ffmpeg readers, so retain their separate signed URLs instead
      // of rejecting a result merely because no muxed 480p stream exists.
      "--format", "bestvideo[height<=720]+bestaudio/bestvideo+bestaudio/best",
      ...(alternateClient ? ["--extractor-args", "youtube:player_client=android_vr"] : []),
      `ytsearch3:${query}`,
    ], { stdout: "pipe", stderr: "pipe" });
    // Each resolution is capped at 25 seconds; searchYoutube enforces the
    // overall 68-second deadline below the control API's 75-second timeout.
    const timer = setTimeout(() => process.kill("SIGKILL"), 25_000);
    try {
      const [stdout, _stderr, exitCode] = await Promise.all([
        collectProcess(process.stdout),
        collectProcess(process.stderr),
        process.exited,
      ]);
      if (exitCode !== 0) throw new Error("YouTube resolution failed");
      console.info(`[KorvoVideo] selected metadata bytes=${new TextEncoder().encode(stdout).length}`);
      return parseYoutubeSourceCandidates(stdout);
    } catch (error) {
      process.kill("SIGKILL");
      await process.exited;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private startFramePump(session: VideoSession): void {
    const process = Bun.spawn([
      this.ffmpegPath,
      "-nostdin", "-v", "error",
      ...(session.videoUserAgent ? ["-user_agent", session.videoUserAgent] : []),
      "-i", session.videoSourceUrl,
      "-an", "-vf", videoFilter(session.clock.fps, session.detail),
      "-q:v", String(session.jpegQuality), "-pix_fmt", "yuvj420p", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
    ], { stdout: "pipe", stderr: "pipe" });
    session.frameProcess = process;
    this.trackTranscoder(session, process, "video");
    void (async () => {
      try {
        for await (const chunk of process.stdout as unknown as AsyncIterable<Uint8Array>) {
          if (session.stopped) break;
          await this.consumeJpegBytes(session, chunk);
        }
      } finally {
        if (!session.stopped) {
          // Decoding/prefetch may finish before the audio presentation clock.
          session.clock.ended = true;
          this.flushDueFrame(session);
        }
      }
    })();
  }

  private async consumeJpegBytes(session: VideoSession, chunk: Uint8Array): Promise<void> {
    let pending = concatBytes(session.partialJpeg, chunk);
    while (!session.stopped) {
      const start = findMarker(pending, 0xff, 0xd8);
      if (start < 0) {
        session.partialJpeg = pending.slice(Math.max(0, pending.length - 1));
        return;
      }
      const end = findMarker(pending, 0xff, 0xd9, start + 2);
      if (end < 0) {
        session.partialJpeg = pending.slice(start);
        if (session.partialJpeg.length > JPEG_FRAME_LIMIT) session.partialJpeg = new Uint8Array();
        return;
      }
      const bytes = pending.slice(start, end + 2);
      pending = pending.slice(end + 2);
      if (bytes.length === 0 || bytes.length > JPEG_FRAME_LIMIT) continue;
      // Backpressure stays on the gateway. Never queue seconds of decoded
      // 768 KB frames in ESP32 PSRAM or evict a frame before its audio time.
      while (!session.stopped && !session.clock.hasCapacity) await Bun.sleep(25);
      if (session.stopped) return;
      const sequence = session.nextSequence++;
      session.clock.push(sequence, {bytes});
      this.flushDueFrame(session);
    }
  }

  private flushDueFrame(session: VideoSession): void {
    if (session.stopped) return;
    const due = session.clock.takeDue();
    if (due) {
      this.send(session.deviceId, "video.frame", {
        asset_id: `video:${session.id}:${due.sequence}`,
        title: session.title,
        pts_ms: due.ptsMs,
        url: `${this.mediaBaseUrl}/api/korvo/video/${session.id}/frame-${due.sequence}.jpg`,
      });
      if (due.sequence === 1 || due.sequence % (session.clock.fps * 5) === 0) {
        console.log(`KORVO_AV_SYNC seq=${due.sequence} pts_ms=${due.ptsMs} audio_ms=${session.clock.positionMs} lead_ms=${Math.round(session.clock.leadMs)}`);
      }
    }
    if (session.clock.finished && this.sessions.get(session.id) === session) this.stopSession(session, "ended");
  }

  private streamAudio(session: VideoSession): Response {
    session.audioProcess?.kill();
    const process = Bun.spawn(audioTranscodeArgs(this.ffmpegPath, session.audioSourceUrl,
      session.audioUserAgent, session.durationSeconds), { stdout: "pipe", stderr: "pipe" });
    session.audioProcess = process;
    this.trackTranscoder(session, process, "audio");
    return new Response(process.stdout, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "audio/ogg; codecs=opus",
        "X-Audio-Role": "music",
        "X-Audio-Codec": "opus",
        "X-Audio-Profile": "opus-80k-mono-48k",
      },
    });
  }

  private trackTranscoder(session: VideoSession, process: any, kind: "audio" | "video"): void {
    void (async () => {
      let tail = "";
      try {
        for await (const chunk of process.stderr as AsyncIterable<Uint8Array>) {
          tail = (tail + textDecoder.decode(chunk)).slice(-4096);
        }
        const code = await process.exited;
        if (session.stopped || (kind === "audio" && session.audioProcess !== process) ||
            (kind === "video" && session.frameProcess !== process)) return;
        if (kind === "audio") {
          session.audioProcessExitCode = code;
          console.log("KORVO_AUDIO_PROCESS_EXIT", JSON.stringify({code, audioMs: session.clock.positionMs,
            expectedMs: session.durationSeconds ? Math.round(session.durationSeconds * 1000) : null}));
        }
        if (code) {
          // Never log signed source URLs. Preserve only bounded error classes.
          const http = tail.match(/(?:HTTP error|Server returned)\s+\d{3}/g) || [];
          console.warn("KORVO_TRANSCODE_ERROR", JSON.stringify({kind, code, http,
            resource: /Resource temporarily unavailable|pthread_create|Cannot allocate memory/i.test(tail),
            invalid: /Invalid data|Invalid argument|Error opening input/i.test(tail)}));
          if (this.sessions.get(session.id) === session) {
            this.send(session.deviceId, "toast.show", {title: "Video stopped", body: "Video source is unavailable"});
            this.stopSession(session, "transcode_failed");
          }
        }
      } catch {
        if (!session.stopped) console.warn("KORVO_TRANSCODE_DIAGNOSTIC_FAILED", kind);
      }
    })();
  }

  private stopSession(session: VideoSession, reason: string): void {
    if (session.stopped) return;
    session.stopped = true;
    if (session.clockTimer) clearInterval(session.clockTimer);
    session.frameProcess?.kill();
    session.audioProcess?.kill();
    const frames = new Map<number, VideoFrame>();
    for (const [sequence, frame] of session.clock.frames) {
      if (sequence <= session.clock.lastSent && sequence > session.clock.lastSent - session.clock.historyFrames) frames.set(sequence, frame);
    }
    if (frames.size) {
      while (this.retiredFrames.size >= 4) {
        const oldest = this.retiredFrames.keys().next().value!;
        clearTimeout(this.retiredFrames.get(oldest)!.timer);
        this.retiredFrames.delete(oldest);
      }
      const id = session.id;
      const timer = setTimeout(() => this.retiredFrames.delete(id), 5000);
      timer.unref();
      this.retiredFrames.set(id, { frames, expiresAt: Date.now() + 5000, timer });
    }
    this.sessions.delete(session.id);
    console.log("KORVO_VIDEO_LIFECYCLE", JSON.stringify({ event: "outbound_video_stop", deviceId: session.deviceId, reason }));
    this.send(session.deviceId, "video.stop", { reason });
  }

  private stopForDevice(deviceId: string, reason: string): void {
    console.log("KORVO_VIDEO_LIFECYCLE", JSON.stringify({ event: "stop", deviceId, reason }));
    for (const session of [...this.sessions.values()]) {
      if (session.deviceId !== deviceId || session.stopped) continue;
      this.stopSession(session, reason);
    }
  }

  private send(deviceId: string, type: string, payload: Record<string, unknown>): void {
    const connection = this.devices.get(deviceId);
    if (!connection) return;
    try {
      connection.socket.write(`${JSON.stringify({ v: 1, type, id: compactId(), payload })}\n`);
    } catch {
      this.devices.delete(deviceId);
    }
  }

  private errorText(error: unknown): string {
    const message = error instanceof Error ? error.message : "video request failed";
    return message.slice(0, 160);
  }
}
