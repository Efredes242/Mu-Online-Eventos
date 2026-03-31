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

    // --- API DATA (JSON) ---
    if (url.pathname === "/api/data") {
      const serverParam = url.searchParams.get("server") || "X500";
      const ctx = await getUserCtx(env, env.TELEGRAM_CHAT_ID);
      const accounts = await getAccountList(env);
      const acc = accounts[ctx.currentAccount];
      
      const [eventsData, charInfo, stats, playersRank, guildsRank] = await Promise.all([
        getEventsData(env),
        acc ? scrapeCharacterInfo(env, ctx.currentAccount, acc.pass, ctx.currentCharacter ? ctx.currentCharacter.hex : null, ctx.server || "X500") : Promise.resolve(null),
        scrapeServerStats(env, serverParam).catch(() => null),
        scrapeRankings(env, "players", serverParam).catch(() => []),
        scrapeRankings(env, "guilds", serverParam).catch(() => [])
      ]);
      
      const responseBody = JSON.stringify({
        serverTime: Date.now(),
        events: eventsData,
        character: charInfo,
        stats: stats,
        rankings: { players: playersRank, guilds: guildsRank },
        serverStatus: "Online"
      });

      return new Response(responseBody, {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        }
      });
    }

    // --- CORS OPTIONS ---
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        }
      });
    }

    // --- DASHBOARD (Default HTML) ---
    const serverParam = url.searchParams.get("server");
    
    // If no server specified, show Landing Page
    if (!serverParam) {
      const allServers = ["X25", "X150", "X500", "X3000"];
      const statsPromises = allServers.map(s => scrapeServerStats(env, s).catch(() => ({ onlinePlayers: "0" })));
      const allStats = await Promise.all(statsPromises);
      const serverStats = {};
      allServers.forEach((s, i) => serverStats[s] = allStats[i]);
      
      const html = renderLandingHTML(serverStats);
      return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    // Detail View for specific server
    const [eventsData, stats, playersRank, guildsRank, killersRank] = await Promise.all([
      getEventsData(env),
      scrapeServerStats(env, serverParam).catch(() => null),
      scrapeRankings(env, "players", serverParam).catch(() => []),
      scrapeRankings(env, "guilds", serverParam).catch(() => []),
      scrapeRankings(env, "killer", serverParam).catch(() => [])
    ]);
    
    const ctx = await getUserCtx(env, env.TELEGRAM_CHAT_ID);
    const userAlarms = await env.AWAKE_CACHE.get("user_alarms", "json") || {};
    const html = renderHTML(eventsData, userAlarms, env, { 
      server: serverParam,
      stats, 
      rankings: { players: playersRank, guilds: guildsRank, killers: killersRank },
      context: ctx
    });
    return new Response(html, {
      headers: { "Content-Type": "text/html;charset=UTF-8" }
    });
  }
};

// ==========================================
// 🛡️ AUTHENTICATION & SCRAPING
// ==========================================

const AVAILABLE_SERVERS = ["X25", "X150", "X500", "X3000"];

// --- PERSISTENCE HELPERS ---
async function getAccountList(env) {
  return await env.AWAKE_CACHE.get("accounts_v2", "json") || {};
}
async function saveAccountList(env, accounts) {
  await env.AWAKE_CACHE.put("accounts_v2", JSON.stringify(accounts));
}
async function getUserCtx(env, userId) {
  return await env.AWAKE_CACHE.get(`user_ctx_${userId}`, "json") || { currentAccount: null, currentCharacter: null, server: "X500" };
}
async function setUserCtx(env, userId, ctx) {
  await env.AWAKE_CACHE.put(`user_ctx_${userId}`, JSON.stringify(ctx));
}

async function getSession(env, accountId = "default") {
  const cached = await env.AWAKE_CACHE.get(`session_${accountId}`, "json");
  if (cached && cached.cookies) return cached;
  return null;
}

async function performLogin(env, server = "X500", customUser = null, customPass = null) {
  const user = customUser || env.AWAKE_USER;
  const pass = customPass || env.AWAKE_PASS;
  if (!user || !pass) throw new Error("Missing credentials. Please /login first.");

  const accountId = customUser || "default";
  
  // --- PREVENTIVE LOGOUT ---
  const currentSession = await getSession(env, accountId);
  if (currentSession && currentSession.cookies) {
    await fetch("https://www.awakemu.com/logout", {
      headers: { "User-Agent": "Mozilla/5.0", "Cookie": currentSession.cookies }
    });
    await env.AWAKE_CACHE.delete(`session_${accountId}`);
  }

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
  await env.AWAKE_CACHE.put(`session_${accountId}`, JSON.stringify(sessionData), { expirationTtl: 3600 * 24 });
  return sessionData;
}

async function discoverCharacters(env, user, pass, server) {
  const session = await performLogin(env, server, user, pass);
  return await discoverCharactersWithSession(env, session, server);
}

async function discoverCharactersWithSession(env, session, server) {
  const res = await fetch("https://www.awakemu.com/shop/change-class", {
    headers: { "User-Agent": "Mozilla/5.0", "Cookie": session.cookies }
  });
  if (!res.ok) return [];
  const html = await res.text();
  // Selector: <select name="select_char" id="select_char"><option value="HEX">NAME</option>...
  const options = [...html.matchAll(/<option[^>]*value="([^"]+)"[^>]*>([^<]+)<\/option>/g)];
  return options.map(m => ({ hex: m[1], name: m[2].trim(), server }));
}

async function scrapeCharacterInfo(env, customUser = null, customPass = null, charHex = null, server = "X500") {
  let session = await getSession(env, customUser || "default");
  if (!session) session = await performLogin(env, server, customUser, customPass);

  const charUrl = charHex 
    ? `https://www.awakemu.com/character/${charHex}/${server}`
    : env.CHARACTER_URL;

  let res = await fetch(charUrl, {
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

async function scrapeServerStats(env, server = "X500") {
  const cacheKey = `awakemu_stats_${server}`;
  try {
    const cached = await env.AWAKE_CACHE.get(cacheKey, "json");
    if (cached) return cached;
  } catch(e){}
  try {
    const res = await fetch(`https://www.awakemu.com/about/stats/${server}`, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const html = await res.text();
    const stats = {};
    const matches = [...html.matchAll(/<td[^>]*>([^<]+)<\/td>\s*<td[^>]*>([^<]+)<\/td>/g)];
    matches.forEach(m => stats[m[1].trim()] = m[2].trim());
    const csMatch = html.match(/Owner:<\/strong>\s*<[^>]*>([^<]+)<\/a>/i);
    if (csMatch) stats["CS Owner"] = csMatch[1].trim();
    
    await env.AWAKE_CACHE.put(cacheKey, JSON.stringify(stats), { expirationTtl: 3600 }); 
    return stats;
  } catch(e) { return null; }
}

async function scrapeRankings(env, type = "players", server = "X500") {
  const cacheKey = `awakemu_rankings_v3_${type}_${server}`;
  try {
    const cached = await env.AWAKE_CACHE.get(cacheKey, "json");
    if (cached) return cached;
  } catch(e){}
  try {
    const body = new URLSearchParams({ type, server }).toString();
    const res = await fetch("https://www.awakemu.com/rankings/load_ranking_data/1", {
      method: "POST",
      headers: { "User-Agent": "Mozilla/5.0", "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
      body
    });
    if (!res.ok) return [];
    let data = await res.json();
    
    let result = [];
    if (data.players) result = data.players;
    else if (data.guilds) result = data.guilds;
    else if (data.killer) result = data.killer;
    else if (Array.isArray(data)) result = data;
    else if (typeof data === 'object') {
       // Search for any property that is an array
       const firstArray = Object.values(data).find(v => Array.isArray(v));
       if (firstArray) result = firstArray;
    }

    const finalResult = result.slice(0, 10);
    await env.AWAKE_CACHE.put(cacheKey, JSON.stringify(finalResult), { expirationTtl: 3600 }); 
    return finalResult;
  } catch(e) { 
    console.error(`Scrape Rankings Error (${type}):`, e.message);
    return []; 
  }
}

async function getEventsData(env) {
  const cacheKey = "awakemu_events_cache";
  const currentTime = Math.floor(Date.now() / 1000);
  let cachedEvents = null;
  
  try {
    const cached = await env.AWAKE_CACHE.get(cacheKey, "json");
    if (cached) {
      cachedEvents = cached;
      // Invalidar si algún evento ha pasado su hora de inicio por más de 60 segundos.
      // Esto da margen de 1 min para que dispare la alarma de "INICIADO" antes de borrar la caché.
      const hasStale = cached.some(e => (e.startTime - currentTime) < -60);
      if (!hasStale) return cached;
    }
  } catch (e) {}
  
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
      
      let shouldPut = true;
      if (cachedEvents && cachedEvents.length === events.length) {
        if (Math.abs(events[0].startTime - cachedEvents[0].startTime) < 60) {
          shouldPut = false;
        }
      }

      if (shouldPut) {
        try {
          await env.AWAKE_CACHE.put(cacheKey, JSON.stringify(events), { expirationTtl: 14400 }); // Caché base de 4 horas
        } catch (e) { console.error("KV Put Error:", e); }
      }
      return events;
    }
    throw new Error("No timers in HTML");
  } catch (err) {
    return cachedEvents || [];
  }
}


async function handleSchedule(env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const deletions = await env.AWAKE_CACHE.get("pending_deletions", "json") || [];
  const nowMs = Date.now();
  const remainingDeletions = [];
  let modified = false;
  for (const del of deletions) {
    if (nowMs >= del.deleteAt) {
      await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: del.chatId, message_id: del.messageId })
      });
      modified = true;
    } else {
      remainingDeletions.push(del);
    }
  }
  if (modified) {
    await env.AWAKE_CACHE.put("pending_deletions", JSON.stringify(remainingDeletions));
  }

  const events = await getEventsData(env);
  const alarms = await env.AWAKE_CACHE.get("user_alarms", "json") || {};
  const currentTime = Math.floor(Date.now() / 1000);
  const minuteBucket = Math.floor(currentTime / 60);

  let charInfo = null;
  try { 
    const ctx = await getUserCtx(env, chatId);
    const accounts = await getAccountList(env);
    const acc = accounts[ctx.currentAccount];
    if (acc) {
      charInfo = await scrapeCharacterInfo(
        env, 
        ctx.currentAccount, 
        acc.pass, 
        ctx.currentCharacter ? ctx.currentCharacter.hex : null, 
        ctx.server || "X500"
      );
    }
  } catch (e) {
    console.error("Scheduled Char Scrape Error:", e.message);
  }

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
    const args = text.split(" ");
    const cmd = args[0].toLowerCase();

    if (["/start", "/char", "/menu", "/bot"].includes(cmd)) {
      try { await deleteTelegram(token, chatId, update.message.message_id); } catch(e){}
      await showMainMenu(env, token, chatId);
    } 
    else if (cmd === "/login" || cmd === "/agregar_cuenta") {
      if (args.length < 3) {
        return await sendTelegram(token, chatId, "❌ Uso: `/login usuario contraseña`\nEjemplo: `/login efredes99 Alckron242`", { parse_mode: "Markdown" });
      }
      const user = args[1];
      const pass = args[2];
      const loading = await sendTelegram(token, chatId, `🔐 *Verificando cuenta ${user}...*`);
      try {
        const accounts = await getAccountList(env);
        // Descubrimiento inicial en X500 (o todos)
        const chars = await discoverCharacters(env, user, pass, "X500");
        accounts[user] = { pass, characters: { "X500": chars } };
        await saveAccountList(env, accounts);
        
        const ctx = await getUserCtx(env, chatId);
        ctx.currentAccount = user;
        await setUserCtx(env, chatId, ctx);

        await deleteTelegram(token, chatId, loading.result.message_id);
        await sendTelegram(token, chatId, `✅ *Cuenta agregada!*\n\nSe detectaron ${chars.length} personajes en X500.\nUsa \`/cuentas\` para cambiar entre cuentas o \`/personajes\` para elegir quién monitorear.`, {
          inline_keyboard: [[{ text: "👥 Mis Cuentas", callback_data: "list_accounts" }, { text: "🏠 Menú", callback_data: "menu_home" }]]
        });
      } catch (e) {
        await deleteTelegram(token, chatId, loading.result.message_id);
        await sendTelegram(token, chatId, `❌ Error al agregar cuenta: ${e.message}`);
      }
    }
    else if (cmd === "/cuentas") {
      await showAccountSelection(env, token, chatId);
    }
    else if (cmd === "/personajes") {
      await showCharacterSelection(env, token, chatId);
    }

  if (update.callback_query) {
    const query = update.callback_query;
    const data = query.data;
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    if (data === "stats" || data === "location") {
      try {
        const ctx = await getUserCtx(env, chatId);
        const accounts = await getAccountList(env);
        const acc = accounts[ctx.currentAccount];
        
        if (!acc) throw new Error("No hay cuenta activa. Usa /cuentas");
        
        const info = await scrapeCharacterInfo(
          env, 
          ctx.currentAccount, 
          acc.pass, 
          ctx.currentCharacter ? ctx.currentCharacter.hex : null, 
          ctx.server || "X500"
        );
        
        const name = ctx.currentCharacter ? ctx.currentCharacter.name : "Personaje";
        const text = data === "stats" 
          ? `📊 *STATS: ${name}*\n\n📈 *Lvl:* ${info.level} (${info.resets} Res)\n⚔️ *STR:* ${info.strength} | 🏹 *AGI:* ${info.agility}\n❤️ *VIT:* ${info.vitality} | ✨ *ENE:* ${info.energy}`
          : `🗺️ *UBICACIÓN: ${name}*\n\n📍 *Mapa:* ${info.location}\n🔌 *Status:* ${info.status}`;
        
        await deleteTelegram(token, chatId, msgId);
        await sendTelegram(token, chatId, text, { inline_keyboard: [[{ text: "🔙 Volver", callback_data: "menu_home" }]] });
      } catch (e) {
        await deleteTelegram(token, chatId, msgId);
        await sendTelegram(token, chatId, `❌ Error: ${e.message}\nUsa /cuentas para configurar.`, { inline_keyboard: [[{ text: "👥 Seleccionar Cuenta", callback_data: "list_accounts" }, { text: "🏠 Menú", callback_data: "menu_home" }]] });
      }
    } else if (data === "menu_start_login") {
      await deleteTelegram(token, chatId, msgId);
      await sendTelegram(token, chatId, "🔐 *AGREGAR CUENTA*\n\nEnvía un mensaje con el formato:\n`/login usuario contraseña`", { parse_mode: "Markdown" });
    } else if (data === "select_game_awake_s18") {
      await showServerSelection(env, token, chatId, msgId);
    } else if (data === "menu_home") {
      await deleteTelegram(token, chatId, msgId);
      await showMainMenu(env, token, chatId);
    } else if (data.startsWith("do_login_")) {
      const server = data.replace("do_login_", "");
      const ctx = await getUserCtx(env, chatId);
      const accounts = await getAccountList(env);
      const acc = accounts[ctx.currentAccount];
      
      if (!acc) {
        return await sendTelegram(token, chatId, "❌ No hay una cuenta activa. Por favor selecciona una primero.", {
          inline_keyboard: [[{ text: "👥 Seleccionar Cuenta", callback_data: "list_accounts" }]]
        });
      }

      await deleteTelegram(token, chatId, msgId);
      const loading = await sendTelegram(token, chatId, `🔄 *CAMBIANDO A ${server}* (${ctx.currentAccount})\n\n⚠️ _Cerrando sesión previa y esperando unos segundos para evitar bloqueos..._`);
      try {
        await new Promise(r => setTimeout(r, 2500));
        
        const session = await performLogin(env, server, ctx.currentAccount, acc.pass);
        const hasChars = await checkCharacters(env, session);
        
        if (loading && loading.result) await deleteTelegram(token, chatId, loading.result.message_id);
        if (hasChars) {
          // Guardar el servidor actual en el contexto
          ctx.server = server;
          
          // Auto-descubrir personajes si no los tenemos
          if (!acc.characters || !acc.characters[server] || acc.characters[server].length === 0) {
            const found = await discoverCharactersWithSession(env, session, server);
            if (!acc.characters) acc.characters = {};
            acc.characters[server] = found;
            await saveAccountList(env, accounts);
          }
          
          await setUserCtx(env, chatId, ctx);
          
          await sendTelegram(token, chatId, `✅ *¡Conectado exitosamente en ${server} con ${ctx.currentAccount}!*`, { 
            inline_keyboard: [[{ text: "🏠 Entrar al Menú", callback_data: "menu_home" }]] 
          });
        } else {
          await sendTelegram(token, chatId, `⚠️ *AVISO*: Se inició sesión en *${server}* con la cuenta *${ctx.currentAccount}* pero la web indica que *no tienes personajes* creados aquí.\n\nPara poder usar el bot, primero debes entrar al juego en este servidor y crear al menos un personaje.`, { inline_keyboard: [[{ text: "🌐 Cambiar Servidor", callback_data: "select_game_awake_s18" }, { text: "🏠 Menú Principal", callback_data: "menu_home" }]] });
        }
      } catch (e) {
        if (loading && loading.result) await deleteTelegram(token, chatId, loading.result.message_id);
        await sendTelegram(token, chatId, `❌ Login Err: ${e.message}`, { inline_keyboard: [[{ text: "🔙 Reintentar", callback_data: "select_game_awake_s18" }]] });
      }
    } else if (data === "events") {
      const events = await getEventsData(env);
      let text = "📅 *PRÓXIMOS EVENTOS*\n\n";
      const sorted = events.sort((a, b) => a.startTime - b.startTime).slice(0, 15);
      
      sorted.forEach(ev => {
        const left = ev.startTime - Math.floor(Date.now()/1000);
        let timeStr = "🟢 *EN CURSO*";
        let emoji = "🟢"; // Menos de 20 min
        
        if (left > 0) {
          if (left > 3600) emoji = "🔴"; // Más de 1 hora
          else if (left > 1200) emoji = "🟠"; // Entre 20 y 60 min
          
          const d = Math.floor(left/86400), h = Math.floor((left%86400)/3600), m = Math.floor((left%3600)/60), s = left%60;
          timeStr = "_" + (d>0?d+"d ":"") + (h>0||d>0?h+"h ":"") + m + "m " + s + "s_";
        }
        text += `${emoji} *${ev.name}:* ${timeStr}\n`;
      });
      await deleteTelegram(token, chatId, msgId);
      await sendTelegram(token, chatId, text, { inline_keyboard: [[{ text: "🔙 Volver", callback_data: "menu_home" }]] });
    } else if (data === "config_alarms") {
      const events = await getEventsData(env);
      const uniqueNames = [...new Set(events.map(e => e.name))].sort();
      const keyboard = [];
      for (let i = 0; i < uniqueNames.length; i += 2) {
        const row = [{ text: uniqueNames[i], callback_data: `sel_ev_${uniqueNames[i]}` }];
        if (uniqueNames[i+1]) row.push({ text: uniqueNames[i+1], callback_data: `sel_ev_${uniqueNames[i+1]}` });
        keyboard.push(row);
      }
      keyboard.push([{ text: "🔙 Volver", callback_data: "menu_home" }]);
      await deleteTelegram(token, chatId, msgId);
      await sendTelegram(token, chatId, "⚙️ *CONFIGURAR ALARMAS*\nElige un evento:", { inline_keyboard: keyboard });
    } else if (data.startsWith("sel_ev_")) {
      const evName = data.replace("sel_ev_", "");
      const alarms = await env.AWAKE_CACHE.get("user_alarms", "json") || {};
      const current = alarms[evName] ? `${alarms[evName]} min` : "Desactivada";
      await deleteTelegram(token, chatId, msgId);
      await sendTelegram(token, chatId, `⏰ *${evName}*\nActual: ${current}\n\nSelecciona el tiempo:`, {
        inline_keyboard: [
          [{ text: "5 min", callback_data: `set_al_${evName}_5` }, { text: "10 min", callback_data: `set_al_${evName}_10` }],
          [{ text: "15 min", callback_data: `set_al_${evName}_15` }, { text: "🔕 Desactivar", callback_data: `set_al_${evName}_0` }],
          [{ text: "Atrás", callback_data: "config_alarms" }]
        ]
      });
    } else if (data.startsWith("set_al_")) {
      try {
        const parts = data.replace("set_al_", "").split("_");
        const mins = parseInt(parts.pop());
        const evName = parts.join("_");
        const alarms = await env.AWAKE_CACHE.get("user_alarms", "json") || {};
        if (mins === 0) delete alarms[evName]; else alarms[evName] = mins;
        await env.AWAKE_CACHE.put("user_alarms", JSON.stringify(alarms));
        await deleteTelegram(token, chatId, msgId);
        await sendTelegram(token, chatId, `✅ Alarma para *${evName}* guardada (${mins === 0 ? 'Desactivada' : `${mins} min`}).`, { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "menu_home" }]] });
      } catch (e) {
        await sendTelegram(token, chatId, `❌ Error al guardar alarma: ${e.message}`, { inline_keyboard: [[{ text: "🔙 Reintentar", callback_data: "config_alarms" }]] });
      }
    } else if (data === "view_alarms") {
      try {
        const alarms = await env.AWAKE_CACHE.get("user_alarms", "json") || {};
        const keys = Object.keys(alarms);
        let text = "🔔 *MIS ALARMAS ACTIVAS*\n\n";
        if (keys.length === 0) {
          text += "_No tienes alarmas configuradas._";
        } else {
          keys.forEach(k => { text += `• *${k}:* ${alarms[k]} min antes\n`; });
        }
        await deleteTelegram(token, chatId, msgId);
        await sendTelegram(token, chatId, text, { inline_keyboard: [[{ text: "⚙️ Configurar", callback_data: "config_alarms" }, { text: "🏠 Menú", callback_data: "menu_home" }]] });
      } catch (e) {
        await sendTelegram(token, chatId, `❌ Error: ${e.message}`, { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "menu_home" }]] });
      }
    } else if (data === "list_accounts") {
      await deleteTelegram(token, chatId, msgId);
      await showAccountSelection(env, token, chatId);
    } else if (data.startsWith("sel_acc_")) {
      const user = data.replace("sel_acc_", "");
      const ctx = await getUserCtx(env, chatId);
      ctx.currentAccount = user;
      await setUserCtx(env, chatId, ctx);
      await deleteTelegram(token, chatId, msgId);
      await sendTelegram(token, chatId, `👤 *Cuenta activa:* ${user}`, {
        inline_keyboard: [[{ text: "🎭 Seleccionar Personaje", callback_data: "list_chars" }, { text: "🏠 Menú", callback_data: "menu_home" }]]
      });
    } else if (data === "list_chars") {
      await deleteTelegram(token, chatId, msgId);
      await showCharacterSelection(env, token, chatId);
    } else if (data.startsWith("sel_chr_")) {
      const charName = data.replace("sel_chr_", "");
      const ctx = await getUserCtx(env, chatId);
      const accounts = await getAccountList(env);
      const acc = accounts[ctx.currentAccount];
      if (acc) {
        // Buscar el hex del personaje en la lista cacheada
        const allChars = Object.values(acc.characters).flat();
        const found = allChars.find(c => c.name === charName);
        if (found) {
          ctx.currentCharacter = { name: found.name, hex: found.hex, server: found.server };
          ctx.server = found.server;
          await setUserCtx(env, chatId, ctx);
          await deleteTelegram(token, chatId, msgId);
          await sendTelegram(token, chatId, `✅ *Personaje seleccionado:* ${found.name} (${found.server})`, {
            inline_keyboard: [[{ text: "📊 Ver Status", callback_data: "stats" }, { text: "🏠 Menú", callback_data: "menu_home" }]]
          });
        }
      }
    } else if (data === "refresh_chars") {
      const ctx = await getUserCtx(env, chatId);
      if (!ctx.currentAccount) return await sendTelegram(token, chatId, "❌ No hay cuenta seleccionada.");
      const accounts = await getAccountList(env);
      const acc = accounts[ctx.currentAccount];
      const loading = await sendTelegram(token, chatId, `🔍 *Buscando personajes en todos los servidores para ${ctx.currentAccount}...*`);
      try {
        const charResults = {};
        for (const s of AVAILABLE_SERVERS) {
          charResults[s] = await discoverCharacters(env, ctx.currentAccount, acc.pass, s);
        }
        acc.characters = charResults;
        await saveAccountList(env, accounts);
        await deleteTelegram(token, chatId, loading.result.message_id);
        await showCharacterSelection(env, token, chatId);
      } catch (e) {
        await deleteTelegram(token, chatId, loading.result.message_id);
        await sendTelegram(token, chatId, `❌ Error en descubrimiento: ${e.message}`);
      }
    } else if (data === "logout") {
      await env.AWAKE_CACHE.delete("session_data");
      await deleteTelegram(token, chatId, msgId);
      await showGameSelection(env, token, chatId);
    }
  }
}

async function showMainMenu(env, token, chatId) {
  const ctx = await getUserCtx(env, chatId);
  let status = "🔴 Sin cuenta";
  if (ctx.currentAccount) {
    status = `🟢 ${ctx.currentAccount}`;
    if (ctx.currentCharacter) status += ` (${ctx.currentCharacter.name})`;
  }
  
  const accounts = await getAccountList(env);
  const accountKeys = Object.keys(accounts);
  
  const keyboard = {
    inline_keyboard: [
      [{ text: "📊 Stats Personaje", callback_data: "stats" }, { text: "🗺️ Ubicación", callback_data: "location" }],
      [{ text: "📅 Lista de Eventos", callback_data: "events" }],
      [{ text: "🔔 Mis Alarmas", callback_data: "view_alarms" }, { text: "⚙️ Configurar", callback_data: "config_alarms" }],
      [{ text: "🌐 Cambiar SV", callback_data: "select_game_awake_s18" }, { text: "🎭 Personajes", callback_data: "list_chars" }]
    ]
  };

  // Agregar botones rápidos de cuenta si hay más de una
  if (accountKeys.length > 1) {
    const accRow = accountKeys.map(acc => ({
      text: (acc === ctx.currentAccount ? `➡️ ${acc}` : `👤 ${acc}`),
      callback_data: `sel_acc_${acc}`
    }));
    keyboard.inline_keyboard.push(accRow);
  } else {
    keyboard.inline_keyboard.push([{ text: "👥 Mis Cuentas", callback_data: "list_accounts" }]);
  }

  keyboard.inline_keyboard.push([{ text: "🚪 Cerrar Sesión", callback_data: "logout" }]);

  await sendTelegram(token, chatId, `🖥️ *Panel AwakeMU Cloud*\n\n👤 *Usuario:* ${status}\n🌐 *Servidor:* ${ctx.server || 'X500'}\n\n👇 Selecciona:`, keyboard);
}

async function showAccountSelection(env, token, chatId) {
  const accounts = await getAccountList(env);
  const keys = Object.keys(accounts);
  const keyboard = [];
  keys.forEach(acc => {
    keyboard.push([{ text: `👤 ${acc}`, callback_data: `sel_acc_${acc}` }]);
  });
  keyboard.push([{ text: "➕ Agregar Cuenta", callback_data: "menu_start_login" }]);
  keyboard.push([{ text: "🏠 Menú Principal", callback_data: "menu_home" }]);
  
  await sendTelegram(token, chatId, "👥 *MIS CUENTAS*\nSelecciona la cuenta activa:", { inline_keyboard: keyboard });
}

async function showCharacterSelection(env, token, chatId) {
  const ctx = await getUserCtx(env, chatId);
  if (!ctx.currentAccount) return await showAccountSelection(env, token, chatId);
  
  const accounts = await getAccountList(env);
  const acc = accounts[ctx.currentAccount];
  const keyboard = [];
  
  if (acc.characters) {
    Object.keys(acc.characters).forEach(srv => {
      acc.characters[srv].forEach(c => {
        keyboard.push([{ text: `[${srv}] ${c.name}`, callback_data: `sel_chr_${c.name}` }]);
      });
    });
  }
  
  keyboard.push([{ text: "🔍 Redescubrir Personajes", callback_data: "refresh_chars" }]);
  keyboard.push([{ text: "🏠 Menú Principal", callback_data: "menu_home" }]);
  
  await sendTelegram(token, chatId, `🎭 *PERSONAJES EN ${ctx.currentAccount}*\n\nSelecciona quién monitorear:`, { inline_keyboard: keyboard });
}

async function showGameSelection(env, token, chatId) {
  const keyboard = { inline_keyboard: [[{ text: "🏰 Mu Awake S18", callback_data: "select_game_awake_s18" }]] };
  await sendTelegram(token, chatId, "🛡️ *BIENVENIDO A AWAKE CLOUD*\n\nSelecciona el juego para comenzar:", keyboard);
}

async function showServerSelection(env, token, chatId, editMsgId = null) {
  const keyboard = {
    inline_keyboard: [
      [{ text: "🌐 Servidor X25", callback_data: "do_login_X25" }, { text: "🌐 Servidor X150", callback_data: "do_login_X150" }],
      [{ text: "🌐 Servidor X500", callback_data: "do_login_X500" }, { text: "🌐 Servidor X3000", callback_data: "do_login_X3000" }],
      [{ text: "🚪 Cerrar Sesión", callback_data: "logout" }]
    ]
  };
  if (editMsgId) await deleteTelegram(token, chatId, editMsgId);
  await sendTelegram(token, chatId, "🛡️ *SELECCIÓN DE SERVIDOR*\n\nElige el servidor para monitorear:", keyboard);
}

async function checkCharacters(env, session) {
  try {
    const res = await fetch("https://www.awakemu.com/add-stats", {
      headers: { "User-Agent": "Mozilla/5.0", "Cookie": session.cookies }
    });
    if (!res.ok) return false;
    const html = await res.text();
    // Buscar si hay enlaces de "Add Stats" con IDs hex (mínimo 10 caracteres hex)
    const hasChars = /\/add-stats\/[a-f0-9]{10,}/.test(html) || html.includes('Logout');
    return hasChars;
  } catch (e) {
    return false;
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
async function deleteTelegram(token, chatId, msgId) {
  const body = { chat_id: chatId, message_id: msgId };
  return await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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

function renderLandingHTML(serverStats) {
  const statsJson = JSON.stringify(serverStats);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Awake MU - Seleccionar Servidor</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/lucide@latest"></script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;700&family=Inter:wght@300;400;600&display=swap');
    :root { --bg-color: #050505; --card-bg: #0f0f0f; --accent-gold: #d4af37; --accent-gold-light: #f1d279; --text-primary: #ffffff; --border-gold: rgba(212, 175, 55, 0.2); }
    body { background-color: var(--bg-color); color: var(--text-primary); font-family: "Inter", sans-serif; background-image: radial-gradient(circle at 50% 0%, rgba(212, 175, 55, 0.05) 0%, transparent 50%), linear-gradient(to bottom, #050505, #0a0a0a); background-attachment: fixed; min-height: 100vh; }
    .font-display { font-family: "Cinzel", serif; letter-spacing: 0.05em; }
    .mu-card { background-color: var(--card-bg); border: 1px solid var(--border-gold); transition: all 0.3s ease; cursor: pointer; position: relative; overflow: hidden; }
    .mu-card:hover { border-color: var(--accent-gold); transform: translateY(-5px); box-shadow: 0 20px 40px rgba(0, 0, 0, 0.9); }
    .mu-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px; background: linear-gradient(90deg, transparent, var(--accent-gold), transparent); opacity: 0.5; }
    .gold-gradient { background: linear-gradient(135deg, var(--accent-gold), var(--accent-gold-light)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  </style>
</head>
<body class="flex items-center justify-center min-vh-100 p-6">
  <div class="max-w-5xl w-full">
    <header class="text-center mb-16">
      <h1 class="text-6xl font-display font-bold gold-gradient mb-4">AWAKE <span class="text-white">MU</span></h1>
      <p class="text-zinc-500 uppercase tracking-[0.4em] text-xs">Selecciona un reino para monitorear</p>
    </header>
    
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6" id="server-grid"></div>
  </div>

  <script>
    const stats = ${statsJson};
    const servers = ["X25", "X150", "X500", "X3000"];
    const grid = document.getElementById("server-grid");

    servers.forEach(s => {
      const card = document.createElement("div");
      card.className = "mu-card p-8 rounded-sm text-center group";
      card.onclick = () => window.location.href = '?server=' + s;
      
      const online = stats[s] ? (stats[s].onlinePlayers || "0") : "0";
      
      card.innerHTML = '<div class="w-12 h-12 bg-black border border-zinc-800 rounded-full flex items-center justify-center mx-auto mb-6 group-hover:border-[#d4af37] transition-all">' +
          '<i data-lucide="server" class="text-zinc-600 group-hover:text-[#d4af37] w-6 h-6"></i>' +
        '</div>' +
        '<h2 class="text-3xl font-display font-bold text-white mb-2">' + s + '</h2>' +
        '<div class="flex items-center justify-center gap-2 text-green-500 text-xs font-bold uppercase tracking-widest">' +
           '<div class="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></div>' +
           online + ' ONLINE' +
        '</div>' +
        '<div class="mt-8 pt-6 border-t border-white/5 text-[10px] text-zinc-500 font-bold uppercase tracking-tighter opacity-0 group-hover:opacity-100 transition-all">' +
          'ENTRAR AL MONITOR <i data-lucide="chevron-right" class="inline w-3 h-3"></i>' +
        '</div>';
      grid.appendChild(card);
    });
    lucide.createIcons();
  </script>
</body>
</html>`;
}

function renderHTML(eventsData, userAlarms, env, extraData = {}) {
  const eventsJson = JSON.stringify(eventsData);
  const alarmsJson = JSON.stringify(userAlarms);
  const extraJson = JSON.stringify(extraData);
  const server = extraData.server || "X500";
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Awake MU - Monitor ${server}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/lucide@latest"></script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;700&family=Inter:wght@300;400;600&family=JetBrains+Mono:wght@400;700&display=swap');
    :root { --bg-color: #050505; --card-bg: #0f0f0f; --accent-gold: #d4af37; --accent-gold-light: #f1d279; --text-primary: #ffffff; --text-secondary: #a1a1aa; --border-gold: rgba(212, 175, 55, 0.2); }
    body { background-color: var(--bg-color); color: var(--text-primary); font-family: "Inter", sans-serif; background-image: radial-gradient(circle at 50% 0%, rgba(212, 175, 55, 0.05) 0%, transparent 50%), linear-gradient(to bottom, #050505, #0a0a0a); background-attachment: fixed; min-height: 100vh; }
    .mu-card { background-color: var(--card-bg); border: 1px solid var(--border-gold); box-shadow: 0 10px 30px rgba(0, 0, 0, 0.8); position: relative; overflow: hidden; transition: all 0.3s ease; }
    .mu-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px; background: linear-gradient(90deg, transparent, var(--accent-gold), transparent); opacity: 0.5; }
    .mu-card:hover { border-color: var(--accent-gold); transform: translateY(-2px); box-shadow: 0 15px 35px rgba(0, 0, 0, 0.9); }
    .font-display { font-family: "Cinzel", serif; letter-spacing: 0.05em; }
    .timer-display { font-family: "JetBrains Mono", monospace; letter-spacing: 0.1em; }
    .gold-text { color: #f1d279; text-shadow: 0 0 12px rgba(241, 210, 121, 0.25); }
    .gold-gradient { background: linear-gradient(135deg, var(--accent-gold), var(--accent-gold-light)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .tab-btn { position: relative; transition: all 0.3s; padding: 0.75rem 1.5rem; color: #a1a1aa; font-weight: 600; text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.1em; border-bottom: 2px solid transparent; }
    .tab-btn.active { color: #d4af37; border-bottom-color: #d4af37; background: rgba(212, 175, 55, 0.05); }
    .hidden { display: none; }
    @keyframes shimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
    .shimmer-effect { position: relative; overflow: hidden; }
    .shimmer-effect::after { content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.05), transparent); animation: shimmer 3s infinite; }
    .event-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; width: 100%; font-size: 0.75rem; color: #ffffff; letter-spacing: 0.08em; }
  </style>
</head>
<body class="p-4 md:p-8 lg:p-12">
  <div class="max-w-7xl mx-auto">
    <header class="flex flex-col md:flex-row justify-between items-start md:items-center mb-10 gap-8">
      <div class="flex items-center gap-6">
        <a href="/" class="w-10 h-10 bg-white/5 border border-white/10 rounded-full flex items-center justify-center hover:bg-white/10 transition-all group" title="Volver al Inicio">
          <i data-lucide="arrow-left" class="w-5 h-5 text-zinc-500 group-hover:text-white"></i>
        </a>
        <div class="relative"><div class="w-16 h-16 bg-black rounded-full flex items-center justify-center border-2 border-[#d4af37]"><i data-lucide="shield" class="text-[#d4af37]" style="width: 32px; height: 32px;"></i></div></div>
        <div>
          <h1 class="text-4xl font-display font-bold gold-gradient tracking-tighter">REINO <span class="text-white">${server}</span></h1>
          <div class="flex items-center gap-2 text-[#a1a1aa] text-[10px] font-medium uppercase tracking-[0.2em] mt-1"><div class="w-1.5 h-1.5 rounded-full bg-green-500"></div> MONITOR ONLINE</div>
        </div>
      </div>
      <div class="mu-card px-6 py-4 rounded-sm border-[#d4af37]/40 flex flex-col items-end shimmer-effect">
        <span class="text-[8px] uppercase tracking-[0.4em] text-[#d4af37] font-bold mb-1">Server Time</span>
        <div class="timer-display text-2xl font-bold text-white" id="clock">00:00:00</div>
        <div class="text-[8px] text-[#a1a1aa] mt-1 font-mono uppercase tracking-widest" id="date">...</div>
      </div>
    </header>

    <div class="flex border-b border-white/10 mb-8 overflow-x-auto no-scrollbar">
      <button onclick="showTab('events')" id="btn-events" class="tab-btn active flex items-center gap-2"><i data-lucide="calendar" class="w-4 h-4"></i> Eventos</button>
      <button onclick="showTab('character')" id="btn-character" class="tab-btn flex items-center gap-2"><i data-lucide="user" class="w-4 h-4"></i> Personaje</button>
      <button onclick="showTab('stats')" id="btn-stats" class="tab-btn flex items-center gap-2"><i data-lucide="bar-chart-3" class="w-4 h-4"></i> Estadísticas</button>
      <button onclick="showTab('rankings')" id="btn-rankings" class="tab-btn flex items-center gap-2"><i data-lucide="trophy" class="w-4 h-4"></i> Rankings</button>
      <button onclick="showTab('killers')" id="btn-killers" class="tab-btn flex items-center gap-2"><i data-lucide="skull" class="w-4 h-4"></i> Top Killers</button>
      <button onclick="showTab('news')" id="btn-news" class="tab-btn flex items-center gap-2"><i data-lucide="newspaper" class="w-4 h-4"></i> Noticias</button>
    </div>

    <!-- TABS CONTENT -->
    <div id="tab-events" class="tab-content">
      <h2 class="font-display text-xl gold-text mb-6 flex items-center gap-3"><i data-lucide="layout-grid" class="w-5 h-5"></i> Próximos Eventos</h2>
      <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4" id="grid-events"></div>
    </div>

    <div id="tab-character" class="tab-content hidden">
      <div class="mu-card p-8 rounded-sm max-w-4xl mx-auto">
        <div class="flex flex-col md:flex-row gap-8 items-center md:items-start">
          <div class="w-32 h-32 bg-black border-2 border-[#d4af37] rounded-full flex items-center justify-center flex-shrink-0 animate-pulse">
            <i data-lucide="user" class="w-16 h-16 text-[#d4af37]"></i>
          </div>
          <div class="flex-grow text-center md:text-left">
            <h2 class="text-4xl font-display font-bold text-white mb-2" id="char-name">...</h2>
            <div class="flex flex-wrap justify-center md:justify-start gap-4 mb-6">
              <span class="bg-white/5 border border-white/10 px-3 py-1 rounded-full text-[10px] text-zinc-400 font-bold uppercase tracking-widest" id="char-server">...</span>
              <span class="bg-green-500/10 border border-green-500/20 px-3 py-1 rounded-full text-[10px] text-green-500 font-bold uppercase tracking-widest" id="char-status">...</span>
            </div>
            
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div class="bg-black/40 p-4 border border-white/5 rounded-sm">
                <span class="text-[8px] text-zinc-500 uppercase block mb-1">Nivel</span>
                <div class="text-2xl font-bold font-mono text-white" id="char-level">-</div>
              </div>
              <div class="bg-black/40 p-4 border border-white/5 rounded-sm">
                <span class="text-[8px] text-zinc-500 uppercase block mb-1">Resets</span>
                <div class="text-2xl font-bold font-mono text-white" id="char-resets">-</div>
              </div>
              <div class="bg-black/40 p-4 border border-white/5 rounded-sm col-span-2">
                <span class="text-[8px] text-zinc-500 uppercase block mb-1">Ubicación</span>
                <div class="text-sm font-bold text-zinc-300 truncate" id="char-location">-</div>
              </div>
            </div>

            <div class="grid grid-cols-4 gap-2 mt-4 text-center">
              <div class="p-2 bg-white/5 rounded-sm border border-white/5"><div class="text-[8px] text-zinc-600 uppercase">STR</div><div class="text-xs font-bold text-zinc-300" id="char-str">-</div></div>
              <div class="p-2 bg-white/5 rounded-sm border border-white/5"><div class="text-[8px] text-zinc-600 uppercase">AGI</div><div class="text-xs font-bold text-zinc-300" id="char-agi">-</div></div>
              <div class="p-2 bg-white/5 rounded-sm border border-white/5"><div class="text-[8px] text-zinc-600 uppercase">VIT</div><div class="text-xs font-bold text-zinc-300" id="char-vit">-</div></div>
              <div class="p-2 bg-white/5 rounded-sm border border-white/5"><div class="text-[8px] text-zinc-600 uppercase">ENE</div><div class="text-xs font-bold text-zinc-300" id="char-ene">-</div></div>
            </div>
          </div>
        </div>
        <div class="mt-8 pt-6 border-t border-white/5 text-center">
          <p class="text-[10px] text-zinc-500 italic">Los datos del personaje se actualizan automáticamente cada 5 minutos.</p>
          <p class="text-[10px] text-zinc-600 mt-1">Usa los comandos /cuentas y /personajes en Telegram para cambiar de cuenta.</p>
        </div>
      </div>
    </div>

    <div id="tab-stats" class="tab-content hidden">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div class="md:col-span-2 mu-card p-6 rounded-sm">
          <h3 class="font-display text-lg gold-text mb-4 flex items-center gap-2"><i data-lucide="globe" class="w-5 h-5"></i> Estado del Servidor</h3>
          <div class="grid grid-cols-2 gap-4" id="stats-grid">
            <div class="bg-black/40 p-4 border border-white/5"><span class="text-[10px] text-zinc-500 uppercase">Cuentas</span><div class="text-xl font-bold" id="stat-accounts">-</div></div>
            <div class="bg-black/40 p-4 border border-white/5"><span class="text-[10px] text-zinc-500 uppercase">Personajes</span><div class="text-xl font-bold" id="stat-chars">-</div></div>
            <div class="bg-black/40 p-4 border border-white/5"><span class="text-[10px] text-zinc-500 uppercase">Online</span><div class="text-xl font-bold text-green-500" id="stat-online">-</div></div>
            <div class="bg-black/40 p-4 border border-white/5"><span class="text-[10px] text-zinc-500 uppercase">Resets Totales</span><div class="text-xl font-bold" id="stat-resets">-</div></div>
          </div>
        </div>
        <div class="mu-card p-6 rounded-sm border-red-900/40">
           <h3 class="font-display text-lg text-red-500 mb-4 flex items-center gap-2"><i data-lucide="shield" class="w-5 h-5"></i> Castle Siege</h3>
           <div class="flex flex-col items-center justify-center py-6">
             <i data-lucide="crown" class="w-12 h-12 text-yellow-500 mb-4 opacity-50"></i>
             <div class="text-[10px] text-zinc-500 uppercase mb-1">Lord de Lorencia</div>
             <div class="text-2xl font-display font-bold text-white tracking-widest" id="stat-cs-owner">...</div>
           </div>
        </div>
      </div>
    </div>

    <div id="tab-rankings" class="tab-content hidden">
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div class="mu-card p-6 rounded-sm">
          <h3 class="font-display text-lg gold-text mb-4 flex items-center gap-2"><i data-lucide="users" class="w-5 h-5"></i> Mejores Jugadores</h3>
          <div class="space-y-2" id="rank-players"></div>
        </div>
        <div class="mu-card p-6 rounded-sm">
          <h3 class="font-display text-lg gold-text mb-4 flex items-center gap-2"><i data-lucide="crown" class="w-5 h-5"></i> Top Clanes</h3>
          <div class="space-y-2" id="rank-guilds"></div>
        </div>
      </div>
    </div>

    <div id="tab-killers" class="tab-content hidden">
      <div class="mu-card p-6 rounded-sm">
        <h3 class="font-display text-lg text-red-500 mb-4 flex items-center gap-2"><i data-lucide="skull" class="w-5 h-5"></i> Los Más Buscados (PK)</h3>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4" id="rank-killers"></div>
      </div>
    </div>

    <div id="tab-news" class="tab-content hidden">
      <div class="mu-card p-8 rounded-sm max-w-2xl">
        <div class="flex gap-6 items-start">
          <div class="w-16 h-16 bg-white/5 border border-white/10 rounded flex items-center justify-center flex-shrink-0"><i data-lucide="newspaper" class="w-8 h-8 text-white/40"></i></div>
          <div>
            <span class="text-[10px] text-zinc-500 uppercase tracking-widest">Marzo 2026</span>
            <h2 class="text-2xl font-display font-bold text-white my-2">Gran Apertura Servidor ${server}</h2>

  </div>

  <script>
    const eventsData = ${eventsJson};
    const alarms = ${alarmsJson};
    const extra = ${extraJson};
    let currentTab = 'events';

    function showTab(id) {
      document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
      document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
      const target = document.getElementById('tab-' + id);
      if (target) target.classList.remove('hidden');
      const btn = document.getElementById('btn-' + id);
      if (btn) btn.classList.add('active');
      currentTab = id;
    }

    function updateClock() {
      const now = new Date();
      document.getElementById('clock').innerText = now.toTimeString().split(' ')[0];
      document.getElementById('date').innerText = now.toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    }

    function renderEvents() {
      const grid = document.getElementById('grid-events');
      if (!grid) return;
      grid.innerHTML = '';
      const now = Math.floor(Date.now() / 1000);

      eventsData.sort((a, b) => a.startTime - b.startTime).forEach(ev => {
        const left = ev.startTime - now;
        const card = document.createElement('div');
        card.className = "mu-card p-5 rounded-sm flex flex-col items-center justify-center text-center";
        
        let timeStr = "00:00:00";
        let statusText = "INICIANDO";
        let colorClass = "text-green-500";
        
        if (left > 0) {
          const h = Math.floor(left / 3600), m = Math.floor((left % 3600) / 60), s = left % 60;
          timeStr = String(h).padStart(2,'0') + ":" + String(m).padStart(2,'0') + ":" + String(s).padStart(2,'0');
          statusText = "PRÓXIMO";
          colorClass = left < 600 ? "text-yellow-500" : "text-white/40";
        } else {
           timeStr = "EN CURSO";
           statusText = "ACTIVO";
           colorClass = "text-green-500 animate-pulse";
        }

        const isAlarmSet = alarms[ev.name];
        
        card.innerHTML = 
          '<div class="flex items-center justify-between w-full mb-4">' +
            '<span class="text-[8px] font-bold tracking-widest uppercase ' + (isAlarmSet ? "text-yellow-500" : "text-zinc-600") + '">' + (isAlarmSet ? "ALERTA" : "INFO") + '</span>' +
            '<i data-lucide="' + (isAlarmSet ? 'bell' : 'calendar') + '" class="w-3 h-3 ' + (isAlarmSet ? "text-yellow-500" : "text-zinc-600") + '"></i>' +
          '</div>' +
          '<span class="event-name font-display mb-3">' + ev.name + '</span>' +
          '<div class="timer-display text-xl font-bold ' + colorClass + ' mb-1">' + timeStr + '</div>' +
          '<div class="text-[8px] text-zinc-600 font-bold tracking-tighter">' + statusText + '</div>';
        
        grid.appendChild(card);
      });
      lucide.createIcons();
    }

    async function fetchData() {
      try {
        const urlParams = new URLSearchParams(window.location.search);
        const srv = urlParams.get('server') || 'X500';
        const res = await fetch('/api/data?server=' + srv);
        const data = await res.json();
        
        // Update stats
        if (data.stats) {
          try {
            document.getElementById('stat-accounts').innerText = data.stats.Accounts || data.stats.totalAccounts || '-';
            document.getElementById('stat-chars').innerText = data.stats.Characters || data.stats.totalCharacters || '-';
            document.getElementById('stat-online').innerText = data.stats.onlinePlayers || '-';
            document.getElementById('stat-resets').innerText = data.stats.Resets || data.stats.totalResets || '-';
            document.getElementById('stat-cs-owner').innerText = data.stats["CS Owner"] || data.stats.csOwner || 'VACANTE';
          } catch(e) {}
        }

        // Update Character Info
        if (data.character) {
          try {
            document.getElementById('char-name').innerText = extra.context && extra.context.currentCharacter ? extra.context.currentCharacter.name : 'Mi Personaje';
            document.getElementById('char-server').innerText = srv;
            document.getElementById('char-status').innerText = data.character.status.includes('Online') ? 'CONECTADO' : 'DESCONECTADO';
            document.getElementById('char-level').innerText = data.character.level;
            document.getElementById('char-resets').innerText = data.character.resets;
            document.getElementById('char-location').innerText = data.character.location;
            document.getElementById('char-str').innerText = data.character.strength;
            document.getElementById('char-agi').innerText = data.character.agility;
            document.getElementById('char-vit').innerText = data.character.vitality;
            document.getElementById('char-ene').innerText = data.character.energy;
            
            const statusEl = document.getElementById('char-status');
            if (data.character.status.includes('Online')) {
              statusEl.className = "bg-green-500/10 border border-green-500/20 px-3 py-1 rounded-full text-[10px] text-green-500 font-bold uppercase tracking-widest";
            } else {
              statusEl.className = "bg-red-500/10 border border-red-500/20 px-3 py-1 rounded-full text-[10px] text-red-500 font-bold uppercase tracking-widest";
            }
          } catch(e) {}
        } else {
          try {
            document.getElementById('char-name').innerText = "Sin Seleccionar";
            document.getElementById('char-location').innerText = "Selecciona un personaje en Telegram";
          } catch(e) {}
        }

        // Update Rankings
        if (data.rankings) {
          try {
            const playersDiv = document.getElementById('rank-players');
            if (playersDiv) {
              playersDiv.innerHTML = data.rankings.players.map((p, i) => 
                '<div class="flex justify-between items-center p-3 bg-black/40 border-l-2 border-zinc-800 hover:border-[#d4af37] transition-all">' +
                  '<div class="flex gap-4 items-center"><span class="font-mono text-zinc-600 text-xs">' + (i+1).toString().padStart(2,'0') + '</span><span class="font-bold">' + p.name + '</span></div>' +
                  '<span class="text-xs text-zinc-500">Resets: <b class="text-white">' + (p.resets || p.Resets || '0') + '</b></span>' +
                '</div>'
              ).join('');
            }

            const guildsDiv = document.getElementById('rank-guilds');
            if (guildsDiv) {
              guildsDiv.innerHTML = data.rankings.guilds.map((g, i) => 
                '<div class="flex justify-between items-center p-3 bg-black/40 border-l-2 border-zinc-800 hover:border-[#d4af37] transition-all">' +
                  '<div class="flex gap-4 items-center"><span class="font-mono text-zinc-600 text-xs">' + (i+1).toString().padStart(2,'0') + '</span><span class="font-bold">' + (g.name || g.Name) + '</span></div>' +
                  '<span class="text-xs text-zinc-500">Score: <b class="text-white">' + (g.score || g.G_Score || g.score || '0') + '</b></span>' +
                '</div>'
              ).join('');
            }

            const killersDiv = document.getElementById('rank-killers');
            if (killersDiv) {
              killersDiv.innerHTML = data.rankings.killers.map((k, i) => 
                '<div class="mu-card p-4 border-red-900/20 flex justify-between items-center">' +
                  '<div class="flex gap-3 items-center"><div class="w-8 h-8 rounded-full bg-red-950 flex items-center justify-center text-red-500 text-xs font-bold">' + (k.PkCount || k.pk_count || 0) + '</div><div><div class="text-sm font-bold">' + k.name + '</div><div class="text-[8px] text-red-900 uppercase">Criminal Nivel ' + (i+1) + '</div></div></div>' +
                  '<i data-lucide="crosshair" class="w-4 h-4 text-red-900/40"></i>' +
                '</div>'
              ).join('');
            }
          } catch(e) {}
        }
        lucide.createIcons();
      } catch (e) {
        console.error("Fetch Error:", e);
      }
    }

    renderEvents();
    updateClock();
    fetchData();
    setInterval(updateClock, 1000);
    setInterval(renderEvents, 1000);
    setInterval(fetchData, 60000);
  </script>
</body>
</html>`;
}
