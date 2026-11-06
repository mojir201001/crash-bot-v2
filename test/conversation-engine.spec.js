import { afterEach, describe, expect, it, vi } from "vitest";
import {
  conversationMediaFromMessage,
  conversationMessageControls,
  deliverClaimedConversationMessage,
  isPrivateConversationMessage,
  sendConversationReadReceipt,
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
    expect(conversationMessageControls({
      id: 15,
      sender_id: 60,
      visibility_status: "visible",
      view_delivery_status: "sent"
    }, 60, { blockedByViewer: true })[0][0].callback_data)
      .toBe("anon:unblock:15");
    expect(conversationMessageControls({
      id: 16,
      sender_id: 60,
      visibility_status: "visible",
      view_delivery_status: "sent"
    }, 60, { blockedByOther: true })).toBeNull();
  });

  it("accepts only actual private messages from the matching safe Telegram user", () => {
    const message = {
      from: { id: 50 },
      chat: { id: 50, type: "private" },
      message_id: 10,
      text: "hello"
    };
    expect(isPrivateConversationMessage(message, 50)).toBe(true);
    expect(isPrivateConversationMessage({ ...message, from: { id: 51 } }, 50)).toBe(false);
    expect(isPrivateConversationMessage({ ...message, chat: { id: 50, type: "group" } }, 50)).toBe(false);
    expect(isPrivateConversationMessage({ ...message, message_id: 0 }, 50)).toBe(false);
    expect(isPrivateConversationMessage(message, Number.MAX_SAFE_INTEGER + 1)).toBe(false);
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

  it("replies to read receipts and falls back with the original ID on definite rejection", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const payload = JSON.parse(init.body);
      calls.push(payload);
      return new Response(JSON.stringify({
        ok: calls.length > 1,
        ...(calls.length > 1
          ? { result: { message_id: 211 } }
          : { description: "reply target unavailable" })
      }), {
        status: calls.length > 1 ? 200 : 400,
        headers: { "Content-Type": "application/json" }
      });
    }));

    await expect(sendConversationReadReceipt({}, 50, 117))
      .resolves.toMatchObject({ outcome: "sent" });
    expect(calls[0].reply_parameters).toEqual({ message_id: 117 });
    expect(calls[1].reply_parameters).toBeUndefined();
    expect(calls[1].text).toContain("#117");
  });
});
