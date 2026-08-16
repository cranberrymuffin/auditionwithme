import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import type { IncomingMessage, ServerResponse } from "node:http";

type LocalRequest = IncomingMessage & {
  body?: unknown;
  bodyRaw?: Buffer;
  query?: Record<string, string>;
};

type LocalResponse = ServerResponse & {
  status: (code: number) => LocalResponse;
  json: (value: unknown) => LocalResponse;
  send: (value: unknown) => LocalResponse;
};

type ApiHandler = (request: LocalRequest, response: LocalResponse) => unknown;
const MAX_LOCAL_API_BODY_BYTES = 20 * 1024 * 1024;

function localVercelApi(): Plugin {
  return {
    name: "local-vercel-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        const match = url.pathname.match(/^\/api\/([a-z0-9-]+)$/i);
        if (!match) return next();

        try {
          const chunks: Buffer[] = [];
          let bodyBytes = 0;
          for await (const chunk of request) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bodyBytes += buffer.byteLength;
            if (bodyBytes > MAX_LOCAL_API_BODY_BYTES) {
              response.statusCode = 413;
              response.setHeader("Content-Type", "application/json");
              response.end(
                JSON.stringify({ error: "Request body is too large" }),
              );
              return;
            }
            chunks.push(buffer);
          }

          const localRequest = request as LocalRequest;
          const rawBody = Buffer.concat(chunks);
          localRequest.bodyRaw = rawBody;
          localRequest.body = rawBody.length
            ? JSON.parse(rawBody.toString("utf8"))
            : {};
          localRequest.query = Object.fromEntries(url.searchParams.entries());

          const localResponse = response as LocalResponse;
          localResponse.status = (code) => {
            localResponse.statusCode = code;
            return localResponse;
          };
          localResponse.json = (value) => {
            localResponse.setHeader("Content-Type", "application/json");
            localResponse.end(JSON.stringify(value));
            return localResponse;
          };
          localResponse.send = (value) => {
            localResponse.end(
              typeof value === "string" || Buffer.isBuffer(value)
                ? value
                : JSON.stringify(value),
            );
            return localResponse;
          };

          const module = await server.ssrLoadModule(`/api/${match[1]}.ts`);
          const handler = module.default as ApiHandler | undefined;
          if (!handler)
            throw new Error(`No API handler found for ${url.pathname}`);
          await handler(localRequest, localResponse);
        } catch (error) {
          console.error(`Local API error (${url.pathname}):`, error);
          if (!response.headersSent) {
            response.statusCode = 500;
            response.setHeader("Content-Type", "application/json");
          }
          if (!response.writableEnded) {
            response.end(
              JSON.stringify({
                error:
                  error instanceof Error ? error.message : "Local API failed",
              }),
            );
          }
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, process.cwd(), ""));

  return {
    plugins: [
      localVercelApi(),
      react(),
      tailwindcss(),
      VitePWA({
        registerType: "autoUpdate",
        injectRegister: false,
        includeAssets: [
          "icons/favicon-16x16.png",
          "icons/favicon-32x32.png",
          "icons/apple-touch-icon.png",
        ],
        manifest: {
          name: "AuditionWithMe",
          short_name: "Audition",
          description:
            "Practice your audition scripts with an on-demand reading partner.",
          start_url: "/",
          scope: "/",
          display: "standalone",
          background_color: "#131824",
          theme_color: "#131824",
          icons: [
            {
              src: "/icons/pwa-192x192.png",
              sizes: "192x192",
              type: "image/png",
              purpose: "any",
            },
            {
              src: "/icons/pwa-512x512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "any",
            },
            {
              src: "/icons/maskable-icon-512x512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
        workbox: {
          skipWaiting: true,
          clientsClaim: true,
          globPatterns: ["**/*.{js,css,html,woff,woff2,svg,ico}"],
          navigateFallbackDenylist: [/^\/api\//],
          runtimeCaching: [
            {
              urlPattern: ({ request }) => request.destination === "image",
              handler: "CacheFirst",
              options: {
                cacheName: "images",
                expiration: {
                  maxEntries: 40,
                  maxAgeSeconds: 30 * 24 * 60 * 60,
                },
              },
            },
          ],
        },
      }),
    ],
  };
});
