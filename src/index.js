const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

const HAILO_URL = process.env.HAILO_URL || 'http://host.docker.internal:8000';
const PORT = process.env.PORT || 8001;

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.get('/api/tags', async (req, res) => {
  try {
    const response = await fetch(`${HAILO_URL}/hailo/v1/list`);
    const data = await response.json();
    const models = (data.models || []).map((name) => ({
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
    console.error('[/api/tags] Error:', err.message);
    res
      .status(502)
      .json({ error: 'Failed to reach hailo-ollama', detail: err.message });
  }
});

app.get('/api/version', (_req, res) => {
  res.json({ version: '0.1.0-hailo' });
});

app.use(
  '/hailo',
  createProxyMiddleware({
    target: HAILO_URL,
    changeOrigin: true,
    on: {
      error: (err, _req, res) => {
        console.error('[proxy /hailo]', err.message);
        res.status(502).json({ error: err.message });
      },
    },
  })
);

app.use(
  '/api',
  createProxyMiddleware({
    target: `${HAILO_URL}/api`,
    changeOrigin: true,
    selfHandleResponse: false,
    on: {
      proxyReq: (proxyReq, req) => {
        console.log(
          `[proxy] ${req.method} ${req.path} → ${HAILO_URL}/api${req.path}`
        );
      },
      proxyRes: (proxyRes, req) => {
        console.log(
          `[proxy] response ${proxyRes.statusCode} for /api${req.path}`
        );
      },
      error: (err, _req, res) => {
        console.error('[proxy /api]', err.message);
        res.status(502).json({ error: err.message });
      },
    },
  })
);

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', upstream: HAILO_URL })
);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`hailo-proxy listening on port ${PORT}`);
  console.log(`Proxying to hailo-ollama at ${HAILO_URL}`);
});
