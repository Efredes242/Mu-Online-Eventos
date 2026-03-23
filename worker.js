export default {
  // Cron trigger execution
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleSchedule(env));
  },

  // HTTP trigger
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- SETUP WEBHOOK (Temporary helper) ---
    if (url.pathname === "/setup-webhook") {
      const token = env.TELEGRAM_BOT_TOKEN;
      const webhookUrl = `https://${url.host}/telegram-webhook`;
      const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook?url=${webhookUrl}`);
      const data = await res.json();
      return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
    }

    // --- TELEGRAM WEBHOOK HANDLER ---
    if (url.pathname === "/telegram-webhook" && request.method === "POST") {
      try {
        const update = await request.json();
        await handleTelegramUpdate(update, env);
      } catch (err) {
        console.error("Webhook Error:", err.message);
      }
      return new Response("OK");
    }

    // --- DASHBOARD (Default) ---
    const eventsData = await getEventsData(env);
    const html = renderHTML(eventsData, env);
    return new Response(html, {
      headers: { "Content-Type": "text/html;charset=UTF-8" }
    });
  }
};

// ==========================================
// 🛡️ AUTHENTICATION & SCRAPING
// ==========================================

async function getSession(env) {
  const cached = await env.AWAKE_CACHE.get("session_data", "json");
  if (cached && cached.cookies) return cached;
  return null;
}

async function performLogin(env, server = "X500") {
  const user = env.AWAKE_USER;
  const pass = env.AWAKE_PASS;
  if (!user || !pass) throw new Error("Missing AWAKE_USER or AWAKE_PASS secrets");

  console.log(`[AUTH] Login como ${user} en servidor ${server}...`);

  const step1 = await fetch("https://www.awakemu.com/", {
    method: "POST",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AwakeTelegramBot/2.0",
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": "https://www.awakemu.com/"
    },
    body: new URLSearchParams({ username: user, password: pass }).toString(),
    redirect: "follow"
  });

  const cookies = [];
  step1.headers.forEach((value, k) => { if (k.toLowerCase() === "set-cookie") cookies.push(value.split(";")[0].trim()); });
  const step1Html = await step1.text();
  if (!step1Html.includes("switch_server") && !step1Html.includes("SELECT SERVER")) throw new Error("Login failed (check credentials)");

  const step2 = await fetch("https://www.awakemu.com/", {
    method: "POST",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AwakeTelegramBot/2.0",
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": "https://www.awakemu.com/",
      "Cookie": cookies.join("; ")
    },
    body: new URLSearchParams({ server }).toString(),
    redirect: "follow"
  });

  step2.headers.forEach((value, k) => {
    if (k.toLowerCase() === "set-cookie") {
      const pair = value.split(";")[0].trim();
      if (!cookies.includes(pair)) cookies.push(pair);
    }
  });

  const sessionData = { cookies: cookies.join("; "), server, timestamp: Date.now() };
  await env.AWAKE_CACHE.put("session_data", JSON.stringify(sessionData), { expirationTtl: 3600 * 24 });
  return sessionData;
}

async function scrapeCharacterInfo(env) {
  let session = await getSession(env);
  if (!session) session = await performLogin(env);

  let res = await fetch(env.CHARACTER_URL, {
    headers: { 
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AwakeTelegramBot/2.0",
      "Cookie": session.cookies 
    }
  });

  let html;
  if (!res.ok) {
    if (res.status === 403 || res.status === 401) {
      session = await performLogin(env);
      res = await fetch(env.CHARACTER_URL, { headers: { "User-Agent": "Mozilla/5.0", "Cookie": session.cookies } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      html = await res.text();
    } else throw new Error("HTTP " + res.status);
  } else {
    html = await res.text();
  }

  const extract = (regex) => { const m = html.match(regex); return m ? m[1].trim() : "N/A"; };
  const level = extract(/Level<\/td>\s*<td[^>]*>(\d+)<\/td>/);
  const resets = extract(/Resets<\/td>\s*<td[^>]*>(\d+)<\/td>/);
  const strength = extract(/Strength<\/td>\s*<td[^>]*>\s*(\d+)\s*<\/td>/);
  const agility = extract(/Agility<\/td>\s*<td[^>]*>\s*(\d+)\s*<\/td>/);
  const vitality = extract(/Vitality<\/td>\s*<td[^>]*>\s*(\d+)\s*<\/td>/);
  const energy = extract(/Energy<\/td>\s*<td[^>]*>\s*(\d+)\s*<\/td>/);
  const locationRaw = extract(/Location<\/td>\s*<td[^>]*>\s*(.*?)\s*<\/td>/s);
  const location = locationRaw.replace(/<[^>]*>?/gm, '').trim();
  let status = "N/A";
  const stMatch = html.match(/Status<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/);
  if (stMatch) status = stMatch[1].includes("Online") ? "🟢 Online" : (stMatch[1].includes("Offline") ? "🔴 Offline" : "🟡 ?");

  return { level, resets, strength, agility, vitality, energy, location, status };
}

// ==========================================
// 📅 EVENT DATA & SCHEDULER
// ==========================================

async function getEventsData(env) {
  const cacheKey = "awakemu_events_cache";
  const currentTime = Math.floor(Date.now() / 1000);
  
  try {
    const response = await fetch("https://www.awakemu.com/", {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AwakeTelegramBot/1.0" }
    });
    if (!response.ok) throw new Error(`Status ${response.status}`);
    const html = await response.text();
    const timersMatch = html.match(/timers:\s*(\[[^\]]+\])/);

    if (timersMatch) {
      const events = JSON.parse(timersMatch[1]).map(e => ({
        id: e.id, name: e.name, startTime: currentTime + parseInt(e.left)
      }));
      await env.AWAKE_CACHE.put(cacheKey, JSON.stringify(events), { expirationTtl: 3600 });
      return events;
    }
    throw new Error("No timers in HTML");
  } catch (err) {
    const cached = await env.AWAKE_CACHE.get(cacheKey, "json");
    return cached || [];
  }
}

async function handleSchedule(env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const deletions = await env.AWAKE_CACHE.get("pending_deletions", "json") || [];
  const nowMs = Date.now();
  const remainingDeletions = [];
  for (const del of deletions) {
    if (nowMs >= del.deleteAt) {
      await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: del.chatId, message_id: del.messageId })
      });
    } else {
      remainingDeletions.push(del);
    }
  }
  await env.AWAKE_CACHE.put("pending_deletions", JSON.stringify(remainingDeletions));

  const events = await getEventsData(env);
  const alarms = await env.AWAKE_CACHE.get("user_alarms", "json") || {};
  const currentTime = Math.floor(Date.now() / 1000);
  const minuteBucket = Math.floor(currentTime / 60);

  let charInfo = null;
  try { charInfo = await scrapeCharacterInfo(env); } catch (e) {}

  for (const ev of events) {
    if (!alarms[ev.name]) continue;
    const notifySeconds = parseInt(alarms[ev.name]) * 60;
    const left = ev.startTime - currentTime;

    if (left <= 0 && left > -60) {
      const dedupKey = `start_sent_${ev.name}_${minuteBucket}`;
      if (!await env.AWAKE_CACHE.get(dedupKey)) {
        await env.AWAKE_CACHE.put(dedupKey, "1", { expirationTtl: 300 });
        const text = `🟢 *¡EVENTO INICIADO!*\n\n🏰 *${ev.name}* ha comenzado ahora.\n🏃 *¡Date prisa y entra rápido!*`;
        const res = await sendTelegram(token, chatId, text);
        if (res.ok) await addPendingDeletion(env, chatId, res.result.message_id, 60000);
      }
    }

    if (left >= notifySeconds && left < notifySeconds + 60) {
      const dedupKey = `alarm_sent_${ev.name}_${alarms[ev.name]}_${minuteBucket}`;
      if (!await env.AWAKE_CACHE.get(dedupKey)) {
        await env.AWAKE_CACHE.put(dedupKey, "1", { expirationTtl: 300 });
        let alertText = `🔔 *¡ALERTA AUTOMÁTICA!*\n\n🏰 *Evento:* ${ev.name}\n⏳ *Inicia en:* ${alarms[ev.name]} minutos`;
        if (charInfo && charInfo.level !== 'N/A') {
          const lvl = parseInt(charInfo.level);
          alertText += `\n\n👤 *Tu personaje:* Lvl *${charInfo.level}* (${charInfo.resets} Resets)`;
          const tier = getTicketTier(ev.name, lvl);
          const tName = getTicketName(ev.name);
          if (tName) alertText += `\n🎫 *Entrada:* ${tName}${tier ? ` *Nivel ${tier}*` : ""} (para lvl ${lvl})`;
        }
        const res = await sendTelegram(token, chatId, alertText);
        if (res.ok) await addPendingDeletion(env, chatId, res.result.message_id, (left * 1000) + 60000);
      }
    }
  }
}

async function addPendingDeletion(env, chatId, messageId, delayMs) {
  const deletions = await env.AWAKE_CACHE.get("pending_deletions", "json") || [];
  deletions.push({ chatId, messageId, deleteAt: Date.now() + delayMs });
  await env.AWAKE_CACHE.put("pending_deletions", JSON.stringify(deletions));
}

// ==========================================
// 🤖 TELEGRAM BOT LOGIC
// ==========================================

async function handleTelegramUpdate(update, env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (update.message && update.message.text) {
    const text = update.message.text;
    const chatId = update.message.chat.id;
    if (["/start", "/char", "/menu", "/bot"].includes(text.toLowerCase())) {
      const session = await getSession(env);
      const status = session ? `🟢 ${session.server}` : "🔴 Sin sesión";
      const keyboard = {
        inline_keyboard: [
          [{ text: "📊 Stats Personaje", callback_data: "stats" }, { text: "🗺️ Ubicación", callback_data: "location" }],
          [{ text: "📅 Lista de Eventos", callback_data: "events" }],
          [{ text: "⚙️ Configurar Alarmas", callback_data: "config_alarms" }],
          [{ text: "🔑 Re-conectar Sesión", callback_data: "do_login_X500" }]
        ]
      };
      await sendTelegram(token, chatId, `🖥️ *Panel AwakeMU Cloud*\nSesión: ${status}\n\n👇 Selecciona:`, keyboard);
    }
  }

  if (update.callback_query) {
    const query = update.callback_query;
    const data = query.data;
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    if (data === "stats" || data === "location") {
      try {
        const info = await scrapeCharacterInfo(env);
        const text = data === "stats" 
          ? `📊 *ESTADÍSTICAS*\n\n📈 *Lvl:* ${info.level} (${info.resets} Res)\n⚔️ *STR:* ${info.strength} | 🏹 *AGI:* ${info.agility}\n❤️ *VIT:* ${info.vitality} | ✨ *ENE:* ${info.energy}`
          : `🗺️ *UBICACIÓN*\n\n📍 *Mapa:* ${info.location}\n🔌 *Status:* ${info.status}`;
        await editTelegram(token, chatId, msgId, text, { inline_keyboard: [[{ text: "🔙 Volver", callback_data: "menu_home" }]] });
      } catch (e) {
        await editTelegram(token, chatId, msgId, `❌ Error: ${e.message}`, { inline_keyboard: [[{ text: "🔑 Login X500", callback_data: "do_login_X500" }]] });
      }
    } else if (data === "menu_home") {
      const session = await getSession(env);
      const status = session ? `🟢 ${session.server}` : "🔴 Sin sesión";
      const keyboard = {
        inline_keyboard: [
          [{ text: "📊 Stats Personaje", callback_data: "stats" }, { text: "🗺️ Ubicación", callback_data: "location" }],
          [{ text: "📅 Lista de Eventos", callback_data: "events" }],
          [{ text: "⚙️ Configurar Alarmas", callback_data: "config_alarms" }],
          [{ text: "🔑 Re-conectar Sesión", callback_data: "do_login_X500" }]
        ]
      };
      await editTelegram(token, chatId, msgId, `🖥️ *Panel AwakeMU Cloud*\nSesión: ${status}\n\n👇 Selecciona:`, keyboard);
    } else if (data.startsWith("do_login_")) {
      const server = data.replace("do_login_", "");
      await editTelegram(token, chatId, msgId, `⏳ Conectando a *${server}*...`);
      try {
        await performLogin(env, server);
        await editTelegram(token, chatId, msgId, `✅ *¡Sesión iniciada en ${server}!*`, { inline_keyboard: [[{ text: "🏠 Ir al Menú", callback_data: "menu_home" }]] });
      } catch (e) {
        await editTelegram(token, chatId, msgId, `❌ Login Err: ${e.message}`, { inline_keyboard: [[{ text: "🔙 Volver", callback_data: "menu_home" }]] });
      }
    } else if (data === "events") {
      const events = await getEventsData(env);
      let text = "📅 *EVENTOS ACTUALES*\n\n";
      events.slice(0, 15).forEach(ev => {
        const left = ev.startTime - Math.floor(Date.now()/1000);
        const timeStr = left <= 0 ? "🟢 *EN CURSO*" : `_${Math.floor(left/60)}m ${left%60}s_`;
        text += `🔹 *${ev.name}:* ${timeStr}\n`;
      });
      await editTelegram(token, chatId, msgId, text, { inline_keyboard: [[{ text: "🔙 Volver", callback_data: "menu_home" }]] });
    } else if (data === "config_alarms") {
      const events = await getEventsData(env);
      const uniqueNames = [...new Set(events.map(e => e.name))].slice(0, 10);
      const keyboard = uniqueNames.map(n => [{ text: n, callback_data: `sel_ev_${n}` }]);
      keyboard.push([{ text: "🔙 Volver", callback_data: "menu_home" }]);
      await editTelegram(token, chatId, msgId, "⚙️ *CONFIGURAR ALARMAS*\nElige un evento:", { inline_keyboard: keyboard });
    } else if (data.startsWith("sel_ev_")) {
      const evName = data.replace("sel_ev_", "");
      const alarms = await env.AWAKE_CACHE.get("user_alarms", "json") || {};
      const current = alarms[evName] ? `${alarms[evName]} min` : "Desactivada";
      await editTelegram(token, chatId, msgId, `⏰ *${evName}*\nActual: ${current}\n\nSelecciona el tiempo:`, {
        inline_keyboard: [
          [{ text: "5 min", callback_data: `set_al_${evName}_5` }, { text: "10 min", callback_data: `set_al_${evName}_10` }],
          [{ text: "15 min", callback_data: `set_al_${evName}_15` }, { text: "🔕 Desactivar", callback_data: `set_al_${evName}_0` }],
          [{ text: "Atrás", callback_data: "config_alarms" }]
        ]
      });
    } else if (data.startsWith("set_al_")) {
      const parts = data.replace("set_al_", "").split("_");
      const mins = parseInt(parts.pop());
      const evName = parts.join("_");
      const alarms = await env.AWAKE_CACHE.get("user_alarms", "json") || {};
      if (mins === 0) delete alarms[evName]; else alarms[evName] = mins;
      await env.AWAKE_CACHE.put("user_alarms", JSON.stringify(alarms));
      await editTelegram(token, chatId, msgId, `✅ Alarma para *${evName}* guardada.`, { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "menu_home" }]] });
    }
  }
}

// ==========================================
// 🛠️ UTILS
// ==========================================

async function sendTelegram(token, chatId, text, replyMarkup = null) {
  const body = { chat_id: chatId, text, parse_mode: "Markdown", reply_markup: replyMarkup };
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return await res.json();
}
async function editTelegram(token, chatId, msgId, text, replyMarkup = null) {
  const body = { chat_id: chatId, message_id: msgId, text, parse_mode: "Markdown", reply_markup: replyMarkup };
  return await fetch(`https://api.telegram.org/bot${token}/editMessageText`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
function getTicketTier(evName, charLevel) {
  const lower = evName.toLowerCase();
  const tiers = lower.includes('illusion') ? [{t:1,m:180,x:399},{t:2,m:400,x:599},{t:3,m:600,x:799},{t:4,m:800,x:999},{t:5,m:1000,x:9999}] : [{t:1,m:50,x:399},{t:2,m:400,x:599},{t:3,m:600,x:699},{t:4,m:700,x:799},{t:5,m:800,x:899},{t:6,m:900,x:999},{t:7,m:1000,x:1200}];
  const match = tiers.find(t => charLevel >= t.m && charLevel <= t.x);
  return match ? match.t : null;
}
function getTicketName(evName) {
  const lower = evName.toLowerCase();
  if (lower.includes('blood castle')) return 'Invisibility Cloak';
  if (lower.includes('devil square')) return "Devil's Invitation";
  if (lower.includes('chaos castle')) return 'Armor of Guardsman';
  if (lower.includes('illusion temple')) return 'Scroll of Blood';
  return null;
}

// ==========================================
// 🎨 DASHBOARD RENDERER
// ==========================================

function renderHTML(eventsData, env) {
  const eventsJson = JSON.stringify(eventsData);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Awake MU - Event Monitor</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/lucide@latest"></script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;700&family=Inter:wght@300;400;600&family=JetBrains+Mono:wght@400;700&display=swap');
    :root { --bg-color: #050505; --card-bg: #0f0f0f; --accent-gold: #d4af37; --accent-gold-light: #f1d279; --text-primary: #ffffff; --text-secondary: #a1a1aa; --border-gold: rgba(212, 175, 55, 0.2); }
    body { background-color: var(--bg-color); color: var(--text-primary); font-family: "Inter", sans-serif; background-image: radial-gradient(circle at 50% 0%, rgba(212, 175, 55, 0.05) 0%, transparent 50%), linear-gradient(to bottom, #050505, #0a0a0a); background-attachment: fixed; min-height: 100vh; }
    .mu-card { background-color: var(--card-bg); border: 1px solid var(--border-gold); box-shadow: 0 10px 30px rgba(0, 0, 0, 0.8); position: relative; overflow: hidden; }
    .mu-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px; background: linear-gradient(90deg, transparent, var(--accent-gold), transparent); opacity: 0.5; }
    .mu-card:hover { border-color: var(--accent-gold); box-shadow: 0 0 20px rgba(212, 175, 55, 0.1); }
    .font-display { font-family: "Cinzel", serif; letter-spacing: 0.05em; }
    .timer-display { font-family: "JetBrains Mono", monospace; letter-spacing: 0.1em; }
    .gold-text { color: #f1d279; text-shadow: 0 0 12px rgba(241, 210, 121, 0.25); }
    .gold-gradient { background: linear-gradient(135deg, var(--accent-gold), var(--accent-gold-light)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    @keyframes shimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
    .shimmer-effect { position: relative; overflow: hidden; }
    .shimmer-effect::after { content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.05), transparent); animation: shimmer 3s infinite; }
    @media (max-width: 480px) { .mu-card { padding: 0.5rem !important; } .event-name { font-size: 0.6rem !important; } .timer-display { font-size: 1rem !important; } header { margin-bottom: 1.5rem !important; } }
    @media (max-width: 640px) { body { padding: 0.75rem !important; } }
    .event-name-wrapper { min-width: 0; flex: 1; overflow: hidden; }
    .event-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; width: 100%; font-size: clamp(0.6rem, 1.5vw, 0.8rem); color: #ffffff; letter-spacing: 0.08em; }
    .status-label { font-size: 8px; color: #b0a88a; font-weight: 500; text-transform: uppercase; letter-spacing: 0.15em; }
    .countdown-label { font-size: 8px; letter-spacing: 0.25em; color: #c4b896; font-weight: 700; text-transform: uppercase; }
  </style>
</head>
<body class="p-4 md:p-8 lg:p-12">
  <div class="max-w-7xl mx-auto">
    <header class="flex flex-col md:flex-row justify-between items-start md:items-center mb-16 gap-8">
      <div class="flex items-center gap-6">
        <div class="relative"><div class="w-20 h-20 bg-black rounded-full flex items-center justify-center border-2 border-[#d4af37] shadow-[0_0_20px_rgba(212,175,55,0.2)]"><i data-lucide="shield" class="text-[#d4af37]" style="width: 40px; height: 40px;"></i></div><div class="absolute -bottom-2 -right-2 bg-[#d4af37] text-black text-[10px] font-bold px-2 py-0.5 rounded-sm uppercase tracking-tighter">LIVE</div></div>
        <div><h1 class="text-5xl font-display font-bold gold-gradient tracking-tighter">AWAKE <span class="text-white">MU</span></h1><div class="flex items-center gap-3 text-[#a1a1aa] text-xs font-medium uppercase tracking-[0.2em] mt-1"><span class="flex items-center gap-1.5"><div class="w-1.5 h-1.5 rounded-full bg-green-500"></div>Server Online</span><span class="opacity-30">|</span><span>Event Monitor System</span></div></div>
      </div>
      <div class="mu-card px-8 py-5 rounded-sm border-[#d4af37]/40 flex flex-col items-end shimmer-effect">
        <span class="text-[9px] uppercase tracking-[0.4em] text-[#d4af37] font-bold mb-2">Current Server Time</span>
        <div class="timer-display text-4xl font-bold text-white" id="clock">00:00:00</div>
        <div class="text-[9px] text-[#a1a1aa] mt-1 font-mono uppercase tracking-widest" id="date">...</div>
      </div>
    </header>
    <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-12">
      <div class="mu-card p-4 rounded-sm flex items-center gap-4 border-l-2 border-l-[#d4af37]"><div class="text-[#d4af37] opacity-50"><i data-lucide="activity"></i></div><div><div class="text-[9px] uppercase tracking-widest text-[#a1a1aa] font-bold">Status</div><div class="text-sm font-bold">Cloud Monitoring</div></div></div>
      <div class="mu-card p-4 rounded-sm flex items-center gap-4 border-l-2 border-l-[#d4af37]"><div class="text-[#d4af37] opacity-50"><i data-lucide="calendar"></i></div><div><div class="text-[9px] uppercase tracking-widest text-[#a1a1aa] font-bold">Schedule</div><div class="text-sm font-bold">Live Timers</div></div></div>
      <div class="col-span-1 md:col-span-2 mu-card p-4 rounded-sm flex items-center justify-center bg-[#d4af37]/5 border-[#d4af37]/20 border"><p class="text-[10px] text-[#d4af37] font-bold uppercase tracking-[0.3em] animate-pulse">Running on Cloudflare Workers</p></div>
    </div>
    <div class="grid grid-cols-1 xs:grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3 lg:gap-4" id="grid"></div>
  </div>
  <script>
    lucide.createIcons();
    const eventsData = ${eventsJson};
    const grid = document.getElementById("grid");
    const MATCH_CONFIGS = [{k:'blood',i:'castle',c:'#ef4444'},{k:'devil',i:'skull',c:'#f97316'},{k:'chaos',i:'sword',c:'#3b82f6'},{k:'golden',i:'gem',c:'#eab308'},{k:'white',i:'zap',c:'#f8fafc'},{k:'crywolf',i:'shield',c:'#a855f7'},{k:'siege',i:'crown',c:'#dc2626'},{k:'kanturu',i:'target',c:'#10b981'},{k:'illusion',i:'ghost',c:'#06b6d4'}];
    function getEventConfig(name){ 
      const lower = name.toLowerCase(); 
      let conf = MATCH_CONFIGS.find(m => lower.includes(m.k)); 
      return conf || {i:'clock',c:'#d4af37'}; 
    }
    const cards = eventsData.map(ev => {
      const conf = getEventConfig(ev.name);
      const card = document.createElement("div");
      card.className = "mu-card p-3 rounded-sm flex flex-col gap-2 relative overflow-hidden group transition-colors duration-300";
      card.innerHTML = '<div class="absolute -right-4 -bottom-4 opacity-[0.03] group-hover:opacity-[0.08] transition-opacity" style="color:' + conf.c + '"><i data-lucide="' + conf.i + '" style="width:80px;height:80px;"></i></div>' +
        '<div class="flex justify-between items-start relative z-10 w-full mb-1">' +
          '<div class="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden">' +
            '<div class="w-7 h-7 rounded-full border flex items-center justify-center bg-black/40 flex-shrink-0" style="border-color:' + conf.c + '40;color:' + conf.c + '"><i data-lucide="' + conf.i + '" style="width:12px;height:12px;"></i></div>' +
            '<div class="event-name-wrapper"><h3 class="font-display font-bold gold-text event-name" title="' + ev.name + '">' + ev.name + '</h3></div>' +
          '</div>' +
        '</div>' +
        '<div class="mt-2 relative z-10"><div class="flex items-center justify-between mb-1"><span class="countdown-label">Countdown</span><div class="h-px flex-1 mx-2 bg-gradient-to-r from-transparent via-white/10 to-transparent"></div></div><div class="timer-display text-xl font-bold text-center py-1 text-white countdown">--:--:--</div></div>' +
        '<div class="mt-auto pt-2 flex justify-between items-center relative z-10 border-t border-white/5"><div class="flex items-center gap-1"><div class="w-1 h-1 rounded-full bg-[#d4af37]"></div><span class="status-label">Online</span></div><div class="w-1.5 h-1.5 rounded-full" style="background-color:' + conf.c + '"></div></div>';
      return { el: card, data: ev, timeEl: card.querySelector(".countdown") };
    });
    cards.sort((a,b)=>a.data.startTime-b.data.startTime).forEach(c=>grid.appendChild(c.el));
    lucide.createIcons();
    function formatTime(s){ 
      const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60; 
      return h.toString().padStart(2,"0") + ":" + m.toString().padStart(2,"0") + ":" + sec.toString().padStart(2,"0"); 
    }
    function update(){
      const now = Math.floor(Date.now()/1000);
      document.getElementById("clock").textContent = new Date().toLocaleTimeString([],{hour12:false});
      document.getElementById("date").textContent = new Date().toLocaleDateString("en-US",{weekday:"long",year:"numeric",month:"long",day:"numeric"});
      cards.forEach(c => {
        const rem = c.data.startTime - now;
        if(rem<=0){ c.timeEl.textContent="STARTED"; c.timeEl.style.color="#ef4444"; }
        else { c.timeEl.textContent=formatTime(rem); c.timeEl.style.color=rem<300?"#ef4444":"#fff"; }
      });
    }
    setInterval(update, 1000); update();
  </script>
</body>
</html>`;
}
