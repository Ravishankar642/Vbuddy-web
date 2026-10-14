import { randomBytes } from "node:crypto";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { EFB_PREFIX } from "@vbuddy/protocol";
import type { Logger } from "../log.js";

const SESSION_MS = 12 * 3_600_000;
const MAX_SESSIONS = 20;
const MAX_BODY = 1024 * 1024;

/** The headers that say who is asking or where the page came from are rewritten for the EFB, which only knows its own address. */
const DROP_REQ = new Set(["host", "connection", "keep-alive", "upgrade", "transfer-encoding", "accept-encoding", "content-length", "cookie", "authorization", "origin", "referer"]);
const DROP_RES = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding", "content-security-policy", "content-security-policy-report-only", "x-frame-options", "set-cookie"]);

/**
 * Makes the Fenix EFB (a web app the Fenix serves on this PC, normally on port 8083) available through VBuddy, under
 * /efb/<session>/, so it works from a tablet or phone on any network, including through the cloud relay.
 *
 * The page is rewritten as it passes: addresses that start with "/" gain the session prefix, and a small script makes
 * everything the page opens later (fetch, XHR, WebSockets, event streams, and addresses that name the EFB's own port)
 * go back through the same prefix. The session token is the only thing that lets a browser in, and only a trusted
 * device (this PC, or a paired one) is given one.
 */
export class EfbProxy {
  private sessions = new Map<string, number>();
  private seenBad = new Set<string>();
  private wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

  constructor(
    private port: () => number,
    private log: Logger,
    private now: () => number = Date.now,
  ) {}

  /** A new session: the path the EFB is reached at. */
  mint(): string {
    const t = this.now();
    for (const [k, exp] of this.sessions) if (exp < t) this.sessions.delete(k);
    while (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value as string);
    const token = randomBytes(24).toString("base64url");
    this.sessions.set(token, t + SESSION_MS);
    return `${EFB_PREFIX}${token}/`;
  }

  private parse(url: string): { token: string; rest: string } | null {
    if (!url.startsWith(EFB_PREFIX)) return null;
    const m = /^\/efb\/([A-Za-z0-9_-]{20,})(\/.*)?$/.exec(url.split("?")[0]!);
    if (!m) return null;
    const exp = this.sessions.get(m[1]!);
    if (exp === undefined || exp < this.now()) return null;
    this.sessions.set(m[1]!, this.now() + SESSION_MS);
    const q = url.indexOf("?");
    return { token: m[1]!, rest: (m[2] ?? "/") + (q >= 0 ? url.slice(q) : "") };
  }

  /** Is the EFB's own server answering on this PC? */
  probe(): Promise<boolean> {
    return new Promise((done) => {
      const req = httpRequest({ host: "127.0.0.1", port: this.port(), method: "HEAD", path: "/", timeout: 1500 }, (res) => {
        res.resume();
        done(true);
      });
      req.on("timeout", () => req.destroy());
      req.on("error", () => done(false));
      req.end();
    });
  }

  /** Handles a request under /efb/. Returns false when the URL isn't one of ours. */
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = req.url ?? "/";
    if (!url.startsWith(EFB_PREFIX)) return false;
    const p = this.parse(url);
    if (!p) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end("This EFB link has expired. Open the EFB again from VBuddy.");
      return true;
    }
    const prefix = `${EFB_PREFIX}${p.token}`;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !DROP_REQ.has(k) && !k.startsWith("x-vbuddy-") && !k.startsWith("x-forwarded") && k !== "x-real-ip" && k !== "forwarded") headers[k] = Array.isArray(v) ? v.join(", ") : v;
    headers["accept-encoding"] = "identity";
    headers.host = `127.0.0.1:${this.port()}`;
    if (req.headers.origin) headers.origin = `http://127.0.0.1:${this.port()}`;
    const up = httpRequest({ host: "127.0.0.1", port: this.port(), method: req.method, path: p.rest, headers, timeout: 30_000 }, (ur) => {
      const type = String(ur.headers["content-type"] ?? "");
      if ((ur.statusCode ?? 0) >= 400 && !this.seenBad.has(p.rest) && this.seenBad.size < 60) {
        this.seenBad.add(p.rest);
        this.log.warn(`EFB file not found or refused (${ur.statusCode}): ${p.rest.split("?")[0]}`);
      }
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(ur.headers)) {
        if (v === undefined || DROP_RES.has(k)) continue;
        out[k] = k === "location" && typeof v === "string" ? this.fixLocation(v, prefix) : v;
      }
      out["cache-control"] = "no-store";
      const rewrite = /text\/html/i.test(type) ? "html" : /text\/css/i.test(type) ? "css" : /javascript|ecmascript/i.test(type) ? "js" : null;
      if (!rewrite) {
        res.writeHead(ur.statusCode ?? 502, out);
        ur.pipe(res);
        return;
      }
      const chunks: Buffer[] = [];
      ur.on("data", (c: Buffer) => chunks.push(c));
      ur.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const body = Buffer.from(rewrite === "html" ? rewriteHtml(text, prefix, this.port()) : rewrite === "css" ? rewriteCss(text, prefix, this.port()) : rewriteJs(text, prefix, this.port()), "utf8");
        out["content-length"] = String(body.length);
        res.writeHead(ur.statusCode ?? 502, out).end(body);
      });
    });
    up.on("timeout", () => up.destroy(new Error("timed out")));
    up.on("error", (e) => {
      if (res.headersSent) return void res.destroy();
      this.log.debug(`EFB request failed: ${e.message}`);
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end(`Can't reach the Fenix EFB on this PC (port ${this.port()}). Load the Fenix A320 in the simulator and open its EFB.`);
    });
    res.on("close", () => up.destroy());
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        up.destroy();
        req.destroy();
      }
    });
    req.pipe(up);
    return true;
  }

  /** Handles a WebSocket under /efb/. Returns false when the URL isn't one of ours. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = req.url ?? "/";
    if (!url.startsWith(EFB_PREFIX)) return false;
    const p = this.parse(url);
    if (!p) {
      socket.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
      return true;
    }
    const protocols = String(req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const upstream = new WebSocket(`ws://127.0.0.1:${this.port()}${p.rest}`, protocols, { headers: { origin: `http://127.0.0.1:${this.port()}` }, handshakeTimeout: 8000 });
    const fail = () => socket.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n");
    upstream.once("error", fail);
    upstream.once("unexpected-response", fail);
    upstream.once("open", () => {
      upstream.off("error", fail);
      this.wss.handleUpgrade(req, socket, head, (client) => {
        const queue: Array<{ data: Buffer; bin: boolean }> = [];
        client.on("message", (data, bin) => upstream.readyState === WebSocket.OPEN ? upstream.send(data, { binary: bin }) : queue.push({ data: Buffer.from(data as Buffer), bin }));
        upstream.on("message", (data, bin) => client.readyState === WebSocket.OPEN && client.send(data, { binary: bin }));
        const closeBoth = (code: number) => {
          const c = code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000;
          if (client.readyState === WebSocket.OPEN) client.close(c);
          if (upstream.readyState === WebSocket.OPEN) upstream.close(c);
        };
        client.on("close", closeBoth);
        upstream.on("close", closeBoth);
        client.on("error", () => upstream.terminate());
        upstream.on("error", () => client.terminate());
      });
    });
    return true;
  }

  private fixLocation(loc: string, prefix: string): string {
    if (loc.startsWith("/") && !loc.startsWith("//")) return prefix + loc;
    try {
      const u = new URL(loc);
      if ((u.hostname === "127.0.0.1" || u.hostname === "localhost") && Number(u.port || 80) === this.port()) return prefix + u.pathname + u.search + u.hash;
    } catch {
      /* not an address: leave it */
    }
    return loc;
  }
}

const esc = (s: string) => s.replace(/[\\']/g, "\\$&");

/** The script that sends the page's own requests back through the prefix. Runs before anything else on the page. */
export function shim(prefix: string, port: number): string {
  return `(function(){var P='${esc(prefix)}',PORT='${port}';
function fx(u){try{if(u instanceof URL)u=u.href;if(typeof u!=='string')return u;
if(u.indexOf('//')===0)u=location.protocol+u;
if(u.charAt(0)==='/')return u.indexOf(P+'/')===0?u:P+u;
var a=new URL(u,location.href);
var own=a.origin===location.origin||a.port===PORT;
if(own&&a.pathname.indexOf(P+'/')!==0)return P+a.pathname+a.search+a.hash;
if(own)return a.pathname+a.search+a.hash;}catch(e){}return u;}
function wx(u){try{u=String(u);var a=new URL(u,location.href);var own=a.hostname===location.hostname||a.port===PORT||a.hostname==='127.0.0.1'||a.hostname==='localhost';
if(own&&(a.port===PORT||a.port===location.port||(!a.port&&!location.port))){var p=a.pathname.indexOf(P+'/')===0?a.pathname:P+a.pathname;
return (location.protocol==='https:'?'wss://':'ws://')+location.host+p+a.search;}}catch(e){}return u;}
function fa(u){return (typeof u==='string'&&u.charAt(0)==='/'&&u.indexOf('//')!==0)?fx(u):u;}
var AT={src:1,href:1,poster:1,action:1,data:1};
var sa=Element.prototype.setAttribute;Element.prototype.setAttribute=function(n,v){try{var l=String(n).toLowerCase();if(AT[l]||l==='xlink:href')v=fa(String(v));else if(l==='srcset')v=sx(String(v));}catch(e){}return sa.call(this,n,v);};
function sx(v){return v.replace(/(^|,)\\s*(\\/[^\\s,]+)/g,function(m,a,u){return a+' '+fx(u);});}
[[HTMLImageElement,'src'],[HTMLScriptElement,'src'],[HTMLSourceElement,'src'],[HTMLMediaElement,'src'],[HTMLIFrameElement,'src'],[HTMLLinkElement,'href'],[HTMLAnchorElement,'href'],[HTMLEmbedElement,'src'],[HTMLObjectElement,'data'],[HTMLInputElement,'src'],[HTMLVideoElement,'poster'],[window.SVGImageElement,'href']].forEach(function(p){try{var C=p[0];if(!C)return;var d=Object.getOwnPropertyDescriptor(C.prototype,p[1]);if(!d||!d.set)return;Object.defineProperty(C.prototype,p[1],{configurable:true,enumerable:d.enumerable,get:d.get,set:function(v){d.set.call(this,typeof v==='string'?fa(v):v);}});}catch(e){}});
try{var sp=Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype,'backgroundImage');if(sp&&sp.set)Object.defineProperty(CSSStyleDeclaration.prototype,'backgroundImage',{configurable:true,get:sp.get,set:function(v){sp.set.call(this,typeof v==='string'?v.replace(/url\\((['"]?)\\/(?!\\/)/g,'url($1'+P+'/'):v);}});}catch(e){}
var f=window.fetch;if(f)window.fetch=function(i,n){try{if(typeof i==='string'||i instanceof URL)i=fx(i);else if(i&&i.url)i=new Request(fx(i.url),i);}catch(e){}return f.call(this,i,n);};
var o=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=fx(u);return o.apply(this,arguments);};
var W=window.WebSocket;function WS(u,p){return p===undefined?new W(wx(u)):new W(wx(u),p);}WS.prototype=W.prototype;['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(function(k){WS[k]=W[k];});window.WebSocket=WS;
if(window.EventSource){var E=window.EventSource;window.EventSource=function(u,c){return new E(fx(u),c);};window.EventSource.prototype=E.prototype;}
var sb=navigator.sendBeacon;if(sb)navigator.sendBeacon=function(u,d){return sb.call(navigator,fx(u),d);};
var wo=window.open;window.open=function(u){arguments[0]=u?fx(u):u;return wo.apply(this,arguments);};
var Wk=window.Worker;if(Wk)window.Worker=function(u,o2){return new Wk(fx(u),o2);};
if(window===window.top){document.addEventListener('DOMContentLoaded',function(){try{var b=document.createElement('a');b.href=location.origin+'/#systems';b.textContent='\u2039 VBuddy';b.setAttribute('aria-label','Back to VBuddy');b.style.cssText='position:fixed;z-index:2147483647;top:calc(env(safe-area-inset-top,0px) + 8px);left:8px;padding:8px 14px;border-radius:999px;background:rgba(122,16,64,.92);color:#fff;font:600 14px system-ui,sans-serif;text-decoration:none;box-shadow:0 2px 10px rgba(0,0,0,.45);opacity:.9';document.body.appendChild(b);}catch(e){}});}
document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(a){var h=a.getAttribute('href');if(h&&h.charAt(0)==='/'&&h.indexOf(P+'/')!==0)a.setAttribute('href',P+h);}},true);
})();`;
}

/** Root-relative addresses in markup gain the prefix, and the shim goes first. */
export function rewriteHtml(html: string, prefix: string, port: number): string {
  const fixed = html
    .replace(/(\s(?:src|href|action|poster|data-src|formaction)\s*=\s*)(["'])\/(?!\/)/gi, `$1$2${prefix}/`)
    .replace(/url\(\s*(["']?)\/(?!\/)/gi, `url($1${prefix}/`)
    .replace(/(\ssrcset\s*=\s*)(["'])([^"']*)\2/gi, (_m, a: string, q: string, v: string) => `${a}${q}${v.replace(/(^|,)(\s*)\/(?!\/)/g, `$1$2${prefix}/`)}${q}`);
  // No <base>: the page already lives under the prefix, so relative addresses resolve correctly from wherever it is (a base at the root broke sub-pages).
  const own = ownAddresses(fixed, prefix, port);
  const inject = `<script>${shim(prefix, port)}</script>`;
  return /<head[^>]*>/i.test(own) ? own.replace(/<head[^>]*>/i, (m) => m + inject) : inject + own;
}

export function rewriteCss(css: string, prefix: string, port = 0): string {
  return ownAddresses(css.replace(/url\(\s*(["']?)\/(?!\/)/gi, `url($1${prefix}/`).replace(/@import\s+(["'])\/(?!\/)/gi, `@import $1${prefix}/`), prefix, port);
}

/** Script text: quoted root-absolute paths to pictures, fonts, sounds and data files gain the prefix (the rest is caught at run time by the shim). */
export function rewriteJs(js: string, prefix: string, port = 0): string {
  return ownAddresses(js.replace(/(["'`])\/(?!\/)([^"'`\s\\]*\.(?:png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|mp3|wav|ogg|mp4|webm|json|css))(\?[^"'`\s\\]*)?\1/gi, (_m, q: string, p: string, qs?: string) => `${q}${prefix}/${p}${qs ?? ""}${q}`), prefix, port);
}

/** Full http(s) addresses of the EFB itself (the PC's network address and its port) become paths under the prefix, so they work from outside the home network. */
export function ownAddresses(text: string, prefix: string, port: number): string {
  if (!port) return text;
  return text.replace(new RegExp(`https?:\\/\\/[A-Za-z0-9.\\-\\[\\]:]+?:${port}(?=[\\/"'\`\\s?#)]|$)`, "g"), prefix);
}
