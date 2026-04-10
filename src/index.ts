import express, { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { Socket } from 'net';

const app = express();

const HAILO_URL: string = process.env.HAILO_URL || 'http://host.docker.internal:8000';
const PORT: number = parseInt(process.env.PORT || '8001', 10);

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

const proxyErrorHandler = (err: Error, _req: Request, res: Response | Socket) => {
  console.error('[proxy error]', err.message);
  if (res instanceof Socket) return;
  res.status(502).json({ error: err.message });
};

app.get('/api/tags', async (_req: Request, res: Response) => {
  try {
    const response = await fetch(`${HAILO_URL}/hailo/v1/list`);
    const data = await response.json() as { models: string[] };

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
    res.status(502).json({ error: 'Failed to reach hailo-ollama', detail: error.message });
  }
});

// ── /api/version — spoof a version so Open WebUI is happy ────────
app.get('/api/version', (_req: Request, res: Response) => {
  res.json({ version: '0.1.0-hailo' });
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
        console.log(`[proxy] ${req.method} ${req.path} → ${HAILO_URL}/api${req.path}`);
      },
      proxyRes: (proxyRes: any, req: Request) => {
        console.log(`[proxy] response ${proxyRes.statusCode} for /api${req.path}`);
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