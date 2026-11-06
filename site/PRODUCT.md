# Product
<!-- impeccable:product-schema 1 -->

## Platform
web

## Users
People evaluating a personal assistant for everyday work and life in Telegram. Russian and English site visitors, including visitors using a phone.

## Product Purpose
Iva is a self-hosted personal assistant in Telegram. The website lets a visitor see a prepared day with Iva and understand its usefulness before installation.

## Positioning
A personal assistant accessible in the messaging app people already use. Approved hero message: "Личный AI помощник в телеграм". The owner requires concrete capabilities instead of decorative slogans.

## Operating Context
The demonstration uses the approved V6 film: a morning overview, a voice message, CRM changes, correspondence, a flight, an invoice, sharing a restaurant, shopping, and following a task to completion.

## Capabilities and Constraints
The public demonstration is scripted and labelled as a demo. Five pairs of buttons accept a visitor's decision; otherwise the existing positive choice plays automatically. The story continues after a choice. The in-phone menu is interactive: model selection and settings use the real Telegram menu as reference. The final chat message names Iva explicitly and offers installation of a personal AI assistant in Telegram; accepting copies the existing install instruction and explains how to pass it to Codex or Claude. It sends nothing to another agent by itself.
The phone is permanently visible. The web experience has no film title cards, logo fly-throughs or outro interstitials.
The original V6 Telegram interface, frame, wallpaper, transcript and message motion are visual authority. The menu button toggles settings and resumes the story when closed; a gentle pulse and an external hand-drawn arrow introduce it. The settings menu has a distinct installation action. The external control hint identifies the scripted experience as a demo. Marketing labels and cues stay outside the phone enclosure.
Installation uses one shared clipboard handler. Website buttons confirm with a large card in the middle of the screen that leaves by itself; in-phone actions show their result and a selectable failure phrase inside the chat. The site requests no Telegram login or model credentials.

## Brand Commitments
Iva leaf logo and blue #368AD2 / green #A4DC55 identity. The website uses self-hosted Manrope for a distinct, readable editorial voice; the phone retains its native V6 typography. Copy describes memory, proactive task handling, configuration, storage and operating costs.
Desktop hero has copy left and large phone right. Mobile keeps the V6 phone frame nearly full screen, a short heading above and explanation/installation below.
The page below the hero begins directly with four concrete situations, with no generic introductory headline. Each mobile situation presents its heading, short explanation, then the people image; desktop alternates image and text. The page includes existing integration logos, Telegram settings, data security, installation and one fully collapsed FAQ group. Email and Telegram correspondence are named explicitly; reading Telegram chats requires connecting the user’s account.

## Evidence on Hand
Approved film source: /Users/majento/dev/tries/2026-10-22-iva-demo-film/src/v6/Film6.tsx and src/v5/Film5.tsx.
Existing preview source: site/src and site/public, revision a3725bba.
Owner interview and proposal: /Users/majento/dev/my/assistant/.scratch/work/site-demo-proposal.md.
Current task authorises V7 implementation on mini and a temporary try.cloudflare preview.

## Product Principles
Show the real prepared scenarios through interaction.
Keep the visual fidelity of V6 while making the controls respond.
Keep the page short and the first experience fast.
Headings have no full stops. Keep GitHub visible in the header on mobile and desktop.
State the privacy boundary accurately: memory/history are stored on the user’s host; Telegram, chosen model and optional transcription providers receive their respective requests.
Preserve useful installation, documentation and language routes.

