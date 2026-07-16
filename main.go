package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/go-redis/redis/v8"
	"github.com/gorilla/mux"
)

type Match struct {
	ID        string `json:"id"`
	HomeTeam  string `json:"home_team"`
	AwayTeam  string `json:"away_team"`
	Score     string `json:"score"`
	Status    string `json:"status"`
	Minute    int    `json:"minute"`
	League    string `json:"league"`
	UpdatedAt string `json:"updated_at"`
}

type CacheService struct {
	mu      sync.RWMutex
	matches map[string]*Match
	rdb     *redis.Client
	ctx     context.Context
}

func NewCacheService(redisAddr string) *CacheService {
	rdb := redis.NewClient(&redis.Options{
		Addr: redisAddr,
	})
	return &CacheService{
		matches: make(map[string]*Match),
		rdb:     rdb,
		ctx:     context.Background(),
	}
}

// SyncFromRedis - boucle qui synchronise le cache local depuis Redis
func (cs *CacheService) SyncFromRedis() {
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()

	log.Println("[Go] Sync Redis démarrée (intervalle 3s)")

	for range ticker.C {
		keys, err := cs.rdb.Keys(cs.ctx, "match:*").Result()
		if err != nil {
			log.Printf("[Go] Erreur KEYS : %v", err)
			continue
		}

		local := make(map[string]*Match, len(keys))

		for _, key := range keys {
			data, err := cs.rdb.Get(cs.ctx, key).Result()
			if err != nil {
				continue
			}
			var m Match
			if err := json.Unmarshal([]byte(data), &m); err != nil {
				continue
			}
			local[m.ID] = &m
		}

		cs.mu.Lock()
		cs.matches = local
		cs.mu.Unlock()
	}
}

// GET /api/matches
func (cs *CacheService) GetMatches(w http.ResponseWriter, r *http.Request) {
	cs.mu.RLock()
	defer cs.mu.RUnlock()

	matches := make([]*Match, 0, len(cs.matches))
	for _, m := range cs.matches {
		matches = append(matches, m)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"count":   len(matches),
		"matches": matches,
	})
}

// GET /api/matches/{id}
func (cs *CacheService) GetMatch(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	id := vars["id"]

	cs.mu.RLock()
	match, ok := cs.matches[id]
	cs.mu.RUnlock()

	if !ok {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": "Match introuvable"})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(match)
}

// Health check
func (cs *CacheService) Health(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func main() {
	redisAddr := os.Getenv("REDIS_ADDR")
	if redisAddr == "" {
		redisAddr = "localhost:6379"
	}

	cache := NewCacheService(redisAddr)
	go cache.SyncFromRedis()

	r := mux.NewRouter()
	r.HandleFunc("/api/matches", cache.GetMatches).Methods("GET")
	r.HandleFunc("/api/matches/{id}", cache.GetMatch).Methods("GET")
	r.HandleFunc("/health", cache.Health).Methods("GET")

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      r,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig
		log.Println("[Go] Arrêt...")
		srv.Shutdown(context.Background())
	}()

	log.Printf("[Go] Serveur sur :%s", port)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("[Go] Erreur serveur : %v", err)
	}
}
