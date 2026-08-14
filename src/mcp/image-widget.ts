import type { McpServer } from "@modelcontextprotocol/server";
import { MCP_ISSUER } from "../limits";

export const IMAGE_WIDGET_URI = "ui://novelai/image-preview-v3.html";
export const IMAGE_WIDGET_MIME_TYPE = "text/html;profile=mcp-app";
export const IMAGE_WIDGET_PROTOCOL_VERSION = "2026-01-26";
export const IMAGE_WIDGET_RENDER_TOOL = "nai_render_image_preview";
/** Unique origin ChatGPT uses to sandbox this template (required for app submission). */
export const IMAGE_WIDGET_DOMAIN = MCP_ISSUER;

/** Status text only — data tools must not bind the widget template. */
export function imageToolStatusMeta(
  invoking: string,
  invoked: string,
): Record<string, unknown> {
  return {
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked,
  };
}

/** Bind the preview template. Use only on the render tool. */
export function imageWidgetToolMeta(
  invoking: string,
  invoked: string,
): Record<string, unknown> {
  return {
    ui: { resourceUri: IMAGE_WIDGET_URI },
    "openai/outputTemplate": IMAGE_WIDGET_URI,
    "openai/widgetAccessible": true,
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked,
  };
}

export function registerImageWidget(
  server: McpServer,
  origin: string = MCP_ISSUER,
): void {
  const resourceDomains = [...new Set([origin, MCP_ISSUER])];
  server.registerResource(
    "image-preview-widget",
    IMAGE_WIDGET_URI,
    {
      title: "NovelAI image preview",
      description: "Inline preview for images returned by NovelAI tools",
      mimeType: IMAGE_WIDGET_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: IMAGE_WIDGET_URI,
          mimeType: IMAGE_WIDGET_MIME_TYPE,
          text: IMAGE_WIDGET_HTML,
          _meta: {
            ui: {
              domain: IMAGE_WIDGET_DOMAIN,
              prefersBorder: true,
              csp: {
                connectDomains: [],
                resourceDomains,
              },
            },
            "openai/widgetDomain": IMAGE_WIDGET_DOMAIN,
            "openai/widgetPrefersBorder": true,
            "openai/widgetCSP": {
              connect_domains: [],
              resource_domains: resourceDomains,
            },
          },
        },
      ],
    }),
  );
}

export const IMAGE_WIDGET_HTML = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>
      :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; background: transparent; }
      #app { display: grid; gap: 10px; padding: 10px; }
      #status { margin: 0; color: color-mix(in srgb, currentColor 68%, transparent); font-size: 13px; }
      #gallery { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: 10px; }
      figure { margin: 0; overflow: hidden; border-radius: 12px; background: color-mix(in srgb, currentColor 6%, transparent); }
      img { display: block; width: 100%; max-height: min(72vh, 760px); object-fit: contain; }
      figcaption { padding: 8px 10px; font-size: 12px; color: color-mix(in srgb, currentColor 72%, transparent); }
    </style>
  </head>
  <body>
    <main id="app" aria-live="polite">
      <p id="status">Preparing image preview…</p>
      <section id="gallery" aria-label="NovelAI generated images"></section>
    </main>
    <script>
      (() => {
        const status = document.getElementById("status");
        const gallery = document.getElementById("gallery");
        const allowedMimeTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
        const initializeId = 1;
        let initialized = false;

        function postToHost(message) {
          if (!window.parent || window.parent === window) return;
          window.parent.postMessage(message, "*");
        }

        function unwrapResult(value) {
          if (!value || typeof value !== "object") return null;
          if (Array.isArray(value.content)) return value;
          if (value.mcp_tool_result && typeof value.mcp_tool_result === "object") {
            return unwrapResult(value.mcp_tool_result);
          }
          if (value.call_tool_result && typeof value.call_tool_result === "object") {
            return unwrapResult(value.call_tool_result);
          }
          if (value.result && typeof value.result === "object") return unwrapResult(value.result);
          return null;
        }

        function textBlocks(result) {
          if (!result || !Array.isArray(result.content)) return [];
          return result.content
            .filter((block) => block && block.type === "text" && typeof block.text === "string")
            .map((block) => block.text.trim())
            .filter(Boolean);
        }

        function isHttpUrl(value) {
          try {
            const parsed = new URL(value);
            return parsed.protocol === "https:" || parsed.protocol === "http:";
          } catch {
            return false;
          }
        }

        function urlImages(result) {
          const data = result && result.structuredContent;
          if (!data || typeof data !== "object") return [];
          const images = Array.isArray(data.images) ? data.images : [];
          const urls = images
            .map((img) => (img && typeof img.url === "string" ? img.url : ""))
            .filter(isHttpUrl);
          if (urls.length) return urls;
          if (typeof data.image_url === "string" && isHttpUrl(data.image_url)) {
            return [data.image_url];
          }
          return [];
        }

        function imageBlocks(result) {
          if (!result || !Array.isArray(result.content)) return [];
          return result.content.filter((block) => {
            if (!block || block.type !== "image" || typeof block.data !== "string") return false;
            const mime = typeof block.mimeType === "string" ? block.mimeType : "";
            return allowedMimeTypes.has(mime) && block.data.length > 0;
          });
        }

        function summary(result) {
          const data = result && result.structuredContent;
          if (!data || typeof data !== "object") return "NovelAI image";
          const parts = [];
          if (typeof data.model === "string") parts.push(data.model);
          if (Number.isFinite(data.seed)) parts.push("seed " + String(data.seed));
          if (Number.isFinite(data.width) && Number.isFinite(data.height)) {
            parts.push(String(data.width) + " × " + String(data.height));
          }
          return parts.length ? parts.join(" · ") : "NovelAI image";
        }

        function render(value) {
          const result = unwrapResult(value);
          gallery.replaceChildren();
          if (!result) return;

          if (result.isError) {
            status.textContent = textBlocks(result)[0] || "The image tool failed.";
            return;
          }

          const urls = urlImages(result);
          const blocks = urls.length ? [] : imageBlocks(result);
          if (!urls.length && !blocks.length) {
            status.textContent = textBlocks(result)[0]
              || "The image was generated, but this host did not expose its image URL to the preview.";
            return;
          }

          const count = urls.length || blocks.length;
          status.textContent = count === 1 ? summary(result) : summary(result) + " · " + count + " images";
          if (urls.length) {
            urls.forEach((url, index) => {
              const figure = document.createElement("figure");
              const image = document.createElement("img");
              const caption = document.createElement("figcaption");
              image.alt = urls.length === 1 ? "NovelAI generated image" : "NovelAI generated image " + String(index + 1);
              image.src = url;
              caption.textContent = urls.length === 1 ? "Generated image" : "Image " + String(index + 1);
              figure.append(image, caption);
              gallery.append(figure);
            });
            return;
          }
          blocks.forEach((block, index) => {
            const figure = document.createElement("figure");
            const image = document.createElement("img");
            const caption = document.createElement("figcaption");
            image.alt = blocks.length === 1 ? "NovelAI generated image" : "NovelAI generated image " + String(index + 1);
            image.src = "data:" + block.mimeType + ";base64," + block.data;
            caption.textContent = blocks.length === 1 ? "Generated image" : "Image " + String(index + 1);
            figure.append(image, caption);
            gallery.append(figure);
          });
        }

        function resultFromOpenAi(oai) {
          if (!oai || typeof oai !== "object") return null;
          return unwrapResult(oai.toolResponseMetadata) || unwrapResult(oai.toolOutput);
        }

        function renderOpenAi(event) {
          const globals = event && event.detail && event.detail.globals
            ? event.detail.globals
            : window.openai;
          const result = resultFromOpenAi(globals);
          if (result) render(result);
        }

        window.addEventListener("message", (event) => {
          if (event.source !== window.parent) return;
          const message = event.data;
          if (!message || message.jsonrpc !== "2.0") return;

          if (message.id == initializeId && message.result && !message.method) {
            if (initialized) return;
            initialized = true;
            postToHost({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
            return;
          }

          if (message.method === "ui/notifications/tool-result") render(message.params);
          if (message.method === "ui/notifications/tool-cancelled") {
            gallery.replaceChildren();
            const reason = message.params && typeof message.params.reason === "string"
              ? message.params.reason
              : "";
            status.textContent = reason || "Image generation was cancelled.";
          }
        }, { passive: true });

        window.addEventListener("openai:set_globals", renderOpenAi, { passive: true });

        postToHost({
          jsonrpc: "2.0",
          id: initializeId,
          method: "ui/initialize",
          params: {
            protocolVersion: "2026-01-26",
            appInfo: { name: "novelai-image-preview", version: "1.0.0" },
            appCapabilities: {},
          },
        });

        renderOpenAi();
      })();
    </script>
  </body>
</html>`;
