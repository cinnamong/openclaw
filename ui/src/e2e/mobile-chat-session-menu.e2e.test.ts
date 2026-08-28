import { expect, it } from "vitest";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionRow,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite(true);

suite.define(() => {
  it.each(["light", "dark"] as const)(
    "keeps mobile sharing inside the %s session More menu",
    async (colorScheme) => {
      const sessionKey = "agent:main:mobile-more";
      const context = await suite.browser.newContext({
        colorScheme,
        hasTouch: true,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 844, width: 390 },
      });
      const page = await context.newPage();
      await installMockGateway(page, {
        allowedSessionVisibilities: ["shared", "read-only", "suggest", "draft"],
        featureMethods: [
          "chat.metadata",
          "chat.startup",
          "session.visibility.set",
          "session.members.listEvidence",
          "session.members.add",
          "session.members.remove",
        ],
        operatorScopes: ["operator.read", "operator.write"],
        sessionKey,
        methodResponses: {
          "sessions.list": sessionsListResponse([
            {
              ...sessionRow(sessionKey, "Mobile menu", Date.parse("2026-08-28T12:00:00.000Z")),
              sharingRole: "owner",
              visibility: "shared",
            },
          ]),
          "session.members.listEvidence": {
            sessionKey,
            owner: { type: "human", id: "owner", label: "Owner" },
            members: [],
            identities: [
              { type: "human", id: "owner", label: "Owner" },
              { type: "human", id: "vyctor", label: "Vyctor" },
            ],
            role: "owner",
            allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
          },
        },
      });

      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await page.getByRole("button", { name: "Actions for Mobile menu" }).click();
        const menu = page.getByRole("menu", { name: "Actions for Mobile menu" });
        const menuHost = page.locator("openclaw-chat-header-session-menu");
        await menu.waitFor({ state: "visible" });
        const rootItems = menuHost.locator(":scope > wa-dropdown > wa-dropdown-item");
        const minimumHeights = await rootItems.evaluateAll((items) =>
          items.map((item) => getComputedStyle(item).minHeight),
        );
        expect(minimumHeights).toEqual(minimumHeights.map(() => "40px"));
        const deleteIconColor = await menuHost
          .locator('wa-dropdown-item[value="delete"] .session-menu__icon')
          .evaluate((element) => getComputedStyle(element).color);
        const deleteLabelColor = await menuHost
          .locator('wa-dropdown-item[value="delete"] .session-menu__text')
          .evaluate((element) => getComputedStyle(element).color);
        expect(deleteIconColor).toBe(deleteLabelColor);
        await captureUiProof(page, `mobile-more-after-${colorScheme}.png`);

        await expect
          .poll(() => page.getByRole("button", { name: "Session sharing" }).count())
          .toBe(0);
        await menuHost.locator('wa-dropdown-item[value="compact:open-sharing"]').click();
        await menuHost.locator('wa-dropdown-item[value="visibility:shared"]').waitFor();
        await menuHost.getByText("Members", { exact: true }).waitFor();
        await captureUiProof(page, `mobile-more-sharing-after-${colorScheme}.png`);
      } finally {
        await context.close();
      }
    },
  );
});
