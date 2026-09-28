import { describe, expect, test, afterEach } from "bun:test";
import { KorvoVideoService } from "../../src/media/korvo-video";

const servicesToCleanup: KorvoVideoService[] = [];

function setupService() {
  process.env.KORVO_MEDIA_BASE_URL = "http://127.0.0.1:8765";
  process.env.KORVO_ALLOWED_DEVICE_ID = "esp32s31-korvo-1";
  const service = new KorvoVideoService();
  (service as any).startFramePump = () => {};
  servicesToCleanup.push(service);
  const sent: any[] = [];
  const socket = {
    write: (data: string) => {
      for (const line of data.trim().split("\n")) {
        if (line) sent.push(JSON.parse(line));
      }
    },
    end: () => {},
  };
  const connection = { socket, buffer: "" };
  (service as any).devices.set("esp32s31-korvo-1", connection);
  return { service, connection, sent };
}

describe("Gateway Video Lifecycle", () => {
  afterEach(() => {
    while (servicesToCleanup.length > 0) {
      const svc = servicesToCleanup.pop()!;
      try {
        (svc as any).stopForDevice("esp32s31-korvo-1", "test_cleanup");
      } catch {}
      try {
        for (const session of (svc as any).sessions.values()) {
          try { (svc as any).stopSession(session, "test_cleanup"); } catch {}
          if (session.clock?.timer) {
            try { clearInterval(session.clock.timer); } catch {}
            try { clearTimeout(session.clock.timer); } catch {}
          }
        }
        (svc as any).sessions.clear();
      } catch {}
    }
  });

  test("slow preparation sends video_loading and eventually publishes video.start", async () => {
    const { service, sent } = setupService();
    (service as any).searchYoutube = async () => {
      await Bun.sleep(40);
      return { title: "Test Title", videoUrl: "http://vid", audioUrl: "http://aud" };
    };

    const sessionPromise = (service as any).startForDevice("esp32s31-korvo-1", "calm music");
    expect(sent.some((m) => m.type === "ai.state" && m.payload?.state === "video_loading")).toBe(true);
    const session = await sessionPromise;
    expect(session.title).toBe("Test Title");
    expect(sent.some((m) => m.type === "video.start" && m.payload?.title === "Test Title")).toBe(true);
    (service as any).stopForDevice("esp32s31-korvo-1", "test_cleanup");
  });

  test("preparation failure sends generic error toast and suppresses video.start", async () => {
    const { service, connection, sent } = setupService();
    (service as any).searchYoutube = async () => {
      await Bun.sleep(20);
      throw new Error("Source 403 Forbidden");
    };

    (service as any).handleDeviceFrame(connection, JSON.stringify({
      v: 1, type: "video.request", payload: { action: "play", value: "failure query" },
    }));
    await Bun.sleep(50);
    const toast = sent.find((m) => m.type === "toast.show");
    expect(toast).toBeDefined();
    expect(toast.payload.title).toBe("Video unavailable");
    expect(toast.payload.body).toBe("Video request failed");
    expect(sent.some((m) => m.type === "video.start")).toBe(false);
  });

  test("concurrent replacement suppresses superseded start and toast", async () => {
    const { service, sent } = setupService();
    (service as any).searchYoutube = async (q: string) => {
      if (q === "first") {
        await Bun.sleep(80);
        return { title: "First Result", videoUrl: "http://vid1", audioUrl: "http://aud1" };
      }
      await Bun.sleep(30);
      return { title: "Second Result", videoUrl: "http://vid2", audioUrl: "http://aud2" };
    };

    const p1 = (service as any).startForDevice("esp32s31-korvo-1", "first");
    await Bun.sleep(10);
    const p2 = (service as any).startForDevice("esp32s31-korvo-1", "second");

    const r2 = await p2;
    expect(r2.title).toBe("Second Result");
    let err1: any = null;
    try { await p1; } catch (e) { err1 = e; }
    expect(err1).not.toBeNull();
    expect(String(err1)).toContain("superseded");

    const startMessages = sent.filter((m) => m.type === "video.start");
    expect(startMessages.length).toBe(1);
    expect(startMessages[0].payload.title).toBe("Second Result");
    (service as any).stopForDevice("esp32s31-korvo-1", "test_cleanup");
  });

  test("exit while pending invalidates request and suppresses publish", async () => {
    const { service, connection, sent } = setupService();
    (service as any).searchYoutube = async () => {
      await Bun.sleep(60);
      return { title: "Slow Exit", videoUrl: "http://vid", audioUrl: "http://aud" };
    };

    const reqPromise = (service as any).startForDevice("esp32s31-korvo-1", "slow exit");
    await Bun.sleep(20);
    (service as any).handleDeviceFrame(connection, JSON.stringify({
      v: 1, type: "video.action", payload: { screen: "video", action: "exit" },
    }));

    let err: any = null;
    try { await reqPromise; } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(String(err)).toContain("superseded");
    expect(sent.some((m) => m.type === "video.start")).toBe(false);
  });

  test("disconnect before completion catches missing device and suppresses start", async () => {
    const { service, connection, sent } = setupService();
    (service as any).searchYoutube = async () => {
      await Bun.sleep(40);
      return { title: "Disconnect", videoUrl: "http://vid", audioUrl: "http://aud" };
    };

    const reqPromise = (service as any).startForDevice("esp32s31-korvo-1", "disconnect");
    await Bun.sleep(15);
    (service as any).removeConnection(connection);

    let err: any = null;
    try { await reqPromise; } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(String(err)).toContain("Request superseded");
    expect(sent.some((m) => m.type === "video.start")).toBe(false);
  });

  test("obsolete session error callback does not cancel replacement session", async () => {
    const { service } = setupService();
    (service as any).searchYoutube = async (q: string) => ({
      title: q, videoUrl: "http://vid", audioUrl: "http://aud",
    });

    const s1 = await (service as any).startForDevice("esp32s31-korvo-1", "session1");
    const s2 = await (service as any).startForDevice("esp32s31-korvo-1", "session2");

    expect(s1.stopped).toBe(true);
    expect(s2.stopped).toBe(false);
    expect((service as any).sessions.get(s2.id)).toBe(s2);

    (service as any).stopSession(s1, "transcode_failed");
    expect(s2.stopped).toBe(false);
    expect((service as any).sessions.get(s2.id)).toBe(s2);
    (service as any).stopForDevice("esp32s31-korvo-1", "test_cleanup");
  });

  test("device.status with actual { video: 'rejected' } triggers toast and stops session", async () => {
    const { service, connection, sent } = setupService();
    (service as any).searchYoutube = async () => ({
      title: "Active Video", videoUrl: "http://vid", audioUrl: "http://aud",
    });
    const session = await (service as any).startForDevice("esp32s31-korvo-1", "calm music");
    expect(session.stopped).toBe(false);

    (service as any).handleDeviceFrame(connection, JSON.stringify({
      v: 1,
      type: "device.status",
      payload: { video: "rejected" },
    }));

    expect(session.stopped).toBe(true);
    const toast = sent.find((m) => m.type === "toast.show");
    expect(toast).toBeDefined();
    expect(toast.payload.title).toBe("Video unavailable");
    expect(toast.payload.body).toBe("Video request failed");
  });

  test("device.status with actual { ui_queue: 'full' } is handled without stopping session or sending toast", async () => {
    const { service, connection, sent } = setupService();
    (service as any).searchYoutube = async () => ({
      title: "Active Video", videoUrl: "http://vid", audioUrl: "http://aud",
    });
    const session = await (service as any).startForDevice("esp32s31-korvo-1", "calm music");
    expect(session.stopped).toBe(false);

    (service as any).handleDeviceFrame(connection, JSON.stringify({
      v: 1,
      type: "device.status",
      payload: { ui_queue: "full" },
    }));

    expect(session.stopped).toBe(false);
    expect(sent.some((m) => m.type === "toast.show")).toBe(false);
  });

  test("old search failure after new request does not send outdated toast", async () => {
    const { service, connection, sent } = setupService();
    (service as any).searchYoutube = async (q: string) => {
      if (q === "first_query") {
        await Bun.sleep(40);
        throw new Error("Search 1 failed");
      }
      await Bun.sleep(15);
      return { title: "Second Title", videoUrl: "http://vid2", audioUrl: "http://aud2" };
    };

    (service as any).handleDeviceFrame(connection, JSON.stringify({
      v: 1, type: "video.request", payload: { action: "play", value: "first_query" },
    }));
    await Bun.sleep(10);
    (service as any).handleDeviceFrame(connection, JSON.stringify({
      v: 1, type: "video.request", payload: { action: "play", value: "second_query" },
    }));

    await Bun.sleep(60);

    expect(sent.some((m) => m.type === "video.start" && m.payload?.title === "Second Title")).toBe(true);
    expect(sent.some((m) => m.type === "toast.show")).toBe(false);
  });

  test("disconnect removeConnection and reconnect before old source finishes suppresses publish", async () => {
    const { service, connection, sent } = setupService();
    (service as any).searchYoutube = async () => {
      await Bun.sleep(50);
      return { title: "Stale Video", videoUrl: "http://vid", audioUrl: "http://aud" };
    };

    const oldPromise = (service as any).startForDevice("esp32s31-korvo-1", "slow query");
    await Bun.sleep(15);
    (service as any).removeConnection(connection);

    const newSocket = {
      write: (data: string) => {
        for (const line of data.trim().split("\n")) {
          if (line) sent.push(JSON.parse(line));
        }
      },
      end: () => {},
    };
    const connection2 = { socket: newSocket, buffer: "" };
    (service as any).handleDeviceFrame(connection2, JSON.stringify({
      v: 1, type: "device.hello", payload: { device_id: "esp32s31-korvo-1" },
    }));

    let err: any = null;
    try {
      await oldPromise;
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    await Bun.sleep(50);
    expect(sent.some((m) => m.type === "video.start")).toBe(false);
  });
});
