package sshshell

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"net"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// A minimal SSH server that accepts the client's key, grants a pty + shell, and
// echoes input after a banner — enough to prove the client end-to-end.
func runEchoServer(conn net.Conn, clientKey ssh.PublicKey) {
	cfg := &ssh.ServerConfig{
		PublicKeyCallback: func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if bytes.Equal(key.Marshal(), clientKey.Marshal()) {
				return &ssh.Permissions{}, nil
			}
			return nil, fmt.Errorf("unknown key")
		},
	}
	_, hostPriv, _ := ed25519.GenerateKey(rand.Reader)
	hostSigner, _ := ssh.NewSignerFromKey(hostPriv)
	cfg.AddHostKey(hostSigner)

	sconn, chans, reqs, err := ssh.NewServerConn(conn, cfg)
	if err != nil {
		return
	}
	defer sconn.Close()
	go ssh.DiscardRequests(reqs)

	for nc := range chans {
		if nc.ChannelType() != "session" {
			nc.Reject(ssh.UnknownChannelType, "only sessions")
			continue
		}
		ch, requests, _ := nc.Accept()
		go func() {
			for req := range requests {
				switch req.Type {
				case "pty-req", "window-change":
					req.Reply(true, nil)
				case "shell":
					req.Reply(true, nil)
					go func() {
						ch.Write([]byte("welcome-to-codespace\r\n$ "))
						buf := make([]byte, 256)
						for {
							n, err := ch.Read(buf)
							if err != nil {
								return
							}
							ch.Write(buf[:n]) // echo
							if bytes.Contains(buf[:n], []byte("exit")) {
								ch.Close()
								return
							}
						}
					}()
				default:
					req.Reply(false, nil)
				}
			}
		}()
	}
}

func TestShellEchoOverPipe(t *testing.T) {
	key, err := GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	// A TCP loopback (buffered, full-duplex) — a bare net.Pipe deadlocks the
	// symmetric SSH handshake. In production the stream is the buffered bridge /
	// dev-tunnels copy, which behaves like TCP here.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		srv, err := ln.Accept()
		if err != nil {
			return
		}
		runEchoServer(srv, key.Signer.PublicKey())
	}()
	cli, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var out bytes.Buffer
	onData := func(b []byte) { mu.Lock(); out.Write(b); mu.Unlock() }

	sh, err := Open(cli, "vscode", key, 80, 24, onData)
	if err != nil {
		t.Fatal(err)
	}
	defer sh.Close()

	if err := sh.Resize(100, 30); err != nil {
		t.Fatalf("resize: %v", err)
	}
	if err := sh.Write([]byte("hello-shell\n")); err != nil {
		t.Fatalf("write: %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		s := out.String()
		mu.Unlock()
		if bytes.Contains([]byte(s), []byte("welcome-to-codespace")) && bytes.Contains([]byte(s), []byte("hello-shell")) {
			return // banner + echo received: pty+shell+I/O works
		}
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	t.Fatalf("did not observe banner + echo; got %q", out.String())
}
