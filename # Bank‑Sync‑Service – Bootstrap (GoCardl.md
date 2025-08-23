# Bank‑Sync‑Service – Bootstrap (GoCardless first)

> Objetivo: levantar **bank‑sync‑service** aislado (GoCardless), con contratos, idempotencia, cache persistente y eventos. Listo para correr en tu NAS y para que **finance‑service** consuma transacciones.

---

## 1) Alcance y principios

- **Proveedor inicial**: GoCardless (modo Sandbox y Live).
- **Contract‑first**: OpenAPI para REST, AsyncAPI para eventos.
- **Estado propio**: Redis (AOF) + checkpoint durable opcional en DB.
- **Idempotencia y reanudación**: dedupe por `externalRef`, cursor incremental por cuenta, locks de sync.
- **Observabilidad**: logs JSON, métricas Prometheus, health/ready.
- **Seguridad**: validación de firma del webhook, network interna Docker.

---

## 2) Estructura de carpetas

```
services/bank-sync-service/
├─ src/
│  ├─ routes/                 # REST (Fastify)
│  │  ├─ accounts.ts
│  │  ├─ sync.ts
│  │  └─ webhook-gc.ts
│  ├─ lib/
│  │  ├─ gcClient.ts          # cliente GoCardless (fetch/axios)
│  │  ├─ redis.ts             # conexión y helpers (AOF recomendado)
│  │  ├─ cursor.ts            # get/set cursor + checkpoint durable
│  │  ├─ dedupe.ts            # SETNX por externalRef
│  │  ├─ lock.ts              # SETNX + EX para /sync
│  │  └─ events.ts            # publish XADD a Redis Streams
│  ├─ workers/
│  │  └─ syncRunner.ts        # pipeline de sync (pull API → normaliza → emite)
│  ├─ index.ts                # bootstrap Fastify
│  └─ types.ts                # tipos internos y contratos
├─ contracts/
│  ├─ openapi.v1.yaml         # REST
│  └─ asyncapi.v1.yaml        # eventos
├─ Dockerfile
├─ Makefile
├─ .env.example
└─ README.md
```

---

## 3) Variables de entorno

```
# Runtime
NODE_ENV=production
PORT=3000
LOG_LEVEL=info

# Infra
REDIS_URL=redis://redis:6379
# Opcional: DB durable para checkpoint (sqlite/pg)
DB_URL=sqlite:./data/bank-sync.db

# GoCardless
GC_BASE_URL=https://bankaccountdata.gocardless.com
GC_ACCESS_TOKEN=REPLACE
GC_WEBHOOK_SECRET=REPLACE
GC_PROVIDER=gocardless
```

> **Tip NAS**: activar AOF en Redis (appendonly yes, `everysec`).

---

## 4) Contratos

### 4.1 OpenAPI (REST)

```yaml
openapi: 3.1.0
info: { title: bank-sync-service, version: 1.0.0 }
servers: [{ url: /v1 }]
paths:
  /accounts:
    get:
      operationId: listAccounts
      responses: { "200": { description: OK } }
  /sync/{accountId}:
    post:
      operationId: startSync
      parameters:
        - {
            in: path,
            name: accountId,
            required: true,
            schema: { type: string },
          }
      responses:
        "202":
          {
            description: Accepted,
            content:
              {
                application/json:
                  {
                    schema:
                      {
                        type: object,
                        properties: { operationId: { type: string } },
                      },
                  },
              },
          }
  /webhook/gocardless:
    post:
      operationId: gcWebhook
      requestBody:
        {
          required: true,
          content: { application/json: { schema: { type: object } } },
        }
      responses: { "200": { description: OK } }
```

### 4.2 AsyncAPI (eventos)

```yaml
asyncapi: 3.0.0
info: { title: bank-sync-events, version: 1.0.0 }
channels:
  bank.tx.created: { address: bank.tx.created }
  bank.sync.completed: { address: bank.sync.completed }
  bank.sync.failed: { address: bank.sync.failed }
components:
  messages:
    TxCreated:
      payload:
        type: object
        required:
          [
            txId,
            externalRef,
            accountId,
            source,
            provider,
            asset,
            amount,
            direction,
            bookedAt,
          ]
        properties:
          txId: { type: string, format: uuid }
          externalRef: { type: string }
          accountId: { type: string }
          source: { type: string, enum: [bank] }
          provider: { type: string, enum: [gocardless] }
          asset: { type: string, examples: [EUR] }
          amount: { type: number }
          fee: { type: number, default: 0 }
          direction: { type: string, enum: [in, out] }
          bookedAt: { type: string, format: date-time }
          description: { type: ["string", "null"] }
          counterparty:
            type: object
            properties:
              {
                name: { type: ["string", "null"] },
                iban: { type: ["string", "null"] },
              }
```

---

## 5) Redis: claves y TTLs

- **Cursor por cuenta**: `gc:cursor:{accountId}` → `{ sinceISO, cursor, lastTxnRef }` _(sin TTL)_
- **Dedupe transacción**: `gc:tx:dedupe:{externalRef}` → `1` _(sin TTL)_
- **Lock de sync**: `gc:sync:lock:{accountId}` _(TTL 15m)_
- **Estado de operación**: `gc:op:{operationId}` → `{ status, startedAt, processed, errors[] }` _(TTL 7d)_
- **Anti‑replay webhook**: `gc:webhook:sig:{eventId}` _(TTL 72h)_

> **Checkpoint durable (opcional):** tabla `bank_sync_checkpoint(account_id pk, since_iso, cursor, updated_at)`.

---

## 6) Flujo de sincronización

1. **POST /sync/{accountId}** → crea `operationId`, toma lock `gc:sync:lock:{accountId}`.
2. Lee `gc:cursor:{accountId}` → llama GoCardless (paginado incremental).
3. Para cada transacción:

   - construye `externalRef` (id del proveedor);
   - `SETNX gc:tx:dedupe:{externalRef}` → si nuevo, **emite** `bank.tx.created` y persiste;

4. Actualiza `gc:cursor:{accountId}` al final de cada página.
5. Libera lock y emite `bank.sync.completed` o `bank.sync.failed`.

---

## 7) Validación de webhook

- Verificar firma/HMAC (`X-Signature` u header equivalente) con `GC_WEBHOOK_SECRET`.
- Descartar replays con `gc:webhook:sig:{eventId}` (SETNX + TTL 72h).
- Normalizar payloads y pasar por el mismo pipeline de dedupe/emisión.

---

## 8) Código base (TypeScript)

**`src/index.ts`**

```ts
import Fastify from "fastify";
import accounts from "./routes/accounts";
import sync from "./routes/sync";
import webhook from "./routes/webhook-gc";
import { initRedis } from "./lib/redis";

const app = Fastify({ logger: true });
app.register(accounts, { prefix: "/v1" });
app.register(sync, { prefix: "/v1" });
app.register(webhook, { prefix: "/v1" });
app.get("/health", async () => ({ ok: true }));
app.get("/ready", async () => ({ ok: true }));

(async () => {
  await initRedis();
  await app.listen({ port: Number(process.env.PORT || 3000), host: "0.0.0.0" });
})();
```

**`src/routes/sync.ts`**

```ts
import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { startSync } from "../workers/syncRunner";

const plugin: FastifyPluginAsync = async (app) => {
  app.post("/sync/:accountId", async (req, res) => {
    const { accountId } = z.object({ accountId: z.string() }).parse(req.params);
    const op = await startSync(accountId);
    return res.code(202).send({ operationId: op });
  });
};
export default plugin;
```

**`src/workers/syncRunner.ts`** (esqueleto)

```ts
import { getCursor, setCursor, withAccountLock } from "../lib/cursor";
import { listTxPages } from "../lib/gcClient";
import { dedupe } from "../lib/dupe";
import { emit } from "../lib/events";
import { v4 as uuid } from "uuid";

export async function startSync(accountId: string) {
  return withAccountLock(accountId, async () => {
    const operationId = uuid();
    const cur = await getCursor(accountId);
    for await (const page of listTxPages(accountId, cur)) {
      for (const tx of page.items) {
        if (await dedupe(tx.externalRef)) {
          await emit("bank.tx.created", normalize(tx));
        }
      }
      await setCursor(accountId, page.nextCursor);
    }
    await emit("bank.sync.completed", { accountId, count: 0 });
    return operationId;
  });
}
```

---

## 9) Docker y Compose

**`Dockerfile`** (Node 20 + distroless)

```Dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json .
RUN npm ci --omit=dev
COPY . .
RUN npm run build

FROM gcr.io/distroless/nodejs20-debian12
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
EXPOSE 3000
CMD ["dist/index.js"]
```

**`infrastructure/docker-compose.services.yml`**

```yaml
version: "3.9"
networks: { core_net: { external: true } }
services:
  bank-sync-service:
    build: ../services/bank-sync-service
    env_file: ../services/bank-sync-service/.env
    networks: [core_net]
    depends_on: [redis]
    volumes:
      - ../services/bank-sync-service/data:/app/data # si usás sqlite
    ports: ["4010:3000"] # opcional en dev
```

---

## 10) Makefile (targets útiles)

```makefile
include ../../makefiles/service.mk
SERVICE=bank-sync-service

.PHONY: logs tail sync
logs:
	docker logs -f bank-sync-service

tail:
	docker compose -f ../../infrastructure/docker-compose.services.yml logs -f bank-sync-service

sync:
	curl -s -XPOST http://localhost:4010/v1/sync/$$ACCOUNT_ID | jq
```

---

## 11) Métricas & Health

- `/health` y `/ready` → 200 OK.
- `/metrics` (Prometheus): `sync_requests_total`, `tx_emitted_total`, `dedupe_skipped_total`, `sync_duration_seconds`.

---

## 12) Testing

- **Unit**: normalizador, dedupe, cursor.
- **Contract**: Prism/Dredd contra `openapi.v1.yaml`.
- **E2E**: mock de GoCardless → POST `/webhook/gocardless` → esperar `bank.tx.created` en Redis → assert.

---

## 13) Troubleshooting

- **No avanza el sync**: revisar `gc:sync:lock:{accountId}` (lock colgado).
- **Duplicados**: confirmar `externalRef` estable; revisar `gc:tx:dedupe:*`.
- **Webhook 401/403**: clave `GC_WEBHOOK_SECRET` o header de firma.
- **Pérdida de estado**: habilitar Redis AOF; verificar persistencia de `data/` si usás DB.

---

## 14) Roadmap inmediato

- Implementar cliente GoCardless sandbox.
- Validar firma webhook + anti‑replay.
- Dedupe + cursor persistentes.
- Emitir eventos y pruebas E2E.
- Documentar credenciales y rotación de tokens/secrets en NAS.

---

> Con este bootstrap podés correr **bank‑sync‑service** hoy, enchufarlo a Redis y empezar a alimentar **finance‑service** sin tocar nada más. Cuando quieras, extendemos a otros proveedores (BBVA CSV/Nordigen, exchanges, etc.) reutilizando el mismo pipeline y contratos.
