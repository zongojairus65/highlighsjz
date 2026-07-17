import asyncio
import aiohttp
import json
from datetime import datetime
import redis.asyncio as aioredis

class LiveScoreCollector:
    def __init__(self):
        self.sources = [
            {
                "url": "https://www.thesportsdb.com/api/v1/json/3/latestFootball.php",
                "parser": self._parse_thesportsdb,
            }
        ]
        self.redis_url = "redis://localhost:6379"

    async def connect_redis(self):
        self.redis = await aioredis.from_url(self.redis_url)

    async def fetch_and_sync(self):
        async with aiohttp.ClientSession() as session:
            while True:
                try:
                    for source in self.sources:
                        async with session.get(source["url"]) as resp:
                            data = await resp.json()
                            matches = source["parser"](data)
                            
                            if matches:
                                await self.redis.set(
                                    "matches",
                                    json.dumps(matches),
                                    ex=300
                                )
                                print(f"[Collector] {len(matches)} matchs syncés")
                except Exception as e:
                    print(f"[Collector] Erreur : {e}")
                
                await asyncio.sleep(10)

    def _parse_thesportsdb(self, data):
        """Parse l'API TheSportsDB"""
        if "results" not in data:
            return []

        matches = []
        for match_data in data.get("results", []):
            match = {
                "id": match_data.get("idEvent"),
                "home_team": match_data.get("strHomeTeam"),
                "away_team": match_data.get("strAwayTeam"),
                "score": f"{match_data.get('intHomeScore', 0)}-{match_data.get('intAwayScore', 0)}",
                "status": "live" if match_data.get("strStatus") == "Live" else "scheduled",
                "minute": 0,
                "league": match_data.get("strLeague", "Unknown"),
                "updated_at": datetime.utcnow().isoformat(),
            }
            matches.append(match)

        return matches

async def main():
    collector = LiveScoreCollector()
    await collector.connect_redis()
    print("[Collector] Connecté à Redis")
    await collector.fetch_and_sync()

if __name__ == "__main__":
    asyncio.run(main())
