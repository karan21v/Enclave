import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { prisma } from "./db.js";
import { newRoomId } from "./ids.js";
import { exportTranscript, proveEvent } from "./transcript.js";
import { attachWebSockets } from "./ws.js";

const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });
const PORT = Number(process.env.PORT ?? 3001);

// client and api on one origin, because the client already assumes it --
// sync.ts builds its socket url off location.host. two hosts would mean CORS,
// absolute urls, and a websocket crossing origins. vite's proxy does this in
// dev, this does it in prod.
const WEB_DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));

app.get("/health", async () => {
  await prisma.$queryRaw`SELECT 1`;
  return { ok: true };
});

app.post("/api/rooms", async () => {
  const room = await prisma.room.create({ data: { id: newRoomId() } });
  return { id: room.id };
});

app.get<{ Params: { id: string } }>("/api/rooms/:id", async (req, reply) => {
  const room = await prisma.room.findUnique({ where: { id: req.params.id } });
  if (!room) return reply.code(404).send({ error: "no such room" });
  return { id: room.id, createdAt: room.createdAt };
});

// The full log plus the root we claim for it. Feed this to
// tools/verify-transcript.mjs, which recomputes both and needs nothing from us.
app.get<{ Params: { id: string } }>("/api/rooms/:id/transcript", async (req, reply) => {
  const room = await prisma.room.findUnique({ where: { id: req.params.id } });
  if (!room) return reply.code(404).send({ error: "no such room" });

  return exportTranscript(req.params.id);
});

// One event, proven against the root, without disclosing the rest of the log.
app.get<{ Params: { id: string; seq: string } }>(
  "/api/rooms/:id/proof/:seq",
  async (req, reply) => {
    const seq = Number(req.params.seq);
    if (!Number.isInteger(seq) || seq < 0) {
      return reply.code(400).send({ error: "seq must be a non-negative integer" });
    }

    const proof = await proveEvent(req.params.id, seq);
    if (!proof) return reply.code(404).send({ error: "no such event" });

    return proof;
  },
);

// after the api routes, so nothing in here can shadow /api or /health. no dist
// in dev, vite serves the client then.
async function serveClient() {
  if (!existsSync(WEB_DIST)) {
    app.log.warn(`no client build at ${WEB_DIST}, serving API only`);
    return;
  }

  await app.register(fastifyStatic, { root: WEB_DIST });

  // /room/<id> is client-side routing, not a file on disk. anything that isn't
  // an api route and didn't match an asset gets index.html and lets the app
  // read the path itself -- along with the fragment, which never got here.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/") || req.url.startsWith("/ws")) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.sendFile("index.html");
  });
}

async function main() {
  await serveClient();
  await app.listen({ port: PORT, host: "0.0.0.0" });

  // has to be after listen(), app.server isn't bound until then
  attachWebSockets(app.server);
  app.log.info("websocket relay up");
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
