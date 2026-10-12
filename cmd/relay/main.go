// Command relay runs the browser relay server. It does not terminate TLS:
// put a reverse proxy with HTTPS/WSS in front before exposing it.
package main

import (
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"time"

	"capybrowserrelay/internal/relay"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:8787", "listen address")
	data := flag.String("data", "./data", "state and audit directory")
	public := flag.Bool("allow-non-loopback", false, "allow binding a non-loopback address")
	flag.Parse()

	host, _, err := net.SplitHostPort(*listen)
	if err != nil {
		log.Fatal(err)
	}
	if ip := net.ParseIP(host); !*public && (ip == nil || !ip.IsLoopback()) && host != "localhost" {
		log.Fatalf("refusing to bind %s: pass -allow-non-loopback to expose the relay", *listen)
	}
	srv, err := relay.New(relay.Config{DataDir: *data, AdminToken: os.Getenv("RELAY_ADMIN_TOKEN")})
	if err != nil {
		log.Fatal(err)
	}
	if srv.NewAdminToken != "" {
		log.Printf("generated admin token (shown once): %s", srv.NewAdminToken)
	}
	hs := &http.Server{Addr: *listen, Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	log.Printf("capy-browser-relay listening on %s (plain HTTP, TLS must be terminated in front)", *listen)
	log.Fatal(hs.ListenAndServe())
}
