# m1tfc REST Server

Standalone REST service that executes `m1tfc` commands in a separate process.

## Why this design

- Service is independent from `m1tfc` runtime.
- Commands execute one-at-a-time through an internal queue to avoid concurrent serial port access.
- Existing CLI stdout JSON is preserved in `commandOutput` and merged into the top-level response when the payload includes `status`, `errorCode`, or `ErrorDescription`.

## API

### Endpoints

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/health` | Returns service health using the base response contract. |
| GET | `/config` | Returns machine name and resolved log file path. |
| GET | `/commands` | Returns the list of supported `m1tfc` command names. |
| POST | `/command` | Runs one `m1tfc` command and returns the CLI JSON stdout when available. |
| GET | `/logs/stream` | Streams log lines via Server-Sent Events (SSE). |
| GET | `/logs/tail?lines=100` | Returns last N lines from the configured log file. |
| GET | `/logs/download` | Downloads the configured log file. |
| POST | `/logs/clear` | Clears the configured log file. |

### POST /command

Request JSON:

```json
{
  "command": "ict",
  "argument": {
    "serial": "ABCD1234",
    "cellBatTol": "new",
    "debug": "1"
  }
}
```

Response JSON (required contract):

```json
{
  "status": "OK",
  "errorCode": 0,
  "ErrorDescription": "Success"
}
```

When command stdout already contains JSON, it is returned as `commandOutput` and its fields are exposed on the top-level response too:

```json
{
  "status": "OK",
  "errorCode": 0,
  "ErrorDescription": "Success",
  "commandOutput": {
    "result": "..."
  }
}
```

CLI commands currently routed through the server:

- `m1dfu`
- `m1tbcmd`
- `m1cmd`
- `mnpcmd`
- `ict`
- `eeprom`
- `progmac`
- `flash`
- `pingM1apps`
- `cleanup`
- `functest`
- `makelabel`

### GET /health
Returns service health using the same base contract fields.

### GET /commands
Returns supported `m1tfc` command names.

## Configuration

Environment variables:

- `PORT` (default `3300`)
- `HOST` (default `0.0.0.0`)
- `M1TFC_CMD` (default `m1tfc`)
- `M1TFC_BASE_ARGS` (default empty)
- `M1TFC_CWD` (default current working directory)
- `MACHINE_NAME` (optional machine label shown in GUI)
- `CONFIG_JSON` (optional path to runtime config JSON; default falls back to `/etc/m1platform/config.json`, then this service's snap data `config.json`)
- `LOG_FILE` (optional absolute/relative log file override)
- `LOG_SSE_HEARTBEAT_MS` (optional SSE heartbeat interval, default `15000`)

Runtime config JSON (`CONFIG_JSON`) may also provide:

- `machineName`
- `teensyLogFilename` (preferred)
- `logFile` or `logFilename` (fallbacks)

## Client Auto-Reconnect Example

Use this in the web app to auto-reconnect to `/logs/stream` without a manual reconnect button.

```javascript
let source = null;
let reconnectTimer = null;
let reconnectDelayMs = 1000;

function connectLogStream(baseUrl, onLine) {
  if (source) source.close();

  const url = `${baseUrl.replace(/\/$/, '')}/logs/stream?lines=500`;
  source = new EventSource(url);

  source.onopen = () => {
    reconnectDelayMs = 1000;
    console.log('log stream connected');
  };

  source.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload && payload.line) onLine(payload.line);
    } catch {
      // Ignore malformed event payloads.
    }
  };

  source.onerror = () => {
    source.close();
    if (reconnectTimer) clearTimeout(reconnectTimer);

    reconnectTimer = setTimeout(() => {
      connectLogStream(baseUrl, onLine);
    }, reconnectDelayMs);

    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 15000);
  };
}

// Usage example:
// connectLogStream('http://127.0.0.1:3300', (line) => appendLineToUi(line));
```

### Dev example with local repo

If the CLI is not installed globally:

```powershell
$env:M1TFC_CMD = "node"
$env:M1TFC_BASE_ARGS = "../m1tfc/bin/m1tfc.js"
$env:M1TFC_CWD = "../m1tfc"
npm start
```

## Run

```bash
npm install
npm start
```
