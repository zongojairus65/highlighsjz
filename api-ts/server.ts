import express, { Request, Response } from 'express';
import { createClient, RedisClientType } from 'redis';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import http from 'http';

// ---------- Types ----------
interface Match {
    id: string;
    home_team: string;
    away_team: string;
    score: string;
    status: string;
    minute: number;
    league: string;
    updated_at: string;
}

// ---------- Redis ----------
const redis: RedisClientType = createClient();
redis.on('error', (err) => console.error('[Redis]', err));

async function connectRedis() {
    await redis.connect();
    console.log('[Redis] Connecté');
}

async function getAllMatches(): Promise<Match[]> {
    const keys = await redis.keys('match:*');
    if (keys.length === 0) return [];
    const raw = await redis.mGet(keys);
    return raw
        .filter((v): v is string => v !== null)
        .map((v) => JSON.parse(v) as Match);
}

async function getMatchById(id: string): Promise<Match | null> {
    const raw = await redis.get(`match:${id}`);
    return raw ? (JSON.parse(raw) as Match) : null;
}

// ---------- Express ----------
const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

// GET /api/matches
app.get('/api/matches', async (_req: Request, res: Response) => {
    try {
        const matches = await getAllMatches();
        res.json({ count: matches.length, matches });
    } catch (err) {
        res.status(500).json({ error: 'Erreur interne' });
    }
});

// GET /api/matches/:id
app.get('/api/matches/:id', async (req: Request, res: Response) => {
    try {
        const match = await getMatchById(req.params.id);
        if (!match) return res.status(404).json({ error: 'Match introuvable' });
        res.json(match);
    } catch (err) {
        res.status(500).json({ error: 'Erreur interne' });
    }
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws: WebSocket) => {
    console.log('[WS] Client connecté');

    const subscriber = redis.duplicate();
    subscriber.connect();
    subscriber.subscribe('live:matches', (message) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'LIVE_UPDATE', data: JSON.parse(message) }));
        }
    });

    ws.on('close', () => {
        subscriber.unsubscribe('live:matches');
        subscriber.quit();
        console.log('[WS] Client déconnecté');
    });
});

// ---------- Démarrage ----------
const PORT = process.env.PORT || 3000;

async function start() {
    await connectRedis();
    server.listen(PORT, () => {
        console.log(`[API] http://localhost:${PORT}/api/matches`);
        console.log(`[WS]  ws://localhost:${PORT}`);
    });
}

start();
