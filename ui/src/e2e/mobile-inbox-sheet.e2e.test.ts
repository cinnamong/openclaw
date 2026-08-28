import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
const viewport = { width: 390, height: 844 };
const suite = createControlUiE2eSuite({
  name: "Control UI mobile Inbox sheet",
  startServerBeforeBrowser: true,
  trackBrowserContexts: true,
});

async function setTheme(page: import("playwright").Page, theme: "dark" | "light") {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate((nextTheme) => {
    const root = document.documentElement;
    root.dataset.themeMode = nextTheme;
    root.dataset.themeResolved = nextTheme;
    root.classList.toggle("wa-dark", nextTheme === "dark");
    root.classList.toggle("wa-light", nextTheme === "light");
    root.style.colorScheme = nextTheme;
  }, theme);
}

suite.define(() => {
  it("rises from the bottom with a continuous header and touch-sized close control", async () => {
    const results: Array<{
      closeBorderRadius: string;
      closeHeight: number;
      closeWidth: number;
      easing: string;
      sheetBackground: string;
      headerBackground: string;
      listBackground: string;
      startTop: number;
      finalTop: number;
      duration: number;
    }> = [];

    for (const theme of ["light", "dark"] as const) {
      const context = await suite.newBrowserContext({
        colorScheme: theme,
        locale: "en-US",
        recordVideo: artifactDir
          ? { dir: path.join(artifactDir, "video"), size: viewport }
          : undefined,
        reducedMotion: "no-preference",
        serviceWorkers: "block",
        viewport,
      });
      const page = await context.newPage();
      await installMockGateway(page, { operatorScopes: ["operator.read", "operator.write"] });
      await page.goto(`${suite.server.baseUrl}activity`);
      await setTheme(page, theme);
      await page.getByRole("button", { name: "Expand sidebar" }).click();
      await page.locator(".nav-drawer").waitFor();
      await page.locator(".sidebar-issues-button:visible").click();
      const panel = page.locator("#sidebar-issues-panel");
      await panel.waitFor({ state: "attached" });

      const result = await panel.evaluate(async (element) => {
        const animation = element.getAnimations().find((candidate) => {
          const effect = candidate.effect;
          return effect instanceof KeyframeEffect && effect.target === element;
        });
        if (!animation?.effect) {
          throw new Error("Expected the mobile Inbox sheet entrance animation");
        }
        const timing = animation.effect.getComputedTiming();
        const startTop = element.getBoundingClientRect().top;
        await animation.finished;
        const close = element.querySelector<HTMLElement>(".sidebar-issues-panel__mobile-close")!;
        const header = element.querySelector<HTMLElement>(".sidebar-issues-panel__header")!;
        const list = element.querySelector<HTMLElement>(".sidebar-issues-panel__list-wrap")!;
        return {
          closeBorderRadius: getComputedStyle(close).borderRadius,
          closeHeight: close.getBoundingClientRect().height,
          closeWidth: close.getBoundingClientRect().width,
          duration: Number(timing.duration),
          easing: getComputedStyle(element).animationTimingFunction,
          finalTop: element.getBoundingClientRect().top,
          sheetBackground: getComputedStyle(element).backgroundColor,
          headerBackground: getComputedStyle(header).backgroundColor,
          listBackground: getComputedStyle(list).backgroundColor,
          startTop,
        };
      });
      results.push(result);

      if (artifactDir) {
        await mkdir(artifactDir, { recursive: true });
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, `mobile-inbox-${theme}.png`),
        });
      }
      await suite.closeBrowserContext(context);
    }

    for (const result of results) {
      expect(result.startTop).toBeGreaterThan(result.finalTop + 100);
      expect(result.duration).toBeGreaterThanOrEqual(200);
      expect(result.duration).toBeLessThan(300);
      expect(result.easing).toBe("cubic-bezier(0.32, 0.72, 0, 1)");
      expect(result.sheetBackground).toBe(result.headerBackground);
      expect(result.headerBackground).not.toBe(result.listBackground);
      expect(result.closeWidth).toBeGreaterThanOrEqual(44);
      expect(result.closeHeight).toBeGreaterThanOrEqual(44);
      expect(result.closeBorderRadius).toBe("9999px");
    }
  });

  it("removes sheet movement when reduced motion is requested", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        reducedMotion: "reduce",
        serviceWorkers: "block",
        viewport,
      },
      async ({ page }) => {
        await installMockGateway(page, { operatorScopes: ["operator.read", "operator.write"] });
        await page.goto(`${suite.server.baseUrl}activity`);
        await page.getByRole("button", { name: "Expand sidebar" }).click();
        await page.locator(".nav-drawer").waitFor();
        await page.locator(".sidebar-issues-button:visible").click();
        const panel = page.locator("#sidebar-issues-panel");
        await panel.waitFor();
        expect(await panel.evaluate((element) => getComputedStyle(element).animationName)).toBe(
          "none",
        );
      },
    );
  });
});
