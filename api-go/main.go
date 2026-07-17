package main

import (
"context"
"crypto/tls"
"encoding/json"
"log"
"net/http"
"os"
"strings"
"sync"
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
// Déterminer si TLS est needed (Upstash a "upstash.io" dans l'adresse)
useTLS := strings.Contains(redisAddr, "upstash.io")

opts := &redis.Options{
Addr: redisAddr,
}

if useTLS {
opts.TLSConfig = &tls.Config{
InsecureSkipVerify: false,
}
}

rdb := redis.NewClient(opts)
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
val, err := cs.rdb.Get(cs.ctx, key).Result()
if err != nil {
log.Printf("[Go] Erreur GET %s : %v", key, err)
continue
}

var m Match
if err := json.Unmarshal([]byte(val), &m); err != nil {
log.Printf("[Go] Erreur JSON %s : %v", key, err)
continue
}

local[m.ID] = &m
}

cs.mu.Lock()
cs.matches = local
cs.mu.Unlock()
}
}

func (cs *CacheService) GetMatches(w http.ResponseWriter, r *http.Request) {
cs.mu.RLock()
defer cs.mu.RUnlock()

w.Header().Set("Content-Type", "application/json")
matches := make([]*Match, 0, len(cs.matches))
for _, m := range cs.matches {
matches = append(matches, m)
}
json.NewEncoder(w).Encode(matches)
}

func (cs *CacheService) GetMatch(w http.ResponseWriter, r *http.Request) {
id := mux.Vars(r)["id"]

cs.mu.RLock()
defer cs.mu.RUnlock()

m, ok := cs.matches[id]
if !ok {
w.WriteHeader(http.StatusNotFound)
json.NewEncoder(w).Encode(map[string]string{"error": "not found"})
return
}

w.Header().Set("Content-Type", "application/json")
json.NewEncoder(w).Encode(m)
}

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
ReadTimeout:  15 * time.Second,
WriteTimeout: 15 * time.Second,
}

log.Printf("[Go] Serveur sur :%s", port)
if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
log.Fatalf("[Go] Erreur serveur : %v", err)
}
}
