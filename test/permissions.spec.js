import { describe, it, expect } from "vitest";
import { canAccess } from "../src/services/permissions.js";
import { adminMenu } from "../src/telegram/keyboards.js";

describe("Role permissions", () => {
  it("allows owner to access all management permissions", () => {
    expect(canAccess("owner", "admin_management")).toBe(true);
    expect(canAccess("owner", "broadcast")).toBe(true);
    expect(canAccess("owner", "channel_archive")).toBe(true);
  });

  it("limits admins to permitted sections", () => {
    expect(canAccess("admin", "moderation")).toBe(true);
    expect(canAccess("admin", "message_archive")).toBe(true);
    expect(canAccess("admin", "ad_requests")).toBe(false);
    expect(canAccess("admin", "admin_management")).toBe(false);
    expect(canAccess("admin", "broadcast")).toBe(false);
    expect(canAccess("admin", "channel_archive")).toBe(false);
    expect(canAccess("admin", "chat_archive")).toBe(false);
    const adminButtons = adminMenu(false).flat().map((button) => button.text);
    expect(adminButtons).not.toContain("📢 درخواست‌های تبلیغات");
    expect(adminButtons).not.toContain("📣 پیام همگانی");
    const ownerButtons = adminMenu(true).flat().map((button) => button.text);
    expect(ownerButtons).toContain("📢 درخواست‌های تبلیغات");
    expect(ownerButtons).toContain("📊 خروجی Excel");
    expect(ownerButtons).not.toContain("💬 آرشیو چت‌های کاربران");
  });

  it("denies management permissions to regular users", () => {
    expect(canAccess("user", "admin_panel")).toBe(false);
    expect(canAccess("user", "moderation")).toBe(false);
    expect(canAccess("user", "message_archive")).toBe(false);
  });

  it("denies unknown roles and permissions", () => {
    expect(canAccess("unknown", "admin_panel")).toBe(false);
    expect(canAccess("admin", "unknown_permission")).toBe(false);
  });
});
