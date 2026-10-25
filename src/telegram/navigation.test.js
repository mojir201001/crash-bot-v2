import { describe, expect, it } from "vitest";
import {
  buildNavigationPage,
  buildPlaceholderPage
} from "./navigation.js";

describe("navigation pages", () => {
  it("shows user menu without admin entry for ordinary users", () => {
    const page = buildNavigationPage("home");
    expect(page.keyboard.flat().some(button => button.callback_data === "nav:admin")).toBe(false);
    expect(page.keyboard.flat().some(button => button.callback_data === "act:profile")).toBe(true);
  });

  it("shows admin entry for staff", () => {
    const page = buildNavigationPage("home", { isStaff: true });
    expect(page.keyboard.flat().some(button => button.callback_data === "nav:admin")).toBe(true);
  });

  it("does not expose admin panel to ordinary users", () => {
    const page = buildNavigationPage("admin", { isStaff: false });
    expect(page.keyboard.flat().some(button => button.callback_data === "act:broadcast")).toBe(false);
  });

  it("adds a return-to-home button to the user menu", () => {
    const page = buildNavigationPage("home");
    expect(page.keyboard.flat().some(button => button.callback_data === "nav:home")).toBe(false);
    expect(page.text).toContain("کراش‌یاب ادیب");
  });

  it("blocks owner-only actions for regular staff", () => {
    expect(buildPlaceholderPage("broadcast", { isStaff: true, isOwner: false })).toBeNull();
  });

  it("provides a back button for a known feature", () => {
    const page = buildPlaceholderPage("profile");
    expect(page.keyboard.flat().some(button => button.callback_data === "nav:home")).toBe(true);
  });
});
