import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const PORT = Number(process.env.PORT ?? 3001);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:5173';

const app = express();

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`[alto-people/api] listening on http://localhost:${PORT}`);
  console.log(`[alto-people/api] CORS origin: ${CORS_ORIGIN}`);
});
