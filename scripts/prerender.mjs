#!/usr/bin/env node
// Prerenders the public marketing pages into static HTML after `vite build`,
// so crawlers that don't run JavaScript (Bing, AI search bots, link
// previews) get each page's real content and its own canonical, title and
// description instead of the empty app shell.
//
// dist/index.html becomes the prerendered home page, each other route gets
// dist/<route>/index.html, and every remaining path (vercel.json rewrite and
// the service worker's navigation fallback) is served dist/app.html, the
// untouched shell emitted by the build — so /practice and friends never flash
// home-page markup. The browser app still mounts with createRoot, replacing
// the prerendered markup, so nothing about client behavior changes.
//
// Usage: node scripts/prerender.mjs [--mode <vite mode>]   (default: production)

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const ROUTES = ["/", "/how-it-works", "/faq", "/pricing", "/terms"];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const ssrOut = join(root, "node_modules", ".prerender");

const modeFlag = process.argv.indexOf("--mode");
const mode = modeFlag !== -1 ? process.argv[modeFlag + 1] : "production";

const escapeAttr = (value) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const escapeText = (value) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** Replaces one tag's attribute value, failing loudly if the tag is gone. */
function setAttr(html, tagPattern, attr, value) {
  const re = new RegExp(`(<${tagPattern}[^>]*?\\s${attr}=")[^"]*(")`, "s");
  if (!re.test(html)) throw new Error(`prerender: no tag matching ${tagPattern}`);
  return html.replace(re, `$1${escapeAttr(value)}$2`);
}

function applySeo(html, seo) {
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeText(seo.title)}</title>`);
  html = setAttr(html, 'meta\\s+name="description"', "content", seo.description);
  html = setAttr(html, 'meta\\s+name="robots"', "content", seo.noindex ? "noindex, nofollow" : "index, follow");
  html = setAttr(html, 'link\\s+rel="canonical"', "href", seo.url);
  html = setAttr(html, 'meta\\s+property="og:title"', "content", seo.title);
  html = setAttr(html, 'meta\\s+property="og:description"', "content", seo.description);
  html = setAttr(html, 'meta\\s+property="og:url"', "content", seo.url);
  html = setAttr(html, 'meta\\s+property="og:image"', "content", seo.image);
  html = setAttr(html, 'meta\\s+name="twitter:title"', "content", seo.title);
  html = setAttr(html, 'meta\\s+name="twitter:description"', "content", seo.description);
  html = setAttr(html, 'meta\\s+name="twitter:image"', "content", seo.image);
  return html;
}

const template = await readFile(join(dist, "app.html"), "utf8");
if (!template.includes('<div id="root"></div>')) {
  throw new Error("prerender: dist/app.html has no empty #root to fill");
}

await build({
  root,
  mode,
  logLevel: "warn",
  build: {
    ssr: "src/entry-server.tsx",
    outDir: ssrOut,
    emptyOutDir: true,
    copyPublicDir: false,
  },
});

const { render } = await import(pathToFileURL(join(ssrOut, "entry-server.js")).href);

for (const route of ROUTES) {
  const { html: body, seo } = render(route);
  if (!seo) throw new Error(`prerender: ${route} rendered no <Seo> tags`);
  if (seo.noindex) throw new Error(`prerender: ${route} is noindex; drop it from ROUTES`);

  const page = applySeo(template, seo).replace(
    '<div id="root"></div>',
    `<div id="root">${body}</div>`,
  );
  const file = route === "/" ? join(dist, "index.html") : join(dist, route.slice(1), "index.html");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, page);
  console.log(`prerendered ${route} -> ${file.slice(root.length + 1)} (${seo.url})`);
}

await rm(ssrOut, { recursive: true, force: true });
