/**
 * Visual and layout assertions against a running stack.
 *
 * Unit tests cannot see a clipped tab bar or a sheet that opens off-screen, and
 * eyeballing ad-hoc screenshots is worse than nothing: a first pass with old
 * headless Chrome's `--window-size` appeared to show a broken 390px layout,
 * which turned out to be the tool not setting a layout viewport at all. Real
 * viewports plus measured assertions is the difference between checking the app
 * and checking the screenshot harness.
 *
 * Auth is one navigation: /auth/dev-login sets the dev-bypass cookie and
 * redirects to /, so no profile or cookie juggling is needed.
 *
 * Usage: bun run ui-check [bffOrigin]
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";

const ORIGIN = process.argv[2] ?? "http://127.0.0.1:8090";
const OUT_DIR = new URL("../.ui-check/", import.meta.url).pathname;

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1200, height: 900 };

let failures = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) {
    failures += 1;
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/**
 * Playwright pins a Chromium build that may not be the one cached on this
 * machine, and downloading ~150MB to assert on CSS is not a good trade. Reuse
 * whatever chromium-* build is already present; fall back to Playwright's own
 * resolution when none is.
 */
function chromiumExecutable(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const cache = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cache)) return undefined;
  const builds = readdirSync(cache)
    .filter((name) => name.startsWith("chromium-"))
    .sort()
    .reverse();
  for (const build of builds) {
    const candidate = join(cache, build, "chrome-linux64", "chrome");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Load the app authenticated and settled. */
async function open(browser: Browser, viewport: { width: number; height: number }): Promise<Page> {
  const page = await browser.newPage({ viewport });
  await page.goto(`${ORIGIN}/auth/dev-login`, { waitUntil: "networkidle" });
  return page;
}

/**
 * Elements the user can never reach, because they extend past the viewport and
 * nothing between them and the root scrolls.
 *
 * Comparing `documentElement.scrollWidth` to `clientWidth` does NOT work here:
 * `.app` is `overflow: hidden`, so anything too wide is silently clipped rather
 * than extending the scroll area — the page reports a clean 390/390 while a tab
 * bar is cut in half. Only `auto`/`scroll` rescue an overflowing element;
 * `hidden` is precisely the bug being looked for.
 */
async function overflow(page: Page): Promise<{ clientWidth: number; clipped: string[] }> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const limit = root.clientWidth;
    const clipped: string[] = [];

    for (const el of Array.from(document.querySelectorAll("*"))) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right <= limit + 1) continue;

      let scrollable = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const overflowX = getComputedStyle(p).overflowX;
        if (overflowX === "auto" || overflowX === "scroll") {
          scrollable = true;
          break;
        }
      }
      if (scrollable) continue;

      const cls = (el.className || "").toString().trim().split(/\s+/)[0] ?? "";
      clipped.push(
        `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""} right=${Math.round(rect.right)}`,
      );
    }
    // Ancestors of a clipped node are usually clipped too; the first few are enough.
    return { clientWidth: limit, clipped: clipped.slice(0, 5) };
  });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT_DIR, `${name}.png`) });
}

mkdirSync(OUT_DIR, { recursive: true });

const executablePath = chromiumExecutable();
console.log(`chromium: ${executablePath ?? "(playwright default)"}`);
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  // Required inside containers and unprivileged environments.
  args: ["--no-sandbox"],
});

try {
  // ── Phone ────────────────────────────────────────────────────────────────
  section(`Phone (${PHONE.width}px)`);
  {
    const page = await open(browser, PHONE);
    await shot(page, "phone-chat");

    const box = await overflow(page);
    check("nothing is clipped off-screen", box.clipped.length === 0, box);

    check("all five tabs are reachable", (await page.locator("nav.tabs button").count()) === 5);
    check("hamburger is shown", await page.locator(".topbar .icon-button.ghost").isVisible());
    check(
      "sidebar is off-canvas",
      await page.evaluate(() => {
        const el = document.querySelector(".sidebar");
        return el ? el.getBoundingClientRect().right <= 1 : false;
      }),
    );

    // The composer is the single control surface; each control must exist and
    // be an icon button with an accessible name.
    for (const label of ["Filter the transcript", "Run a command", "Model for this conversation"]) {
      const button = page.locator(`.composer-row button[aria-label="${label}"]`);
      check(`composer has "${label}"`, (await button.count()) === 1);
      check(`"${label}" is an icon button`, (await button.locator("svg.icon").count()) === 1);
    }
    check(
      "composer has a permission-mode button",
      (await page.locator('.composer-row button[aria-label^="Permission mode"]').count()) === 1,
    );
    check(
      "composer has a send button",
      (await page.locator('.composer-row button[aria-label="Send message"]').count()) === 1,
    );

    // Every icon-only control must be nameable; today's regression was that
    // most glyph buttons had no accessible name at all.
    const unnamed = await page.evaluate(() =>
      Array.from(document.querySelectorAll("button"))
        .filter((b) => {
          const hasIcon = b.querySelector("svg.icon") !== null;
          const text = (b.textContent ?? "").trim();
          const named = b.getAttribute("aria-label") || b.getAttribute("title");
          return hasIcon && text.length === 0 && !named;
        })
        .map((b) => b.className || "(button)"),
    );
    check("no unnamed icon-only buttons", unnamed.length === 0, unnamed);

    // The glyph census this replaced: emoji and dingbats rendered per-platform.
    const glyphs = await page.evaluate(() => {
      const found = new Set<string>();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      // Emoji, dingbats, arrows and geometric shapes. The variation selector is
      // an alternation branch, not a class member: it combines with the glyph
      // before it, so a class cannot express it.
      const re =
        /[\u2190-\u21FF\u2300-\u23FF\u25A0-\u25FF\u2600-\u27BF]|[\u{1F300}-\u{1FAFF}]|\uFE0F/gu;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (const m of (node.textContent ?? "").matchAll(re)) found.add(m[0]);
      }
      return [...found];
    });
    check("no emoji or dingbat glyphs left in the UI", glyphs.length === 0, glyphs);

    check(
      "favicon link is present",
      await page.evaluate(() => {
        const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
        return Boolean(link?.href?.startsWith("data:image/svg+xml"));
      }),
    );
    check(
      "the filter row above the transcript is gone",
      (await page.locator(".filters").count()) === 0,
    );

    // Sheets open, and Escape closes them.
    await page.locator('.composer-row button[aria-label^="Filter"]').click();
    check("filters sheet opens", await page.locator(".sheet-panel").isVisible());
    await shot(page, "phone-filters");
    check(
      "sheet is a bottom sheet on a phone",
      await page.evaluate(() => {
        const panel = document.querySelector(".sheet-panel");
        if (!panel) return false;
        const rect = panel.getBoundingClientRect();
        return Math.abs(rect.bottom - window.innerHeight) < 2;
      }),
    );
    await page.keyboard.press("Escape");
    check("escape closes the sheet", (await page.locator(".sheet-panel").count()) === 0);

    await page.locator('.composer-row button[aria-label^="Permission mode"]').click();
    check("permission sheet opens", await page.locator(".sheet-panel").isVisible());
    await shot(page, "phone-permissions");
    await page.keyboard.press("Escape");

    await page.locator('.composer-row button[aria-label="Run a command"]').click();
    check("commands sheet opens", await page.locator(".sheet-panel").isVisible());
    const commandCount = await page.locator(".sheet-panel .picker li").count();
    check("commands sheet lists commands", commandCount > 0, { commandCount });
    check(
      "undispatchable commands are hidden",
      (await page.locator('.sheet-panel .picker li:has-text("/secret")').count()) === 0 &&
        (await page.locator('.sheet-panel .picker li:has-text("/channels")').count()) === 0,
    );
    await shot(page, "phone-commands");
    await page.keyboard.press("Escape");

    await page.close();
  }

  // ── Desktop ──────────────────────────────────────────────────────────────
  section(`Desktop (${DESKTOP.width}px)`);
  {
    const page = await open(browser, DESKTOP);
    await shot(page, "desktop-chat");

    const box = await overflow(page);
    check("nothing is clipped off-screen", box.clipped.length === 0, box);

    check("hamburger is hidden", !(await page.locator(".topbar .icon-button.ghost").isVisible()));
    check(
      "sidebar is pinned on screen",
      await page.evaluate(() => {
        const el = document.querySelector(".sidebar");
        return el ? el.getBoundingClientRect().left >= 0 : false;
      }),
    );

    await page.locator('.composer-row button[aria-label^="Filter"]').click();
    check("filters sheet opens", await page.locator(".sheet-panel").isVisible());
    check(
      "sheet is a centred modal on desktop",
      await page.evaluate(() => {
        const panel = document.querySelector(".sheet-panel");
        if (!panel) return false;
        const rect = panel.getBoundingClientRect();
        // Centred means a gap below it, unlike the phone bottom sheet.
        return window.innerHeight - rect.bottom > 20;
      }),
    );
    await shot(page, "desktop-filters");
    await page.keyboard.press("Escape");

    // Settings: Channels is gone, the other three remain.
    await page.locator('nav.tabs button:text-is("Settings")').click();
    await page.waitForTimeout(500);
    check(
      "Channels section is gone",
      (await page.locator('.pane-bar button:text-is("Channels")').count()) === 0,
    );
    check(
      "Connection / MCP / Skills remain",
      (await page.locator(".pane-bar button").count()) === 3,
    );
    const settingsBox = await overflow(page);
    check("settings has nothing clipped", settingsBox.clipped.length === 0, settingsBox);
    await shot(page, "desktop-settings");

    await page.close();
  }
} finally {
  await browser.close();
}

console.log(
  failures === 0
    ? `\n✓ ui-check passed — screenshots in ${OUT_DIR}`
    : `\n✗ ui-check FAILED (${failures}) — screenshots in ${OUT_DIR}`,
);
process.exit(failures === 0 ? 0 : 1);
