import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { homedir, platform } from "node:os";
import { isAbsolute, resolve } from "node:path";

let server: ReturnType<typeof createServer> | undefined;
let baseUrl: string | undefined;
let token = "";
let latestCtx: ExtensionCommandContext | undefined;
let latestThemeCss = "";
let liveMessage: any;
let cachedMessages: ChatMessage[] = [];
let messageCacheDirty = true;
let agentWorking = false;
let broadcastTimer: ReturnType<typeof setTimeout> | undefined;
const editDiffCache = new Map<string, string>();
const eventClients = new Set<ServerResponse>();

type ChatMessage = { id: string; role: string; text: string; label?: string; toolTitle?: string; toolDiff?: string; thinking?: string; toolCalls?: ToolCall[] };
type ToolCall = { name?: string; arguments?: Record<string, any> };

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (part && typeof part === "object" && "type" in part) {
				const p = part as { type?: string; text?: unknown };
				if (p.type === "text" && typeof p.text === "string") return p.text;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function thinkingFromContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (part && typeof part === "object" && "type" in part) {
				const p = part as { type?: string; thinking?: unknown };
				if (p.type === "thinking" && typeof p.thinking === "string") return p.thinking;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function toolCallsFromContent(content: unknown): ToolCall[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap((part) => {
		if (!part || typeof part !== "object" || !("type" in part)) return [];
		const call = part as { type?: string; name?: string; arguments?: Record<string, any> };
		return call.type === "toolCall" ? [{ name: call.name, arguments: call.arguments ?? {} }] : [];
	});
}

function shortPath(value: unknown): string {
	if (typeof value !== "string" || !value) return "";
	const home = homedir().replaceAll("\\", "/");
	return value.replaceAll("\\", "/").replace(home, "~").replaceAll("/", "\\");
}

function toolTitle(name: string, args: Record<string, any> = {}): string {
	if (name === "read") {
		const start = Number(args.offset ?? args.start_line);
		const limit = Number(args.limit);
		const range = Number.isFinite(start) && start > 0 ? `:${start}${Number.isFinite(limit) && limit > 0 ? `-${start + limit - 1}` : ""}` : "";
		return `read ${shortPath(args.path)}${range}`.trim();
	}
	if (name === "edit" || name === "write") return `${name} ${shortPath(args.path)}`.trim();
	if (name === "bash" || name === "ctx_shell" || name === "lc_shell") return `${name} ${String(args.command ?? "").split(/\r?\n/)[0]}`.trim();
	return name || "tool";
}

function findStartLine(path: unknown, oldText: string, newText: string, cwd: string): number | undefined {
	if (typeof path !== "string") return undefined;
	try {
		const fullPath = isAbsolute(path) ? path : resolve(cwd, path);
		const content = readFileSync(fullPath, "utf8").replaceAll("\r\n", "\n");
		const needle = (newText || oldText).replaceAll("\r\n", "\n");
		const index = needle ? content.indexOf(needle) : -1;
		if (index < 0) return undefined;
		return content.slice(0, index).split("\n").length;
	} catch {
		return undefined;
	}
}

function numberedLines(prefix: "+" | "-", text: string, startLine?: number): string {
	return text.split(/\r?\n/).map((line, index) => {
		const number = startLine ? String(startLine + index).padStart(5, " ") : "     ";
		return `${prefix} ${number} ${line}`;
	}).join("\n");
}

function editDiff(args: Record<string, any> = {}, cwd = process.cwd()): string {
	if (!Array.isArray(args.edits)) return "";
	const cacheKey = JSON.stringify([cwd, args.path, args.edits]);
	const cached = editDiffCache.get(cacheKey);
	if (cached !== undefined) return cached;
	const diff = args.edits
		.map((edit: { oldText?: string; newText?: string }, index: number) => {
			const oldText = String(edit.oldText ?? "");
			const newText = String(edit.newText ?? "");
			const startLine = findStartLine(args.path, oldText, newText, cwd);
			const oldLines = numberedLines("-", oldText, startLine);
			const newLines = numberedLines("+", newText, startLine);
			return `@@ edit ${index + 1}${startLine ? `:${startLine}` : ""} @@\n${oldLines}\n${newLines}`;
		})
		.join("\n\n");
	editDiffCache.set(cacheKey, diff);
	return diff;
}

function chatMessageFromAgentMessage(message: { role?: string; content?: unknown }, id: string, label?: string): ChatMessage {
	return {
		id,
		role: message.role ?? "custom",
		text: textFromContent(message.content),
		label,
		thinking: thinkingFromContent(message.content),
		toolCalls: toolCallsFromContent(message.content),
	};
}

function rebuildMessages(ctx: ExtensionCommandContext): ChatMessage[] {
	const branch = ctx.sessionManager.getBranch();
	const calls = new Map<string, ToolCall>();
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const message = entry.message as { content?: unknown };
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			const call = part as { type?: string; id?: string; name?: string; arguments?: Record<string, any> };
			if (call.type === "toolCall" && call.id) calls.set(call.id, { name: call.name, arguments: call.arguments });
		}
	}
	return branch
		.filter((entry) => entry.type === "message")
		.map((entry) => {
			const message = entry.message as { role?: string; content?: unknown; toolCallId?: string; toolName?: string };
			const call = message.toolCallId ? calls.get(message.toolCallId) : undefined;
			const name = message.toolName ?? call?.name ?? "";
			const args = call?.arguments ?? {};
			return {
				...chatMessageFromAgentMessage(message, entry.id, ctx.sessionManager.getLabel(entry.id)),
				toolTitle: name ? toolTitle(name, args) : undefined,
				toolDiff: name === "edit" ? editDiff(args, ctx.cwd) : undefined,
			};
		})
		.filter((message) => message.text.trim() || message.thinking?.trim() || message.toolDiff?.trim() || message.toolCalls?.length);
}

function conversationTitle(ctx: ExtensionCommandContext): string {
	const named = ctx.sessionManager.getSessionName?.();
	if (named) return `Pi Reply — ${named}`;
	const firstUser = ctx.sessionManager.getBranch().find((entry) => {
		if (entry.type !== "message") return false;
		return (entry.message as { role?: string }).role === "user";
	}) as { message?: { content?: unknown } } | undefined;
	const text = textFromContent(firstUser?.message?.content).replace(/\s+/g, " ").trim();
	return `Pi Reply — ${text ? text.slice(0, 60) : ctx.sessionManager.getSessionId().slice(0, 8)}`;
}

function getMessages(ctx: ExtensionCommandContext): ChatMessage[] {
	if (messageCacheDirty) {
		cachedMessages = rebuildMessages(ctx);
		messageCacheDirty = false;
	}
	const messages = [...cachedMessages];
	if (liveMessage) {
		const live = chatMessageFromAgentMessage(liveMessage, "__live");
		const last = messages.at(-1);
		if ((live.text.trim() || live.thinking?.trim() || live.toolCalls?.length) && (!last || last.role !== live.role || last.text !== live.text)) messages.push(live);
	}
	return messages;
}

async function readJson(req: IncomingMessage): Promise<any> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	const body = Buffer.concat(chunks).toString("utf8");
	return body ? JSON.parse(body) : {};
}

function sendJson(res: ServerResponse, status: number, value: unknown) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(value));
}

function sendText(res: ServerResponse, status: number, value: string, contentType = "text/plain; charset=utf-8") {
	res.writeHead(status, { "content-type": contentType });
	res.end(value);
}

function authorized(req: IncomingMessage): boolean {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	return url.searchParams.get("token") === token;
}

function formatQuoteReply(items: Array<{ quote: string; reply: string }>, note: string): string {
	const blocks: string[] = [];
	for (const item of items) {
		const quote = item.quote.trim();
		const reply = item.reply.trim();
		if (!reply) continue;
		const lines: string[] = [];
		if (quote) lines.push("LLM:", quote.split(/\r?\n/).map((line) => `> ${line}`).join("\n"), "");
		lines.push("User:", reply);
		blocks.push(lines.join("\n").trim());
	}
	if (note.trim()) blocks.push(note.trim());
	return blocks.join("\n\n---\n\n").trim();
}

function ansiColor(styled: string, fallback: string): string {
	const rgb = styled.match(/(?:38|48);2;(\d+);(\d+);(\d+)m/);
	if (rgb) return `rgb(${rgb[1]}, ${rgb[2]}, ${rgb[3]})`;
	return fallback;
}

function resolveThemeValue(value: unknown, vars: Record<string, unknown>): string | undefined {
	if (typeof value === "string") {
		if (value === "") return undefined;
		if (value.startsWith("#") || value.startsWith("rgb")) return value;
		return resolveThemeValue(vars[value], vars);
	}
	return undefined;
}

function themeExportColors(ctx: ExtensionCommandContext): { pageBg?: string; cardBg?: string; infoBg?: string } {
	const sourcePath = ctx.ui.theme.sourcePath;
	if (!sourcePath) return {};
	try {
		const raw = JSON.parse(readFileSync(sourcePath, "utf8")) as { vars?: Record<string, unknown>; export?: Record<string, unknown> };
		const vars = raw.vars ?? {};
		return {
			pageBg: resolveThemeValue(raw.export?.pageBg, vars),
			cardBg: resolveThemeValue(raw.export?.cardBg, vars),
			infoBg: resolveThemeValue(raw.export?.infoBg, vars),
		};
	} catch {
		return {};
	}
}

function browserState(ctx: ExtensionCommandContext) {
	return { ok: true, title: conversationTitle(ctx), messages: getMessages(ctx), working: agentWorking };
}

function broadcastMessages() {
	if (!latestCtx) return;
	const payload = `event: messages\ndata: ${JSON.stringify(browserState(latestCtx))}\n\n`;
	for (const client of [...eventClients]) client.write(payload);
}

function scheduleBroadcast(ctx?: ExtensionCommandContext, delayMs = 75) {
	if (ctx) latestCtx = ctx;
	if (broadcastTimer) return;
	broadcastTimer = setTimeout(() => {
		broadcastTimer = undefined;
		broadcastMessages();
	}, delayMs);
}

function themeCss(ctx: ExtensionCommandContext): string {
	const theme = ctx.ui.theme;
	const fg = (token: string, fallback: string) => ansiColor(theme.getFgAnsi(token as any), fallback);
	const bg = (token: string, fallback: string) => ansiColor(theme.getBgAnsi(token as any), fallback);
	const exported = themeExportColors(ctx);
	const customBg = bg("customMessageBg", "#2d2838");
	return `
--accent: ${fg("accent", "#8abeb7")};
--border: ${fg("border", "#5f87ff")};
--border-accent: ${fg("borderAccent", "#00d7ff")};
--border-muted: ${fg("borderMuted", "#505050")};
--success: ${fg("success", "#b5bd68")};
--error: ${fg("error", "#cc6666")};
--warning: ${fg("warning", "#ffff00")};
--muted: ${fg("muted", "#808080")};
--dim: ${fg("dim", "#666666")};
--text: ${fg("text", "#d4d4d4")};
--thinking-text: ${fg("thinkingText", "#808080")};
--user-text: ${fg("userMessageText", "#d4d4d4")};
--custom-text: ${fg("customMessageText", "#d4d4d4")};
--custom-label: ${fg("customMessageLabel", "#9575cd")};
--tool-title: ${fg("toolTitle", "#d4d4d4")};
--tool-output: ${fg("toolOutput", "#808080")};
--heading: ${fg("mdHeading", "#f0c674")};
--link: ${fg("mdLink", "#81a2be")};
--link-url: ${fg("mdLinkUrl", "#666666")};
--code: ${fg("mdCode", "#8abeb7")};
--code-block: ${fg("mdCodeBlock", "#b5bd68")};
--code-block-border: ${fg("mdCodeBlockBorder", "#808080")};
--quote-text: ${fg("mdQuote", "#808080")};
--quote-border: ${fg("mdQuoteBorder", "#808080")};
--hr: ${fg("mdHr", "#808080")};
--list-bullet: ${fg("mdListBullet", "#8abeb7")};
--diff-add: ${fg("toolDiffAdded", "#b5bd68")};
--diff-del: ${fg("toolDiffRemoved", "#cc6666")};
--diff-context: ${fg("toolDiffContext", "#808080")};
--syntax-comment: ${fg("syntaxComment", "#6A9955")};
--syntax-keyword: ${fg("syntaxKeyword", "#569CD6")};
--syntax-function: ${fg("syntaxFunction", "#DCDCAA")};
--syntax-variable: ${fg("syntaxVariable", "#9CDCFE")};
--syntax-string: ${fg("syntaxString", "#CE9178")};
--syntax-number: ${fg("syntaxNumber", "#B5CEA8")};
--syntax-type: ${fg("syntaxType", "#4EC9B0")};
--syntax-operator: ${fg("syntaxOperator", "#D4D4D4")};
--syntax-punctuation: ${fg("syntaxPunctuation", "#D4D4D4")};
--thinking-off: ${fg("thinkingOff", "#505050")};
--thinking-minimal: ${fg("thinkingMinimal", "#6e6e6e")};
--thinking-low: ${fg("thinkingLow", "#5f87af")};
--thinking-medium: ${fg("thinkingMedium", "#81a2be")};
--thinking-high: ${fg("thinkingHigh", "#b294bb")};
--thinking-xhigh: ${fg("thinkingXhigh", "#d183e8")};
--bash-mode: ${fg("bashMode", "#b5bd68")};
--selected-bg: ${bg("selectedBg", "#3a3a4a")};
--user-bg: ${bg("userMessageBg", "#343541")};
--custom-bg: ${customBg};
--tool-pending-bg: ${bg("toolPendingBg", "#282832")};
--tool-success-bg: ${bg("toolSuccessBg", "#283228")};
--tool-error-bg: ${bg("toolErrorBg", "#3c2828")};
--theme-page-bg: ${exported.pageBg ?? customBg};
--theme-card-bg: ${exported.cardBg ?? customBg};
--page-bg: #1b1b1b;
--pane-bg: #1f1f1f;
--panel-bg: #232323;
--info-bg: ${exported.infoBg ?? bg("toolErrorBg", "#3c3728")};
`;
}

function appHtml() {
	return String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${latestCtx ? conversationTitle(latestCtx) : "Pi Reply"}</title>
<style>
:root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace; font-size: 14px; font-variant-ligatures: none; ${latestThemeCss} background: var(--page-bg); color: var(--text); }
body { margin: 0; display: grid; grid-template-columns: minmax(0, 1fr) 420px; height: 100vh; background: var(--page-bg); }
main { overflow-y: auto; overflow-x: hidden; padding: 14px; background: var(--pane-bg); min-width: 0; }
aside { padding: 14px; overflow: auto; background: var(--panel-bg); }
.msg { width: 100%; box-sizing: border-box; margin: 0 0 10px; padding: 10px; border-radius: 0; border: 0; line-height: 1.35; overflow-wrap: anywhere; }
.assistant { background: transparent; }
.user { background: var(--user-bg); color: var(--text); }
.toolResult { background: var(--tool-success-bg); }
.toolResult[open] { background: var(--tool-success-bg); }
.role { font-size: 12px; color: var(--muted); margin-bottom: 6px; user-select: none; text-transform: uppercase; letter-spacing: .04em; }
button { background: var(--tool-pending-bg); color: var(--text); border: 0; border-radius: 0; padding: 8px 10px; cursor: pointer; margin: 0 6px 8px 0; font: inherit; }
button:hover { background: var(--selected-bg); }
button:disabled { color: var(--dim); cursor: not-allowed; background: var(--tool-pending-bg); }
button.secondary { background: var(--tool-pending-bg); }
button.danger { background: var(--tool-error-bg); color: var(--error); }
#add-pop { display: none; position: fixed; z-index: 10; box-shadow: 0 8px 30px #000b; }
textarea { box-sizing: border-box; width: 100%; min-height: 74px; background: var(--page-bg); color: var(--text); border: 0; border-radius: 0; padding: 8px; font: inherit; }
textarea:focus { outline: 1px solid var(--accent); }
details.msg { white-space: normal; }
details.msg summary { cursor: pointer; color: var(--muted); }
.toolResult summary { color: var(--success); }
details.msg pre { white-space: pre-wrap; margin: 10px 0 0; }
.thinking { color: var(--thinking-text); background: var(--tool-pending-bg); padding: 8px; margin: 0 0 10px; font-style: italic; }
.diff { padding: 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
.diff-line.add { color: var(--diff-add); }
.diff-line.del { color: var(--diff-del); }
.diff-line { display: block; }
.md p { margin: 0 0 0.75em; }
.md h1, .md h2, .md h3 { margin: 0.4em 0; color: var(--heading); }
.md code { background: var(--tool-pending-bg); color: var(--code); border: 0; border-radius: 0; padding: 1px 4px; }
.md pre { background: var(--tool-pending-bg); color: var(--code-block); border: 0; border-radius: 0; padding: 10px; overflow: hidden; white-space: pre-wrap; overflow-wrap: anywhere; }
a { color: var(--link); }
.quote { border: 0; border-radius: 0; padding: 10px; margin: 10px 0; background: var(--custom-bg); }
.quote-head { display: flex; justify-content: space-between; gap: 8px; align-items: center; margin-bottom: 8px; color: var(--accent); font-size: 12px; }
.quote-text { font-size: 12px; color: var(--text); max-height: 120px; overflow-y: auto; overflow-x: hidden; white-space: pre-wrap; overflow-wrap: anywhere; border-left: 3px solid var(--quote-border); padding: 6px 0 6px 14px; margin: 0 0 10px 10px; background: var(--tool-pending-bg); }
.reply-label { display: block; color: var(--muted); font-size: 12px; margin: 8px 0 4px; }
.hint { color: var(--muted); font-size: 13px; margin-bottom: 10px; }
.working { color: var(--accent); font-size: 13px; margin: 0 0 10px; }
@media (max-width: 900px) { body { grid-template-columns: 1fr; } aside { border-top: 1px solid var(--border); } }
</style>
</head>
<body>
<main id="chat"></main>
<aside>
  <h2>Pi Reply</h2>
  <div class="hint">Highlight text in the chat, click the floating Add button, write a reply. Repeat, then Reply.</div>
  <button id="refresh" class="secondary" title="Refresh chat">↻</button><button id="clear" class="danger" title="Clear quotes">×</button>
  <div id="quotes"></div>
  <label>Extra note</label>
  <textarea id="note" placeholder="Ctrl+Enter sends all"></textarea>
  <p><button id="send" disabled>Reply</button></p>
  <div id="working" class="working" hidden><span id="working-frame">⠋</span> Working</div>
  <div id="status" class="hint"></div>
</aside>
<button id="add-pop">Add quote</button>
<script>
const token = new URLSearchParams(location.search).get('token');
const chat = document.getElementById('chat');
const quotes = document.getElementById('quotes');
const status = document.getElementById('status');
const working = document.getElementById('working');
const workingFrame = document.getElementById('working-frame');
const addPop = document.getElementById('add-pop');
const sendButton = document.getElementById('send');
const spinnerFrames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
let spinnerIndex = 0;
let spinnerTimer;
let items = [];
function updateSendState() {
  const hasUserText = Boolean(document.getElementById('note').value.trim()) || items.some(item => String(item.reply || '').trim());
  sendButton.disabled = !hasUserText;
}
function setWorking(on) {
  working.hidden = !on;
  if (!on) { clearInterval(spinnerTimer); spinnerTimer = undefined; return; }
  if (spinnerTimer) return;
  spinnerTimer = setInterval(() => {
    spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
    workingFrame.textContent = spinnerFrames[spinnerIndex];
  }, 80);
}
function esc(s) { return String(s || '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function md(s) {
  const tick = String.fromCharCode(96);
  const chunks = String(s || '').split(tick + tick + tick);
  const inlineCode = new RegExp(tick + '([^' + tick + ']+)' + tick, 'g');
  return chunks.map((chunk, i) => {
    if (i % 2) return '<pre><code>' + esc(chunk.replace(/^\w+\n/, '')) + '</code></pre>';
    return esc(chunk)
      .replace(/^(#{1,3})\s+(.+)$/gm, (_m, h, text) => '<h' + h.length + '>' + text + '</h' + h.length + '>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
      .replace(inlineCode, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\n\n+/g, '</p><p>')
      .replace(/\n/g, '<br>');
  }).join('').replace(/^(.+)$/s, '<p>$1</p>').replace(/<p>(\s*<h[1-3]>)/g, '$1').replace(/(<\/h[1-3]>\s*)<\/p>/g, '$1');
}
function isToolish(m) { return /tool/i.test(m.role) || /^(Run:|State:|Activity:|Mode:|Progress:|Started:|Updated:|Dir:|Output:)/m.test(m.text); }
function renderDiff(diff) {
  return '<div class="diff">' + String(diff || '').split(/\r?\n/).map(line => {
    const kind = line.startsWith('+') ? ' add' : line.startsWith('-') ? ' del' : '';
    return '<span class="diff-line' + kind + '">' + esc(line) + '</span>';
  }).join('') + '</div>';
}
function renderThinking(m) {
  return m.thinking ? '<details class="thinking"><summary>thinking</summary><div class="md">' + md(m.thinking) + '</div></details>' : '';
}
function renderToolCalls(m) {
  return (m.toolCalls || []).map((call, i) => {
    const args = call.arguments && Object.keys(call.arguments).length ? '<pre>' + esc(JSON.stringify(call.arguments, null, 2)) + '</pre>' : '';
    return '<details class="msg toolResult" data-id="' + esc(m.id + '-call-' + i) + '"><summary>calling ' + esc(call.name || 'tool') + '</summary>' + args + '</details>';
  }).join('');
}
function renderMessage(m) {
  const title = esc(m.role) + (m.label ? ' · ' + esc(m.label) : '');
  const firstLine = esc(String(m.text || '').trim().split(/\r?\n/)[0]?.slice(0, 90) || '(empty)');
  if (isToolish(m)) {
    const body = '<div class="md">' + md(m.text) + '</div>' + (m.toolDiff ? renderDiff(m.toolDiff) : '');
    return '<details class="msg ' + esc(m.role) + '" data-id="' + esc(m.id) + '"><summary>' + esc(m.toolTitle || 'tool output') + '</summary>' + body + '</details>'; 
  }
  if (m.role === 'user') return '<details class="msg user" data-id="' + esc(m.id) + '"><summary>' + title + ' · ' + firstLine + '</summary><div class="md">' + md(m.text) + '</div></details>';
  return '<section class="msg ' + esc(m.role) + '"><div class="role">' + title + '</div>' + renderThinking(m) + '<div class="md">' + md(m.text) + '</div>' + renderToolCalls(m) + '</section>'; 
}
function renderQuotes(focusIndex) {
  quotes.innerHTML = items.length
    ? items.map((item, i) => '<div class="quote"><div class="quote-head"><strong>LLM ' + (i + 1) + '</strong><button class="secondary" data-remove="' + i + '">Remove</button></div><div class="quote-text md">' + md(item.quote) + '</div><label class="reply-label">User:</label><textarea data-i="' + i + '" placeholder="Reply to this quote...">' + esc(item.reply || '') + '</textarea></div>').join('')
    : '<div class="hint">No quotes yet.</div>';
  quotes.querySelectorAll('textarea').forEach(t => t.oninput = () => { items[Number(t.dataset.i)].reply = t.value; updateSendState(); });
  quotes.querySelectorAll('button[data-remove]').forEach(b => b.onclick = () => { items.splice(Number(b.dataset.remove), 1); renderQuotes(); });
  updateSendState();
  if (focusIndex !== undefined) requestAnimationFrame(() => {
    const box = quotes.querySelector('textarea[data-i="' + focusIndex + '"]');
    box?.focus();
    box?.scrollIntoView({ block: 'center' });
  });
}
const rendered = new Map();
function messageSig(m) { return JSON.stringify([m.role, m.text, m.label, m.toolTitle, m.toolDiff, m.thinking, m.toolCalls]); }
function htmlForMessage(m) {
  const sig = messageSig(m);
  const cached = rendered.get(m.id);
  if (cached?.sig === sig) return cached.html;
  const html = renderMessage(m);
  rendered.set(m.id, { sig, html });
  return html;
}
function renderMessages(messages) {
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
  const openIds = new Set([...chat.querySelectorAll('details[data-id][open]')].map(el => el.dataset.id));
  const keepIds = new Set(messages.map(m => m.id));
  for (const id of rendered.keys()) if (!keepIds.has(id)) rendered.delete(id);
  messages.forEach((m, i) => {
    const html = htmlForMessage(m);
    const current = chat.children[i];
    if (current?.dataset?.id === m.id && current.dataset.sig === rendered.get(m.id).sig) return;
    const template = document.createElement('template');
    template.innerHTML = html;
    const next = template.content.firstElementChild;
    next.dataset.id = m.id;
    next.dataset.sig = rendered.get(m.id).sig;
    if (openIds.has(m.id) && next.tagName === 'DETAILS') next.setAttribute('open', '');
    current ? current.replaceWith(next) : chat.appendChild(next);
  });
  while (chat.children.length > messages.length) chat.lastElementChild.remove();
  requestAnimationFrame(() => { if (atBottom) chat.scrollTop = chat.scrollHeight; });
}
function applyState(data) {
  if (data.title) document.title = data.title;
  setWorking(Boolean(data.working));
  renderMessages(data.messages || []);
}
async function load() {
  const res = await fetch('/api/messages?token=' + encodeURIComponent(token));
  applyState(await res.json());
}
function addSelection() {
  const quote = String(getSelection()).trim();
  if (!quote) { status.textContent = 'No text selected.'; return; }
  items.push({ quote, reply: '' });
  renderQuotes(items.length - 1);
  addPop.style.display = 'none';
  status.textContent = 'Added quote.';
}
addPop.onclick = addSelection;
document.addEventListener('selectionchange', () => {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !chat.contains(sel.anchorNode)) { addPop.style.display = 'none'; return; }
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  addPop.style.left = Math.min(rect.right + 8, innerWidth - 120) + 'px';
  addPop.style.top = Math.max(rect.top - 4, 8) + 'px';
  addPop.style.display = 'block';
});
document.getElementById('refresh').onclick = load;
document.getElementById('note').oninput = updateSendState;
document.getElementById('clear').onclick = () => { items = []; document.getElementById('note').value = ''; renderQuotes(); };
document.addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.ctrlKey) {
    event.preventDefault();
    sendButton.click();
  }
});
document.getElementById('send').onclick = async () => {
  if (sendButton.disabled) return;
  const note = document.getElementById('note').value;
  const cleanItems = items.filter(item => String(item.reply || '').trim());
  const payload = { items: cleanItems, note };
  const res = await fetch('/api/send?token=' + encodeURIComponent(token), { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(payload) });
  const data = await res.json();
  status.textContent = data.ok ? '' : ('Error: ' + data.error);
  if (data.ok) {
    items = [];
    document.getElementById('note').value = '';
    getSelection()?.removeAllRanges();
    addPop.style.display = 'none';
    renderQuotes();
  }
};
load().catch(err => status.textContent = String(err));
const events = new EventSource('/api/events?token=' + encodeURIComponent(token));
events.addEventListener('messages', event => applyState(JSON.parse(event.data)));
events.onerror = () => setTimeout(() => load().catch(err => status.textContent = String(err)), 1000);
setInterval(() => load().catch(err => status.textContent = String(err)), 5000);
</script>
</body>
</html>`;
}

function openUrl(url: string) {
	const os = platform();
	const cmd = os === "win32" ? "cmd" : os === "darwin" ? "open" : "xdg-open";
	const args = os === "win32" ? ["/c", "start", "", url] : [url];
	spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

async function ensureServer(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<string> {
	latestCtx = ctx;
	messageCacheDirty = true;
	latestThemeCss = themeCss(ctx);
	if (server && baseUrl) return baseUrl;
	token = randomBytes(18).toString("hex");
	server = createServer(async (req, res) => {
		try {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			if (url.pathname === "/") return sendText(res, 200, appHtml(), "text/html; charset=utf-8");
			if (!authorized(req)) return sendJson(res, 403, { ok: false, error: "bad token" });
			if (url.pathname === "/api/events") {
				res.writeHead(200, {
					"content-type": "text/event-stream; charset=utf-8",
					"cache-control": "no-cache, no-transform",
					connection: "keep-alive",
				});
				eventClients.add(res);
				req.on("close", () => eventClients.delete(res));
				res.write(`event: messages\ndata: ${JSON.stringify(latestCtx ? browserState(latestCtx) : { ok: true, title: "Pi Reply", messages: [], working: agentWorking })}\n\n`);
				return;
			}
			if (url.pathname === "/api/messages") return sendJson(res, 200, latestCtx ? browserState(latestCtx) : { ok: true, title: "Pi Reply", messages: [], working: agentWorking });
			if (url.pathname === "/api/send" && req.method === "POST") {
				const body = await readJson(req);
				const text = formatQuoteReply(body.items ?? [], body.note ?? "");
				if (!text) return sendJson(res, 400, { ok: false, error: "nothing to send" });
				if (latestCtx?.isIdle()) pi.sendUserMessage(text);
				else pi.sendUserMessage(text, { deliverAs: "steer" });
				return sendJson(res, 200, { ok: true });
			}
			return sendJson(res, 404, { ok: false, error: "not found" });
		} catch (error) {
			return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	});

	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Could not bind Pi Reply server");
	baseUrl = `http://127.0.0.1:${address.port}/?token=${token}`;
	return baseUrl;
}

export default function (pi: ExtensionAPI) {
	const openReply = async (ctx: ExtensionCommandContext) => {
		const url = await ensureServer(pi, ctx);
		openUrl(url);
		ctx.ui.notify("Opened Pi Reply in browser", "info");
	};

	pi.registerCommand("reply", {
		description: "Open Pi Reply for the current chat",
		handler: async (_args, ctx) => openReply(ctx),
	});



	pi.on("message_start", (event, ctx) => {
		messageCacheDirty = true;
		liveMessage = event.message;
		agentWorking = true;
		scheduleBroadcast(ctx as ExtensionCommandContext, 0);
	});

	pi.on("message_update", (event, ctx) => {
		liveMessage = event.message;
		agentWorking = true;
		scheduleBroadcast(ctx as ExtensionCommandContext, 75);
	});

	pi.on("message_end", (event, ctx) => {
		messageCacheDirty = true;
		liveMessage = event.message;
		scheduleBroadcast(ctx as ExtensionCommandContext, 0);
	});

	for (const eventName of ["turn_start", "agent_start", "tool_execution_start", "tool_execution_update", "tool_call"] as const) {
		pi.on(eventName as any, (_event, ctx) => {
			if (eventName !== "tool_execution_update") messageCacheDirty = true;
			agentWorking = true;
			scheduleBroadcast(ctx as ExtensionCommandContext);
		});
	}
	for (const eventName of ["turn_end", "agent_end", "tool_execution_end", "tool_result", "session_tree"] as const) {
		pi.on(eventName as any, (_event, ctx) => {
			messageCacheDirty = true;
			liveMessage = undefined;
			agentWorking = false;
			scheduleBroadcast(ctx as ExtensionCommandContext);
		});
	}

	pi.on("session_shutdown", () => {
		for (const client of eventClients) client.end();
		eventClients.clear();
		server?.close();
		server = undefined;
		baseUrl = undefined;
	});
}
