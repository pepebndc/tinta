// Usage:
//   node render.mjs stills <t> [t ...]      Write stills/t<t>.jpg.
//   node render.mjs video [workers]          Render video.mp4 with motion blur.
// Motion blur: each output frame averages SUB samples across a 180 degree shutter.
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import TL from "./timeline.js";

const FPS = 60, SUB = 4, SHUTTER = 0.5;
const VERT = !!process.env.VERT, W = VERT ? 1080 : 1920, H = VERT ? 1920 : 1080;
const OUT = VERT ? "video-vertical.mp4" : "video.mp4";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const url = pathToFileURL("index.html").href + (VERT ? "?v=1" : "");

async function open() {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--force-color-profile=srgb", "--hide-scrollbars"] });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready);
  return { browser, page };
}

const mode = process.argv[2] || "stills";
if (mode === "stills") {
  mkdirSync("stills", { recursive: true });
  const { browser, page } = await open();
  for (const t of process.argv.slice(3).map(Number)) {
    await page.evaluate((t) => render(t), t);
    await page.screenshot({ path: `stills/${VERT ? "v" : "t"}${t.toFixed(2)}.jpg`, type: "jpeg", quality: 85 });
  }
  await browser.close();
} else {
  const workers = Number(process.argv[3] || 4);
  const frames = Math.round(TL.DUR * FPS);
  const per = Math.ceil(frames / workers);
  mkdirSync("seg", { recursive: true });
  const t0 = Date.now();
  await Promise.all(Array.from({ length: workers }, async (_, w) => {
    const a = w * per, b = Math.min(frames, a + per);
    const { browser, page } = await open();
    // Sub-frames go in as 240 fps; tmix averages each group of SUB and select keeps one frame per group.
    const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS * SUB), "-c:v", "png", "-i", "-",
      "-vf", `tmix=frames=${SUB},select='eq(mod(n\\,${SUB})\\,${SUB - 1})',setpts=N/${FPS}/TB`,
      "-r", String(FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "10", "-pix_fmt", "yuv444p", `seg/s${w}.mp4`], { stdio: ["pipe", "inherit", "inherit"] });
    for (let i = a; i < b; i++) {
      for (let s = 0; s < SUB; s++) {
        const t = (i + (s / SUB) * SHUTTER - SHUTTER / 2) / FPS;
        await page.evaluate((t) => render(Math.max(0, t)), t);
        const buf = await page.screenshot({ type: "png", optimizeForSpeed: true });
        if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
      }
      if ((i - a) % 120 === 0) console.log(`worker ${w}: frame ${i - a}/${b - a} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    }
    ff.stdin.end();
    await new Promise((r) => ff.on("close", r));
    await browser.close();
  }));
  writeFileSync("seg/list.txt", Array.from({ length: workers }, (_, w) => `file 's${w}.mp4'`).join("\n"));
  // Join the segments, add fine grain, and encode the master.
  await new Promise((r) => spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "seg/list.txt",
    "-vf", "noise=alls=3:allf=t,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-tune", "film",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", OUT], { stdio: "inherit" }).on("close", r));
  rmSync("seg", { recursive: true, force: true });
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

// Puppeteer can leave handles open after the browsers close, so exit when the work is done.
process.exit(0);
