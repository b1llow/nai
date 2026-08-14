import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IMAGE_WIDGET_HTML,
  IMAGE_WIDGET_PROTOCOL_VERSION,
} from "../src/mcp/image-widget";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type HostMessage = Record<string, unknown>;

function widgetScript(): string {
  const script = IMAGE_WIDGET_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("widget HTML is missing a script");
  return script;
}

function mountWidget(openai?: Record<string, unknown>) {
  const posted: HostMessage[] = [];
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const parent = {
    postMessage(message: HostMessage) {
      posted.push(message);
    },
  };
  const status = { textContent: "" };
  const gallery = {
    nodes: [] as Array<{ src: string; alt: string; caption: string }>,
    replaceChildren() {
      this.nodes = [];
    },
    append(figure: { src: string; alt: string; caption: string }) {
      this.nodes.push(figure);
    },
  };

  const document = {
    getElementById(id: string) {
      if (id === "status") return status;
      if (id === "gallery") return gallery;
      return null;
    },
    createElement(tag: string) {
      if (tag === "figure") {
        const figure = {
          src: "",
          alt: "",
          caption: "",
          append(image: { src: string; alt: string }, caption: { textContent: string }) {
            figure.src = image.src;
            figure.alt = image.alt;
            figure.caption = caption.textContent;
          },
        };
        return figure;
      }
      if (tag === "img") return { alt: "", src: "" };
      if (tag === "figcaption") return { textContent: "" };
      return {};
    },
  };

  const windowObj = {
    parent,
    openai,
    addEventListener(type: string, fn: (event: unknown) => void) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
  };

  vi.stubGlobal("window", windowObj);
  vi.stubGlobal("document", document);
  new Function(widgetScript())();

  function emit(type: string, event: unknown) {
    for (const fn of listeners.get(type) ?? []) fn(event);
  }

  function hostMessage(data: HostMessage) {
    emit("message", { source: parent, data });
  }

  return { posted, status, gallery, emit, hostMessage, windowObj };
}

function imageResult(isError = false) {
  return {
    isError,
    structuredContent: {
      model: "nai-diffusion-4-5-full",
      seed: 7,
      width: 832,
      height: 1216,
    },
    content: isError
      ? [{ type: "text", text: "Missing NovelAI Persistent API token." }]
      : [
          { type: "text", text: '{"image_id":"img_abc"}' },
          { type: "image", data: PNG_1X1, mimeType: "image/png" },
        ],
  };
}

describe("image preview widget", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("completes the MCP Apps initialize handshake before accepting tool results", () => {
    const { posted, hostMessage, status, gallery } = mountWidget();

    expect(posted).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "ui/initialize",
        params: {
          protocolVersion: IMAGE_WIDGET_PROTOCOL_VERSION,
          appInfo: { name: "novelai-image-preview", version: "1.0.0" },
          appCapabilities: {},
        },
      },
    ]);
    expect(status.textContent).toBe("Preparing image preview…");

    hostMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: IMAGE_WIDGET_PROTOCOL_VERSION,
        hostInfo: { name: "host", version: "1" },
        hostCapabilities: {},
        hostContext: {},
      },
    });
    expect(posted[1]).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/initialized",
    });

    hostMessage({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: imageResult(),
    });
    expect(status.textContent).toBe("nai-diffusion-4-5-full · seed 7 · 832 × 1216");
    expect(gallery.nodes).toHaveLength(1);
    expect(gallery.nodes[0]?.src).toBe("data:image/png;base64," + PNG_1X1);
  });

  it("renders ChatGPT toolResponseMetadata envelopes and openai:set_globals updates", () => {
    const { status, gallery, emit, windowObj } = mountWidget({
      toolResponseMetadata: {
        mcp_tool_result: imageResult(),
      },
    });
    expect(gallery.nodes).toHaveLength(1);
    expect(status.textContent).toContain("nai-diffusion-4-5-full");

    windowObj.openai = {
      toolResponseMetadata: {
        call_tool_result: imageResult(),
      },
    };
    emit("openai:set_globals", { detail: { globals: windowObj.openai } });
    expect(gallery.nodes).toHaveLength(1);
    expect(gallery.nodes[0]?.alt).toBe("NovelAI generated image");
  });

  it("shows the tool error instead of claiming the host hid a successful image", () => {
    const { hostMessage, status, gallery } = mountWidget();
    hostMessage({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: imageResult(true),
    });
    expect(gallery.nodes).toHaveLength(0);
    expect(status.textContent).toBe("Missing NovelAI Persistent API token.");
    expect(status.textContent).not.toMatch(/did not expose/);
  });
});
