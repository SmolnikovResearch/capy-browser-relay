// Command fakeext runs the fake extension against a relay, for manual and
// agent-client smoke tests. It seeds a few tabs and answers commands.
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"

	"capybrowserrelay/internal/fakeext"
)

func main() {
	base := flag.String("relay", "http://127.0.0.1:8787", "relay base URL")
	code := flag.String("code", "", "one-time pairing code")
	name := flag.String("name", "fake-laptop", "device name")
	flag.Parse()
	x := fakeext.New(*base).UseKey()
	if s, err := x.Pair(*code, *name); err != nil || s != 201 {
		log.Fatalf("pair failed: status=%d err=%v", s, err)
	}
	x.AddTab("https://example.com/", "Example Domain", "Example Domain. This domain is for use in illustrative examples.")
	x.AddTab("https://example.com/form", "Form", "Search form. Fields: #q")
	x.AddTab("https://secret.invalid/", "Not allowed", "must never be visible")
	if err := x.Connect(); err != nil {
		log.Fatal(err)
	}
	fmt.Printf("paired as device %s, connected\n", x.DeviceID)
	c := make(chan os.Signal, 1)
	signal.Notify(c, os.Interrupt)
	select {
	case <-c:
	case <-x.Closed():
		log.Print("relay closed the connection")
	}
}
