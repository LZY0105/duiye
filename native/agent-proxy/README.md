# Local Agent proxy

The local Agent proxy is a Windows development companion. It listens only on
`127.0.0.1:8787`, accepts page text from the desktop browser, and forwards a
non-streaming request to an OpenAI-compatible `/chat/completions` endpoint.

It is not an Android release transport: `127.0.0.1` inside an Android app is
the phone itself, not this computer.

## Security boundary

- The proxy binds to loopback only; it is not reachable from the LAN.
- API keys are read only from process environment variables.
- The proxy does not log PDF text, API keys, upstream URLs, or model output.
- Browser CORS is limited to Vite's local defaults (`localhost:5173` and
  `127.0.0.1:5173`). An additional exact origin can be supplied through
  `DUIYE_AGENT_ALLOWED_ORIGIN`.
- Requests are limited to 32 KiB of page text; upstream responses are limited
  to 1 MiB.

## Build

Run from this directory:

```powershell
cmake -S . -B build
cmake --build build --config Release
```

The executable is normally `build\Release\agent-proxy.exe` when using a Visual
Studio generator.

## Run with a real model provider

Set these variables in the same PowerShell session that starts the proxy. Do
not put a real key in a source file, `.env` file committed to Git, issue, or
chat message.

```powershell
$env:DUIYE_AGENT_BASE_URL = 'https://provider.example/v1'
$env:DUIYE_AGENT_API_KEY = 'replace-with-your-local-secret'
$env:DUIYE_AGENT_MODEL = 'provider-model-id'
.\build\Release\agent-proxy.exe
```

`DUIYE_AGENT_BASE_URL` may also be the complete
`https://provider.example/v1/chat/completions` endpoint. Only HTTPS endpoints
are accepted.

Optional timeout, in milliseconds (default: 60000; range: 1000 to 120000):

```powershell
$env:DUIYE_AGENT_TIMEOUT_MS = '60000'
```

## Mock mode

Mock mode performs no network request and is useful for verifying the browser
integration before configuring a provider:

```powershell
$env:DUIYE_AGENT_MODE = 'mock'
.\build\Release\agent-proxy.exe
```

Without mock mode or all three upstream variables, `/health` reports
`ready: false` and answer requests fail with `upstream_not_configured`.

## Health check

While the proxy is running:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

The health response reports only `ready` and `mode`; it intentionally does not
expose the configured endpoint, model, or key.