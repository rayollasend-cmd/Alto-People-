import { env } from './config/env.js';
import { createApp } from './app.js';

const app = createApp();

app.listen(env.PORT, () => {
  console.log(`[alto-people/api] listening on http://localhost:${env.PORT}`);
  console.log(`[alto-people/api] CORS origin: ${env.CORS_ORIGIN}`);
});
