// Vercel Serverless Function — прокси к Mistral API
// Ключ берётся из переменной окружения, в браузере его нет

export const config = {
    runtime: 'nodejs',
    maxDuration: 10 // ВАЖНО: на бесплатном Hobby плане максимум 10 секунд
};

const MISTRAL_API = 'https://api.mistral.ai/v1/chat/completions';
const SYSTEM_PROMPT = `Ты — интеллектуальный финансовый ассистент, специализирующийся на расчетах в российских рублях, банковской математике, учете наличности, налогах и вкладах.

СТРОГИЕ ПРАВИЛА ОТВЕТОВ:
1. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО использовать любые текстовые эмодзи и юникод-смайлы.
2. Вместо текстовых маркеров используй встроенный SVG-код. Примеры:
   - Информация: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
   - Внимание: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>
   - Галочка: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>
   - Стрелка: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
3. Отвечай строго, по делу, на русском языке.
4. Используй Markdown для форматирования.
5. Все денежные суммы в формате: 1 234,56 ₽.
6. При расчетах показывай пошаговое решение.
7. Никогда не упоминай название провайдера нейросети.`;

// Мягкий rate-limit (сбрасывается при холодном старте сервера Vercel)
const requestCounts = new Map();

function checkRateLimit(ip) {
    const now = Date.now();
    const windowMs = 60 * 1000; // 1 минута
    const maxRequests = 20;     // 20 запросов в минуту

    const record = requestCounts.get(ip) || { count: 0, resetAt: now + windowMs };
    if (now > record.resetAt) {
        record.count = 0;
        record.resetAt = now + windowMs;
    }
    record.count++;
    requestCounts.set(ip, record);
    return record.count <= maxRequests;
}

export default async function handler(req, res) {
    // 1. Только POST запросы
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // 2. Проверка API ключа
    const apiKey = process.env.MISTRAL_API_KEY;
    if (!apiKey) {
        console.error('[API] MISTRAL_API_KEY is not set in Vercel Environment Variables');
        return res.status(500).json({ error: 'API key not configured' });
    }

    // 3. Rate-limit (берём первый IP из списка, если их несколько)
    const forwarded = req.headers['x-forwarded-for'];
    const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null) || 
               req.socket.remoteAddress || 'unknown';
    
    if (!checkRateLimit(ip)) {
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

    const { messages = [], model = 'mistral-small-latest' } = req.body;

    if (!messages.length) {
        return res.status(400).json({ error: 'Messages array is required' });
    }

    try {
        // 4. Добавляем системный промпт
        const fullMessages = [
            { role: 'system', content: SYSTEM_PROMPT },
            ...messages
        ];

        // 5. Запрос к Mistral
        const upstream = await fetch(MISTRAL_API, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model,
                messages: fullMessages,
                stream: true,
                temperature: 0.7,
                max_tokens: 2048
            })
        });

        if (!upstream.ok) {
            const errText = await upstream.text();
            return res.status(upstream.status).json({ error: errText });
        }

        // 6. Проксирование стрима на клиент
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // отключает буферизацию на уровне прокси

        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(decoder.decode(value, { stream: true }));
        }

        res.end();
    } catch (error) {
        console.error('[API] Error:', error);
        // Если стрим уже начался, нельзя отправить JSON, но тут мы ловим ошибки до стрима
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        } else {
            res.end();
        }
    }
}