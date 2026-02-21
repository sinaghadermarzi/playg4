import express from 'express';
import fs from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_MESSAGE_LENGTH = 280;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MESSAGES_FILE = join(__dirname, 'data', 'messages.json');

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// Ensure data directory exists
fs.mkdirSync(dirname(MESSAGES_FILE), { recursive: true });

// Initialize messages file if it doesn't exist
if (!fs.existsSync(MESSAGES_FILE)) {
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify([], null, 2));
}

function readMessages() {
  const data = fs.readFileSync(MESSAGES_FILE, 'utf-8');
  return JSON.parse(data);
}

function writeMessages(messages) {
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2));
}

async function sendTelegramNotification(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('Telegram notification skipped: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('Telegram API error:', err);
    }
  } catch (err) {
    console.error('Failed to send Telegram notification:', err.message);
  }
}

// ─── Message Board Endpoints ──────────────────────────────────────────────────

app.get('/api/messages', (req, res) => {
  const messages = readMessages();
  res.json(messages);
});

app.post('/api/messages', (req, res) => {
  const { message } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message is required' });
  }

  const trimmed = message.trim();

  if (trimmed.length === 0) {
    return res.status(400).json({ error: 'Message cannot be empty' });
  }

  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    return res
      .status(400)
      .json({ error: `Message must be ${MAX_MESSAGE_LENGTH} characters or less` });
  }

  const messages = readMessages();
  const entry = {
    id: Date.now(),
    message: trimmed,
    timestamp: new Date().toISOString(),
  };
  messages.push(entry);
  writeMessages(messages);

  sendTelegramNotification(`New message on Message Board:\n\n${trimmed}`);

  res.status(201).json(entry);
});

app.post('/api/telegram-webhook', (req, res) => {
  const update = req.body;
  const text = update?.message?.text;

  if (!text) {
    return res.sendStatus(200);
  }

  const from = update.message.from;
  const sender = from.username
    ? `@${from.username}`
    : [from.first_name, from.last_name].filter(Boolean).join(' ');

  const messages = readMessages();
  const entry = {
    id: Date.now(),
    message: text,
    timestamp: new Date().toISOString(),
    source: 'telegram',
    sender,
  };
  messages.push(entry);
  writeMessages(messages);

  res.sendStatus(200);
});

// ─── Movie Recommendation Agent Endpoint ──────────────────────────────────────

app.post('/api/movie-recommendations', async (req, res) => {
  const { favoriteMovies, moviePreferences } = req.body;

  if (!Array.isArray(favoriteMovies) || favoriteMovies.length === 0) {
    return res.status(400).json({ error: 'favoriteMovies must be a non-empty array' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY environment variable is not set' });
  }

  // Server-Sent Events setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering for SSE
  res.flushHeaders();

  const send = (data) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      // Client disconnected
    }
  };

  // Keep connection alive with periodic heartbeat
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 15000);

  try {
    const { runMovieAgent } = await import('./movie-agent.js');
    const prefs = moviePreferences || {};

    send({ type: 'start', message: 'Starting deep research into your movie taste...' });

    for await (const msg of runMovieAgent(favoriteMovies, prefs)) {
      if (!msg || typeof msg !== 'object') continue;

      const msgType = msg.type;

      // Final result
      if (msgType === 'result') {
        if (msg.subtype === 'success') {
          send({ type: 'result', content: msg.result });
        } else {
          const errMsg = msg.errors?.join('; ') || 'Research encountered an error';
          send({ type: 'error', message: errMsg });
        }
        continue;
      }

      // Assistant turn — extract tool calls and text for progress display
      if (msgType === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (!block || typeof block !== 'object') continue;

          if (block.type === 'tool_use') {
            if (block.name === 'WebSearch') {
              const query = block.input?.query || block.input?.q || '';
              send({ type: 'search', query });
            } else if (block.name === 'WebFetch') {
              const url = block.input?.url || '';
              send({ type: 'fetch', url });
            }
          } else if (block.type === 'text' && block.text?.trim()) {
            // Only send short interim thoughts (long text is likely the final result
            // which will come via the 'result' message)
            const text = block.text.trim();
            if (text.length > 0 && text.length < 500) {
              send({ type: 'thinking', content: text });
            }
          }
        }
        continue;
      }

      // Tool use summary — compact description of what tools were used
      if (msgType === 'tool_use_summary' && msg.summary) {
        send({ type: 'summary', content: msg.summary });
        continue;
      }

      // Tool progress notification
      if (msgType === 'tool_progress' && msg.tool_name) {
        send({ type: 'tool_progress', toolName: msg.tool_name, elapsed: msg.elapsed_time_seconds });
        continue;
      }
    }

    send({ type: 'done' });
  } catch (err) {
    console.error('Movie agent error:', err);
    send({ type: 'error', message: err.message || 'An unexpected error occurred' });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// ─── Server Start ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Movie recommender: http://localhost:${PORT}/movies.html`);
});
