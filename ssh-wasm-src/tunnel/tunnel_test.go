package tunnel

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"io"
	"log"
	"net"
	"testing"
	"time"

	"github.com/microsoft/dev-tunnels/go/tunnels/ssh/messages"
	"golang.org/x/crypto/ssh"
)

// A mock dev-tunnels relay: an SSH server (none-auth) that accepts the control
// session and echoes on port-forward channels — enough to prove Connect +
// OpenPort + data round-trip over the injected conn.
func runMockRelay(conn net.Conn) {
	cfg := &ssh.ServerConfig{NoClientAuth: true}
	_, hostPriv, _ := ed25519.GenerateKey(rand.Reader)
	signer, _ := ssh.NewSignerFromKey(hostPriv)
	cfg.AddHostKey(signer)

	sconn, chans, reqs, err := ssh.NewServerConn(conn, cfg)
	if err != nil {
		return
	}
	defer sconn.Close()
	go ssh.DiscardRequests(reqs)

	for nc := range chans {
		switch nc.ChannelType() {
		case "session":
			ch, r, _ := nc.Accept()
			go ssh.DiscardRequests(r)
			go func() { io.Copy(io.Discard, ch) }()
		case messages.PortForwardChannelType:
			ch, r, _ := nc.Accept()
			go ssh.DiscardRequests(r)
			go func() { io.Copy(ch, ch) }() // echo
		default:
			nc.Reject(ssh.UnknownChannelType, "unsupported")
		}
	}
}

func TestTunnelOpenPortEcho(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		srv, err := ln.Accept()
		if err == nil {
			runMockRelay(srv)
		}
	}()
	cli, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := Connect(ctx, cli, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer c.Close()

	conn, err := c.OpenPort(ctx, 16634)
	if err != nil {
		t.Fatalf("OpenPort: %v", err)
	}
	if _, err := conn.Write([]byte("ping-16634")); err != nil {
		t.Fatalf("write: %v", err)
	}
	buf := make([]byte, len("ping-16634"))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(buf) != "ping-16634" {
		t.Fatalf("echo mismatch: %q", buf)
	}
}

func TestPortTrackerWait(t *testing.T) {
	pt := newPortTracker()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	go func() { time.Sleep(20 * time.Millisecond); pt.Add(2222) }()
	if err := pt.wait(ctx, 2222); err != nil {
		t.Fatalf("wait: %v", err)
	}
}
