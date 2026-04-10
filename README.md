# ollama-hailo-proxy

A lightweight Node.js/TypeScript proxy that bridges [hailo-ollama](https://github.com/hailo-ai/hailo_model_zoo_genai) to [Open WebUI](https://github.com/open-webui/open-webui) by translating Hailo's API responses into the Ollama API schema.

## The Problem

`hailo-ollama` exposes an Ollama-compatible API but returns an empty array from `/api/tags` — the endpoint Open WebUI uses to discover available models. This proxy intercepts that call, fetches the real model list from Hailo's `/hailo/v1/list` endpoint, and reformats it into the shape Open WebUI expects.

## How It Works

```
Open WebUI → ollama-hailo-proxy :8001 → hailo-ollama :8000 → Hailo-10H
```

- `/api/tags` — fetches from `/hailo/v1/list` and reformats to Ollama schema
- `/api/version` — spoofs a version string so Open WebUI's connection check passes
- `/hailo/*` — proxied directly to hailo-ollama
- `/api/*` — proxied directly to hailo-ollama
- `/health` — health check endpoint

## Requirements

- Raspberry Pi 5 with AI HAT+ 2 (Hailo-10H)
- HailoRT 5.x installed and working (`hailortcli scan` should show the device)
- `hailo-ollama` running on port `8000`
- Docker + Docker Compose

## Setup

### 1. Pull models into hailo-ollama first

Models must be pulled before they can be used. With `hailo-ollama` running:

```bash
# See what's available
curl http://localhost:8000/hailo/v1/list

# Pull a model
curl http://localhost:8000/api/pull \
  -H 'Content-Type: application/json' \
  -d '{"model": "qwen2.5:1.5b", "stream": false}'
```

### 2. Deploy the proxy

```bash
git clone <this-repo>
cd ollama-hailo-proxy
docker compose up -d --build
```

### 3. Verify

```bash
# Health check
curl http://localhost:8001/health

# Should return your pulled models in Ollama format
curl http://localhost:8001/api/tags | python3 -m json.tool
```

### 4. Configure Open WebUI

In Open WebUI → **Settings → Connections → Ollama URL**, set:

```
http://ollama-hailo-proxy:8001
```

Your Hailo models should now appear in the model selector.

## Configuration

Environment variables can be set at build time via Docker build args or overridden at runtime:

| Variable | Default | Description |
|---|---|---|
| `HAILO_URL` | `http://host.docker.internal:8000` | URL of the hailo-ollama server |
| `PORT` | `8001` | Port the proxy listens on |

### Override at build time

```bash
docker compose build --build-arg HAILO_URL=http://192.168.1.x:8000
```

### Override at runtime

Add to `docker-compose.yml` under the service:

```yaml
environment:
  - HAILO_URL=http://192.168.1.x:8000
```

## Available Models (as of HailoRT 5.3.0)

| Model | Best for |
|---|---|
| `qwen3:1.7b` | General chat, latest Qwen release |
| `qwen2.5:1.5b` | General chat, strong reasoning |
| `qwen2.5-coder:1.5b` | Code generation and scripting |
| `qwen2:1.5b` | General chat, best multilingual support |
| `deepseek_r1:1.5b` | Step-by-step reasoning |
| `llama3.2:1b` | General chat, fastest inference |

## Project Structure

```
ollama-hailo-proxy/
├── src/
│   └── index.ts        # Proxy server
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
└── README.md
```

## Troubleshooting

**Open WebUI shows no models**
- Make sure you have pulled at least one model into hailo-ollama (`/api/pull`)
- Check `curl http://localhost:8001/api/tags` returns models

**Network error in Open WebUI**
- Verify hailo-ollama is running: `curl http://localhost:8000/hailo/v1/list`
- Check proxy logs: `docker logs ollama-hailo-proxy`
- Confirm the model is pulled before trying to chat with it

**ollama-hailo-proxy shows unhealthy**
- hailo-ollama must be running before the proxy starts
- Start hailo-ollama first, then `docker compose up -d`

**Model not found error**
- The model list shows what's available to download, not what's loaded
- Pull the model first before selecting it in Open WebUI
