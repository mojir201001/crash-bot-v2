import { afterEach, describe, expect, it, vi } from "vitest";
import {
  conversationMediaFromMessage,
  conversationMessageControls,
  deliverClaimedConversationMessage,
  sendConversationContent
} from "../src/services/conversation-engine.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shared conversation engine", () => {
  it("extracts supported Telegram media from message updates", () => {
    expect(conversationMediaFromMessage({
      photo: [{ file_id: "small" }, { file_id: "large" }]
    })).toEqual({
      type: "photo",
      method: "sendPhoto",
      fileId: "large"
    });
    expect(conversationMediaFromMessage({
      video_note: { file_id: "note" }
    })).toEqual({
      type: "video_note",
      method: "sendVideoNote",
      fileId: "note"
    });
    expect(conversationMediaFromMessage({ text: "plain text" })).toBeNull();
    for (const [type, method] of Object.entries({
      photo: "sendPhoto",
      voice: "sendVoice",
      audio: "sendAudio",
      video: "sendVideo",
      video_note: "sendVideoNote",
      document: "sendDocument",
      animation: "sendAnimation",
      sticker: "sendSticker"
    })) {
      expect(conversationMediaFromMessage({
        [type]: { file_id: `${type}-id` }
      })).toMatchObject({ type, method, fileId: `${type}-id` });
    }
  });

  it("builds source-specific controls from shared message state", () => {
    expect(conversationMessageControls({
      id: 12,
      sender_id: 50,
      visibility_status: "visible",
      view_delivery_status: "sent"
    }, 60, { namespace: "ad", includeView: true })).toEqual([
      [
        { text: "↩️ پاسخ", callback_data: "ad:reply:12" },
        { text: "🚫 بلاک", callback_data: "ad:block:12" }
      ]
    ]);
    expect(conversationMessageControls({
      id: 13,
      sender_id: 50,
      visibility_status: "blocked",
      view_delivery_status: "pending"
    }, 60, { namespace: "ad", includeView: true })[0][0].callback_data)
      .toBe("ad:unblock_view:13");
    expect(conversationMessageControls({
      id: 14,
      sender_id: 60,
      visibility_status: "visible",
      view_delivery_status: "sent"
    }, 60)).toEqual([
      [
        { text: "↩️ پاسخ به پیام", callback_data: "anon:reply:14" },
        { text: "🚫 مسدود کردن گفت‌وگو", callback_data: "anon:block:14" }
      ]
    ]);
  });

  it("settles delivery failures as unknown and does not retry them", async () => {
    const deliver = vi.fn().mockRejectedValue(new Error("network"));
    const settle = vi.fn().mockResolvedValue(undefined);
    const result = await deliverClaimedConversationMessage({
      deliver,
      settle,
      label: "test message"
    });
    expect(result.status).toBe("unknown");
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith("unknown", { outcome: "unknown" });
  });

  it.each([
    ["sent", "sent"],
    ["rejected", "failed"],
    ["unknown", "unknown"]
  ])("normalizes Telegram outcome %s to %s", async (outcome, status) => {
    const settle = vi.fn().mockResolvedValue(undefined);
    const result = await deliverClaimedConversationMessage({
      deliver: async () => ({ outcome }),
      settle
    });
    expect(result.status).toBe(status);
    expect(settle).toHaveBeenCalledWith(status, { outcome });
  });

  it("uses the shared Telegram transport for captions and no-caption media", async () => {
    const calls = [];
    let messageId = 100;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({
        method: String(url).split("/").at(-1),
        payload: JSON.parse(init.body)
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: { message_id: ++messageId }
        })
      };
    }));

    await sendConversationContent({}, 123, {
      text: "header",
      mediaType: "photo",
      mediaFileId: "photo-id",
      inlineKeyboard: [[{ text: "Reply", callback_data: "anon:reply:1" }]]
    });
    const sticker = await sendConversationContent({}, 123, {
      text: "sticker header",
      mediaType: "sticker",
      mediaFileId: "sticker-id"
    });

    expect(calls.map((call) => call.method))
      .toEqual(["sendPhoto", "sendMessage", "sendSticker"]);
    expect(calls[0].payload.caption).toBe("header");
    expect(calls[0].payload.reply_markup.inline_keyboard[0][0].callback_data)
      .toBe("anon:reply:1");
    expect(sticker.messageIds).toHaveLength(2);
  });
});
