export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "crash-bot-v2"
      });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      if (!env.TELEGRAM_BOT_TOKEN || !env.WEBHOOK_SECRET) {
        return Response.json(
          { ok: false, error: "Bot is not configured" },
          { status: 503 }
        );
      }

      const secret = request.headers.get(
        "X-Telegram-Bot-Api-Secret-Token"
      );

      if (secret !== env.WEBHOOK_SECRET) {
        return Response.json({ ok: false }, { status: 401 });
      }

      let update;

      try {
        update = await request.json();
      } catch {
        return Response.json(
          { ok: false, error: "Invalid JSON" },
          { status: 400 }
        );
      }

      const message = update?.message;

      if (message?.text === "/start" && message?.chat?.id) {
        const response = await fetch(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: message.chat.id,
              text: "سلام! به کراش‌یاب ادیب خوش آمدی. ربات با موفقیت متصل شده است."
            })
          }
        );

        if (!response.ok) {
          console.error("Telegram sendMessage failed:", response.status);
          return Response.json(
            { ok: false, error: "Telegram API error" },
            { status: 502 }
          );
        }
      }

      return Response.json({ ok: true });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }
};
