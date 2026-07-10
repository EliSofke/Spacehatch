// Package sshshell runs an interactive SSH client over a byte stream (a
// tunnel-forwarded port) using canonical golang.org/x/crypto/ssh — replacing the
// hand-rolled SSH glue and openssh.js key handling. It generates the ephemeral
// key the agent registers, authenticates as the returned user, requests a pty +
// shell, and streams I/O to callbacks.
package sshshell

import (
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"io"
	"net"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// Key is an ephemeral SSH key: the signer authenticates the second SSH session,
// and Authorized is the OpenSSH authorized_keys line handed to StartRemoteServer.
type Key struct {
	Signer     ssh.Signer
	Authorized string
}

// GenerateKey creates an ed25519 keypair for the codespace SSH session.
func GenerateKey() (*Key, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		return nil, err
	}
	sshPub, err := ssh.NewPublicKey(pub)
	if err != nil {
		return nil, err
	}
	authorized := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(sshPub))) + " spacehatch"
	return &Key{Signer: signer, Authorized: authorized}, nil
}

// Shell is a live pty+shell over an SSH session.
type Shell struct {
	client  *ssh.Client
	session *ssh.Session
	stdin   io.WriteCloser
	// closing is set by Close() before we tear the session down, so the
	// session.Wait() monitor can tell our own teardown from a server-side end.
	// WASM is single-threaded, so a plain bool needs no synchronisation here.
	closing bool
}

type cbWriter struct{ onData func([]byte) }

func (w cbWriter) Write(p []byte) (int, error) {
	b := make([]byte, len(p))
	copy(b, p)
	w.onData(b)
	return len(p), nil
}

// Open runs an SSH client over conn: authenticate as user with key, request a
// pty (cols x rows), start a shell, and stream stdout/stderr to onData. onEnd,
// if non-nil, is called once when the interactive shell/channel ends and it was
// not our own Close() — this catches a server-side idle-shell timeout, which the
// connection-level keepalive cannot see.
func Open(conn net.Conn, user string, key *Key, cols, rows int, onData func([]byte), onEnd func(error)) (*Shell, error) {
	cfg := &ssh.ClientConfig{
		User:            user,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(key.Signer)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // host key is trusted at the tunnel layer
	}
	sconn, chans, reqs, err := ssh.NewClientConn(conn, "codespace:22", cfg)
	if err != nil {
		return nil, fmt.Errorf("ssh handshake: %w", err)
	}
	client := ssh.NewClient(sconn, chans, reqs)

	session, err := client.NewSession()
	if err != nil {
		client.Close()
		return nil, fmt.Errorf("ssh session: %w", err)
	}

	modes := ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 14400, ssh.TTY_OP_OSPEED: 14400}
	if err := session.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		session.Close()
		client.Close()
		return nil, fmt.Errorf("pty-req: %w", err)
	}

	stdin, err := session.StdinPipe()
	if err != nil {
		session.Close()
		client.Close()
		return nil, err
	}
	session.Stdout = cbWriter{onData}
	session.Stderr = cbWriter{onData}

	if err := session.Shell(); err != nil {
		session.Close()
		client.Close()
		return nil, fmt.Errorf("shell: %w", err)
	}

	sh := &Shell{client: client, session: session, stdin: stdin}
	if onEnd != nil {
		go func() {
			err := session.Wait() // returns when the shell/channel closes
			if !sh.closing {
				onEnd(err)
			}
		}()
	}
	return sh, nil
}

// Write sends input bytes to the remote shell.
func (s *Shell) Write(p []byte) error {
	_, err := s.stdin.Write(p)
	return err
}

// Resize updates the remote pty size (RFC 4254 window-change).
func (s *Shell) Resize(cols, rows int) error {
	return s.session.WindowChange(rows, cols)
}

// Ping measures the round-trip time of an SSH keepalive global request to the
// codespace sshd. This traverses the full transport path (browser → worker →
// relay → tunnel host → forwarded port → sshd) and back, without touching the
// interactive shell, so it isolates network + crypto latency from pty/shell
// processing. The request is a no-op the server replies to (or rejects — either
// reply completes the round trip).
func (s *Shell) Ping() (time.Duration, error) {
	start := time.Now()
	_, _, err := s.client.SendRequest("keepalive@openssh.com", true, nil)
	if err != nil {
		return 0, err
	}
	return time.Since(start), nil
}

// Close tears down the session and connection.
func (s *Shell) Close() error {
	s.closing = true
	if s.session != nil {
		s.session.Close()
	}
	if s.client != nil {
		return s.client.Close()
	}
	return nil
}
