import { describe, it, expect, vi, afterEach } from "vitest";
import {
  sendInlineTelegram,
  answerCallbackQuery,
  editInlineTelegram
} from "../src/telegram/api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Telegram inline keyboard API", () => {
  const env = { TELEGRAM_BOT_TOKEN: "test-token" };

  it("sends inline keyboard buttons", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true })
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendInlineTelegram(
      env,
      123,
      "مدیریت عضویت",
      [[{ text: "افزودن", callback_data: "membership:add" }]]
    );

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.chat_id).toBe(123);
    expect(body.reply_markup.inline_keyboard[0][0].callback_data)
      .toBe("membership:add");
  });

  it("answers a callback query", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true })
    }));

    await expect(answerCallbackQuery(env, "callback-1", "انجام شد"))
      .resolves.toBe(true);

    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.callback_query_id).toBe("callback-1");
    expect(body.text).toBe("انجام شد");
  });

  it("edits a message with inline buttons", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true })
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(editInlineTelegram(
      env,
      123,
      456,
      "فهرست",
      [[{ text: "بازگشت", callback_data: "membership:back" }]]
    )).resolves.toBe(true);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.message_id).toBe(456);
    expect(body.reply_markup.inline_keyboard[0][0].callback_data)
      .toBe("membership:back");
  });
});
