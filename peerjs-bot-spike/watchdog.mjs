// DS-side client for the AMS local watchdog. Node port of the proven Go client
// (custom-extend-app/ethan-chess-service/cmd/bot-ds/watchdog.go).
//
// The DS connects over WebSocket (default ws://localhost:5555/watchdog),
// announces "ready" once it can serve, sends a "heartbeat" at least every 15s to
// stay healthy, and reacts to "drain" (AMS asking it to wind down). Messages are
// JSON objects keyed by type with an object value: {"ready":{}}, {"heartbeat":{}},
// and (inbound) {"drain":{...}}.
import { WebSocket } from 'ws'

const ts = () => new Date().toISOString().slice(11, 19)
const wlog = (...a) => console.log(ts(), '[watchdog]', ...a)

export class Watchdog {
  constructor(url, dsid) {
    this.url = url || process.env.AMS_WATCHDOG_URL || 'ws://localhost:5555/watchdog'
    // AMS ties the watchdog socket to this server via the ams-dsid header. Without
    // it the socket connects but "ready" is ignored → the server never leaves
    // Creating and AMS reaps it with CreationTimeout.
    this.dsid = dsid || process.env.DS_ID || ''
    this.ws = null
    this.closed = false
    this.onDrain = null
    this.hbTimer = null
  }

  // Dial the watchdog. Resolves once the socket is open; rejects if unreachable
  // (e.g. local dev with no amssim), letting the caller run standalone.
  connect() {
    return new Promise((resolve, reject) => {
      const opts = this.dsid ? { headers: { 'ams-dsid': this.dsid } } : {}
      const ws = new WebSocket(this.url, opts)
      let settled = false
      ws.on('open', () => {
        this.ws = ws
        settled = true
        wlog('connected', this.url, this.dsid ? '(dsid ' + this.dsid.slice(0, 12) + '…)' : '(no dsid)')
        resolve()
      })
      ws.on('message', (data) => this._onMessage(data))
      ws.on('error', (e) => {
        if (!settled) { settled = true; reject(e) }
        else wlog('error:', e?.message || e)
      })
      ws.on('close', () => { if (settled) wlog('connection closed') })
      setTimeout(() => { if (!settled) { settled = true; reject(new Error('watchdog connect timeout')) } }, 8000)
    })
  }

  _send(type) {
    if (!this.ws || this.closed || this.ws.readyState !== WebSocket.OPEN) return
    try { this.ws.send(JSON.stringify({ [type]: {} })) } catch (e) { wlog('send', type, 'failed:', e?.message || e) }
  }

  // Tell the watchdog the DS can now be allocated to a session.
  sendReady() { this._send('ready') }

  // Optionally extend the session timeout (e.g. a long game).
  resetSessionTimeout() { this._send('resetSessionTimeout') }

  // Send a heartbeat now and then every `everyMs` (AMS requires <=15s).
  startHeartbeat(everyMs = 5000) {
    this._send('heartbeat')
    this.hbTimer = setInterval(() => this._send('heartbeat'), everyMs)
    if (this.hbTimer.unref) this.hbTimer.unref()
  }

  _onMessage(data) {
    let msg
    try { msg = JSON.parse(data.toString()) } catch { return }
    wlog('<-', data.toString().slice(0, 200))
    if (msg && Object.prototype.hasOwnProperty.call(msg, 'drain')) {
      wlog('drain received')
      if (this.onDrain) this.onDrain(msg.drain)
    }
  }

  close() {
    this.closed = true
    if (this.hbTimer) clearInterval(this.hbTimer)
    if (this.ws) { try { this.ws.close() } catch {} }
  }
}
