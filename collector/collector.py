import asyncio
import json
from datetime import datetime
import os
import redis.asyncio as aioredis
from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeout

class SofascoreScraper:
    """Scraper sofascore.com pour matchs en live"""
    
    async def fetch_live_matches(self):
        """Retourne les matchs en live depuis sofascore"""
        try:
            async with async_playwright() as p:
                browser = await p.chromium.launch(headless=True)
                page = await browser.new_page()
                
                await page.goto("https://www.sofascore.com/football", timeout=30000)
                await page.wait_for_timeout(5000)  # Attendre le rendu JS
                
                # Extraire les matchs du DOM
                matches_data = await page.evaluate("""
                    () => {
                        const matches = [];
                        document.querySelectorAll('[data-testid="event"]').forEach(el => {
                            const homeTeam = el.querySelector('[data-testid="home-team-name"]')?.textContent;
                            const awayTeam = el.querySelector('[data-testid="away-team-name"]')?.textContent;
                            const score = el.querySelector('[data-testid="score"]')?.textContent;
                            const status = el.querySelector('[data-testid="status"]')?.textContent;
                            
                            if (homeTeam && awayTeam && score) {
                                matches.push({
                                    home_team: homeTeam.trim(),
                                    away_team: awayTeam.trim(),
                                    score: score.trim(),
                                    status: status ? status.trim() : 'live',
                                    league: 'Mixed'
                                });
                            }
                        });
                        return matches;
                    }
                """)
                
                await browser.close()
                return matches_data
        except Exception as e:
            print(f"[Sofascore] Erreur: {e}")
            return []

class LivescoreScraper:
    """Scraper livescore.com pour matchs en live"""
    
    async def fetch_live_matches(self):
        """Retourne les matchs en live depuis livescore"""
        try:
            async with async_playwright() as p:
                browser = await p.chromium.launch(headless=True)
                page = await browser.new_page()
                
                await page.goto("https://www.livescore.com/", timeout=30000)
                await page.wait_for_timeout(5000)
                
                matches_data = await page.evaluate("""
                    () => {
                        const matches = [];
                        document.querySelectorAll('.ScoreTable_match').forEach(el => {
                            const home = el.querySelector('.ScoreTable_home .ScoreTable_teamName')?.textContent;
                            const away = el.querySelector('.ScoreTable_away .ScoreTable_teamName')?.textContent;
                            const score = el.querySelector('.ScoreTable_score')?.textContent;
                            
                            if (home && away && score) {
                                matches.push({
                                    home_team: home.trim(),
                                    away_team: away.trim(),
                                    score: score.trim(),
                                    status: 'live',
                                    league: 'Mixed'
                                });
                            }
                        });
                        return matches;
                    }
                """)
                
                await browser.close()
                return matches_data
        except Exception as e:
            print(f"[Livescore] Erreur: {e}")
            return []

class Scraper1xbet:
    """Scraper 1xbet.bf pour matchs en live"""
    
    async def fetch_live_matches(self):
        """Retourne les matchs en live depuis 1xbet"""
        try:
            async with async_playwright() as p:
                browser = await p.chromium.launch(headless=True)
                page = await browser.new_page()
                
                await page.goto("https://1xbet.bf/", timeout=30000)
                await page.wait_for_timeout(5000)
                
                matches_data = await page.evaluate("""
                    () => {
                        const matches = [];
                        document.querySelectorAll('.line-event').forEach(el => {
                            const home = el.querySelector('.team-home')?.textContent;
                            const away = el.querySelector('.team-away')?.textContent;
                            const score = el.querySelector('.event-score')?.textContent;
                            
                            if (home && away && score) {
                                matches.push({
                                    home_team: home.trim(),
                                    away_team: away.trim(),
                                    score: score.trim(),
                                    status: 'live',
                                    league: 'Mixed'
                                });
                            }
                        });
                        return matches;
                    }
                """)
                
                await browser.close()
                return matches_data
        except Exception as e:
            print(f"[1xbet] Erreur: {e}")
            return []

class LiveScoreCollector:
    def __init__(self):
        self.redis_url = os.getenv("REDIS_URL", "redis://localhost:6379")
        self.sofascore = SofascoreScraper()
        self.livescore = LivescoreScraper()
        self.oneXBet = Scraper1xbet()

    async def connect_redis(self):
        self.redis = await aioredis.from_url(self.redis_url)
        print(f"[Collector] Connecté à Redis")

    async def fetch_and_sync(self):
        while True:
            try:
                print("[Collector] Scraping des matchs en live...")
                
                # Scraper toutes les sources en parallèle
                sofascore_matches = await self.sofascore.fetch_live_matches()
                livescore_matches = await self.livescore.fetch_live_matches()
                oneXbet_matches = await self.oneXBet.fetch_live_matches()
                
                # Fusionner et dédupliquer
                all_matches = self.merge_and_deduplicate([
                    sofascore_matches,
                    livescore_matches,
                    oneXbet_matches
                ])
                
                if all_matches:
                    # Enrichir avec IDs
                    for i, match in enumerate(all_matches):
                        match["id"] = str(i + 1)
                        match["updated_at"] = datetime.utcnow().isoformat()
                    
                    await self.redis.set("matches", json.dumps(all_matches), ex=300)
                    print(f"[Collector] ✅ {len(all_matches)} matchs syncés")
                else:
                    print("[Collector] ⚠️ Aucun match trouvé")
                
                await asyncio.sleep(30)  # Sync toutes les 30 sec
            except Exception as e:
                print(f"[Collector] ❌ Erreur : {e}")
                await asyncio.sleep(30)

    def merge_and_deduplicate(self, sources):
        """Fusionne et déduplique les matchs de plusieurs sources"""
        seen = set()
        merged = []
        
        for source_matches in sources:
            for match in source_matches:
                key = f"{match['home_team']}_{match['away_team']}".lower()
                if key not in seen:
                    seen.add(key)
                    merged.append(match)
        
        return merged

async def main():
    collector = LiveScoreCollector()
    try:
        await collector.connect_redis()
        print("[Collector] 🚀 Démarrage du scraping...")
        await collector.fetch_and_sync()
    except Exception as e:
        print(f"[Collector] ❌ Erreur fatale: {e}")

if __name__ == "__main__":
    asyncio.run(main())
