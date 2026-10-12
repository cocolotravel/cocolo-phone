# COCOLO Call (phone.cocolotravel.com)

A small static page that lets an agent call a prospect from a Zammad ticket, in the browser, from the COCOLO Paris number. The call is recorded; n8n transcribes it and adds a note to the ticket.

There is no build step and no secret in this repository.

## Files

| File | Purpose |
|---|---|
| `index.html`, `style.css`, `app.js` | The page |
| `vendor/twilio.min.js` | Twilio Voice SDK 2.18.5 (Apache-2.0, licence in `vendor/LICENSE.md`), hosted here on purpose |
| `_headers` | Netlify security headers (content security policy, microphone permission) |
| `robots.txt` | Keeps search engines out |

## How it works

1. An agent clicks the link on a Zammad ticket: `https://phone.cocolotravel.com/?ticket=<ticket number>`.
2. The page asks for the agents username and password (kept only for the browser session) and loads the customer's name and numbers from n8n (`/webhook/softphone-ticket`).
3. The agent confirms the number. The page gets a short-lived call token from n8n (`/webhook/softphone-token`) and starts the call through Twilio.
4. Twilio asks n8n how to place the call (`/webhook/softphone-voice`): caller ID +33 1 62 04 58 08, record both sides, play the recording notice to the customer.
5. When the recording is ready, Twilio notifies the "Call recording to Zammad note" workflow in n8n, which adds the transcript and summary to the ticket.

## Deploying

- Netlify: connect this repository. Build command: none. Publish directory: the repository root.
- DNS (Cloudflare): `CNAME phone -> <your-site>.netlify.app`, proxy status **DNS only**.
- Pushing to the main branch publishes automatically.

## Changing things

- n8n address: `API` at the top of `app.js`. If it changes, also update `connect-src` in `_headers`.
- Allowed origin for the n8n endpoints: set in the Token Request and Ticket Info Request webhooks (workflow "Softphone API").
- If the call fails and the browser console mentions a blocked resource, a rule in `_headers` is too strict for the Twilio SDK. Add only the host named in the error.

## Not in this repository

Passwords, Twilio keys, and the n8n credentials. Never commit those.
