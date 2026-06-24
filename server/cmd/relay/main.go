package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	_ "net/http/pprof"
	"os"
	"os/signal"
	"syscall"
	"time"
	"zooid/zooid"
)

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.Lshortfile)

	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, syscall.SIGINT, syscall.SIGTERM)

	port := zooid.Env("PORT")
	apiHost := zooid.Env("API_HOST")
	pprofAddr := zooid.Env("PPROF_ADDR")

	// pprof server — only starts when PPROF_ADDR is set. Bind to
	// 127.0.0.1:6060 (or similar) and tunnel via SSH; never expose publicly.
	if pprofAddr != "" {
		go func() {
			log.Printf("pprof listening on %s\n", pprofAddr)
			if err := http.ListenAndServe(pprofAddr, nil); err != nil {
				log.Printf("pprof server error: %v\n", err)
			}
		}()
	}

	// Create the main handler
	mainHandler := http.HandlerFunc(
		func(w http.ResponseWriter, r *http.Request) {
			instance, exists := zooid.Dispatch(r.Host)
			if exists {
				instance.Relay.ServeHTTP(w, r)
			} else {
				http.Error(w, "Not Found", http.StatusNotFound)
			}
		},
	)

	// Wrap with API handler if API_HOST is configured
	var handler http.Handler = mainHandler
	if apiHost != "" {
		apiHandler := zooid.NewAPIHandler()
		handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Check if this request is for the API host
			if r.Host == apiHost {
				apiHandler.ServeHTTP(w, r)
			} else {
				mainHandler.ServeHTTP(w, r)
			}
		})
	}

	srv := &http.Server{
		Addr:    fmt.Sprintf(":%s", port),
		Handler: handler,
	}

	go func() {
		log.Printf("running on :%s\n", port)
		if err := srv.ListenAndServe(); err != http.ErrServerClosed {
			log.Printf("HTTP server error: %v\n", err)
		}
	}()

	go zooid.Start()

	<-shutdown

	log.Println("\nShutting down gracefully...")

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("HTTP server shutdown error: %v\n", err)
	}
}
