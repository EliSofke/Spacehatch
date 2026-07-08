//go:build js && wasm

// Package bridge adapts a JS duplex byte stream (a browser WebSocket to the
// worker /relay) into a Go net.Conn, so canonical Go libraries — dev-tunnels/go
// (SSH relay), grpc-go (agent), x/crypto/ssh (shell) — run unchanged on top.
// This ~1-file adapter is the only hand-rolled transport code in the endgame.
package bridge

import (
	"io"
	"net"
	"sync"
	"syscall/js"
	"time"
)

var uint8Array = js.Global().Get("Uint8Array")

// Conn is a net.Conn over a JS byte duplex. Outbound Write bytes go to a JS sink
// function; inbound bytes arrive via Push (called from JS) and buffer for Read.
type Conn struct {
	sink js.Value // JS: function(Uint8Array) -> void

	mu     sync.Mutex
	cond   *sync.Cond
	buf    []byte
	closed bool
	err    error
}

// NewConn wraps a JS sink function as a net.Conn.
func NewConn(sink js.Value) *Conn {
	c := &Conn{sink: sink}
	c.cond = sync.NewCond(&c.mu)
	return c
}

// Push delivers inbound bytes (from the JS WebSocket 'message' handler).
func (c *Conn) Push(data []byte) {
	c.mu.Lock()
	if !c.closed {
		c.buf = append(c.buf, data...)
		c.cond.Broadcast()
	}
	c.mu.Unlock()
}

// CloseWithError unblocks readers with a specific error (e.g. WS 'close'/'error').
func (c *Conn) CloseWithError(err error) {
	c.mu.Lock()
	if !c.closed {
		c.closed = true
		c.err = err
		c.cond.Broadcast()
	}
	c.mu.Unlock()
}

func (c *Conn) Read(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for len(c.buf) == 0 && !c.closed {
		c.cond.Wait()
	}
	if len(c.buf) == 0 {
		if c.err != nil {
			return 0, c.err
		}
		return 0, io.EOF
	}
	n := copy(p, c.buf)
	c.buf = c.buf[n:]
	return n, nil
}

func (c *Conn) Write(p []byte) (int, error) {
	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()
	if closed {
		return 0, net.ErrClosed
	}
	arr := uint8Array.New(len(p))
	js.CopyBytesToJS(arr, p)
	c.sink.Invoke(arr)
	return len(p), nil
}

func (c *Conn) Close() error {
	c.mu.Lock()
	if !c.closed {
		c.closed = true
		c.cond.Broadcast()
	}
	c.mu.Unlock()
	return nil
}

// net.Conn boilerplate. Deadlines are no-ops: the stream is reliable and callers
// (grpc-go, x/crypto/ssh) drive timeouts via context / keepalives instead.
type addr struct{}

func (addr) Network() string                       { return "js-ws" }
func (addr) String() string                        { return "relay" }
func (c *Conn) LocalAddr() net.Addr                 { return addr{} }
func (c *Conn) RemoteAddr() net.Addr                { return addr{} }
func (c *Conn) SetDeadline(t time.Time) error       { return nil }
func (c *Conn) SetReadDeadline(t time.Time) error   { return nil }
func (c *Conn) SetWriteDeadline(t time.Time) error  { return nil }

var _ net.Conn = (*Conn)(nil)
