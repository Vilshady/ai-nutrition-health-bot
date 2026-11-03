export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("AI Nutrition Bot is Running!", { status: 200 });
    }

    try {
      const update = await request.json();
      if (!update.message) return new Response("OK");

      const msg = update.message;
      const chatId = msg.chat.id;
      const fromUser = msg.from || {};
      const firstName = fromUser.first_name || "Друг";

      // Настройка пользователей (Fitbit синхронизируется только для основного ID)
      const primaryUserId = Number(env.PRIMARY_USER_ID || 0);
      const isPrimary = chatId === primaryUserId;
      const user = {
        name: firstName,
        sheet: isPrimary ? (env.PRIMARY_USER_SHEET || "Vilshady") : firstName,
        fitbit: isPrimary
      };

      const text = msg.text || msg.caption || "";
      const lower = text.trim().toLowerCase();

      // Команда /start
      if (lower === "/start") {
        await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, 
          `👋 <b>Привет, ${user.name}!</b>\nЯ твой персональный AI-нутрициолог.\n\n• Присылай фото еды или пиши текстом\n• Твой отдельный лист в таблице: <b>${user.sheet}</b>\n• Напиши <i>«удали»</i> для отмены\n• <i>/stats</i> — сводка за день.`
        );
        return new Response("OK");
      }

      // Определение биологической даты (сутки сменяются в 05:00 утра)
      const now = new Date(new Date().getTime() + 3 * 3600 * 1000); // UTC+3
      if (now.getUTCHours() < 5) {
        now.setUTCDate(now.getUTCDate() - 1);
      }
      const bioDate = now.toISOString().split("T")[0];

      // Команда «удали»
      if (["удали", "отмени", "стереть", "/undo"].includes(lower)) {
        await fetch(`${env.SHEETS_URL}?action=delete_last&sheet=${encodeURIComponent(user.sheet)}`);
        await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, `🗑 Последняя запись удалена с листа «${user.sheet}».`);
        return new Response("OK");
      }

      // Команда «статистика»
      if (lower.startsWith("/stats") || lower.includes("что я ел") || lower.includes("статистик")) {
        const rowsRes = await fetch(`${env.SHEETS_URL}?sheet=${encodeURIComponent(user.sheet)}`);
        const rows = await rowsRes.json();
        let totalKcal = 0, totalP = 0, totalF = 0, totalC = 0;
        let mealsList = [];

        if (rows && rows.length > 1) {
          for (const r of rows.slice(1)) {
            const rDate = String(r[0]).split("T")[0];
            if (rDate === bioDate) {
              const kcal = Number(r[4]) || 0;
              const p = Number(r[5]) || 0;
              const f = Number(r[6]) || 0;
              const c = Number(r[7]) || 0;
              totalKcal += kcal; totalP += p; totalF += f; totalC += c;
              mealsList.push(`• <b>${r[2]}</b>: ${r[3]} (${kcal} ккал)`);
            }
          }
        }

        if (mealsList.length === 0) {
          await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, `📅 За сегодня (${bioDate}) записей пока нет.`);
        } else {
          await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, 
            `📊 <b>Сводка за день (${bioDate}) для ${user.name}:</b>\n\n${mealsList.join("\n")}\n\n🔥 <b>Итого: ${totalKcal} ккал</b> (Б:${totalP.toFixed(1)}г | Ж:${totalF.toFixed(1)}г | У:${totalC.toFixed(1)}г)`
          );
        }
        return new Response("OK");
      }

      // Обработка фото
      let imageBase64 = null;
      if (msg.photo && msg.photo.length > 0) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const fileRes = await (await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`)).json();
        const filePath = fileRes.result.file_path;
        const imgBuffer = await (await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`)).arrayBuffer();
        imageBase64 = arrayBufferToBase64(imgBuffer);
      }

      // Анализ через Gemini API
      const parsed = await analyzeWithGemini(env.GEMINI_API_KEY, user.name, text, imageBase64);

      if (parsed.type === "greeting") {
        await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, parsed.reply || `👋 Привет, ${user.name}! Что вкусного сегодня в меню?`);
        return new Response("OK");
      }

      if (parsed.type === "delete") {
        await fetch(`${env.SHEETS_URL}?action=delete_last&sheet=${encodeURIComponent(user.sheet)}`);
        await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, `🗑 Запись удалена с листа «${user.sheet}».`);
        return new Response("OK");
      }

      if (!parsed.calories || parsed.calories <= 0) {
        await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, "🤔 Не похоже на еду. Напиши конкретнее, что съел, или прикрепи фото блюда!");
        return new Response("OK");
      }

      // Определение слота (Завтрак / Обед / Ужин)
      const rowsRes = await fetch(`${env.SHEETS_URL}?sheet=${encodeURIComponent(user.sheet)}`);
      const rows = await rowsRes.json();
      let slotsToday = [];
      if (rows && rows.length > 1) {
        for (const r of rows.slice(1)) {
          if (String(r[0]).split("T")[0] === bioDate && r[2]) {
            slotsToday.push(String(r[2]).trim());
          }
        }
      }

      let slotName = "Завтрак";
      let slotEnum = "BREAKFAST";
      if (!slotsToday.includes("Завтрак")) {
        slotName = "Завтрак"; slotEnum = "BREAKFAST";
      } else if (!slotsToday.includes("Обед")) {
        slotName = "Обед"; slotEnum = "LUNCH";
      } else if (!slotsToday.includes("Ужин")) {
        slotName = "Ужин"; slotEnum = "DINNER";
      } else {
        slotName = "Ужин (добор)"; slotEnum = "DINNER";
      }

      const timeStr = now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

      // Запись в Google Таблицу
      await fetch(env.SHEETS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sheet: user.sheet,
          date: bioDate,
          time: timeStr,
          meal_type: slotName,
          name: parsed.name,
          calories: parsed.calories,
          protein: parsed.protein || 0,
          fat: parsed.fat || 0,
          carbs: parsed.carbs || 0,
          fiber: parsed.fiber || 0,
          protein_source: parsed.protein_source || "",
          nutrients: parsed.nutrients || "",
          amino_profile: parsed.amino_profile || ""
        })
      });

      // Запись в Fitbit (если включен)
      let fitbitStatus = "";
      if (user.fitbit && env.FITBIT_MCP_URL && env.FITBIT_TOKEN) {
        try {
          await fetch(env.FITBIT_MCP_URL, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.FITBIT_TOKEN}`,
              "Content-Type": "application/json",
              "User-Agent": "Mozilla/5.0"
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: Date.now(),
              method: "tools/call",
              params: {
                name: "log_food",
                arguments: {
                  name: parsed.name,
                  meal_type: slotEnum,
                  calories_kcal: parsed.calories,
                  protein_g: parsed.protein || 0,
                  fat_g: parsed.fat || 0,
                  carbs_g: parsed.carbs || 0,
                  datetime: new Date().toISOString()
                }
              }
            })
          });
          fitbitStatus = " | Fitbit ✓";
        } catch (e) {}
      }

      const commentBlock = parsed.comment ? `\n💬 <i>${parsed.comment}</i>\n` : "";
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, 
        `✅ <b>Записал в ${slotName}!</b>\n\n🍽 <b>${parsed.name}</b>\n• <b>Калории:</b> ${parsed.calories} ккал\n• <b>БЖУ:</b> Б: ${parsed.protein}г | Ж: ${parsed.fat}г | У: ${parsed.carbs}г\n• <b>Клетчатка:</b> ${parsed.fiber || 0}г\n• <b>Белок:</b> ${parsed.protein_source || ""}\n• <b>Нутриенты:</b> ${parsed.nutrients || ""}${commentBlock}\n🔗 <i>Лист «${user.sheet}» ✓${fitbitStatus}</i>`
      );

    } catch (err) {
      console.error(err);
    }

    return new Response("OK");
  }
};

async function sendTelegram(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: "HTML" })
  });
}

async function analyzeWithGemini(apiKey, userName, text, imageBase64) {
  const prompt = `Ты персональный нутрициолог и фитнес-наставник пользователя ${userName}.
Общайся как живой человек, без шаблонной роботизированной шелухи.
Верни строго JSON объект:
1. "type": "greeting" (если просто диалог), "food" (если еда), "delete" (если отмена).
2. Если greeting: "reply" (живой ответ).
3. Если food:
   - "name": емкое название с весом в скобках.
   - "calories": целое число ккал.
   - "protein", "fat", "carbs", "fiber": числа граммов с 1 знаком.
   - "protein_source", "nutrients", "amino_profile": краткие строки.
   - "comment": краткий живой комментарий от наставника к блюду.`;

  const parts = [{ text: prompt }];
  if (text) parts.push({ text: `Ввод пользователя: ${text}` });
  if (imageBase64) {
    parts.push({
      inline_data: { mime_type: "image/jpeg", data: imageBase64 }
    });
  }

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseMimeType: "application/json" }
    })
  });

  const data = await res.json();
  let raw = data.candidates[0].content.parts[0].text.trim();
  raw = raw.replace(/^```[a-z]*\n/, "").replace(/\n```$/, "");
  return JSON.parse(raw);
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
