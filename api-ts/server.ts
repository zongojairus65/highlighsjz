import express, { Request, Response } from 'express';
import { createClient, RedisClientType } from 'redis';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import http from 'http';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';

// ---------- Swagger Config ----------
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'LiveScore API',
      version: '1.0.0',
      description: 'API en temps réel pour les résultats de football avec WebSocket',
      contact: {
        name: 'zongojairus65',
        url: 'https://github.com/zongojairus65/highlighsjz'
      }
    },
    servers: [
      {
        url: process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000',
        description: 'Production Server'
      }
    ]
  },
  apis: ['./server.ts']
};

const swaggerDocs = swaggerJsdoc(swaggerOptions);

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

// Swagger UI
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));
app.get('/swagger.json', (req: Request, res: Response) => {
    res.json(swaggerDocs);
});

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

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Vérifier la santé du service
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Service actif
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: ok
 */
app.get('/health', (req: Request, res: Response) => {
    res.json({ status: 'ok' });
});

/**
 * @swagger
 * /api/matches:
 *   get:
 *     summary: Récupérer tous les matchs en direct
 *     tags: [Matches]
 *     responses:
 *       200:
 *         description: Liste des matchs
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: string
 *                     example: "1"
 *                   home_team:
 *                     type: string
 *                     example: "PSG"
 *                   away_team:
 *                     type: string
 *                     example: "OL"
 *                   score:
 *                     type: string
 *                     example: "2-1"
 *                   status:
 *                     type: string
 *                     example: "live"
 *                   minute:
 *                     type: number
 *                     example: 45
 *                   league:
 *                     type: string
 *                     example: "Ligue 1"
 *                   updated_at:
 *                     type: string
 *                     example: "2026-07-16T23:53:00Z"
 *       500:
 *         description: Erreur serveur
 */
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

/**
 * @swagger
 * /api/matches/update:
 *   post:
 *     summary: Mettre à jour les matchs (notifie WebSocket)
 *     tags: [Matches]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: array
 *             items:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                 home_team:
 *                   type: string
 *                 away_team:
 *                   type: string
 *                 score:
 *                   type: string
 *                 status:
 *                   type: string
 *                 minute:
 *                   type: number
 *                 league:
 *                   type: string
 *                 updated_at:
 *                   type: string
 *     responses:
 *       200:
 *         description: Matchs mis à jour
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *       500:
 *         description: Erreur serveur
 */
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
        console.log(`[Docs] http://localhost:${PORT}/docs`);
        console.log(`[WS]  ws://localhost:${PORT}`);
    });
})();
