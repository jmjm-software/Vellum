#!/usr/bin/env node
/**
 * Renders the live dashboard in a real browser and asserts that the uploaded
 * image in the published design actually draws.
 *
 * This is the path the Android WebView uses (same web client), and it is the
 * one an <img src="/api/assets/…"> cannot do by itself: the endpoint is
 * access-controlled and images cannot send an Authorization header, so the
 * client must fetch bytes with its token and hand the renderer an object URL.
 *
 * Usage: node scripts/check-live-image.mjs [--server http://localhost:8787]
 */
import { chromium } from "playwright";

const argServer = process.argv.indexOf("--server");
const SERVER = argServer >= 0 ? process.argv[argServer + 1] : process.env.VELLUM_SERVER || "http://localhost:8787";
const TOKEN = process.env.VELLUM_CLIENT_TOKEN || "client-dev-token";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const failures = [];
page.on("console", (msg) => {
  if (msg.type() === "error" && !/favicon/i.test(msg.text())) failures.push(msg.text());
});
page.on("pageerror", (err) => failures.push(err.message));

await page.goto(`${SERVER}/?token=${TOKEN}`, { waitUntil: "load" });
await page.waitForSelector("[data-component-id]", { timeout: 30_000 });
await page.waitForTimeout(2500); // allow asset fetch + decode

const images = await page.evaluate(`(() => {
  const out = [];
  for (const img of Array.from(document.querySelectorAll("img[data-component-id]"))) {
    out.push({
      id: img.getAttribute("data-component-id"),
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      srcScheme: (img.currentSrc || img.src || "").split(":")[0]
    });
  }
  return out;
})()`);

console.log(`images rendered by the live client: ${images.length}`);
for (const img of images) {
  console.log(`  ${img.id}: complete=${img.complete} naturalWidth=${img.naturalWidth} scheme=${img.srcScheme}`);
}

const ok = images.length > 0 && images.every((i) => i.complete && i.naturalWidth > 0 && i.srcScheme === "blob");
if (failures.length > 0) console.error("page errors:", failures.slice(0, 3));
console.log(ok ? "LIVE_IMAGE_OK" : "LIVE_IMAGE_FAILED");

await browser.close();
process.exit(ok ? 0 : 1);
