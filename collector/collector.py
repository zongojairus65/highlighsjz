import asyncio
import aiohttp
import json
from datetime import datetime

import aioredis


class LiveScoreCollector:
    def __init__(self, redis_url="redis://localhost:6379"):
        self.redis = None
        self.session = None
        self.sources = [
            # Simule une source — à remplacer par API réelle
            {
                "url": "https://www.thesportsdb.com/api/v1/json/3/latestFootball.php",
                "parser": self._parse_thesportsdb,
            },
            {
                "url": "https://api.football-data.org/v4/matches",
                "headers": {"X-Auth-Token": "VOTRE_TOKEN"},  # ← à configurer
                "parser": self._parse_football_data,
            },
        ]

    async def start(self):
        self.redis = await aioredis.from_url(self.redis_url, decode_responses=True)
        self.session = aiohttp.ClientSession()
        print("[Collector] Démarré — cycle toutes les 10 secondes")

        while True:
            tasks = [self._fetch_source(src) for src in self.sources]
            await asyncio.gather(*tasks, return_exceptions=True)
            await asyncio.sleep(10)

    async def _fetch_source(self, source):
        try:
            async with self.session.get(
                source["url"], headers=source.get("headers", {}), timeout=10
            ) as resp:
                if resp.status != 200:
                    print(f"[Collector] HTTP {resp.status} — {source['url']}")
                    return
                data = await resp.json()
                matches = source["parser"](data)
                for match in matches:
                    await self._store_match(match)
        except Exception as e:
            print(f"[Collector] Erreur {source['url']}: {e}")

    def _parse_football_data(self, data):
        """Parse l'API football-data.org"""
        matches = []
        for m in data.get("matches", []):
            score = m.get("score", {}).get("fullTime", {})
            home_score = score.get("home")
            away_score = score.get("away")
            score_str = f"{home_score or '?'} - {away_score or '?'}"

            matches.append({
                "id": str(m["id"]),
                "home_team": m["homeTeam"]["name"],
                "away_team": m["awayTeam"]["name"],
                "score": score_str,
                "status": m["status"],
                "minute": m.get("minute", 0),
                "league": m.get("competition", {}).get("name", ""),
                "updated_at": datetime.utcnow().isoformat(),
            })
        return matches

    def _parse_thesportsdb(self, data):
        """Parse l'API TheSportsDB"""
        matches = []
        events = data.get("events", []) or data.get("event", [])
        for e in events:
            home = e.get("strHomeTeam", e.get("strTeam1", ""))
            away = e.get("strAwayTeam", e.get("strTeam2", ""))
            score = f"{e.get('intHomeScore', '?')} - {e.get('intAwayScore', '?')}"
            matches.append({
                "id": e.get("idEvent", str(hash(home + away))),
                "home_team": home,
                "away_team": away,
                "score": score,
                "status": e.get("strStatus", "LIVE"),
                "minute": int(e.get("intMinute", 0) or 0),
                "league": e.get("strLeague", ""),
                "updated_at": datetime.utcnow().isoformat(),
            })
        return matches

    async def _store_match(self, match):
        key = f"match:{match['id']}"
        await self.redis.setex(key, 180, json.dumps(match))   # TTL 3 min
        await self.redis.publish("live:matches", json.dumps(match))


async def main():
    collector = LiveScoreCollector()
    await collector.start()


if __name__ == "__main__":
    asyncio.run(main())
