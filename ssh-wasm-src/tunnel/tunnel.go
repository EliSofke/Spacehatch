// Package tunnel drives the dev-tunnels relay from the browser without the SDK's
// built-in WebSocket dialer (which needs raw sockets). It injects a caller-
// provided net.Conn (the JS WebSocket bridge) into the SDK's canonical SSH relay
// session and port-forwarding, so only ~1 tiny adapter is hand-rolled: a
// portForwardingManager (one method) and an ssh.Channel->net.Conn shim.
package tunnel

import (
	"context"
	"fmt"
	"log"
	"net"
	"sync"
	"time"

	tunnelssh "github.com/microsoft/dev-tunnels/go/tunnels/ssh"
	"github.com/microsoft/dev-tunnels/go/tunnels/ssh/messages"
	"golang.org/x/crypto/ssh"
)

// portTracker implements the SDK's portForwardingManager (single Add method) and
// lets callers wait for a port to be forwarded by the host.
type portTracker struct {
	mu      sync.Mutex
	ports   map[uint16]bool
	waiters map[uint16][]chan struct{}
}

func newPortTracker() *portTracker {
	return &portTracker{ports: map[uint16]bool{}, waiters: map[uint16][]chan struct{}{}}
}

// Add is called by the SDK when the host forwards a port.
func (p *portTracker) Add(port uint16) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ports[port] = true
	for _, ch := range p.waiters[port] {
		close(ch)
	}
	delete(p.waiters, port)
}

func (p *portTracker) wait(ctx context.Context, port uint16) error {
	p.mu.Lock()
	if p.ports[port] {
		p.mu.Unlock()
		return nil
	}
	ch := make(chan struct{})
	p.waiters[port] = append(p.waiters[port], ch)
	p.mu.Unlock()
	select {
	case <-ch:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Client is a connected tunnel relay client.
type Client struct {
	sess *tunnelssh.ClientSSHSession
	pf   *portTracker
}

// Connect runs the dev-tunnels SSH relay session over the provided conn (the
// browser WebSocket bridge). The tunnel access token was already presented at
// the WebSocket handshake, so the SSH layer uses "none" auth.
func Connect(ctx context.Context, conn net.Conn, logger *log.Logger) (*Client, error) {
	pf := newPortTracker()
	sess := tunnelssh.NewClientSSHSession(conn, pf, false, logger)
	if err := sess.Connect(ctx); err != nil {
		return nil, fmt.Errorf("relay ssh connect: %w", err)
	}
	c := &Client{sess: sess, pf: pf}
	// Keep the relay session alive at the SSH session level. The inner OpenSSH
	// keepalive already sends port-forward channel data, but some relays only
	// reset their idle timer on session-level requests, so send one of those too.
	// Stops when the request errors (session gone).
	go c.keepAlive()
	return c, nil
}

// keepAlive sends a periodic session-level global request so the relay does not
// treat the tunnel as idle. The relay may answer with a request-failure (that is
// fine — any reply proves liveness); we only stop on a transport error.
func (c *Client) keepAlive() {
	for {
		time.Sleep(20 * time.Second)
		if _, _, err := c.sess.SendSessionRequest("keepalive@openssh.com", true, nil); err != nil {
			return
		}
	}
}

// WaitForPort blocks until the host forwards the given port (or ctx is done).
func (c *Client) WaitForPort(ctx context.Context, port uint16) error {
	return c.pf.wait(ctx, port)
}

// RefreshPorts asks the host to re-publish its forwarded ports (gh does this
// before connecting to an agent-started port).
func (c *Client) RefreshPorts() error {
	ok, _, err := c.sess.SendSessionRequest("RefreshPorts", true, nil)
	if err != nil {
		return fmt.Errorf("RefreshPorts: %w", err)
	}
	if !ok {
		return fmt.Errorf("RefreshPorts refused")
	}
	return nil
}

// OpenPort opens a streaming channel to a forwarded port and returns it as a
// net.Conn suitable for grpc-go and x/crypto/ssh.
func (c *Client) OpenPort(ctx context.Context, port uint16) (net.Conn, error) {
	pfc := messages.NewPortForwardChannel(c.sess.NextChannelID(), "127.0.0.1", uint32(port), "", 0)
	data, err := pfc.Marshal()
	if err != nil {
		return nil, err
	}
	ch, err := c.sess.OpenChannel(ctx, pfc.Type(), data)
	if err != nil {
		return nil, fmt.Errorf("open forwarded port %d: %w", port, err)
	}
	return &chanConn{Channel: ch}, nil
}

// Close tears down the relay session.
func (c *Client) Close() error { return c.sess.Close() }

// chanConn adapts an ssh.Channel (io.ReadWriteCloser) to net.Conn.
type chanConn struct{ ssh.Channel }

type connAddr struct{}

func (connAddr) Network() string                      { return "tunnel" }
func (connAddr) String() string                       { return "forwarded" }
func (chanConn) LocalAddr() net.Addr                  { return connAddr{} }
func (chanConn) RemoteAddr() net.Addr                 { return connAddr{} }
func (chanConn) SetDeadline(t time.Time) error        { return nil }
func (chanConn) SetReadDeadline(t time.Time) error    { return nil }
func (chanConn) SetWriteDeadline(t time.Time) error   { return nil }

var _ net.Conn = (*chanConn)(nil)
