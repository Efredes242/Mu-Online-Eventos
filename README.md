# AwakeMU Telegram Bot 🤖

Este proyecto es un bot automatizado que corre en Cloudflare Workers. 
Escanea constantemente la página de AwakeMU y te notifica a tu canal/grupo de Telegram 5 minutos antes de que empiece un evento importante.

## Características
- 🚀 **100% Serverless:** Se ejecuta gratis en la red edge de Cloudflare gracias a sus Workers y sus Cron Triggers.
- 💾 **Alta Disponibilidad:** Aunque la página del servidor oficial de AwakeMU se caiga o se quede "trabada" visualmente, el bot cachea inteligentemente la hora absoluta de los eventos en **Cloudflare KV**, por lo que seguirás recibiendo alertas sin interrupciones.
- 🚫 **Anti-Duplicación:** Alerta una y solo una vez por ciclo de evento aprovechando la ventana de tiempo estricta del Cron.
- ⚙️ **Filtros Personalizados:** Especifica solo los eventos que te interesan.

---

## 🛠️ Instrucciones de Despliegue

### 1. Requisitos Previos
- Cuenta gratuita en [Cloudflare](https://dash.cloudflare.com/sign-up).
- [Node.js](https://nodejs.org/) instalado en tu PC (para correr la línea de comandos).
- Un bot de Telegram (créalo hablando con [@BotFather](https://t.me/botfather) en Telegram y guarda el **Token**).
- El ID del Chat o Canal donde el bot enviará los mensajes. (Puedes obtenerlo agregando al bot al canal y enviando un mensaje, luego revisa `https://api.telegram.org/bot<TU_TOKEN>/getUpdates`).

### 2. Preparar el Entorno
Abre tu terminal (PowerShell o CMD) en la carpeta del proyecto (`d:\Proyectos\MU\AwakeMUTelegramBot`) e instala la herramienta oficial de Cloudflare:
```bash
npm install -g wrangler
```

Inicia sesión en tu cuenta de Cloudflare desde la terminal:
```bash
wrangler login
```

### 3. Crear la caché KV
Para que el bot sobreviva a caídas del servidor y no sufra problemas, crearemos una base de datos ultrarrápida (KV):
```bash
wrangler kv:namespace create AWAKE_CACHE
```
Esto te imprimirá por pantalla un ID (algo como `id = "abcdef1234567890"`). 

Abre el archivo `wrangler.toml` de este proyecto y **reemplaza** el valor de `id = "YOUR_KV_NAMESPACE_ID_HERE"` con el ID que te acaba de generar la consola.

### 4. Configurar Filtros y Tiempos
Abre `wrangler.toml`. En la sección `[vars]` puedes configurar los eventos que quieres rastrear:
```toml
TARGET_EVENTS = "Blood Castle,Devil Square,Chaos Castle,Kanturu,Illusion Temple"
MINUTES_BEFORE = "5"
```
*(Si dejas `TARGET_EVENTS` vacío, te alertará de literalmente TODOS los eventos).*

### 5. Configurar los Secretos de Telegram
Para proteger tus datos (Token de Bot), los subiremos forma segura a Cloudflare mediante estos comandos:

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
```
*(Pega allí el Token de tu bot de Telegram)*

```bash
wrangler secret put TELEGRAM_CHAT_ID
```
*(Pega allí el Chat ID (suele empezar con `-` si es un grupo) )*

### 6. Desplegar el Bot 🚀
Finalmente, sube el código a la red de Cloudflare con un solo comando:
```bash
wrangler deploy
```

¡Listo! A partir de ahora Cloudflare ejecutará tu script 1 vez por minuto de forma completamente gratuita, incluso si tienes tu PC apagada.

### Extras
- Puedes probar el funcionamiento de forma manual una vez desplegado visitando la URL que te genera wrangler (Ej: `https://awakemu-telegram-bot.<tu-usuario>.workers.dev`). Al visitarla forzará una ejecución del script como si fuese un chequeo de cron.
