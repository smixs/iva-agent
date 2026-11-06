# Use cases

Iva is a personal agent that lives on your own server and works in your Telegram 24/7. Text, voice, months of memory, browser errands, document editing — an ideal assistant right inside Telegram, no extra apps or services. The README lists features; this page shows what people actually do with them: business owners, specialists, executives and regular humans.

## The highlight reel

- Twice a day (08:30 and 14:00 by default) the Brief arrives on its own: today's tasks, calendar, mail, chats; in between Iva writes first when something waits for you.
- "What did we agree with client X about the last shipment?" — found in seconds, months later.
- A five-minute voice note from the car → a task list, a draft email, a meeting card.
- A 4,000-line price list reconciled in minutes instead of a day.
- "Make a quote from this price list, cut the discount by 2.5%, send it to the client" — a finished Google Doc, link right in the chat.
- "What did I miss in Telegram yesterday?" — a review of your chats and work groups (userbot mode).
- Tired of paying for Perplexity — research with links to sources, done by Iva.
- A photo of a business card → a contact card with what you agreed on.
- A Gmail reply and a calendar invite sent without opening the laptop.
- A bedtime story for your daughter — and tomorrow Iva remembers where the plot left off.

## For business owners

**🧠 Memory and context.** Iva remembers what was discussed, when and with whom. Ask "what did we decide with client X about the last shipment?" — she finds the thread, pulls up the agreements and reminds you what's due.

**📎 Files and documents.** Clients send price lists, specs and invoices — Iva edits them, makes copies, builds tables, reconciles the numbers, fills in forms. Say "make a quote from this price list, discount 2.5% lower, send it to the client" — she creates a Google Doc and drops the link right in the chat.

**📬 What did I miss.** In userbot mode Iva reads your own Telegram account: ask "what did I miss yesterday?" and she walks through your chats and work groups — what happened, what needs your attention.

**📊 Data at volume.** Price lists, sales reports, reconciliations — she processes them right on your server. What takes a day by hand takes her minutes.

**📰 Industry news.** What's new with your suppliers, competitors and market — collected on request, with topics and sources tuned to you. Want it regularly — Iva sets up a cron and the summary arrives every morning by itself.

**🔎 Background checks.** Before a deal, Iva gathers what open sources say about the company and the people across the table.

**📮 Mail and calendar.** Gmail, meetings with invites — straight from the chat. Ask "what's in the inbox?" and she tells you what actually needs a reply.

## For specialists

**🔎 Research with receipts.** An answer with links to sources instead of a retelling, on any of four search providers.

**📊 Tables and exports.** Send a ten-thousand-row CSV; she parses it, runs the numbers and returns a summary.

**🎙 Voice and call recordings.** Voice notes, audio and video messages become text, decisions and tasks. Language auto-detected (ru/uz/en).

**✍️ Drafts in your voice.** Emails, documents, replies — she has months of your context to draw from, and a draft can arrive as a ready Google Doc with a link.

**🌐 Browser errands.** Iva drives a real browser: fills forms on websites, pulls data off pages, takes screenshots — and reads pages behind a login, even your Instagram feed, then tells you what's going on there.

**🗂 A knowledge base you own.** All memory is plain markdown cards in an Obsidian-compatible vault. Open it in Obsidian, grep it, take it with you.

## For executives

**🧭 Decision cards.** What you chose, when and why — old versions stay in a dated history. No more "why did we do it this way?" archaeology.

**📇 Personal CRM.** Who promised what, what you agreed on, when to follow up.

**🤝 Meeting prep.** A brief on the company and the person across the table, a couple of minutes before the call.

**📮 Inbox and calendar from chat** — handled between meetings, from the phone.

**🔐 Confidentiality.** Your server, your keys; memory is a private git repository you own. Deal talk doesn't live in someone else's SaaS — for an executive this tends to be the deciding argument.

**📊 Transparent spend.** Every model step is logged; `/usage` reports the burn for free.

## For everyday life

Voice notes and shopping lists. People and dates she actually remembers. Search and purchases researched with sources. Reminders and schedules: say "remind me on Friday to congratulate Sergey" or "send my day plan every morning at 9" — Iva puts it on her reminder list or her schedule, and the message arrives right on time. Bedtime stories that continue tonight's plot tomorrow. The interface speaks Russian or English, switched with one button in `/menu`; voice notes are understood in Russian, English and Uzbek.

## Iva grows around you

Out of the box Iva ships with ten skills: web research, a browser, Google Workspace, a daily brief, local document processing, rich Telegram posts, problem reports, update recovery, a personal-account userbot and injection defense. The rest is yours to add — and adding is cheap:

- a **skill** is one markdown file with a procedure;
- an **MCP connector** to your CRM, database or internal service is one config file;
- a **subagent** for a recurring pipeline is one folder.

The author's own install has grown past 80 skills: Iva runs a Telegram channel, compiles weekly reports, generates images, sorts through social media exports. Give her a skill with your expertise — and she becomes a second brain that takes the routine off your plate. How to extend: [docs/extending.md](extending.md).

## Honest limits

Everything that arrives on its own runs on a schedule inside Iva: the Brief twice a day, night reports, and Watch, which checks Telegram and mail once an hour without the model and writes first only when a chat or a letter has waited for you or a regular job failed — never at night (23:00–08:00) unless the sender is on your urgent list, and at most five such messages a day. Reminders live in her own table on your server, which she fills when you ask (see [Reminders](reminders.md)). `iva proactive off` (or the toggle in /menu → Notices) stops Watch, the Brief and Insight; failures still reach you. The model and voice transcription are cloud APIs you choose and pay for directly, with no markup. The userbot mode (acting from your personal account) is opt-in and at your own risk.

## Try it

```bash
curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/install.sh | bash
```

[Quick start](../README.md#quick-start) · [Features](../README.md#features) · [Docs](README.md)
