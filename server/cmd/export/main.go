package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"

	"fiatjaf.com/nostr"
	"zooid/zooid"
)

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.Lshortfile)

	var (
		relay = flag.String("relay", "", "Relay name (required)")
	)
	flag.Parse()

	if *relay == "" {
		fmt.Fprintln(os.Stderr, "Error: --relay is required")
		flag.Usage()
		os.Exit(1)
	}

	name := zooid.ConfigNameFromId(*relay)
	path := zooid.ConfigPathFromName(name)
	config, err := zooid.LoadConfigFromPath(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	// Create event store
	events := &zooid.EventStore{
		Config: config,
		Schema: &zooid.Schema{Name: config.Schema},
	}

	// Initialize the event store
	if err := events.Init(); err != nil {
		log.Fatalf("Failed to initialize event store: %v", err)
	}

	// Query all events and output as JSONL
	count := 0
	filter := nostr.Filter{} // Empty filter matches all events

	for event := range events.QueryEvents(filter, 0) {
		jsonBytes, err := json.Marshal(event)
		if err != nil {
			log.Printf("Failed to marshal event %s: %v", event.ID.Hex(), err)
			continue
		}
		fmt.Println(string(jsonBytes))
		count++
	}

	fmt.Fprintf(os.Stderr, "Exported %d events\n", count)
}
