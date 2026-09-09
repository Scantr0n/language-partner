import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5175;
const REALTIME_MODEL = process.env.REALTIME_MODEL || 'gpt-realtime';
const LOOKUP_MODEL = process.env.LOOKUP_MODEL || 'gpt-4o-mini';

const LOOKUP_SYSTEM_PROMPTS = {
  zh: 'You are a helpful Mandarin Chinese tutor for a learner studying toward HSK4. When they ask about a word, phrase, or grammar point, explain it clearly in English. Include the Chinese characters and pinyin. Keep answers concise (a few sentences), and give a short example sentence in Chinese with pinyin and English translation when it helps.',
  ja: 'You are a helpful Japanese tutor for a beginner, below JLPT N5 level. When they ask about a word, phrase, or grammar point, explain it clearly in English. Include the Japanese text and romaji. Keep answers concise (a few sentences), and give a short example sentence in Japanese with romaji and English translation when it helps.',
};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Mints a short-lived ephemeral token so the browser can open a WebRTC
// connection to OpenAI directly without ever seeing the real API key.
app.post('/api/session', async (req, res) => {
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'sk-your-key-here') {
    return res.status(500).json({
      error: 'OPENAI_API_KEY is not set. Edit language-partner/.env and replace the placeholder with your real key.',
    });
  }

  const { instructions, voice } = req.body || {};

  try {
    const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session: {
          type: 'realtime',
          model: REALTIME_MODEL,
          instructions: instructions || 'You are a helpful language practice partner.',
          output_modalities: ['audio'],
          audio: {
            input: {
              transcription: { model: 'whisper-1' },
              turn_detection: { type: 'server_vad' },
            },
            output: {
              voice: voice || 'alloy',
            },
          },
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('OpenAI session error:', response.status, errText);
      return res.status(response.status).json({ error: errText });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Failed to create realtime session:', err);
    res.status(500).json({ error: String(err) });
  }
});

// Text-only word/grammar lookup — cheaper than opening a realtime voice session.
app.post('/api/ask', async (req, res) => {
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'sk-your-key-here') {
    return res.status(500).json({
      error: 'OPENAI_API_KEY is not set. Edit language-partner/.env and replace the placeholder with your real key.',
    });
  }

  const { question, language } = req.body || {};
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'Missing question' });
  }

  const systemPrompt = LOOKUP_SYSTEM_PROMPTS[language] || LOOKUP_SYSTEM_PROMPTS.zh;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: LOOKUP_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: question },
        ],
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('OpenAI lookup error:', response.status, errText);
      return res.status(response.status).json({ error: errText });
    }

    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content || 'No answer returned.';
    res.json({ answer });
  } catch (err) {
    console.error('Failed to fetch lookup answer:', err);
    res.status(500).json({ error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Language partner running at http://localhost:${PORT}`);
});
