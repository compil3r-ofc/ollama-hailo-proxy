import express, { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { Socket } from 'net';

const app = express();

const HAILO_URL: string =
  process.env.HAILO_URL || 'http://host.docker.internal:8000';
const PORT: number = parseInt(process.env.PORT || '8001', 10);

// ── Body parsing (needed for /api/chat interception) ──────────────
app.use(express.json({ limit: '10mb' }));

// ── Logging middleware ────────────────────────────────────────────
app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── /api/tags — translate hailo /hailo/v1/list → Ollama schema ───
interface HailoModel {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
  details: {
    format: string;
    family: string;
    families: string[];
    parameter_size: string;
    quantization_level: string;
  };
}

interface ChatMessage {
  role: string;
  content: string | { type: string; text?: string }[];
}

const proxyErrorHandler = (
  err: Error,
  _req: Request,
  res: Response | Socket
) => {
  console.error('[proxy error]', err.message);
  if (res instanceof Socket) return;
  res.status(502).json({ error: err.message });
};

/**
 * Sanitize a single string: escape control characters that HailoRT's JSON
 * parser rejects (literal LF, CR, TAB, etc.).
 */
function sanitizeString(s: string): string {
  return s
    .replace(/\\/g, '\\\\') // must be first
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(
      /[\x00-\x1F\x7F]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
    );
}

/**
 * Sanitize all message content fields before forwarding to HailoRT.
 * Handles both string content and OpenAI-style array content.
 */
function sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((msg) => {
    if (typeof msg.content === 'string') {
      return { ...msg, content: sanitizeString(msg.content) };
    }
    if (Array.isArray(msg.content)) {
      const sanitized = msg.content.map((part) => {
        if (part.type === 'text' && typeof part.text === 'string') {
          return { ...part, text: sanitizeString(part.text) };
        }
        return part;
      });
      return { ...msg, content: sanitized };
    }
    return msg;
  });
}

app.get('/api/tags', async (_req: Request, res: Response) => {
  try {
    const response = await fetch(`${HAILO_URL}/hailo/v1/list`);
    const data = (await response.json()) as { models: string[] };

    const models: HailoModel[] = (data.models || []).map((name: string) => ({
      name,
      model: name,
      modified_at: new Date().toISOString(),
      size: 0,
      digest: '',
      details: {
        format: 'hailo',
        family: name.split(':')[0],
        families: [name.split(':')[0]],
        parameter_size: name.split(':')[1] || 'unknown',
        quantization_level: 'INT4',
      },
    }));

    res.json({ models });
  } catch (err) {
    const error = err as Error;
    console.error('[/api/tags] Error:', error.message);
    res
      .status(502)
      .json({ error: 'Failed to reach hailo-ollama', detail: error.message });
  }
});

// ── /api/version — spoof a version so Open WebUI is happy ────────
app.get('/api/version', (_req: Request, res: Response) => {
  res.json({ version: '0.1.0-hailo' });
});

// ── /api/chat — intercept, sanitize, and forward ─────────────────
app.post('/api/chat', async (req: Request, res: Response) => {
  try {
    const body = req.body as {
      messages?: ChatMessage[];
      stream?: boolean;
      [key: string]: unknown;
    };

    if (body.messages && Array.isArray(body.messages)) {
      body.messages = sanitizeMessages(body.messages);
    }

    const targetUrl = `${HAILO_URL}/api/chat`;
    console.log(`[/api/chat] Forwarding sanitized request to ${targetUrl}`);

    const upstream = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(req.headers['authorization']
          ? { authorization: req.headers['authorization'] as string }
          : {}),
      },
      body: JSON.stringify(body),
    });

    const contentType = upstream.headers.get('content-type') || '';
    res.status(upstream.status);
    res.setHeader('content-type', contentType || 'application/json');

    // Stream the response body back as-is
    const reader = upstream.body?.getReader();
    if (!reader) {
      res.end();
      return;
    }

    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          res.end();
          break;
        }
        res.write(value);
      }
    };

    await pump();
  } catch (err) {
    const error = err as Error;
    console.error('[/api/chat] Error:', error.message);
    res
      .status(502)
      .json({ error: 'Failed to reach hailo-ollama', detail: error.message });
  }
});

// ── /hailo/* — pass through directly ─────────────────────────────
app.use(
  '/hailo',
  createProxyMiddleware({
    target: HAILO_URL,
    changeOrigin: true,
    on: { error: proxyErrorHandler },
  })
);

// ── All other /api/* — proxy to hailo-ollama keeping /api prefix ──
app.use(
  '/api',
  createProxyMiddleware({
    target: `${HAILO_URL}/api`,
    changeOrigin: true,
    selfHandleResponse: false,
    on: {
      proxyReq: (_proxyReq: any, req: Request) => {
        console.log(
          `[proxy] ${req.method} ${req.path} → ${HAILO_URL}/api${req.path}`
        );
      },
      proxyRes: (proxyRes: any, req: Request) => {
        console.log(
          `[proxy] response ${proxyRes.statusCode} for /api${req.path}`
        );
      },
      error: proxyErrorHandler,
    },
  })
);

// ── Health check ──────────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', upstream: HAILO_URL });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`hailo-proxy listening on port ${PORT}`);
  console.log(`Proxying to hailo-ollama at ${HAILO_URL}`);
});
