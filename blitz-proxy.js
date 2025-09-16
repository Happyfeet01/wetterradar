import express from 'express';
import cors from 'cors';
import { Client } from '@simonschick/blitzortungapi';

const app = express();
app.use(cors());

const bo = new Client();
const strikes = [];
const RETAIN_MS = 10 * 60 * 1000; // 10 Minuten aufbewahren

bo.on('strike', s => {
  strikes.push({ lat: s.lat, lon: s.lon, time: Date.now(), amp: s.amp });
});

setInterval(() => {
  const cutoff = Date.now() - RETAIN_MS;
  while (strikes.length && strikes[0].time < cutoff) strikes.shift();
}, 30_000);

app.get('/blitze', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Historie einmalig schicken
  res.write(`data: ${JSON.stringify({ type: 'init', strikes })}\n\n`);

  const onStrike = (s) => {
    const rec = { lat: s.lat, lon: s.lon, time: Date.now(), amp: s.amp };
    res.write(`data: ${JSON.stringify({ type: 'strike', strike: rec })}\n\n`);
  };
  bo.on('strike', onStrike);

  req.on('close', () => bo.off('strike', onStrike));
});

app.listen(9024, () => console.log('SSE auf http://localhost:9024/blitze'));
