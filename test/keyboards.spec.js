import { describe, it, expect } from "vitest";
import { userMenu, adminMenu } from "../src/telegram/keyboards.js";

const buttonTexts = (keyboard) => keyboard.flat().map((button) => button.text);

describe("Telegram menus", () => {
  it("shows only user options to regular users", () => {
    const buttons = buttonTexts(userMenu(false));

    expect(buttons).toContain("👤 پروفایل من");
    expect(buttons).toContain("💌 ثبت پست کراش");
    expect(buttons).not.toContain("🛠 پنل مدیریت");
  });

  it("shows the management entry to admins and owners", () => {
    expect(buttonTexts(userMenu(true))).toContain("🛠 پنل مدیریت");
  });

  it("limits the admin menu to permitted sections", () => {
    const buttons = buttonTexts(adminMenu(false));

    expect(buttons).toContain("🔎 بررسی پیام‌های ناشناس");
    expect(buttons).toContain("🗂 آرشیو پیام‌های ناشناس");
    expect(buttons).toContain("📢 درخواست‌های تبلیغات");
    expect(buttons).toContain("👤 پنل کاربر");

    expect(buttons).not.toContain("👥 مدیریت ادمین‌ها");
    expect(buttons).not.toContain("📣 پیام همگانی");
    expect(buttons).not.toContain("⚙️ تنظیمات ربات");
  });

  it("shows owner-only sections to the owner", () => {
    const buttons = buttonTexts(adminMenu(true));

    expect(buttons).toContain("👥 مدیریت ادمین‌ها");
    expect(buttons).toContain("📣 پیام همگانی");
    expect(buttons).toContain("⚙️ تنظیمات ربات");
    expect(buttons).toContain("🗃 آرشیو پیام‌های کانال");
  });
});
