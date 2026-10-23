export async function sendTelegram(env, chatId, text, keyboard) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        reply_markup: {
          keyboard,
          resize_keyboard: true,
          is_persistent: true
        }
      })
    }
  );

  if (!response.ok) {
    console.error("Telegram sendMessage failed:", response.status);
    return false;
  }

  const result = await response.json();
  return result.ok === true;
}
