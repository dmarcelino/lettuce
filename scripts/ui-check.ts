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
    check(
      "the top bar names the agent",
      (await page.locator(".topbar .where-agent").innerText()).trim() !== "",
    );
    check("no drawer on a phone", !(await page.locator(".sidebar").isVisible()));

    // The switcher: agents and conversations in one full-screen menu, opened
    // from the composer. Each list starts with its own "new" card, in one
    // shared style, and the agents sit at the bottom, in thumb reach.
    const switcherButton = page.locator(
      '.composer-row button[aria-label="Agents and conversations"]',
    );
    check("composer has the switcher button", await switcherButton.isVisible());
    await switcherButton.click();
    const switcher = page.locator(".switcher");
    check("switcher opens", await switcher.isVisible());
    const news = switcher.locator(".switcher-new");
    const newLabels = await news.allInnerTexts();
    check(
      "New conversation and New agent are both there",
      newLabels.some((t) => t.startsWith("New conversation")) &&
        newLabels.some((t) => t === "New agent"),
      newLabels,
    );
    const newStyles = await news.evaluateAll((els) =>
      els.map((el) => {
        const cs = getComputedStyle(el);
        return [cs.borderStyle, cs.borderColor, cs.color, cs.fontWeight, cs.height].join("|");
      }),
    );
    check('both "new" cards share one style', new Set(newStyles).size === 1, newStyles);
    const agentsBox = await switcher.locator(".switcher-agents").boundingBox();
    check(
      "agents sit at the bottom",
      agentsBox !== null && Math.abs(agentsBox.y + agentsBox.height - PHONE.height) < 2,
      agentsBox,
    );
    const switcherBox = await overflow(page);
    check("switcher has nothing clipped", switcherBox.clipped.length === 0, switcherBox);
    await shot(page, "phone-switcher");
    await switcher.locator(".switcher-bar .sheet-close").click();
    check("back closes the switcher", (await page.locator(".switcher").count()) === 0);

    // The phone's Back button closes the top modal, never the app.
    const url = page.url();
    const pressBack = async () => {
      await page.evaluate(() => history.back());
      await page.waitForTimeout(400);
    };
    const onOverlayEntry = () =>
      page.evaluate(
        () => (history.state as { lettaOverlay?: boolean } | null)?.lettaOverlay === true,
      );
    check("closing on screen leaves no stale Back entry", !(await onOverlayEntry()));

    await switcherButton.click();
    await pressBack();
    check(
      "Back closes the switcher and stays in the app",
      (await page.locator(".switcher").count()) === 0 &&
        page.url() === url &&
        (await page.locator(".composer textarea").isVisible()),
    );

    await switcherButton.click();
    const more = page.locator(".switcher-list .switcher-more").first();
    if ((await more.count()) > 0) {
      await more.click();
      await pressBack();
      check(
        "Back closes the ⋯ menu first, keeping the switcher",
        (await page.locator(".switcher-menu").count()) === 0 &&
          (await page.locator(".switcher").count()) === 1,
      );
    }
    await pressBack();
    check("then Back closes the switcher", (await page.locator(".switcher").count()) === 0);

    await page.locator('.composer-row button[aria-label^="Filter"]').click();
    await pressBack();
    check(
      "Back closes a sheet and stays in the app",
      (await page.locator(".sheet-panel").count()) === 0 && page.url() === url,
    );

    // Fingertip-sized: every composer control is at least 44px on a phone, only
    // the switcher sits on the left, and the row fits without a sideways scroll.
    const controls = await page.evaluate(() => {
      const row = document.querySelector(".composer-row") as HTMLElement;
      // "Left" means before the spacer, the gap that splits the row, not left of
      // centre: six 44px buttons fill most of a phone row.
      const gap = (row.querySelector(".spacer") as HTMLElement).getBoundingClientRect().left;
      const buttons = [...row.querySelectorAll("button")].filter((b) => b.offsetParent !== null);
      return {
        small: buttons
          .map((b) => ({
            name: b.getAttribute("aria-label"),
            ...b.getBoundingClientRect().toJSON(),
          }))
          .filter((b) => b.width < 44 || b.height < 44)
          .map((b) => `${b.name} ${Math.round(b.width)}x${Math.round(b.height)}`),
        left: buttons
          .filter((b) => b.getBoundingClientRect().right <= gap)
          .map((b) => b.getAttribute("aria-label")),
        scrolls: row.scrollWidth > row.clientWidth + 1,
      };
    });
    check("composer buttons are at least 44px", controls.small.length === 0, controls.small);
    check(
      "only the switcher is on the left",
      controls.left.length === 1 && controls.left[0] === "Agents and conversations",
      controls.left,
    );
    check("composer row fits without scrolling", !controls.scrolls);

    // The composer is the single control surface; each control must exist and
    // be an icon button with an accessible name.
    for (const label of ["Filter the transcript", "Run a command"]) {
      const button = page.locator(`.composer-row button[aria-label="${label}"]`);
      check(`composer has "${label}"`, (await button.count()) === 1);
      check(`"${label}" is an icon button`, (await button.locator("svg.icon").count()) === 1);
    }
    // The model button's accessible name gains the model in force once one is
    // known ("Model: <name>"), so match on the prefix.
    const model = page.locator('.composer-row button[aria-label^="Model"]');
    check("composer has a model button", (await model.count()) === 1);
    check("model button is an icon button", (await model.locator("svg.icon").count()) === 1);
    const permission = page.locator('.composer-row button[aria-label^="Permission mode"]');
    check("composer has a permission-mode button", (await permission.count()) === 1);
    check(
      "permission button is icon-only",
      (await permission.innerText()).trim().length === 0,
      await permission.innerText(),
    );
    check(
      "permission button colours the mode",
      /\bmode-(unrestricted|acceptEdits|standard|strict)\b/.test(
        (await permission.getAttribute("class")) ?? "",
      ),
      await permission.getAttribute("class"),
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
    const groups = await page
      .locator(".sheet-panel .menu-list")
      .first()
      .locator(".menu-row-title")
      .allInnerTexts();
    check(
      "five filter groups incl. Tasks",
      groups.length === 5 && groups.some((g) => g.includes("Tasks")),
      groups,
    );
    // Timestamps: on by default, and the filter-sheet toggle hides them.
    const timestampToggle = page.locator(".sheet-panel .menu-row", { hasText: "Timestamps" });
    const toggleInput = {
      isChecked: async () => (await timestampToggle.getAttribute("aria-pressed")) === "true",
      uncheck: async () => {
        if (await toggleInput.isChecked()) await timestampToggle.click();
      },
      check: async () => {
        if (!(await toggleInput.isChecked())) await timestampToggle.click();
      },
    };
    check("timestamp toggle is in the filter sheet", (await timestampToggle.count()) === 1);
    check("timestamps are on by default", await toggleInput.isChecked());
    const hasEntries = (await page.locator(".messages .entry").count()) > 0;
    if (hasEntries) {
      check("entries carry a timestamp", (await page.locator(".messages time").count()) > 0);
    }
    await toggleInput.uncheck();
    check(
      "turning timestamps off hides them",
      (await page.locator(".messages time").count()) === 0,
    );
    await toggleInput.check();
    if (hasEntries) {
      check(
        "turning them back on restores them",
        (await page.locator(".messages time").count()) > 0,
      );
    }
    if (hasEntries) {
      // One message system: you on the right, the agent full width on the
      // left, different rail colours; steps folded; no uppercase labels.
      const style = await page.evaluate(() => {
        const user = document.querySelector<HTMLElement>(".messages .entry.user");
        const agent = document.querySelector<HTMLElement>(
          ".messages .entry.assistant:not(.subagent)",
        );
        const list = document.querySelector<HTMLElement>(".messages");
        const uppercase = [...document.querySelectorAll<HTMLElement>(".messages *")].filter(
          (el) => getComputedStyle(el).textTransform === "uppercase" && el.textContent?.trim(),
        ).length;
        return {
          userRail: user ? getComputedStyle(user).borderRightColor : null,
          agentRail: agent ? getComputedStyle(agent).borderLeftColor : null,
          userRight:
            user && list
              ? list.getBoundingClientRect().right - user.getBoundingClientRect().right < 30
              : null,
          uppercase,
          overflow: list ? list.scrollWidth > list.clientWidth + 1 : false,
        };
      });
      if (style.userRail && style.agentRail) {
        check(
          "you and the agent have different rail colours",
          style.userRail !== style.agentRail,
          style,
        );
      }
      if (style.userRight !== null) check("your messages sit on the right", style.userRight, style);
      check("no uppercase labels in the transcript", style.uppercase === 0, style);
      check("the transcript does not scroll sideways", !style.overflow, style);
      const steps = page.locator(".messages .steps-head").first();
      if ((await steps.count()) > 0) {
        check("steps start collapsed", (await steps.getAttribute("aria-expanded")) === "false");
        await steps.click();
        check("a tap opens the steps", (await steps.getAttribute("aria-expanded")) === "true");
        await steps.click();
      }
    }
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
    const commandCount = await page.locator(".sheet-panel .menu-list li").count();
    check("commands sheet lists commands", commandCount > 0, { commandCount });
    check(
      "undispatchable commands are hidden",
      (await page.locator('.sheet-panel .menu-list li:has-text("/secret")').count()) === 0 &&
        (await page.locator('.sheet-panel .menu-list li:has-text("/channels")').count()) === 0,
    );
    await shot(page, "phone-commands");
    await page.keyboard.press("Escape");

    // Every composer menu follows one set of rules: a header with a ✕, no
    // footer, and the shared row.
    for (const label of ["Run a command", "Filter", "Permission mode", "Model"]) {
      await page.locator(`.composer-row button[aria-label^="${label}"]`).first().click();
      await page.waitForTimeout(600);
      const shape = await page.evaluate(() => ({
        close: document.querySelectorAll(".sheet-panel .sheet-head .sheet-close").length,
        footer: document.querySelectorAll(".sheet-panel .sheet-actions").length,
        oldRows: document.querySelectorAll(".sheet-panel .picker").length,
        rows: document.querySelectorAll(".sheet-panel .menu-row").length,
        // Compact, but never below a fingertip target.
        shortRows: [...document.querySelectorAll(".sheet-panel .menu-row")].filter(
          (row) => row.getBoundingClientRect().height < 44,
        ).length,
      }));
      check(
        `"${label}" menu: header ✕, no footer, shared rows ≥44px`,
        shape.close === 1 &&
          shape.footer === 0 &&
          shape.oldRows === 0 &&
          shape.rows > 0 &&
          shape.shortRows === 0,
        shape,
      );
      await page.locator(".sheet-panel .sheet-close").click();
      await page.waitForTimeout(300);
    }

    // Typed slash commands. The popover has to be reachable without the sheet,
    // and it must not be the thing that pushes the composer off-screen — it
    // sits above a textarea the on-screen keyboard has already crowded.
    const textarea = page.locator(".composer textarea");
    await textarea.fill("/cl");
    const popover = page.locator(".composer-suggestions");
    check("typing a slash opens the suggestions", await popover.isVisible());
    check(
      "suggestions are filtered to the prefix",
      // An id match, not has-text: "/clear" is a text substring of
      // "/clear-messages" too, so has-text(/clear) over-counted once a second
      // command shared the prefix.
      (await popover.locator("li").count()) > 0 &&
        (await popover.locator("#composer-suggestion-clear").count()) === 1,
    );
    check(
      "a suggestion is highlighted by default",
      (await popover.locator("button.active").count()) === 1,
    );
    await shot(page, "phone-slash-suggestions");
    const withPopover = await overflow(page);
    check("suggestions do not clip the composer", withPopover.clipped.length === 0, withPopover);

    await page.keyboard.press("Escape");
    check("escape closes the suggestions", (await popover.count()) === 0);

    // A pasted absolute path is a message, not a command — the popover must
    // stay out of the way of it.
    await textarea.fill("/work/agent-x/notes.md");
    check("a path does not open the suggestions", (await popover.count()) === 0);
    await textarea.fill("");

    // An unsent draft survives a tab switch — the composer unmounts when the
    // Chat tab is left, so the text has to be persisted and restored.
    await textarea.fill("half a thought, unsent");
    await page.locator('nav.tabs button:text-is("Files")').click();
    await page.locator(".composer textarea").waitFor({ state: "detached" });
    await page.locator('nav.tabs button:text-is("Chat")').click();
    const restored = page.locator(".composer textarea");
    await restored.waitFor({ state: "visible" });
    check(
      "an unsent draft is restored after switching tabs",
      (await restored.inputValue()) === "half a thought, unsent",
      await restored.inputValue(),
    );
    await restored.fill("");

    await page.close();
  }

  // ── Desktop ──────────────────────────────────────────────────────────────
  section(`Desktop (${DESKTOP.width}px)`);
  {
    const page = await open(browser, DESKTOP);
    await shot(page, "desktop-chat");

    const box = await overflow(page);
    check("nothing is clipped off-screen", box.clipped.length === 0, box);

    check(
      "no switcher button in the composer on desktop",
      !(await page
        .locator('.composer-row button[aria-label="Agents and conversations"]')
        .isVisible()),
    );
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

    // Settings: Channels is gone; the rest of the chips are the ones we built.
    await page.locator('nav.tabs button:text-is("Settings")').click();
    await page.waitForTimeout(500);
    check(
      "Channels section is gone",
      (await page.locator('.pane-bar button:text-is("Channels")').count()) === 0,
    );
    const expectedChips = ["Connection", "MCP", "Skills", "Secrets", "Reflection", "Notifications"];
    const chipLabels = (await page.locator(".pane-bar button").allInnerTexts()).map((t) =>
      t.trim(),
    );
    check(
      `chips are ${expectedChips.join(" / ")}`,
      JSON.stringify(chipLabels) === JSON.stringify(expectedChips),
      chipLabels,
    );
    const settingsBox = await overflow(page);
    check("settings has nothing clipped", settingsBox.clipped.length === 0, settingsBox);

    // The two sections added from upstream must lay out like the existing ones,
    // not just exist. Secrets needs an agent selected; Reflection needs a
    // conversation, and renders an empty-state notice when it has none.
    for (const chip of ["Secrets", "Reflection"]) {
      await page.locator(`.pane-bar button:text-is("${chip}")`).click();
      await page.waitForTimeout(400);
      const box = await overflow(page);
      check(`${chip.toLowerCase()} section has nothing clipped`, box.clipped.length === 0, box);
    }
    await page.locator('.pane-bar button:text-is("Connection")').click();
    await page.waitForTimeout(300);

    // Models served: count in the heading, provider per row.
    const servedHeading = await page.locator('.section-note:has-text("Models served")').innerText();
    check("models-served heading carries a count", /\(\d+\)/.test(servedHeading), servedHeading);

    // Refreshing against a stable endpoint must NOT raise the change warning —
    // a detector that cries wolf on every refresh is worse than none.
    const warningSelector = '.warning:has-text("different set of models")';
    check(
      "no spurious model-change warning on load",
      (await page.locator(warningSelector).count()) === 0,
    );
    await page.locator('button:has-text("Refresh models")').click();
    await page.waitForTimeout(2500);
    check(
      "no spurious model-change warning after a refresh",
      (await page.locator(warningSelector).count()) === 0,
    );

    // Skills: the enable field is the only route to a global skill now that the
    // sandbox stops the agent writing /root/.letta/skills itself.
    await page.locator('.pane-bar button:text-is("Skills")').click();
    await page.waitForTimeout(300);
    const enableButton = page.locator('button:text-is("Enable globally")');
    check("skills section offers an enable field", (await enableButton.count()) === 1);
    check("enable is disabled until a path is typed", await enableButton.isDisabled());
    await page.locator('.pane input[placeholder^="/work/"]').fill("/work/agent-x/.agents/skills/s");
    check("enable becomes available with a path", await enableButton.isEnabled());
    const skillsBox = await overflow(page);
    check("skills section has nothing clipped", skillsBox.clipped.length === 0, skillsBox);
    await shot(page, "desktop-skills");

    // Notifications: headless Chromium supports the Push/Notification APIs,
    // so this renders the real toggle rather than the iOS install notice —
    // just needs to render without clipping, not actually subscribe.
    await page.locator('.pane-bar button:text-is("Notifications")').click();
    await page.waitForTimeout(300);
    check(
      "notifications section offers a toggle or an unsupported notice",
      (await page
        .locator('button:has-text("Enable notifications"), p:has-text("not supported")')
        .count()) > 0,
    );
    // The test-notification button is only useful once a device is subscribed,
    // and headless Chromium cannot subscribe (no push service), so its absence
    // here is the assertion: it must not offer a button that could only fail.
    check(
      "no test-notification button until this device is subscribed",
      (await page.locator('button:has-text("Send a test notification")').count()) === 0,
    );
    const notificationsBox = await overflow(page);
    check(
      "notifications section has nothing clipped",
      notificationsBox.clipped.length === 0,
      notificationsBox,
    );
    await shot(page, "desktop-notifications");

    await shot(page, "desktop-settings");

    // Sheet geometry. MemoryTab and TasksTab used to hand-roll the markup and
    // omit .sheet-panel, so on desktop the body and the actions became two
    // independently centred flex items — a narrow box with the buttons floating
    // outside it. The panel carries the desktop width, the radius and the
    // shadow, so its presence is the assertion that matters.
    await page.locator('nav.tabs button:text-is("Tasks")').click();
    await page.waitForTimeout(1000);
    await page.locator(".pane-bar button, .pane button").filter({ hasText: "New" }).first().click();
    await page.waitForTimeout(500);
    check("task sheet renders a panel", (await page.locator(".sheet-panel").count()) === 1);
    check(
      "actions live inside the panel, not beside it",
      (await page.locator(".sheet-panel .sheet-actions").count()) === 1,
    );
    const geometry = await page.evaluate(() => {
      const p = document.querySelector(".sheet-panel")?.getBoundingClientRect();
      const a = document.querySelector(".sheet-actions")?.getBoundingClientRect();
      const b = document.querySelector(".sheet-body")?.getBoundingClientRect();
      return p && a && b
        ? {
            panelWidth: Math.round(p.width),
            actionsInside: a.left >= p.left - 1 && a.right <= p.right + 1,
            bodyInside: b.left >= p.left - 1 && b.right <= p.right + 1,
            centred: Math.abs(p.left + p.width / 2 - window.innerWidth / 2) < 2,
          }
        : null;
    });
    const formPanelWidth = geometry?.panelWidth ?? 0;
    check("panel takes the desktop width", formPanelWidth >= 500, geometry);
    check("panel is centred", geometry?.centred === true, geometry);
    check(
      "body and actions are within the panel",
      Boolean(geometry?.bodyInside && geometry?.actionsInside),
      geometry,
    );
    await shot(page, "desktop-sheet");

    // The shared Sheet supplies a scrim and an Escape handler; the hand-rolled
    // ones had neither, so a sheet could only be dismissed by its own button.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    check("escape closes the task sheet", (await page.locator(".sheet-panel").count()) === 0);

    // A document sheet must actually be bigger than a form sheet, and must give
    // its height to the content: the memory editor used to scroll inside a
    // scrolling body, so a 5KB block showed about a dozen lines.
    await page.locator('nav.tabs button:text-is("Memory")').click();
    await page.waitForTimeout(1500);
    const memoryBlocks = await page.locator(".pane .list > li button").count();
    if (memoryBlocks === 0) {
      console.log("  SKIP  document sheet sizing (this agent has no memory blocks)");
    } else {
      await page.locator(".pane .list > li button").first().click();
      await page.waitForTimeout(600);
      const doc = await page.evaluate(() => {
        const panel = document.querySelector(".sheet-panel.fill");
        const body = document.querySelector(".sheet-panel.fill .sheet-body");
        const editor = document.querySelector(".sheet-panel.fill .memory-editor");
        if (!panel || !body || !editor) return null;
        return {
          panelWidth: Math.round(panel.getBoundingClientRect().width),
          editorHeight: Math.round(editor.getBoundingClientRect().height),
          // The body must NOT be the scroller; the editor must be.
          bodyScrolls: body.scrollHeight > body.clientHeight + 1,
        };
      });
      check("memory sheet fills its panel", doc !== null);
      // The point of the `fill` modifier is height, NOT width: a form sheet and
      // a document sheet must be the same size across, or the app looks like two
      // different apps depending on which modal you opened.
      check("every sheet is the same width", doc?.panelWidth === formPanelWidth, {
        form: formPanelWidth,
        document: doc?.panelWidth,
      });
      check("the editor gets the panel's height", (doc?.editorHeight ?? 0) > 300, doc);
      check("only one scroll region — the body does not scroll", doc?.bodyScrolls === false, doc);
      await shot(page, "desktop-memory-sheet");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }

    // Files must be retrievable, not just browsable. Anything the agent writes
    // — a tailored docx, a converted pdf — is otherwise stranded on the server.
    await page.locator('nav.tabs button:text-is("Files")').click();
    await page.waitForTimeout(1500);
    const fileRows = page.locator('.file-row button[aria-label^="Download "]');
    const downloadable = await fileRows.count();
    if (downloadable === 0) {
      // Asserting against an empty tree would pass for the wrong reason.
      console.log("  SKIP  a file downloads (no files in this agent's workspace)");
    } else {
      check("file rows carry a download button", downloadable > 0, { downloadable });

      // Prefer an ordinary file: a dotfile is a worse subject, because the
      // browser renames it on the way out (see below).
      const labels = await fileRows.evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("aria-label") ?? ""),
      );
      const names = labels.map((label) => label.replace(/^Download /, ""));
      const pick = Math.max(
        names.findIndex((name) => !name.startsWith(".")),
        0,
      );
      // Chromium strips leading dots from a download filename on purpose, so a
      // page cannot drop a hidden file into someone's Downloads folder. Nothing
      // we can or should override — the expectation is what the browser will
      // actually write.
      const expected = (names[pick] ?? "").replace(/^\.+/, "");

      // The only assertion that proves the blob actually reaches the browser's
      // download manager rather than just being built in memory.
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 15_000 }),
        fileRows.nth(pick).click(),
      ]);
      check(
        "a file download starts with the right name",
        download.suggestedFilename() === expected,
        {
          expected,
          got: download.suggestedFilename(),
        },
      );
      const filesBox = await overflow(page);
      check("files list has nothing clipped", filesBox.clipped.length === 0, filesBox);
      await shot(page, "desktop-files");
    }

    // A reload must come back to the agent you were on. It used to land on
    // whichever one agent_list returned first, which on a phone meant losing
    // your place every time the tab was reloaded.
    await page.locator('nav.tabs button:text-is("Chat")').click();
    const agentSelect = page.locator("#agent-select");
    const agentIds = (
      await agentSelect
        .locator("option")
        .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))
    ).filter((value) => value !== "");

    if (agentIds.length < 2) {
      // Nothing to switch to, so the assertion would pass for the wrong reason.
      console.log("  SKIP  selection survives a reload (needs two agents)");
    } else {
      const before = await agentSelect.inputValue();
      const target = agentIds.find((id) => id !== before) ?? before;
      await agentSelect.selectOption(target);
      await page.waitForTimeout(1500);
      const conversationBefore = await page
        .locator(".conversations li.active .conversation-name")
        .innerText()
        .catch(() => "");

      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(2000);
      check("agent selection survives a reload", (await agentSelect.inputValue()) === target, {
        expected: target,
        got: await agentSelect.inputValue(),
      });
      if (conversationBefore) {
        const conversationAfter = await page
          .locator(".conversations li.active .conversation-name")
          .innerText()
          .catch(() => "");
        check(
          "conversation selection survives a reload",
          conversationAfter === conversationBefore,
          { expected: conversationBefore, got: conversationAfter },
        );
      }
    }

    await page.close();
  }

  // ── Activity indicators ──────────────────────────────────────────────────
  // A turn cannot be started on demand here, so the BFF's `__bff_activity`
  // frame is injected into a real session instead. What is asserted is what a
  // DOM count cannot see: the dot occupies space and is painted. It once
  // shipped with no CSS at all — present in the DOM, 0x0 on screen.
  section("Activity indicators");
  for (const viewport of [DESKTOP, PHONE]) {
    const page = await browser.newPage({ viewport });
    let inject: ((frame: string) => void) | null = null;
    await page.routeWebSocket(/\/ws$/, (ws) => {
      ws.connectToServer();
      inject = (frame) => ws.send(frame);
    });
    await page.goto(`${ORIGIN}/auth/dev-login`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const agentId = await page.locator("#agent-select").inputValue();
    const rows = page.locator(".conversations li:not(.activity-note)");
    if (!agentId || (await rows.count()) === 0 || !inject) {
      check(`${viewport.width}px: activity check has an agent and a conversation`, false);
      await page.close();
      continue;
    }
    const send = inject as (frame: string) => void;
    // Mark a conversation other than the open one, so the phone badge shows too.
    const selection = await page.evaluate(() => localStorage.getItem("letta-ui:selection"));
    const openId = selection ? (JSON.parse(selection).conversationId as string | null) : null;
    send(
      JSON.stringify({
        type: "__bff_activity",
        active: [
          { agent_id: agentId, conversation_id: "default" },
          ...(openId ? [{ agent_id: agentId, conversation_id: openId }] : []),
        ],
      }),
    );
    await page.waitForTimeout(300);

    const painted = (selector: string) =>
      page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return { found: false };
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          found: true,
          width: rect.width,
          height: rect.height,
          background: style.backgroundColor,
          visible:
            rect.width >= 6 && rect.height >= 6 && style.backgroundColor !== "rgba(0, 0, 0, 0)",
        };
      }, selector);

    if (viewport === DESKTOP) {
      if (openId) {
        const dot = await painted(".conversations .conversation-name .activity-dot");
        check(
          "desktop: a responding conversation's dot is painted",
          dot.found && Boolean(dot.visible),
          dot,
        );
      }
      const note = await painted(".activity-note .activity-dot");
      check(
        "desktop: the default-conversation notice is painted",
        note.found && Boolean(note.visible),
        note,
      );
    } else {
      const badge = await painted(".topbar .badge-dot");
      check("phone: the menu badge is painted", badge.found && Boolean(badge.visible), badge);
    }
    await shot(page, `activity-${viewport.width}`);
    await page.close();
  }

  // ── Enter on a phone ─────────────────────────────────────────────────────
  // A real touch device: coarse pointer, no hover. There Enter must add a new
  // line and never send — an accidental send cannot be taken back. A plain
  // phone-sized viewport does not emulate the pointer, hence the context.
  section("Enter on a touch device");
  {
    const context = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/auth/dev-login`, { waitUntil: "networkidle" });
    const textarea = page.locator(".composer textarea");
    await textarea.waitFor();
    await textarea.fill("first line");
    await textarea.press("End");
    await textarea.press("Enter");
    await textarea.pressSequentially("second line");
    const value = await textarea.inputValue();
    check("Enter adds a new line instead of sending", value === "first line\nsecond line", value);
    await textarea.fill("");
    await context.close();
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
