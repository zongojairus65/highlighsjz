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
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redis: RedisClientType = createClient({ url: redisUrl });

redis.on('error', (err) => {
    console.error('[Redis] Error:', err);
});

redis.on('connect', () => {
    console.log('[Redis] Connected');
});

// ---------- Express & WebSocket ----------
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());

// Store connected clients
const clients: Set<WebSocket> = new Set();

// WebSocket connection
wss.on('connection', (ws: WebSocket) => {
    console.log('[WS] New client connected');
    clients.add(ws);

    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data.toString());
            if (message.type === 'subscribe') {
                // Subscribe to Redis channel
                const subscriber = redis.duplicate();
                await subscriber.connect();
                
                subscriber.on('message', (channel, msg) => {
                    ws.send(JSON.stringify({
                        type: 'update',
                        data: JSON.parse(msg)
                    }));
                });

                await subscriber.subscribe(message.channel, (msg) => {
                    // Already handled in on('message')
                });
            }
        } catch (err) {
            console.error('[WS] Error:', err);
        }
    });

    ws.on('close', () => {
        console.log('[WS] Client disconnected');
        clients.delete(ws);
    });

    ws.on('error', (err) => {
        console.error('[WS] Error:', err);
    });
});

// REST API endpoints
app.get('/api/matches', async (req: Request, res: Response) => {
    try {
        const matches = await redis.get('matches');
        if (matches) {
            res.json(JSON.parse(matches));
        } else {
            res.json([]);
        }
    } catch (err) {
        console.error('[API] Error fetching matches:', err);
        res.status(500).json({ error: 'Failed to fetch matches' });
    }
});

app.post('/api/matches/update', async (req: Request, res: Response) => {
    try {
        const matches = req.body;
        await redis.set('matches', JSON.stringify(matches));
        
        // Notify WebSocket clients
        clients.forEach((client) => {
            if (client.readyState === 1) {
                client.send(JSON.stringify({
                    type: 'update',
                    data: matches
                }));
            }
        });

        res.json({ success: true });
    } catch (err) {
        console.error('[API] Error updating matches:', err);
        res.status(500).json({ error: 'Failed to update matches' });
    }
});

// Health check
app.get('/health', (req: Request, res: Response) => {
    res.json({ status: 'ok' });
});

// Connect Redis and start server
(async () => {
    try {
        await redis.connect();
        console.log('[Redis] Connected to Redis');
    } catch (err) {
        console.error('[Redis] Failed to connect:', err);
    }

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`[API] http://localhost:${PORT}/api/matches`);
        console.log(`[WS]  ws://localhost:${PORT}`);
    });
})();
