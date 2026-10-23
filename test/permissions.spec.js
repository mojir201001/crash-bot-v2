import { describe, it, expect } from "vitest";
import { canAccess } from "../src/services/permissions.js";

describe("Role permissions", () => {
  it("allows owner to access all management permissions", () => {
    expect(canAccess("owner", "admin_management")).toBe(true);
    expect(canAccess("owner", "broadcast")).toBe(true);
    expect(canAccess("owner", "channel_archive")).toBe(true);
  });

  it("limits admins to permitted sections", () => {
    expect(canAccess("admin", "moderation")).toBe(true);
    expect(canAccess("admin", "message_archive")).toBe(true);
    expect(canAccess("admin", "ad_requests")).toBe(true);
    expect(canAccess("admin", "admin_management")).toBe(false);
    expect(canAccess("admin", "broadcast")).toBe(false);
    expect(canAccess("admin", "channel_archive")).toBe(false);
    expect(canAccess("admin", "chat_archive")).toBe(false);
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
