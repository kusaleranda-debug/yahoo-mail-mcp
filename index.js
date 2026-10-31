#!/usr/bin/env node
// Yahoo Mail MCP server
// Lets Claude list folders, search, read, move, flag and organise Yahoo Mail over IMAP.
// It never permanently deletes mail: "deleting" means moving to Trash.
//
// Credentials come from environment variables set in the Claude desktop config:
//   YAHOO_EMAIL         e.g. you@yahoo.com
//   YAHOO_APP_PASSWORD  a Yahoo *app password* (not your normal password)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { z } from "zod";

const EMAIL = process.env.YAHOO_EMAIL;
const APP_PASSWORD = process.env.YAHOO_APP_PASSWORD;
const HOST = process.env.YAHOO_IMAP_HOST || "imap.mail.yahoo.com";

if (!EMAIL || !APP_PASSWORD) {
  console.error("Missing YAHOO_EMAIL or YAHOO_APP_PASSWORD environment variable.");
  process.exit(1);
}

// Open a fresh IMAP connection for each request. Simple and robust:
// Yahoo drops idle connections, so we don't keep one open.
async function withClient(fn) {
  const client = new ImapFlow({
    host: HOST,
    port: 993,
    secure: true,
    auth: { user: EMAIL, pass: APP_PASSWORD },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
  }
}

async function withFolder(folder, fn) {
  return withClient(async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  });
}

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (err) => ({
  isError: true,
  content: [{ type: "text", text: `Error: ${err?.message || String(err)}` }],
});

function summarise(msg) {
  const env = msg.envelope || {};
  const from = (env.from || []).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");
  return {
    uid: msg.uid,
    date: (env.date || msg.internalDate)?.toISOString?.() ?? null,
    from,
    subject: env.subject || "(no subject)",
    unread: !(msg.flags && msg.flags.has("\\Seen")),
    flagged: !!(msg.flags && msg.flags.has("\\Flagged")),
  };
}

const server = new McpServer({ name: "yahoo-mail", version: "1.0.0" });

// ---------- list_folders ----------
server.tool(
  "list_folders",
  "List all Yahoo Mail folders with message and unread counts.",
  {},
  async () => {
    try {
      const folders = await withClient(async (client) => {
        const list = await client.list({ statusQuery: { messages: true, unseen: true } });
        return list.map((f) => ({
          path: f.path,
          special: f.specialUse || null,
          messages: f.status?.messages ?? null,
          unread: f.status?.unseen ?? null,
        }));
      });
      return ok(folders);
    } catch (e) { return fail(e); }
  }
);

// ---------- search_emails ----------
server.tool(
  "search_emails",
  "Search a folder. All filters are optional and combined with AND. Returns newest first. Dates are YYYY-MM-DD.",
  {
    folder: z.string().default("INBOX").describe("Folder path, e.g. INBOX, Bulk, Trash, or a custom folder"),
    from: z.string().optional().describe("Sender name or address contains this text"),
    subject: z.string().optional().describe("Subject contains this text"),
    text: z.string().optional().describe("Anywhere in the email contains this text"),
    since: z.string().optional().describe("On or after this date (YYYY-MM-DD)"),
    before: z.string().optional().describe("Before this date (YYYY-MM-DD)"),
    unread_only: z.boolean().optional().describe("Only unread emails"),
    limit: z.number().int().min(1).max(200).default(50),
  },
  async ({ folder, from, subject, text, since, before, unread_only, limit }) => {
    try {
      const results = await withFolder(folder, async (client) => {
        const query = {};
        if (from) query.from = from;
        if (subject) query.subject = subject;
        if (text) query.body = text;
        if (since) query.since = new Date(since);
        if (before) query.before = new Date(before);
        if (unread_only) query.seen = false;
        if (Object.keys(query).length === 0) query.all = true;

        const uids = (await client.search(query, { uid: true })) || [];
        const picked = uids.sort((a, b) => b - a).slice(0, limit);
        if (picked.length === 0) return { total: 0, emails: [] };

        const emails = [];
        for await (const msg of client.fetch(picked, { envelope: true, flags: true, internalDate: true }, { uid: true })) {
          emails.push(summarise(msg));
        }
        emails.sort((a, b) => b.uid - a.uid);
        return { total: uids.length, showing: emails.length, emails };
      });
      return ok(results);
    } catch (e) { return fail(e); }
  }
);

// ---------- read_email ----------
server.tool(
  "read_email",
  "Read one email's full text by its UID (from search_emails). Does not mark it as read.",
  {
    folder: z.string().default("INBOX"),
    uid: z.number().int(),
    max_chars: z.number().int().min(500).max(50000).default(8000),
  },
  async ({ folder, uid, max_chars }) => {
    try {
      const data = await withFolder(folder, async (client) => {
        const msg = await client.fetchOne(String(uid), { source: true, flags: true }, { uid: true });
        if (!msg) throw new Error(`No email with UID ${uid} in ${folder}`);
        const parsed = await simpleParser(msg.source);
        const body = (parsed.text || parsed.html?.replace(/<[^>]+>/g, " ") || "").replace(/\s+\n/g, "\n").trim();
        return {
          uid,
          date: parsed.date?.toISOString() ?? null,
          from: parsed.from?.text ?? "",
          to: parsed.to?.text ?? "",
          subject: parsed.subject ?? "(no subject)",
          attachments: (parsed.attachments || []).map((a) => ({ filename: a.filename, size: a.size, type: a.contentType })),
          body: body.length > max_chars ? body.slice(0, max_chars) + "\n…[truncated]" : body,
        };
      });
      return ok(data);
    } catch (e) { return fail(e); }
  }
);

// ---------- move_emails ----------
server.tool(
  "move_emails",
  "Move emails (by UID) from one folder to another. To 'delete', move to Trash. Nothing is ever permanently deleted.",
  {
    folder: z.string().default("INBOX").describe("Folder the emails are in now"),
    uids: z.array(z.number().int()).min(1).max(500),
    destination: z.string().describe("Target folder path, e.g. Archive, Trash, or a custom folder"),
  },
  async ({ folder, uids, destination }) => {
    try {
      const res = await withFolder(folder, (client) => client.messageMove(uids, destination, { uid: true }));
      return ok({ moved: uids.length, from: folder, to: destination, result: !!res });
    } catch (e) { return fail(e); }
  }
);

// ---------- move_matching ----------
server.tool(
  "move_matching",
  "Find every email in a folder matching a sender and/or subject and move them all to another folder in one go.",
  {
    folder: z.string().default("INBOX"),
    from: z.string().optional(),
    subject: z.string().optional(),
    destination: z.string(),
    create_destination: z.boolean().default(true).describe("Create the destination folder if it doesn't exist"),
  },
  async ({ folder, from, subject, destination, create_destination }) => {
    try {
      if (!from && !subject) throw new Error("Give at least a 'from' or 'subject' filter.");
      const res = await withClient(async (client) => {
        if (create_destination) {
          const exists = (await client.list()).some((f) => f.path.toLowerCase() === destination.toLowerCase());
          if (!exists) await client.mailboxCreate(destination);
        }
        const lock = await client.getMailboxLock(folder);
        try {
          const query = {};
          if (from) query.from = from;
          if (subject) query.subject = subject;
          const uids = (await client.search(query, { uid: true })) || [];
          if (uids.length) await client.messageMove(uids, destination, { uid: true });
          return { matched: uids.length, moved: uids.length, from: folder, to: destination };
        } finally { lock.release(); }
      });
      return ok(res);
    } catch (e) { return fail(e); }
  }
);

// ---------- create_folder ----------
server.tool(
  "create_folder",
  "Create a new Yahoo Mail folder. Use '/' for sub-folders, e.g. 'Bills/Electricity'.",
  { name: z.string().min(1) },
  async ({ name }) => {
    try {
      const res = await withClient((client) => client.mailboxCreate(name));
      return ok({ created: res?.path || name });
    } catch (e) { return fail(e); }
  }
);

// ---------- set_read / set_flag ----------
server.tool(
  "mark_emails",
  "Mark emails as read/unread or flagged/unflagged (starred).",
  {
    folder: z.string().default("INBOX"),
    uids: z.array(z.number().int()).min(1).max(500),
    read: z.boolean().optional(),
    flagged: z.boolean().optional(),
  },
  async ({ folder, uids, read, flagged }) => {
    try {
      await withFolder(folder, async (client) => {
        if (read === true) await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
        if (read === false) await client.messageFlagsRemove(uids, ["\\Seen"], { uid: true });
        if (flagged === true) await client.messageFlagsAdd(uids, ["\\Flagged"], { uid: true });
        if (flagged === false) await client.messageFlagsRemove(uids, ["\\Flagged"], { uid: true });
      });
      return ok({ updated: uids.length, read, flagged });
    } catch (e) { return fail(e); }
  }
);

// ---------- start ----------
if (process.argv.includes("--test")) {
  // Quick login check: `npm run test-login`
  withClient(async (c) => (await c.list()).map((f) => f.path))
    .then((f) => { console.log("Login OK. Folders:", f.join(", ")); process.exit(0); })
    .catch((e) => { console.error("Login failed:", e.message); process.exit(1); });
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Yahoo Mail MCP server running");
}
